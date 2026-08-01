package com.appindex.Rerank

import kotlin.math.ln

/**
 * BM25 RAG 检索 — 基于 documentText 的自动语义检索（Kotlin 版）
 *
 * 对应 JS 版 `bm25-rag-search.js`。
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
 * @param k1 词频饱和参数，默认 1.5
 * @param b 文档长度归一化参数，默认 0.75
 */
class BM25RagSearch(
    private val k1: Double = 1.5,
    private val b: Double = 0.75
) {

    /** 文档记录：id / 原文 / 分词 / 长度 / 词频表 */
    private data class Doc(
        val id: String,
        val text: String,
        val len: Int,
        val tf: Map<String, Int>
    )

    /** 倒排表条目：文档索引 + 词频 */
    private data class Posting(val idx: Int, val tf: Int)

    /** 倒排表项：token -> {df, postings} */
    private data class InvertedEntry(
        val df: Int,
        val postings: List<Posting>
    )

    private var docs: List<Doc> = emptyList()
    private val inverted: MutableMap<String, InvertedEntry> = mutableMapOf()
    private var avgdl: Double = 0.0
    private var n: Int = 0
    private var built: Boolean = false

    /**
     * 构建 BM25 索引。
     * @param vectors (id, documentText) 列表
     */
    fun build(vectors: List<Pair<String, String>>) {
        docs = emptyList()
        inverted.clear()
        avgdl = 0.0
        n = 0

        if (vectors.isEmpty()) {
            built = false
            return
        }

        val newDocs = ArrayList<Doc>(vectors.size)
        // token -> 出现该 token 的文档索引集合（用于计算 df）
        val docFreqMap: MutableMap<String, MutableSet<Int>> = mutableMapOf()
        var totalLen = 0

        for ((i, item) in vectors.withIndex()) {
            val id = item.first.ifEmpty { "doc_$i" }
            val text = item.second
            val tokens = tokenize(text)
            val tfMap: MutableMap<String, Int> = mutableMapOf()
            for (t in tokens) {
                tfMap[t] = (tfMap[t] ?: 0) + 1
                docFreqMap.getOrPut(t) { mutableSetOf() }.add(i)
            }
            newDocs.add(Doc(id, text, tokens.size, tfMap))
            totalLen += tokens.size
        }

        docs = newDocs
        n = docs.size
        avgdl = if (n > 0) totalLen.toDouble() / n else 0.0

        // 构建倒排索引
        for ((token, idxSet) in docFreqMap) {
            val postings = idxSet.map { idx -> Posting(idx, docs[idx].tf[token] ?: 0) }
            inverted[token] = InvertedEntry(idxSet.size, postings)
        }

        built = true
    }

    /**
     * BM25 检索。
     * @param query 查询文本
     * @param topK 返回数量，默认 10
     * @return (id, score) 按分数降序
     */
    fun search(query: String, topK: Int = 10): List<Pair<String, Double>> {
        if (!built || query.isEmpty()) return emptyList()
        val qTokens = tokenize(query)
        if (qTokens.isEmpty()) return emptyList()

        val scores: MutableMap<Int, Double> = mutableMapOf()
        val avgdlOrOne = if (avgdl > 0) avgdl else 1.0
        val seen = HashSet<String>()

        // 去重查询 token（同一 token 只算一次）
        for (t in qTokens) {
            if (!seen.add(t)) continue
            val entry = inverted[t] ?: continue
            val df = entry.df
            // IDF（BM25 变体，保证非负）
            val idf = ln(1.0 + (n - df + 0.5) / (df + 0.5))
            if (idf <= 0.0) continue

            for (p in entry.postings) {
                val doc = docs[p.idx]
                val tf = p.tf
                val dl = doc.len
                // BM25 分数
                val denom = tf + k1 * (1 - b + b * dl / avgdlOrOne)
                val s = idf * (tf * (k1 + 1)) / denom
                scores[p.idx] = (scores[p.idx] ?: 0.0) + s
            }
        }

        // 排序取 topK（分数降序）
        return scores.entries
            .sortedByDescending { it.value }
            .take(topK)
            .map { e -> docs[e.key].id to e.value }
    }

    /** 是否已构建索引。 */
    fun isBuilt(): Boolean = built

    /** 已索引文档总数。 */
    fun size(): Int = n

    companion object {
        /** 版本号，与 JS 版对齐。 */
        const val VERSION = "1.0.0"

        /**
         * 分词：中文 unigram + bigram，英文按词小写，数字按串。
         * 对应 JS 版 tokenize()。
         */
        fun tokenize(text: String): List<String> {
            if (text.isEmpty()) return emptyList()
            val tokens = ArrayList<String>()

            // 英文词（小写化）
            val lower = text.lowercase()
            Regex("[a-z]+").findAll(lower).forEach { tokens.add(it.value) }

            // 数字串
            Regex("[0-9]+").findAll(text).forEach { tokens.add(it.value) }

            // 中文字符序列（CJK 统一表意文字）
            val cnChars = Regex("[\u4e00-\u9fa5]").findAll(text).map { it.value }.toList()
            // unigram：每个中文字
            for (c in cnChars) tokens.add(c)
            // bigram：相邻两字组合（捕获"公园""导航"等词级语义）
            for (i in 0 until cnChars.size - 1) {
                tokens.add(cnChars[i] + cnChars[i + 1])
            }

            return tokens
        }
    }
}
