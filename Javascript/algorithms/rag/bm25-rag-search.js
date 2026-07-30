/*!
 * BM25 RAG Search — 基于 documentText 的自动语义检索
 * v1.0.0 · MIT
 *
 * 原理：对 RAG vectors 的 documentText 建倒排索引，查询时用 BM25 算法
 *       自动计算相似度，无需手写意图规则，无需神经网络模型。
 *
 * 分词策略：
 *   - 中文：unigram（单字）+ bigram（双字组合），兼顾精确与模糊
 *   - 英文：小写化按词
 *   - 数字：按串
 *
 * BM25 参数：
 *   - k1 = 1.5（词频饱和）
 *   - b = 0.75（文档长度归一化）
 *
 * API：
 *   var bm25 = new BM25RagSearch();
 *   bm25.build(vectors);              // vectors: [{packageName, documentText, ...}]
 *   var results = bm25.search('公园', 10);  // 返回 [{id, score}]
 */
(function (root, factory) {
  var mod = factory(root || {});
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.BM25RagSearch = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  /**
   * 分词：中文 unigram+bigram，英文按词小写，数字按串
   * @param {string} text
   * @returns {string[]}
   */
  function tokenize(text) {
    if (!text) return [];
    var tokens = [];
    // 英文词（小写化）
    var enMatches = text.toLowerCase().match(/[a-z]+/g) || [];
    for (var i = 0; i < enMatches.length; i++) tokens.push(enMatches[i]);
    // 数字串
    var numMatches = text.match(/[0-9]+/g) || [];
    for (var i = 0; i < numMatches.length; i++) tokens.push(numMatches[i]);
    // 中文字符序列
    var cnChars = text.match(/[\u4e00-\u9fa5]/g) || [];
    // unigram：每个中文字
    for (var i = 0; i < cnChars.length; i++) tokens.push(cnChars[i]);
    // bigram：相邻两字组合（捕获"公园""导航"等词级语义）
    for (var i = 0; i < cnChars.length - 1; i++) {
      tokens.push(cnChars[i] + cnChars[i + 1]);
    }
    return tokens;
  }

  /**
   * BM25 倒排索引
   * @param {number} [k1=1.5] 词频饱和参数
   * @param {number} [b=0.75] 文档长度归一化参数
   */
  function BM25RagSearch(k1, b) {
    this._k1 = k1 || 1.5;
    this._b = b || 0.75;
    this._docs = [];           // [{id, text, tokens, len}]
    this._inverted = {};       // token -> {df, postings: Map(docIdx->tf)}
    this._avgdl = 0;           // 平均文档长度
    this._N = 0;               // 文档总数
    this._built = false;
  }

  BM25RagSearch.prototype = {
    /**
     * 构建 BM25 索引
     * @param {Array} vectors RAG vectors，每项含 packageName + documentText
     */
    build: function (vectors) {
      var self = this;
      this._docs = [];
      this._inverted = {};
      this._avgdl = 0;
      this._N = 0;

      if (!vectors || !vectors.length) {
        this._built = false;
        return;
      }

      var totalLen = 0;
      var docFreqMap = {};  // token -> Set(docIdx)

      for (var i = 0; i < vectors.length; i++) {
        var v = vectors[i];
        var id = v.packageName || v.id || ('doc_' + i);
        var text = v.documentText || '';
        var tokens = tokenize(text);
        var tfMap = {};
        for (var j = 0; j < tokens.length; j++) {
          var t = tokens[j];
          tfMap[t] = (tfMap[t] || 0) + 1;
          if (!docFreqMap[t]) docFreqMap[t] = {};
          docFreqMap[t][i] = true;
        }
        this._docs.push({ id: id, text: text, tokens: tokens, len: tokens.length, tf: tfMap });
        totalLen += tokens.length;
      }

      this._N = this._docs.length;
      this._avgdl = this._N > 0 ? totalLen / this._N : 0;

      // 构建倒排索引
      for (var token in docFreqMap) {
        var docs = docFreqMap[token];
        var df = 0;
        var postings = [];
        for (var docIdx in docs) {
          df++;
          var di = parseInt(docIdx, 10);
          postings.push({ idx: di, tf: this._docs[di].tf[token] || 0 });
        }
        this._inverted[token] = { df: df, postings: postings };
      }

      this._built = true;
    },

    /**
     * BM25 检索
     * @param {string} query 查询文本
     * @param {number} [topK=10] 返回数量
     * @returns {Array<{id:string, score:number}>} 按分数降序
     */
    search: function (query, topK) {
      if (!this._built || !query) return [];
      var qTokens = tokenize(query);
      if (!qTokens.length) return [];

      var scores = {};  // docIdx -> score
      var k1 = this._k1;
      var b = this._b;
      var N = this._N;
      var avgdl = this._avgdl || 1;

      // 去重查询 token（同一 token 只算一次）
      var seen = {};
      for (var qi = 0; qi < qTokens.length; qi++) {
        var t = qTokens[qi];
        if (seen[t]) continue;
        seen[t] = true;

        var entry = this._inverted[t];
        if (!entry) continue;

        var df = entry.df;
        // IDF（BM25 变体，保证非负）
        var idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        if (idf <= 0) continue;

        var postings = entry.postings;
        for (var pi = 0; pi < postings.length; pi++) {
          var p = postings[pi];
          var doc = this._docs[p.idx];
          var tf = p.tf;
          var dl = doc.len;
          // BM25 分数
          var denom = tf + k1 * (1 - b + b * dl / avgdl);
          var s = idf * (tf * (k1 + 1)) / denom;
          scores[p.idx] = (scores[p.idx] || 0) + s;
        }
      }

      // 排序取 topK
      var arr = [];
      for (var idx in scores) {
        arr.push({ id: this._docs[parseInt(idx, 10)].id, score: scores[idx] });
      }
      arr.sort(function (a, b) { return b.score - a.score; });
      return arr.slice(0, topK || 10);
    },

    isBuilt: function () { return this._built; },
    size: function () { return this._N; }
  };

  BM25RagSearch.tokenize = tokenize;
  BM25RagSearch.version = '1.0.0';
  return BM25RagSearch;
});
