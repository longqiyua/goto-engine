'use strict';

/**
 * GOTO Base Personal Learning — PersonalRanker 接口
 *
 * 把 Engine/Base 的候选项与 Personal Learning Overlay 的亲和度结合，
 * 产出最终带 personalScore / finalScore 的候选列表，供 HOST 决定是否重排。
 *
 * 关键规则：
 *   1. 精确匹配保护：若 exactMatchProtection=true，且查询精确命中某应用名（或别名），
 *      则此应用保最高优先级，不会被 personalBoost 反超
 *   2. personalBoost：基于 affinity.currentWeight * confidence 计算个人加权分数
 *   3. 应该抑制的候选（shouldSuppress=true）：personalBoost=0，且不参与个人加权
 *   4. 最大 personalBoost 不超过 maxPersonalBoost
 *
 * 纯函数：不读写 store，不修改入参；返回新数组。
 */

const { buildConfig } = require('./learning-types');
const {
  computePersonalBoost,
  shouldSuppress
} = require('./learning-algorithms');

/**
 * 主入口：对候选项应用个性化加权并产出最终排序。
 *
 * 输入：
 *   - query: 归一化后的查询字符串
 *   - engineResults: Engine 返回的候选项 [{packageName, score, name, ...}]
 *   - baseResults: Base 增强后的候选项 [{packageName, score, name, ...}]（可为空）
 *   - affinities: Map<packageName, QueryAppAffinity>（由调用方从 store 读出）
 *   - config: 学习配置（可选，缺省使用 DEFAULT_LEARNING_CONFIG）
 *
 * 输出：[{packageName, engineScore, baseScore, personalScore, finalScore, matchedBy, explanation}]
 *   按 finalScore 降序排列
 *
 * matchedBy 取值：
 *   - 'exact-match': 精确命中应用名/别名
 *   - 'personal-boost': 个性化加权
 *   - 'engine-only': 仅 Engine 命中
 *   - 'base-only': 仅 Base 命中
 *   - 'manual-launch': 手动启动候选
 *
 * @param {string} query 归一化查询
 * @param {Array} engineResults Engine 候选
 * @param {Array} [baseResults] Base 候选
 * @param {Map<string, object>} [affinities] packageName → affinity
 * @param {object} [config] 学习配置
 * @returns {Array}
 */
function rankCandidates(query, engineResults, baseResults, affinities, config) {
  const cfg = buildConfig(config || {});
  const affMap = affinities instanceof Map ? affinities : new Map(Object.entries(affinities || {}));

  // 合并候选：以 packageName 为 key，保留 engine/base 分数
  const merged = new Map();
  if (Array.isArray(engineResults)) {
    for (const r of engineResults) {
      if (!r || !r.packageName) continue;
      const cur = merged.get(r.packageName) || {
        packageName: r.packageName,
        name: r.name || r.label || r.packageName,
        engineScore: 0,
        baseScore: 0,
        original: r
      };
      cur.engineScore = typeof r.score === 'number' ? r.score : 0;
      merged.set(r.packageName, cur);
    }
  }
  if (Array.isArray(baseResults)) {
    for (const r of baseResults) {
      if (!r || !r.packageName) continue;
      const cur = merged.get(r.packageName) || {
        packageName: r.packageName,
        name: r.name || r.label || r.packageName,
        engineScore: 0,
        baseScore: 0,
        original: r
      };
      cur.baseScore = typeof r.score === 'number' ? r.score : 0;
      // 若 base 提供了 name，覆盖（base 数据更权威）
      if (r.name) cur.name = r.name;
      merged.set(r.packageName, cur);
    }
  }

  // 步骤 1: 精确匹配保护
  const exactMatchedPackages = cfg.exactMatchProtection
    ? findExactMatchPackages(query, merged, cfg)
    : new Set();

  // 步骤 2: 计算 personalBoost
  const candidates = [];
  for (const c of merged.values()) {
    const aff = affMap.get(c.packageName);
    let personalScore = 0;
    const explanation = [];
    if (aff && !shouldSuppress(aff, cfg)) {
      personalScore = computePersonalBoost(aff, cfg);
      if (personalScore > 0) {
        explanation.push(`personal-boost=${personalScore.toFixed(4)} (weight=${(aff.currentWeight || 0).toFixed(4)}, conf=${(aff.confidence || 0).toFixed(4)})`);
      }
    } else if (aff && shouldSuppress(aff, cfg)) {
      explanation.push(`suppressed (weight=${(aff.currentWeight || 0).toFixed(4)} <= ${cfg.suppressionThreshold})`);
    }

    candidates.push({
      packageName: c.packageName,
      name: c.name,
      engineScore: round4(c.engineScore),
      baseScore: round4(c.baseScore),
      personalScore: round4(personalScore),
      // finalScore = max(engineScore, baseScore) + personalBoost
      // 若有精确匹配保护，则精确匹配项不参与 personalBoost 比较
      finalScore: round4(Math.max(c.engineScore, c.baseScore) + personalScore),
      matchedBy: classifyMatch(c, exactMatchedPackages, personalScore),
      explanation: explanation.join('; ')
    });
  }

  // 步骤 3: 应用精确匹配保护
  const protected_ = applyExactMatchProtection(candidates, query, cfg);

  // 步骤 4: 限制 personalBoost 总量（防止一批候选都顶满）
  const limited = limitPersonalBoost(protected_, cfg);

  // 步骤 5: 排序
  limited.sort((a, b) => {
    // 精确匹配优先
    if (a.matchedBy === 'exact-match' && b.matchedBy !== 'exact-match') return -1;
    if (b.matchedBy === 'exact-match' && a.matchedBy !== 'exact-match') return 1;
    // 否则按 finalScore 降序
    return (b.finalScore || 0) - (a.finalScore || 0);
  });

  return limited;
}

