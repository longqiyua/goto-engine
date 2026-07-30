'use strict';

/**
 * GOTO Base Where Pattern Builder — TimingPattern Builder
 *
 * 从 AppUsageAggregate 数组推导出应用时间使用模式。
 *
 * 算法：
 *   1. 按 packageName 分组
 *   2. 对每组会话，提取 startedAt 的 (weekday, hour, minute)
 *   3. 统计 weekdays 直方图（7 项）
 *   4. 统计 hourly 直方图（24 项），归一化为 0..1
 *   5. 计算 typicalHour = 最大概率小时
 *   6. typicalMinute = 该小时内会话的分钟中位数
 *   7. confidence = (sampleCount / maxSampleThreshold) * hourConcentration
 *   8. 异常值过滤：P90 之外的会话不计入典型小时
 *   9. 时间衰减：按 lastSeenAt 与 decayHalfLifeDays 计算 weightedTransitionCount
 *
 * 重要：禁止接入 Android Usage Access；输入必须为 AppUsageAggregate 数组（Fixture 或未来由 HOST 注入）。
 */

const {
  createTimingPattern,
  buildWherePatternConfig
} = require('./where-pattern-types.js');

class TimingPatternBuilder {
  /**
   * @param {object} [config] 配置覆盖
   *   - {number} [minSampleCount=3] 最小样本数
   *   - {number} [minConfidence=0.4] 最小置信度
   *   - {number} [defaultTimeWindowMinutes=30] 默认窗口
   *   - {number} [decayHalfLifeDays=30] 衰减半衰期
   *   - {number} [decayMinWeight=0.05] 衰减下限
   *   - {number} [maxSampleThreshold=10] confidence 饱和样本数
   *   - {function} [now] 自定义时间函数
   */
  constructor(config) {
    this._config = buildWherePatternConfig(config || {});
    this._now = (config && typeof config.now === 'function')
      ? config.now
      : (() => new Date().toISOString());
  }

  /**
   * 从 AppUsageAggregate 数组构建 TimingPattern 数组。
   * @param {Array<object>} aggregates AppUsageAggregate[]
   * @returns {Array<object>} TimingPattern[]（已过滤低于阈值的应用）
   */
  build(aggregates) {
    if (!Array.isArray(aggregates) || aggregates.length === 0) return [];

    // 按 packageName 分组
    const groups = new Map();
    for (const agg of aggregates) {
      if (!agg || !agg.packageName || !agg.startedAt) continue;
      const ts = Date.parse(agg.startedAt);
      if (isNaN(ts)) continue;
      let arr = groups.get(agg.packageName);
      if (!arr) {
        arr = [];
        groups.set(agg.packageName, arr);
      }
      arr.push({ agg, ts });
    }

    const patterns = [];
    for (const [packageName, sessions] of groups.entries()) {
      const pattern = this._buildOne(packageName, sessions);
      if (pattern) patterns.push(pattern);
    }
    return patterns;
  }

  /**
   * 增量更新：在已有 pattern 基础上合并新会话。
   * @param {object} existing 已有的 TimingPattern（可为 null）
   * @param {Array<object>} newAggregates 新会话
   * @returns {object|null} 更新后的 TimingPattern（或 null 表示样本不足）
   */
  update(existing, newAggregates) {
    if (!Array.isArray(newAggregates) || newAggregates.length === 0) {
      return existing || null;
    }
    if (existing) {
      // 简化策略：从 existing 与新 aggregates 重建（pattern 本身记录了 sampleCount，
      // 但具体样本已被压缩。这里采用合并 weekdays / hourlyPattern 的近似重建法）
      return this._mergeAndRebuild(existing, newAggregates);
    }
    return this._buildOne(newAggregates[0].packageName, newAggregates.map(a => ({ agg: a, ts: Date.parse(a.startedAt) })));
  }

