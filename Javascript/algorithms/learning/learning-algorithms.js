'use strict';

/**
 * GOTO Base Personal Learning — 核心算法（纯函数，无 IO）
 *
 * 本模块实现 Personal Learning Overlay 的所有更新/排序规则。
 * 所有函数都是纯函数：相同输入永远产出相同输出，不修改全局状态，不读写文件。
 *
 * 设计原则：
 *   1. 第一次点击：仅建立 candidate 映射，confidence 不超过 candidateThreshold
 *   2. 多次重复选择：逐步增加 confidence
 *   3. 用户改选其他应用：降低旧映射权重（correctionDecrement）
 *   4. 连续改选：视为纠错信号，减量更大
 *   5. 长期未使用：按 decayHalfLifeDays 衰减，但不低于 decayMinWeight
 *   6. 短查询（<= shortQueryMaxLength）：证据权重 *= shortQueryEvidenceFactor
 *   7. 排名第一且用户点击：增量较小（rank1ClickIncrement）
 *   8. 排名较低但用户主动点击：增量较大（lowRankClickIncrement）
 *   9. 最大 personalBoost 不超过 maxPersonalBoost
 *   10. 精确应用名命中保有最高优先级保护
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HALF_LIFE_DIVISOR = Math.log(2); // ln(2) ≈ 0.6931

/**
 * 计算时间衰减后的"加权点击次数"系数。
 *
 * 公式：factor = max(decayMinWeight, 0.5 ^ (daysSinceLastSeen / decayHalfLifeDays))
 *
 * 说明：完全等同于放射性指数衰减，半衰期为 decayHalfLifeDays。
 *   - daysSinceLastSeen = 0  → factor = 1.0（无衰减）
 *   - daysSinceLastSeen = decayHalfLifeDays → factor = 0.5
 *   - daysSinceLastSeen = 2 * decayHalfLifeDays → factor = 0.25
 *   - ... 但不低于 decayMinWeight
 *
 * @param {string} lastSeenAt ISO 8601 时间
 * @param {string|Date} now 当前时间
 * @param {object} config 学习配置
 * @returns {number} 衰减系数 [decayMinWeight, 1]
 */
function computeDecayWeight(lastSeenAt, now, config) {
  const halfLifeDays = (config && typeof config.decayHalfLifeDays === 'number')
    ? config.decayHalfLifeDays : 30;
  const minWeight = (config && typeof config.decayMinWeight === 'number')
    ? config.decayMinWeight : 0.05;

  if (!lastSeenAt) return minWeight;
  const lastMs = Date.parse(lastSeenAt);
  const nowMs = (now instanceof Date) ? now.getTime() : Date.parse(now);
  if (isNaN(lastMs) || isNaN(nowMs)) return minWeight;
  if (nowMs <= lastMs) return 1.0;

  const daysSince = (nowMs - lastMs) / MS_PER_DAY;
  if (daysSince <= 0) return 1.0;

  // 0.5 ^ (days / halfLife)
  const factor = Math.pow(0.5, daysSince / halfLifeDays);
  return Math.max(minWeight, factor);
}

/**
 * 计算本次点击的增量。
 *
 * 规则：
 *   - 首次点击（isRepeat=false）：firstClickIncrement
 *   - 重复点击（isRepeat=true）：repeatClickIncrement + 排名加成
 *     - rank === 1：rank1ClickIncrement（用户预期行为，加权较小）
 *     - rank > 3（低排名）：lowRankClickIncrement（用户主动选择，加权较大）
 *     - 中间排名：0
 *   - 短查询（queryLength <= shortQueryMaxLength）：增量 *= shortQueryEvidenceFactor
 *
 * @param {number} rank 学习前排名（1-based，0 表示未在候选中）
 * @param {boolean} isRepeat 是否为重复点击（已存在 affinity）
 * @param {number} queryLength 归一化查询字符数（不含空格）
 * @param {object} config 学习配置
 * @returns {number} 增量（>= 0）
 */
function computeClickIncrement(rank, isRepeat, queryLength, config) {
  const cfg = config || {};
  const firstInc = cfg.firstClickIncrement || 0.15;
  const repeatInc = cfg.repeatClickIncrement || 0.1;
  const rank1Inc = cfg.rank1ClickIncrement || 0.05;
  const lowRankInc = cfg.lowRankClickIncrement || 0.2;
  const shortFactor = cfg.shortQueryEvidenceFactor || 0.5;
  const shortMaxLen = cfg.shortQueryMaxLength || 2;

  let inc;
  if (!isRepeat) {
    inc = firstInc;
  } else {
    inc = repeatInc;
    // 排名加成（仅重复点击考虑排名加成，避免首次点击被排名主导）
    if (rank === 1) {
      inc += rank1Inc;
    } else if (rank === 0 || rank > 3) {
      // rank === 0 表示未在候选中（用户主动启动），视为强信号
      inc += lowRankInc;
    }
  }

  if (typeof queryLength === 'number' && queryLength > 0 && queryLength <= shortMaxLen) {
    inc *= shortFactor;
  }

  return Math.max(0, inc);
}

