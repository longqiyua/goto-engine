'use strict';

/**
 * GOTO Base Where Pattern Builder — AppTransitionPattern Builder
 *
 * 从 AppUsageAggregate 数组推导出应用转移模式。
 *
 * 算法：
 *   1. 按时间排序所有会话
 *   2. 对相邻 (A, B) 计算 delay = B.startedAt - A.endedAt
 *   3. 按 (from, to) 分组
 *   4. 对每组：
 *      - transitionCount = 样本数
 *      - medianDelayMs = 延时中位数
 *      - p90DelayMs = P90 延时（异常值过滤用）
 *      - weightedTransitionCount = 应用时间衰减后的加权和
 *      - confidence = (sampleCount / maxSampleThreshold) * (1 - delayPenalty)
 *   5. 异常值过滤：delay > p90ThresholdMs 的样本不计入中位数
 *   6. 时间衰减
 *
 * 重要：禁止接入 Android Usage Access；输入必须为 AppUsageAggregate 数组。
 */

const {
  createAppTransitionPattern,
  buildWherePatternConfig
} = require('./where-pattern-types.js');

class AppTransitionPatternBuilder {
  /**
   * @param {object} [config]
   *   - {number} [minSampleCount=3]
   *   - {number} [minConfidence=0.4]
   *   - {number} [decayHalfLifeDays=30]
   *   - {number} [decayMinWeight=0.05]
   *   - {number} [maxSampleThreshold=10]
   *   - {number} [outlierP90ThresholdMs=600000] P90 延时阈值
   *   - {number} [maxDelayMs=1800000] 最大允许延时（30 分钟）
   *   - {function} [now]
   */
  constructor(config) {
    this._config = buildWherePatternConfig(config || {});
    this._maxDelayMs = (config && typeof config.maxDelayMs === 'number')
      ? config.maxDelayMs : 1800000;
    this._now = (config && typeof config.now === 'function')
      ? config.now
      : (() => new Date().toISOString());
  }

  /**
   * 从 AppUsageAggregate 数组构建 AppTransitionPattern 数组。
   * @param {Array<object>} aggregates AppUsageAggregate[]
   * @returns {Array<object>} AppTransitionPattern[]
   */
  build(aggregates) {
    if (!Array.isArray(aggregates) || aggregates.length === 0) return [];

    // 按时间排序
    const sorted = aggregates
      .filter(a => a && a.packageName && a.startedAt && a.endedAt)
      .map(a => ({
        packageName: a.packageName,
        startedAt: a.startedAt,
        endedAt: a.endedAt,
        startedMs: Date.parse(a.startedAt),
        endedMs: Date.parse(a.endedAt)
      }))
      .filter(a => !isNaN(a.startedMs) && !isNaN(a.endedMs))
      .sort((a, b) => a.startedMs - b.startedMs);

    if (sorted.length < 2) return [];

    // 收集所有转移
    const transitions = new Map(); // "from->to" -> { from, to, delays: [], timestamps: [] }
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      if (prev.packageName === curr.packageName) continue;
      const delay = curr.startedMs - prev.endedMs;
      if (delay < 0 || delay > this._maxDelayMs) continue; // 异常：延时为负或超长
      const key = prev.packageName + '->' + curr.packageName;
      let entry = transitions.get(key);
      if (!entry) {
        entry = {
          from: prev.packageName,
          to: curr.packageName,
          delays: [],
          timestamps: []
        };
        transitions.set(key, entry);
      }
      entry.delays.push(delay);
      entry.timestamps.push(curr.startedMs);
    }

