'use strict';

/**
 * GOTO Base Where Pattern Builder — GotoInternalPattern Builder
 *
 * 从 QueryEvent + SelectionEvent 数组推导出 GOTO 内部行为模式。
 *
 * 算法：
 *   1. 按 (normalizedQuery, selectedPackageName) 分组
 *   2. 对每组的 SelectionEvent：
 *      - 提取 timestamp 的 (weekday, hour, minute)
 *   3. 统计 weekday 直方图与 hourly 直方图
 *   4. typicalHour = 出现次数最多的小时
 *   5. typicalMinute = 该小时内分钟的中位数
 *   6. confidence = (sampleCount / maxSampleThreshold) * hourConcentration * 衰减
 *   7. 异常值过滤：P90 之外的样本不计入典型小时
 *
 * 输入来源是真实的 Personal Base QueryEvent + SelectionEvent（用户搜索行为）。
 */

const {
  createGotoInternalPattern,
  buildWherePatternConfig
} = require('./where-pattern-types.js');

class GotoInternalPatternBuilder {
  /**
   * @param {object} [config]
   *   - {number} [minSampleCount=3]
   *   - {number} [minConfidence=0.4]
   *   - {number} [defaultTimeWindowMinutes=30]
   *   - {number} [decayHalfLifeDays=30]
   *   - {number} [decayMinWeight=0.05]
   *   - {number} [maxSampleThreshold=10]
   *   - {number} [outlierP90ThresholdMs] （未使用，预留）
   *   - {function} [now]
   */
  constructor(config) {
    this._config = buildWherePatternConfig(config || {});
    this._now = (config && typeof config.now === 'function')
      ? config.now
      : (() => new Date().toISOString());
  }

  /**
   * 从 SelectionEvent 数组构建 GotoInternalPattern 数组。
   *
   * @param {Array<object>} selectionEvents SelectionEvent[]（必须包含 normalizedQuery、selectedPackageName、timestamp）
   * @returns {Array<object>} GotoInternalPattern[]
   */
  build(selectionEvents) {
    if (!Array.isArray(selectionEvents) || selectionEvents.length === 0) return [];

    // 按 (normalizedQuery, selectedPackageName) 分组
    const groups = new Map();
    for (const se of selectionEvents) {
      if (!se || !se.normalizedQuery || !se.selectedPackageName || !se.timestamp) continue;
      const ts = Date.parse(se.timestamp);
      if (isNaN(ts)) continue;
      const key = se.normalizedQuery + '@' + se.selectedPackageName;
      let arr = groups.get(key);
      if (!arr) {
        arr = [];
        groups.set(key, arr);
      }
      arr.push({ se, ts });
    }

    const patterns = [];
    for (const [, sessions] of groups.entries()) {
      const pattern = this._buildOne(sessions);
      if (pattern) patterns.push(pattern);
    }
    return patterns;
  }

  /**
   * 增量更新：在已有 pattern 基础上合并新事件。
   */
  update(existing, newSelectionEvents) {
    if (!Array.isArray(newSelectionEvents) || newSelectionEvents.length === 0) {
      return existing || null;
    }
    if (!existing) {
      // 无 existing pattern，用新数据独立构建
      const all = this.build(newSelectionEvents);
      return all.length > 0 ? all[0] : null;
    }
    // 合并：按 newSelectionEvents 过滤同 query+pkg 的事件
    const filtered = newSelectionEvents.filter(se =>
      se && se.normalizedQuery === existing.normalizedQuery &&
      se.selectedPackageName === existing.targetPackageName);
    if (filtered.length === 0) return existing;

    const newSessions = filtered
      .map(se => ({ se, ts: Date.parse(se.timestamp) }))
      .filter(s => !isNaN(s.ts));
    if (newSessions.length === 0) return existing;

    const newPattern = this._buildOne(newSessions);

    // 合并 weekdays（或运算）
    const mergedWeekdays = existing.weekdays.slice();
    for (const { ts } of newSessions) {
      const d = new Date(ts);
      const jsDay = d.getUTCDay();
      const weekdayIdx = jsDay === 0 ? 6 : jsDay - 1;
      mergedWeekdays[weekdayIdx] = true;
    }

    const mergedSample = (existing.sampleCount || 0) + newSessions.length;

    let mergedConf;
    let typicalHour = existing.typicalHour;
    let typicalMinute = existing.typicalMinute;

    if (newPattern) {
      // 新事件足够独立构建 pattern
      mergedConf = round(0.4 * (existing.confidence || 0) + 0.6 * newPattern.confidence, 4);
      typicalHour = newPattern.typicalHour;
      typicalMinute = newPattern.typicalMinute;
    } else {
      // 新事件不足 minSampleCount，轻量合并
      const existingSample = Math.max(1, existing.sampleCount || 0);
      const newWeight = newSessions.length / (existingSample + newSessions.length);
      mergedConf = round((1 - newWeight) * (existing.confidence || 0) + newWeight * 0.5, 4);
    }

    const newLastMs = Math.max.apply(null, newSessions.map(s => s.ts));
    const newFirstMs = Math.min.apply(null, newSessions.map(s => s.ts));
    const lastSeen = (Date.parse(existing.lastSeenAt) > newLastMs)
      ? existing.lastSeenAt : new Date(newLastMs).toISOString();
    const firstSeen = (Date.parse(existing.firstSeenAt) < newFirstMs)
      ? existing.firstSeenAt : new Date(newFirstMs).toISOString();

    return Object.assign({}, existing, {
      weekdays: mergedWeekdays,
      sampleCount: mergedSample,
      confidence: mergedConf >= this._config.minConfidence ? mergedConf : this._config.minConfidence,
      typicalHour,
      typicalMinute,
      firstSeenAt: firstSeen,
      lastSeenAt: lastSeen,
      decayVersion: (existing.decayVersion || 0)
    });
  }

