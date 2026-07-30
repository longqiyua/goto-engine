'use strict';

/**
 * GOTO Base — Boost 分数计算（JS 版）
 *
 * 纯函数模块：输入 query + Engine 候选项，输出带 boostScore 的候选项。
 * 不修改 Engine，不重排 Engine 结果顺序（仅添加分数字段，由 HOST 决定是否重排）。
 *
 * Boost 来源：
 * 1. 语义相似度（来自 SemanticSearch）
 * 2. 同义词簇命中（来自 clusters.json）
 * 3. 意图映射命中（来自 intent-map.json）
 * 4. 应用流行度（popularity）
 *
 * 最终 boostScore ∈ [0, 0.3]，防止语义盖过 Engine 关键词匹配。
 */

class BoostCalculator {
  constructor(options) {
    options = options || {};
    this.synonymClusters = options.synonymClusters || [];  // SynonymCluster[]
    this.intentMappings = options.intentMappings || [];    // IntentMapping[]
    this.maxBoost = options.maxBoost || 0.3;
  }

  /**
   * 为 Engine 候选项计算 boost 分数。
   *
   * @param {string} query 用户查询
   * @param {Array} items Engine 返回的候选项（每个含 id/name/packageName 等字段）
   * @param {Array<{id, score}>} semanticHits SemanticSearch 的 top-K 结果
   * @returns {Array} 原候选项数组（顺序不变），每项新增：
   *   - boostScore: number  [0, 0.3]
   *   - semanticScore: number  [0, 1]
   *   - synonymHit: boolean
   *   - intentHit: boolean
   *   - finalScore: number  (原 score + boostScore，若原 score 存在)
   */
  computeBoost(query, items, semanticHits) {
    if (!items || items.length === 0) return [];

    const q = String(query || '').toLowerCase().trim();
    const semanticMap = new Map();
    if (Array.isArray(semanticHits)) {
      for (const h of semanticHits) {
        if (h && h.id) semanticMap.set(h.id, h.score || 0);
      }
    }

    const synonymHits = this._matchSynonyms(q);
    const intentHits = this._matchIntents(q);

    return items.map(item => {
      const id = item.packageName || item.id || item.name;
      const semanticScore = semanticMap.get(id) || 0;
      const synHit = synonymHits.has(id);
      const intentHit = intentHits.has(id);

      // 各分量加权
      let boost = 0;
      boost += semanticScore * 0.15;           // 语义相似度（上限 0.15）
      boost += synHit ? 0.05 : 0;              // 同义词命中（+0.05）
      boost += intentHit ? 0.10 : 0;           // 意图命中（+0.10，最强信号）

      // 流行度微调（±0.02）
      const popularity = Number(item.popularity || 0.5);
      boost += (popularity - 0.5) * 0.04;

      // 限幅
      boost = Math.max(0, Math.min(this.maxBoost, boost));

      const origScore = typeof item.score === 'number' ? item.score : 0;
      return Object.assign({}, item, {
        boostScore: Number(boost.toFixed(4)),
        semanticScore: Number(semanticScore.toFixed(4)),
        synonymHit: synHit,
        intentHit: intentHit,
        finalScore: Number((origScore + boost).toFixed(4))
      });
    });
  }

  /**
   * 匹配同义词簇，返回命中的应用包名集合（MVP：用 intentMapping 的 preferredApps 近似）。
   */
  _matchSynonyms(query) {
    const hits = new Set();
    for (const cluster of this.synonymClusters) {
      if (!cluster.members || !cluster.intentCategory) continue;
      const matched = cluster.members.some(m =>
        query.includes(String(m).toLowerCase()) || String(m).toLowerCase().includes(query)
      );
      if (matched) {
        // 同义词簇本身不直接绑定应用，需通过 intentMap 找 preferredApps
        for (const intent of this.intentMappings) {
          if (intent.intentCategory === cluster.intentCategory && Array.isArray(intent.preferredApps)) {
            intent.preferredApps.forEach(p => hits.add(p));
          }
        }
      }
    }
    return hits;
  }

  /**
   * 匹配意图映射，返回命中的应用包名集合。
   */
  _matchIntents(query) {
    const hits = new Set();
    for (const intent of this.intentMappings) {
      if (!intent.keywords || !intent.preferredApps) continue;
      const matched = intent.keywords.some(k =>
        query.includes(String(k).toLowerCase()) || String(k).toLowerCase().includes(query)
      );
      if (matched) {
        intent.preferredApps.forEach(p => hits.add(p));
      }
    }
    return hits;
  }
}

module.exports = BoostCalculator;