    const patterns = [];
    for (const entry of transitions.values()) {
      const pattern = this._buildOne(entry);
      if (pattern) patterns.push(pattern);
    }
    return patterns;
  }

  /**
   * 增量更新：在已有 pattern 基础上合并新转移。
   */
  update(existing, newAggregates) {
    if (!Array.isArray(newAggregates) || newAggregates.length === 0) {
      return existing || null;
    }
    if (!existing) {
      const all = this.build(newAggregates);
      const match = all.find(p => p.fromPackageName === newAggregates[0].packageName);
      return match || null;
    }

    // 尝试用新数据独立构建
    const newPatterns = this.build(newAggregates);
    const match = newPatterns.find(p =>
      p.fromPackageName === existing.fromPackageName &&
      p.toPackageName === existing.toPackageName);

    if (match) {
      // 新数据足够独立构建 pattern，做完整合并
      const mergedCount = (existing.transitionCount || 0) + match.transitionCount;
      const mergedWeighted = (existing.weightedTransitionCount || 0) + match.weightedTransitionCount;
      const mergedMedian = Math.round(
        0.5 * (existing.medianDelayMs || 0) + 0.5 * match.medianDelayMs
      );
      const mergedConf = round(
        0.4 * (existing.confidence || 0) + 0.6 * match.confidence, 4
      );
      const lastSeen = (Date.parse(existing.lastSeenAt) > Date.parse(match.lastSeenAt))
        ? existing.lastSeenAt : match.lastSeenAt;
      const firstSeen = (Date.parse(existing.firstSeenAt) < Date.parse(match.firstSeenAt))
        ? existing.firstSeenAt : match.firstSeenAt;

      return Object.assign({}, existing, {
        transitionCount: mergedCount,
        weightedTransitionCount: mergedWeighted,
        medianDelayMs: mergedMedian,
        confidence: mergedConf,
        firstSeenAt: firstSeen,
        lastSeenAt: lastSeen,
        decayVersion: (existing.decayVersion || 0)
      });
    }

    // 新数据不足以独立构建 pattern，做轻量合并：
    // 提取属于此转移的新会话对
    const newTransitions = this._extractTransitions(newAggregates);
    const relevant = newTransitions.filter(t =>
      t.from === existing.fromPackageName && t.to === existing.toPackageName);

    if (relevant.length === 0) return existing;

    const newCount = relevant.length;
    const mergedCount = (existing.transitionCount || 0) + newCount;
    const newWeightedSum = relevant.reduce((sum, t) => sum + this._decayFactor(t.timestamp), 0);
    const mergedWeighted = (existing.weightedTransitionCount || 0) + round(newWeightedSum, 4);
    const allNewDelays = relevant.map(t => t.delay);
    const mergedMedian = Math.round(
      0.5 * (existing.medianDelayMs || 0) + 0.5 * median(allNewDelays.slice().sort((a, b) => a - b))
    );
    const newLastMs = Math.max.apply(null, relevant.map(t => t.timestamp));
    const newFirstMs = Math.min.apply(null, relevant.map(t => t.timestamp));
    const lastSeen = (Date.parse(existing.lastSeenAt) > newLastMs)
      ? existing.lastSeenAt : new Date(newLastMs).toISOString();
    const firstSeen = (Date.parse(existing.firstSeenAt) < newFirstMs)
      ? existing.firstSeenAt : new Date(newFirstMs).toISOString();

    return Object.assign({}, existing, {
      transitionCount: mergedCount,
      weightedTransitionCount: mergedWeighted,
      medianDelayMs: mergedMedian,
      confidence: existing.confidence, // 保持 confidence（轻量合并不改信号强度）
      firstSeenAt: firstSeen,
      lastSeenAt: lastSeen,
      decayVersion: (existing.decayVersion || 0)
    });
  }

  _extractTransitions(aggregates) {
    if (!Array.isArray(aggregates) || aggregates.length < 2) return [];
    const sorted = aggregates
      .filter(a => a && a.packageName && a.startedAt && a.endedAt)
      .map(a => ({
        packageName: a.packageName,
        startedMs: Date.parse(a.startedAt),
        endedMs: Date.parse(a.endedAt)
      }))
      .filter(a => !isNaN(a.startedMs) && !isNaN(a.endedMs))
      .sort((a, b) => a.startedMs - b.startedMs);

    const transitions = [];
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      if (prev.packageName === curr.packageName) continue;
      const delay = curr.startedMs - prev.endedMs;
      if (delay < 0 || delay > this._maxDelayMs) continue;
      transitions.push({ from: prev.packageName, to: curr.packageName, delay, timestamp: curr.startedMs });
    }
    return transitions;
  }

  _buildOne(entry) {
    if (entry.delays.length < this._config.minSampleCount) return null;

    // 排序计算中位数与 P90
    const sortedDelays = entry.delays.slice().sort((a, b) => a - b);
    const medianDelayMs = median(sortedDelays);
    const p90DelayMs = percentile(sortedDelays, 0.9);

    // 时间衰减后的加权和
    let weightedSum = 0;
    for (let i = 0; i < entry.timestamps.length; i++) {
      const factor = this._decayFactor(entry.timestamps[i]);
      weightedSum += factor;
    }

    const sampleCount = entry.delays.length;
    const sampleFactor = Math.min(1, sampleCount / this._config.maxSampleThreshold);
    // confidence 基于"信号强度"（sampleFactor），延时质量作为 metadata 供 scorer 使用
    const rawConfidence = sampleFactor;
    // 先用 rawConfidence 过滤（minConfidence 针对原始信号强度）
    if (rawConfidence < this._config.minConfidence) return null;
    // 再应用时间衰减
    const lastSeenMs = Math.max.apply(null, entry.timestamps);
    let confidence = this._applyDecay(rawConfidence, lastSeenMs);
    // 延时惩罚（记录为 metadata，不直接影响 confidence 过滤）
    const delayPenalty = Math.min(1, medianDelayMs / this._maxDelayMs);

    const firstSeenMs = Math.min.apply(null, entry.timestamps);

    return createAppTransitionPattern({
      fromPackageName: entry.from,
      toPackageName: entry.to,
      transitionCount: sampleCount,
      weightedTransitionCount: round(weightedSum, 4),
      medianDelayMs: Math.round(medianDelayMs),
      p90DelayMs: Math.round(p90DelayMs),
      confidence: round(confidence, 4),
      firstSeenAt: new Date(firstSeenMs).toISOString(),
      lastSeenAt: new Date(lastSeenMs).toISOString(),
      decayVersion: 0,
      enabled: true,
      metadata: {
        source: 'pattern-builder',
        delayPenalty: round(delayPenalty, 4),
        builderVersion: '1.0.0'
      }
    });
  }

  _decayFactor(timestampMs) {
    const nowMs = Date.parse(this._now());
    const elapsedDays = Math.max(0, (nowMs - timestampMs) / 86400000);
    const halfLife = this._config.decayHalfLifeDays;
    return Math.max(this._config.decayMinWeight, Math.pow(0.5, elapsedDays / halfLife));
  }

  _applyDecay(confidence, lastSeenMs) {
    const nowMs = Date.parse(this._now());
    const elapsedDays = Math.max(0, (nowMs - lastSeenMs) / 86400000);
    const halfLife = this._config.decayHalfLifeDays;
    const factor = Math.pow(0.5, elapsedDays / halfLife);
    return Math.max(this._config.decayMinWeight, confidence * factor);
  }
}

function median(sortedArr) {
  if (!sortedArr || sortedArr.length === 0) return 0;
  const mid = Math.floor(sortedArr.length / 2);
  if (sortedArr.length % 2 === 0) {
    return Math.round((sortedArr[mid - 1] + sortedArr[mid]) / 2);
  }
  return sortedArr[mid];
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

module.exports = { AppTransitionPatternBuilder };