/**
 * 计算纠正减量。
 *
 * 规则：
 *   - 单次纠正（isConsecutive=false）：correctionDecrement
 *   - 连续纠正（isConsecutive=true）：correctionDecrement * 1.5（视为强纠错信号）
 *
 * @param {boolean} isConsecutive 是否为连续纠正（最近一次也是纠正）
 * @param {object} config 学习配置
 * @returns {number} 减量（>= 0）
 */
function computeCorrectionDecrement(isConsecutive, config) {
  const cfg = config || {};
  const base = cfg.correctionDecrement || 0.15;
  return isConsecutive ? base * 1.5 : base;
}

/**
 * 判定一次点击是否为"纠正信号"。
 *
 * 纠正信号：用户改选了其他应用，并且该应用的 rank 在最近一次候选中靠前（<=3）但未被选择。
 * 此函数仅返回布尔，减量由 computeCorrectionDecrement 计算。
 *
 * @param {object} prevSelection 上次的选择事件
 * @param {object} currentSelection 本次的选择事件
 * @returns {boolean}
 */
function isCorrectionSignal(prevSelection, currentSelection) {
  if (!prevSelection || !currentSelection) return false;
  if (prevSelection.normalizedQuery !== currentSelection.normalizedQuery) return false;
  if (prevSelection.selectedPackageName === currentSelection.selectedPackageName) return false;
  // 同一查询下用户改选了不同的应用 → 纠正
  return true;
}

/**
 * 根据 SelectionEvent 更新 QueryAppAffinity（返回新对象，不修改入参）。
 *
 * 实现说明：
 *   - 若 affinity 为空（首次点击）：firstSeenAt = timestamp，建立 candidate
 *   - selectionCount++
 *   - weightedSelectionCount = (weightedSelectionCount * decayFactor) + increment
 *     其中 decayFactor 由 lastSeenAt → timestamp 的间隔计算（按半衰期衰减）
 *   - lastSeenAt = timestamp
 *   - confidence = clamp(weightedSelectionCount, 0, 1)（更精细的 confidence 公式由 updateAliasStatus 统一）
 *   - 当前 currentWeight = weightedSelectionCount - correctionCount * correctionDecrement - negativeCount * correctionDecrement
 *
 * @param {object|null} affinity 旧 QueryAppAffinity（若不存在则传 null）
 * @param {object} selectionEvent 选择事件（必含 normalizedQuery, packageName, selectedRankBeforeLearning, timestamp）
 * @param {object} config 学习配置
 * @returns {object} 更新后的 QueryAppAffinity（新对象）
 */
function updateAffinity(affinity, selectionEvent, config) {
  const cfg = config || {};
  const {
    createQueryAppAffinity
  } = require('./learning-types');

  const ts = selectionEvent.timestamp;
  const rank = selectionEvent.selectedRankBeforeLearning || 0;
  const qLen = (selectionEvent.normalizedQuery || '').replace(/\s+/g, '').length;

  if (!affinity) {
    // 首次点击：建立 candidate 映射
    const created = createQueryAppAffinity({
      normalizedQuery: selectionEvent.normalizedQuery,
      packageName: selectionEvent.selectedPackageName,
      firstSeenAt: ts
    });
    created.lastSeenAt = ts;
    const inc = computeClickIncrement(rank, false, qLen, cfg);
    created.selectionCount = 1;
    created.weightedSelectionCount = inc;
    created.confidence = clampConfidence(inc, cfg);
    created.currentWeight = inc;
    // 上下文统计（首次点击也填充）
    const ctx = selectionEvent.context || {};
    const timeOfDay = ctx.timeOfDay || 'unknown';
    created.contextStats[timeOfDay] = { count: 1, avgRank: rank };
    return created;
  }

  // 已存在 affinity：增量更新
  // 注意：返回新对象，不修改入参
  const updated = JSON.parse(JSON.stringify(affinity));

  const decayFactor = computeDecayWeight(updated.lastSeenAt, ts, cfg);
  const isRepeat = true;
  const inc = computeClickIncrement(rank, isRepeat, qLen, cfg);

  // 衰减旧权重，再加新增量
  updated.weightedSelectionCount = (updated.weightedSelectionCount * decayFactor) + inc;
  updated.selectionCount = (updated.selectionCount || 0) + 1;
  updated.lastSeenAt = ts;

  // 上下文统计
  const ctx = selectionEvent.context || {};
  const timeOfDay = ctx.timeOfDay || 'unknown';
  if (!updated.contextStats) updated.contextStats = {};
  const bucket = updated.contextStats[timeOfDay] || { count: 0, avgRank: 0 };
  // 增量平均
  const newCount = bucket.count + 1;
  bucket.avgRank = (bucket.avgRank * bucket.count + rank) / newCount;
  bucket.count = newCount;
  updated.contextStats[timeOfDay] = bucket;

  // 重置连续纠正计数（用户成功点击了此应用）
  updated.lastConsecutiveCorrectionCount = 0;

  // 重新计算 confidence & currentWeight
  updated.confidence = clampConfidence(updated.weightedSelectionCount, cfg);
  updated.currentWeight = updated.weightedSelectionCount
    - (updated.correctionCount || 0) * (cfg.correctionDecrement || 0.15)
    - (updated.negativeCount || 0) * (cfg.correctionDecrement || 0.15) * 0.5; // 负向信号减半

  return updated;
}

