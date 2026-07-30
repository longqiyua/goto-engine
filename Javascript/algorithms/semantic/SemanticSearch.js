'use strict';

/**
 * GOTO Base — 语义向量检索（JS 版）
 *
 * MVP 实现：纯 JS 线性扫描 cosine 相似度。
 * 生产环境可替换为 hnswlib-wasm（同接口）。
 *
 * 不依赖任何 npm 包，保证零安装即可运行。
 */

class SemanticSearch {
  constructor() {
    this._vectors = new Map();   // id -> Float64Array
    this._meta = null;           // { model, dim, count, ... }
    this._loaded = false;
  }

  /**
   * 从 vector-store.json 加载向量（新格式，由 build-rag-from-seeds.js 生成）。
   * 兼容旧格式 vectors.json（meta.dim + id/embedding）。
   * @param {object} vectorsJson
   *   新格式字段：version / embeddingModel / dimension / vectors[]
   *     vectors[i] = { packageName, appName, primaryCategory, documentText, vector[] }
   */
  load(vectorsJson) {
    if (!vectorsJson || !Array.isArray(vectorsJson.vectors)) {
      throw new Error('GOTO Base: vectorsJson 格式无效');
    }
    // 新格式：embeddingModel/dimension；兼容旧格式：meta.model/meta.dim
    this._meta = vectorsJson.meta || {
      model: vectorsJson.embeddingModel || 'bge-small-zh-v1.5',
      dim: vectorsJson.dimension || 0
    };
    const dim = this._meta.dim || 0;
    this._vectors.clear();

    for (const item of vectorsJson.vectors) {
      // 新格式：packageName/vector；兼容旧格式：id/embedding
      const id = item.packageName || item.id;
      const emb = item.vector || item.embedding;
      if (!id || !Array.isArray(emb)) continue;
      if (dim && emb.length !== dim) {
        console.warn('GOTO Base: 向量维度不匹配，跳过', id);
        continue;
      }
      this._vectors.set(id, this._normalize(emb));
    }

    this._loaded = true;
  }

  /**
   * L2 归一化（cosine 相似度要求向量等长）。
   */
  _normalize(vec) {
    const arr = vec instanceof Float64Array ? vec : Float64Array.from(vec);
    let norm = 0;
    for (let i = 0; i < arr.length; i++) norm += arr[i] * arr[i];
    norm = Math.sqrt(norm);
    if (norm === 0) return arr;
    const out = new Float64Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = arr[i] / norm;
    return out;
  }

  /**
   * 用一个查询向量检索 top-K 最近邻。
   * @param {number[]} queryVec 查询向量
   * @param {number} k 返回数量
   * @returns {Array<{id: string, score: number}>} 按相似度降序
   */
  searchByVector(queryVec, k) {
    if (!this._loaded) return [];
    const q = this._normalize(queryVec);
    const results = [];
    for (const [id, vec] of this._vectors) {
      const score = this._cosine(q, vec);
      results.push({ id, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k || 10);
  }

  /**
   * 用文本查询检索（MVP：用查询向量模拟；生产环境接 embedding 模型）。
   * MVP 阶段 query 直接当作向量字符串解析或用 mock 映射；
   * 真实场景由调用方先调用 embedding 模型生成向量，再传给 searchByVector。
   *
   * @param {string} query 查询文本
   * @param {number} k 返回数量
   * @param {object} [queryVector] 预计算的查询向量（若有则直接用）
   */
  search(query, k, queryVector) {
    if (queryVector && Array.isArray(queryVector)) {
      return this.searchByVector(queryVector, k);
    }
    // MVP：无 embedding 模型时返回空（避免错误匹配）
    // 生产环境应在此调用 transformers.js 生成 query 向量
    return [];
  }

  _cosine(a, b) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    // 已归一化，dot 即 cosine
    return dot;
  }

  /** 已加载向量数。 */
  size() {
    return this._vectors.size;
  }

  /** 是否已加载。 */
  isLoaded() {
    return this._loaded;
  }

  /** 元信息。 */
  meta() {
    return this._meta;
  }
}

module.exports = SemanticSearch;