/**
 * 应用个性化加权：对每个候选，将 personalBoost 加到 finalScore 上。
 * 已在 rankCandidates 内联实现，此函数对外暴露便于单独调用。
 *
 * @param {Array} candidates [{packageName, finalScore, ...}]
 * @param {Map<string, object>} affinities
 * @param {object} config
 * @returns {Array} 新数组，每项加 personalScore
 */
function applyPersonalBoost(candidates, affinities, config) {
  const cfg = buildConfig(config || {});
  const affMap = affinities instanceof Map ? affinities : new Map(Object.entries(affinities || {}));
  if (!Array.isArray(candidates)) return [];
  return candidates.map(c => {
    const aff = affMap.get(c.packageName);
    let personalScore = 0;
    if (aff && !shouldSuppress(aff, cfg)) {
      personalScore = computePersonalBoost(aff, cfg);
    }
    return Object.assign({}, c, {
      personalScore: round4(personalScore),
      finalScore: round4((c.finalScore || c.engineScore || 0) + personalScore)
    });
  });
}

/**
 * 精确匹配保护：若某候选精确匹配查询，强制将其排在第一位，并标记 matchedBy='exact-match'。
 * 注意：仅修改排序与 matchedBy 标记，不修改 finalScore 字段。
 *
 * @param {Array} candidates
 * @param {string} query
 * @param {object} config
 * @returns {Array} 重排后的新数组
 */
function applyExactMatchProtection(candidates, query, config) {
  const cfg = buildConfig(config || {});
  if (!cfg.exactMatchProtection) return candidates.slice();
  if (!query || !Array.isArray(candidates)) return candidates.slice();

  const qLower = String(query).toLowerCase().trim();
  if (!qLower) return candidates.slice();

  // 找出精确匹配的候选
  const exactMatchIndices = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c && c.name && String(c.name).toLowerCase().trim() === qLower) {
      exactMatchIndices.push(i);
    }
  }

  if (exactMatchIndices.length === 0) return candidates.slice();

  // 取 finalScore 最高的精确匹配项的索引
  exactMatchIndices.sort((a, b) => {
    const sa = candidates[a].finalScore || 0;
    const sb = candidates[b].finalScore || 0;
    return sb - sa;
  });
  const topIdx = exactMatchIndices[0];

  // 构造新数组：先放 markedTop，再放其他
  const markedTop = Object.assign({}, candidates[topIdx], { matchedBy: 'exact-match' });
  const result = [markedTop];
  for (let i = 0; i < candidates.length; i++) {
    if (i === topIdx) continue;
    result.push(candidates[i]);
  }
  return result;
}

/**
 * 限制 personalBoost 总量，防止一组候选都顶满 maxPersonalBoost。
 * 简单策略：按 personalScore 降序排序，若总和超过 N * maxPersonalBoost，按比例缩放。
 *
 * @param {Array} candidates
 * @param {object} config
 * @returns {Array} 新数组（已缩放）
 */
function limitPersonalBoost(candidates, config) {
  const cfg = buildConfig(config || {});
  const maxBoost = cfg.maxPersonalBoost ?? 0.5;
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  // 找出所有有 personalScore 的候选
  let total = 0;
  const idx = [];
  for (let i = 0; i < candidates.length; i++) {
    const ps = candidates[i].personalScore || 0;
    if (ps > 0) {
      total += ps;
      idx.push(i);
    }
  }
  if (total === 0) return candidates.slice();

  // 每个候选上限为 maxBoost；若超出，按比例缩放
  const cap = idx.length * maxBoost;
  if (total <= cap) return candidates.slice();

  const scale = cap / total;
  return candidates.map((c, i) => {
    if (!idx.includes(i)) return c;
    const newPs = Math.min(maxBoost, (c.personalScore || 0) * scale);
    const diff = newPs - (c.personalScore || 0);
    return Object.assign({}, c, {
      personalScore: round4(newPs),
      finalScore: round4((c.finalScore || 0) + diff)
    });
  });
}

// ====== 内部辅助 ======

function findExactMatchPackages(query, merged, config) {
  const set = new Set();
  if (!query) return set;
  const qLower = String(query).toLowerCase().trim();
  if (!qLower) return set;
  for (const c of merged.values()) {
    if (c.name && String(c.name).toLowerCase().trim() === qLower) {
      set.add(c.packageName);
    }
  }
  return set;
}

function classifyMatch(c, exactMatchedPackages, personalScore) {
  if (exactMatchedPackages.has(c.packageName)) return 'exact-match';
  if (personalScore > 0) return 'personal-boost';
  if (c.engineScore > 0 && c.baseScore > 0) return 'engine-and-base';
  if (c.baseScore > 0) return 'base-only';
  if (c.engineScore > 0) return 'engine-only';
  return 'unknown';
}

function round4(v) {
  if (typeof v !== 'number' || isNaN(v)) return 0;
  return Math.round(v * 10000) / 10000;
}

module.exports = {
  rankCandidates,
  applyPersonalBoost,
  applyExactMatchProtection,
  limitPersonalBoost
};