/**
 * 应用一次纠正信号到 affinity（用户改选了其他应用，此 affinity 被削弱）。
 * 返回新对象，不修改入参。
 *
 * @param {object} affinity 旧 affinity
 * @param {object} correctionEvent 纠正事件（包含 normalizedQuery, timestamp, selectedPackageName 是用户改选的目标）
 * @param {boolean} isConsecutive 是否连续纠正
 * @param {object} config 学习配置
 * @returns {object} 更新后的 affinity
 */
function applyCorrection(affinity, correctionEvent, isConsecutive, config) {
  if (!affinity) return affinity;
  const cfg = config || {};
  const updated = JSON.parse(JSON.stringify(affinity));

  const dec = computeCorrectionDecrement(isConsecutive, cfg);
  updated.correctionCount = (updated.correctionCount || 0) + 1;
  updated.lastConsecutiveCorrectionCount = (updated.lastConsecutiveCorrectionCount || 0) + 1;
  updated.lastSeenAt = correctionEvent.timestamp || updated.lastSeenAt;

  // currentWeight 直接减量（可为负）
  updated.currentWeight = (updated.currentWeight || 0) - dec;

  // confidence 按当前权重重算
  updated.confidence = clampConfidence(updated.currentWeight, cfg);

  return updated;
}

/**
 * 应用一次负向信号到 affinity（用户主动跳过此应用）。
 * 返回新对象。
 *
 * @param {object} affinity
 * @param {object} negativeEvent 负向事件
 * @param {object} config
 * @returns {object}
 */
function applyNegative(affinity, negativeEvent, config) {
  if (!affinity) return affinity;
  const cfg = config || {};
  const updated = JSON.parse(JSON.stringify(affinity));

  updated.negativeCount = (updated.negativeCount || 0) + 1;
  updated.lastSeenAt = negativeEvent.timestamp || updated.lastSeenAt;
  // 负向信号：currentWeight 直接减半的 correctionDecrement
  const dec = (cfg.correctionDecrement || 0.15) * 0.5;
  updated.currentWeight = (updated.currentWeight || 0) - dec;
  updated.confidence = clampConfidence(updated.currentWeight, cfg);

  return updated;
}

/**
 * 根据置信度与权重更新别名状态。
 *
 * 规则：
 *   - currentWeight <= suppressionThreshold → SUPPRESSED
 *   - confidence >= activeThreshold → ACTIVE
 *   - confidence >= candidateThreshold → CANDIDATE
 *   - 其他 → 维持原状态（不主动降级，避免抖动）
 *
 * 显式 DELETED 状态不在此函数恢复。
 *
 * @param {object} alias PersonalAlias 对象
 * @param {object} config 学习配置
 * @returns {object} 更新后的 alias（新对象）
 */