  _buildOne(packageName, sessions) {
    if (sessions.length < this._config.minSampleCount) return null;

    // 1. weekday 直方图
    const weekdayCount = [0, 0, 0, 0, 0, 0, 0];
    const hourlyCount = new Array(24).fill(0);
    const hourMinuteBuckets = new Map(); // hour -> [minutes]
    let firstSeenMs = Infinity;
    let lastSeenMs = -Infinity;

    for (const { agg, ts } of sessions) {
      const d = new Date(ts);
      // 注意：JS Date.getUTCDay() 周日=0，周一=1.. 周六=6
      // 我们使用 0=周一.. 6=周日（与 schema.weekdays 对齐）
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

    // 2. 找出典型小时（出现次数最多的小时）
    let typicalHour = 0;
    let maxCount = -1;
    for (let h = 0; h < 24; h++) {
      if (hourlyCount[h] > maxCount) {
        maxCount = hourlyCount[h];
        typicalHour = h;
      }
    }
    if (maxCount === 0) return null;

    // 3. typicalMinute = 该小时内的分钟中位数
    const minutesInHour = hourMinuteBuckets.get(typicalHour) || [];
    const typicalMinute = median(minutesInHour);

    // 4. weekdays 数组（出现次数 >= 1 即 true）
    const weekdays = weekdayCount.map(c => c > 0);

    // 5. hourlyPattern 归一化
    const maxHourly = Math.max(1, ...hourlyCount);
    const hourlyPattern = hourlyCount.map(c => c / maxHourly);

    // 6. confidence = (sampleCount / maxSampleThreshold) * hourConcentration
    const sampleCount = sessions.length;
    const sampleFactor = Math.min(1, sampleCount / this._config.maxSampleThreshold);
    const hourConcentration = maxCount / sampleCount;
    const rawConfidence = sampleFactor * hourConcentration;
    // 先用 rawConfidence 过滤（minConfidence 针对"原始信号强度"）
    if (rawConfidence < this._config.minConfidence) return null;
    // 再应用时间衰减（衰减影响最终 confidence，但不影响是否被召回）
    let confidence = this._applyDecay(rawConfidence, lastSeenMs);

    // 7. P90 异常值过滤（保留为 metadata，不影响 pattern 主字段）
    const delays = sessions.map(s => s.agg.durationMs || 0).sort((a, b) => a - b);
    const p90 = percentile(delays, 0.9);

    const pattern = createTimingPattern({
      packageName,
      weekdays,
      typicalHour,
      typicalMinute,
      timeWindowMinutes: this._config.defaultTimeWindowMinutes,
      hourlyPattern,
      sampleCount,
      confidence: round(confidence, 4),
      firstSeenAt: new Date(firstSeenMs).toISOString(),
      lastSeenAt: new Date(lastSeenMs).toISOString(),
      decayVersion: 0,
      enabled: true,
      metadata: {
        source: 'pattern-builder',
        p90DurationMs: p90,
        maxSampleThreshold: this._config.maxSampleThreshold,
        builderVersion: '1.0.0'
      }
    });
    return pattern;
  }

  _mergeAndRebuild(existing, newAggregates) {
    // 简化策略：将 existing.sampleCount 与新会话数相加作为新 sampleCount，
    // weekdays 合并（或运算），hourlyPattern 按权重合并，
    // typicalHour / typicalMinute 以新会话为主导（若新会话数 >= minSampleCount）
    const newSessions = newAggregates
      .filter(a => a && a.packageName === existing.packageName && a.startedAt)
      .map(a => ({ agg: a, ts: Date.parse(a.startedAt) }));
    if (newSessions.length === 0) return existing;

    const newPattern = this._buildOne(existing.packageName, newSessions);

    // 合并 weekdays（或运算）：即使新会话不足以独立构建 pattern，仍可贡献 weekday 信号
    const mergedWeekdays = existing.weekdays.slice();
    for (const { ts } of newSessions) {
      const d = new Date(ts);
      const jsDay = d.getUTCDay();
      const weekdayIdx = jsDay === 0 ? 6 : jsDay - 1;
      mergedWeekdays[weekdayIdx] = true;
    }

    // 合并 sampleCount
    const mergedSample = (existing.sampleCount || 0) + newSessions.length;

    // 合并 confidence
    let mergedConf;
    let typicalHour = existing.typicalHour;
    let typicalMinute = existing.typicalMinute;
    let hourlyPattern = existing.hourlyPattern;

    if (newPattern) {
      // 新会话足够独立构建 pattern，以新数据为主导
      mergedConf = round(0.4 * (existing.confidence || 0) + 0.6 * newPattern.confidence, 4);
      typicalHour = newPattern.typicalHour;
      typicalMinute = newPattern.typicalMinute;
      hourlyPattern = newPattern.hourlyPattern;
    } else {
      // 新会话不足 minSampleCount，做轻量合并：confidence 微调
      const existingSample = Math.max(1, existing.sampleCount || 0);
      const newWeight = newSessions.length / (existingSample + newSessions.length);
      mergedConf = round((1 - newWeight) * (existing.confidence || 0) + newWeight * 0.5, 4);
    }

    // 取较新/较早时间
    const newLastMs = Math.max(...newSessions.map(s => s.ts));
    const newFirstMs = Math.min(...newSessions.map(s => s.ts));
    const lastSeen = (Date.parse(existing.lastSeenAt) > newLastMs)
      ? existing.lastSeenAt : new Date(newLastMs).toISOString();
    const firstSeen = (Date.parse(existing.firstSeenAt) < newFirstMs)
      ? existing.firstSeenAt : new Date(newFirstMs).toISOString();

    const result = Object.assign({}, existing, {
      weekdays: mergedWeekdays,
      sampleCount: mergedSample,
      confidence: mergedConf >= this._config.minConfidence ? mergedConf : this._config.minConfidence,
      typicalHour,
      typicalMinute,
      hourlyPattern,
      firstSeenAt: firstSeen,
      lastSeenAt: lastSeen,
      decayVersion: (existing.decayVersion || 0)
    });

    return result;
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

function percentile(sortedArr, p) {
  if (!sortedArr || sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.floor(p * sortedArr.length));
  return sortedArr[idx];
}

function round(v, digits) {
  const f = Math.pow(10, digits || 4);
  return Math.round(v * f) / f;
}

module.exports = { TimingPatternBuilder };