  _buildOne(sessions) {
    if (sessions.length < this._config.minSampleCount) return null;

    const weekdayCount = [0, 0, 0, 0, 0, 0, 0];
    const hourlyCount = new Array(24).fill(0);
    const hourMinuteBuckets = new Map();
    let firstSeenMs = Infinity;
    let lastSeenMs = -Infinity;

    for (const { ts } of sessions) {
      const d = new Date(ts);
      const jsDay = d.getUTCDay();
      const weekdayIdx = jsDay === 0 ? 6 : jsDay - 1;
      weekdayCount[weekdayIdx]++;
      const hour = d.getUTCHours();
      const minute = d.getUTCMinutes();
      hourlyCount[hour]++;
      let arr = hourMinuteBuckets.get(hour);
      if (!arr) {
        arr = [];
        hourMinuteBuckets.set(hour, arr);
      }
      arr.push(minute);
      if (ts < firstSeenMs) firstSeenMs = ts;
      if (ts > lastSeenMs) lastSeenMs = ts;
    }

    let typicalHour = 0;
    let maxCount = -1;
    for (let h = 0; h < 24; h++) {
      if (hourlyCount[h] > maxCount) {
        maxCount = hourlyCount[h];
        typicalHour = h;
      }
    }
    if (maxCount === 0) return null;

    const minutesInHour = hourMinuteBuckets.get(typicalHour) || [];
    const typicalMinute = median(minutesInHour);
    const weekdays = weekdayCount.map(c => c > 0);

    const sampleCount = sessions.length;
    const sampleFactor = Math.min(1, sampleCount / this._config.maxSampleThreshold);
    const hourConcentration = maxCount / sampleCount;
    const rawConfidence = sampleFactor * hourConcentration;
    // 先用 rawConfidence 过滤（minConfidence 针对原始信号强度）
    if (rawConfidence < this._config.minConfidence) return null;
    // 再应用时间衰减
    let confidence = this._applyDecay(rawConfidence, lastSeenMs);

    const first = sessions[0].se;
    return createGotoInternalPattern({
      normalizedQuery: first.normalizedQuery,
      targetPackageName: first.selectedPackageName,
      weekdays,
      typicalHour,
      typicalMinute,
      timeWindowMinutes: this._config.defaultTimeWindowMinutes,
      sampleCount,
      confidence: round(confidence, 4),
      firstSeenAt: new Date(firstSeenMs).toISOString(),
      lastSeenAt: new Date(lastSeenMs).toISOString(),
      decayVersion: 0,
      enabled: true,
      metadata: {
        source: 'pattern-builder',
        builderVersion: '1.0.0'
      }
    });
  }

  _applyDecay(confidence, lastSeenMs) {
    const nowMs = Date.parse(this._now());
    const elapsedDays = Math.max(0, (nowMs - lastSeenMs) / 86400000);
    const halfLife = this._config.decayHalfLifeDays;
    const factor = Math.pow(0.5, elapsedDays / halfLife);
    return Math.max(this._config.decayMinWeight, confidence * factor);
  }
}

function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
}

function round(v, digits) {
  const f = Math.pow(10, digits || 4);
  return Math.round(v * f) / f;
}

module.exports = { GotoInternalPatternBuilder };