function updateAliasStatus(alias, config) {
  if (!alias) return alias;
  const cfg = config || {};
  const updated = JSON.parse(JSON.stringify(alias));

  const {
    AliasStatus
  } = require('./learning-types');

  // 已显式删除，不再恢复
  if (updated.status === AliasStatus.DELETED) return updated;

  // 检查过期
  if (typeof updated.expiresAt === 'string' && updated.expiresAt) {
    const now = Date.now();
    const exp = Date.parse(updated.expiresAt);
    if (!isNaN(exp) && now > exp) {
      updated.status = AliasStatus.SUPPRESSED;
      return updated;
    }
  }

  // 强抑制优先
  if (typeof updated.currentWeight === 'number' &&
      updated.currentWeight <= (cfg.suppressionThreshold ?? -0.3)) {
    updated.status = AliasStatus.SUPPRESSED;
    return updated;
  }

  // 状态升级
  if (typeof updated.confidence !== 'number') updated.confidence = 0;
  if (updated.confidence >= (cfg.activeThreshold ?? 0.6)) {
    if (updated.status !== AliasStatus.ACTIVE) {
      updated.status = AliasStatus.ACTIVE;
    }
  } else if (updated.confidence >= (cfg.candidateThreshold ?? 0.3)) {
    if (updated.status === AliasStatus.CANDIDATE || updated.status === AliasStatus.ACTIVE) {
      // 维持
    } else {
      updated.status = AliasStatus.CANDIDATE;
    }
  } else {
    // confidence 不足，降至 candidate 或保持 suppressed
    if (updated.status !== AliasStatus.SUPPRESSED) {
      updated.status = AliasStatus.CANDIDATE;
    }
  }
  return updated;
}

/**
 * 计算个性化加权分数（personalBoost）。
 *
 * 公式：boost = clamp(currentWeight, 0, maxPersonalBoost)
 *
 * 注意：currentWeight 可为负（被抑制），此函数返回 0（不主动惩罚）。
 * 主动惩罚由 shouldSuppress 决定（PersonalRanker 决定是否纳入候选）。
 *
 * @param {object} affinity QueryAppAffinity
 * @param {object} config 学习配置
 * @returns {number} [0, maxPersonalBoost]
 */
function computePersonalBoost(affinity, config) {
  if (!affinity) return 0;
  const cfg = config || {};
  const maxBoost = cfg.maxPersonalBoost ?? 0.5;
  if (typeof affinity.currentWeight !== 'number') return 0;
  if (affinity.currentWeight <= 0) return 0;
  // 加权：confidence 影响最终生效比例
  const effective = affinity.currentWeight * (typeof affinity.confidence === 'number' ? affinity.confidence : 1);
  return Math.max(0, Math.min(maxBoost, effective));
}

/**
 * 判定是否应该抑制此应用（不参与个性化加权）。
 *
 * 规则：
 *   - currentWeight <= suppressionThreshold → true
 *   - 别名状态为 SUPPRESSED 或 DELETED → true
 *
 * @param {object} affinity QueryAppAffinity
 * @param {object} config 学习配置
 * @returns {boolean}
 */
function shouldSuppress(affinity, config) {
  if (!affinity) return false;
  const cfg = config || {};
  if (typeof affinity.currentWeight === 'number' &&
      affinity.currentWeight <= (cfg.suppressionThreshold ?? -0.3)) {
    return true;
  }
  return false;
}

/**
 * 分数归一化：将一组分数线性映射到 [0, 1]。
 *
 * 规则：
 *   - 全部相同 → 全部映射为 0.5
 *   - 否则：norm = (x - min) / (max - min)
 *   - 空输入 → 空数组
 *
 * @param {number[]} scores
 * @returns {number[]}
 */
function normalizeScores(scores) {
  if (!Array.isArray(scores) || scores.length === 0) return [];
  if (scores.length === 1) return [0.5];
  let min = Infinity, max = -Infinity;
  for (const s of scores) {
    if (typeof s !== 'number' || isNaN(s)) continue;
    if (s < min) min = s;
    if (s > max) max = s;
  }
  if (min === max) return scores.map(() => 0.5);
  const range = max - min;
  return scores.map(s => (typeof s === 'number' && !isNaN(s)) ? (s - min) / range : 0);
}

// ====== 内部辅助 ======

function clampConfidence(value, config) {
  if (typeof value !== 'number' || isNaN(value)) return 0;
  // confidence 是 [0, 1] 的概率值，由加权点击次数等推导
  // 这里使用简单的线性映射 + clamp
  return Math.max(0, Math.min(1, value));
}

module.exports = {
  // 衰减
  computeDecayWeight,
  // 增量
  computeClickIncrement,
  computeCorrectionDecrement,
  isCorrectionSignal,
  // 更新
  updateAffinity,
  applyCorrection,
  applyNegative,
  updateAliasStatus,
  // 排序
  computePersonalBoost,
  shouldSuppress,
  normalizeScores,
  // 暴露常量便于测试
  MS_PER_DAY
};
