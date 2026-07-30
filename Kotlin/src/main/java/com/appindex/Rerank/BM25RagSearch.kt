package com.appindex.Rerank

import kotlin.math.ln

/**
 * BM25 RAG Search — 基于 documentText 的自动语义检索
 *
 * 与 JS 版 `algorithms/rag/bm25-rag-search.js` 对齐（v1.0.0，三语言同步）。
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
 * 使用：
 *   val bm25 = BM25RagSearch()
 *   bm25.build(listOf("com.app" to "公园导航"))
 *   val results = bm25.search("公园", 10)  // 返回 [(id, score), ...]
 */
class BM25RagSearch(
    private val k1: Double = 1.5,
    private val b: Double = 0.75
) {
    /** 文档条目：id、原文、分词、长度、词频表 */
    private data class DocEntry(
        val id: String,
        val text: String,
        val tokens: List<String>,
        val len: Int,
        val tf: Map<String, Int>
    )

    /** 倒排索引条目：df + postings（docIdx → tf） */
    private data class InvertedEntry(
        val df: Int,
        val postings: List<Pair<Int, Int>>
    )

    private var docs: List<DocEntry> = emptyList()
    private var inverted: Map<String, InvertedEntry> = emptyMap()
    private var avgdl: Double = 0.0
    private var n: Int = 0
    private var built: Boolean = false

    /**
     * 构建 BM25 索引
     *
     * @param vectors 每项为 (id, documentText) — 调用方负责从 RagVectorEntry 转换
     */
    fun build(vectors: List<Pair<String, String>>) {
        this.docs = emptyList()
        this.inverted = emptyMap()
        this.avgdl = 0.0
        this.n = 0
        this.built = false

        if (vectors.isEmpty()) return

        val docsList = ArrayList<DocEntry>(vectors.size)
        // token -> 出现该 token 的 docIdx 集合
        val docFreqMap = LinkedHashMap<String, MutableSet<Int>>()
        var totalLen = 0

        for ((i, v) in vectors.withIndex()) {
            val id = v.first.ifEmpty { "doc_$i" }
            val text = v.second
            val tokens = tokenize(text)
            val tfMap = HashMap<String, Int>()
            for (t in tokens) {
                tfMap[t] = (tfMap[t] ?: 0) + 1
                docFreqMap.getOrPut(t) { LinkedHashSet() }.add(i)
            }
            docsList.add(
                DocEntry(
                    id = id,
                    text = text,
                    tokens = tokens,
                    len = tokens.size,
                    tf = tfMap
                )
            )
            totalLen += tokens.size
        }

        this.docs = docsList
        this.n = docsList.size
        this.avgdl = if (this.n > 0) totalLen.toDouble() / this.n else 0.0

        // 构建倒排索引
        val inv = HashMap<String, InvertedEntry>(docFreqMap.size)
        for ((token, idxSet) in docFreqMap) {
            val postings = ArrayList<Pair<Int, Int>>(idxSet.size)
            for (docIdx in idxSet) {
                val tf = docsList[docIdx].tf[token] ?: 0
                postings.add(docIdx to tf)
            }
            inv[token] = InvertedEntry(df = idxSet.size, postings = postings)
        }
        this.inverted = inv
        this.built = true
    }

    /**
     * BM25 检索
     *
     * @param query 查询文本
     * @param topK 返回数量（默认 10）
     * @return 按 score 降序的 (id, score) 列表；同分按 docIdx 升序（与 JS 对齐）
     */
    fun search(query: String, topK: Int = 10): List<Pair<String, Double>> {
        if (!built || query.isEmpty()) return emptyList()
        val qTokens = tokenize(query)
        if (qTokens.isEmpty()) return emptyList()

        val scores = HashMap<Int, Double>()
        val avgdlSafe = if (avgdl > 0) avgdl else 1.0

        // 去重查询 token（同一 token 只算一次）
        val seen = HashSet<String>()
        for (t in qTokens) {
            if (!seen.add(t)) continue
            val entry = inverted[t] ?: continue
            val df = entry.df
            // IDF（BM25 变体，保证非负）
            val idf = ln(1.0 + (n - df + 0.5) / (df + 0.5))
            if (idf <= 0.0) continue

            for ((docIdx, tf) in entry.postings) {
                val doc = docs[docIdx]
                val dl = doc.len.toDouble()
                // BM25 分数 = IDF * (tf * (k1+1)) / (tf + k1*(1-b+b*dl/avgdl))
                val denom = tf + k1 * (1.0 - b + b * dl / avgdlSafe)
                val s = idf * (tf * (k1 + 1.0)) / denom
                scores[docIdx] = (scores[docIdx] ?: 0.0) + s
            }
        }

        // 排序：score 降序，docIdx 升序（与 JS for...in 整数键升序 + 稳定排序对齐）
        val arr = ArrayList<Pair<Int, Double>>(scores.size)
        for ((idx, sc) in scores) {
            arr.add(idx to sc)
        }
        arr.sortWith(compareByDescending<Pair<Int, Double>> { it.second }.thenBy { it.first })
        return arr.take(topK).map { docs[it.first].id to it.second }
    }

    /** 索引是否已构建 */
    fun isBuilt(): Boolean = built

    /** 文档总数 */
    fun size(): Int = n

    companion object {
        /** 版本号（与 JS `BM25RagSearch.version` 对齐） */
        const val VERSION = "1.0.0"

        // 预编译正则（与 JS 分词策略一致）
        private val EN_REGEX = Regex("[a-z]+")
        private val NUM_REGEX = Regex("[0-9]+")
        private val CN_REGEX = Regex("[\u4e00-\u9fa5]")

        /**
         * 分词：中文 unigram+bigram，英文按词小写，数字按串
         *
         * 与 JS `tokenize` / Rust `bm25_rag::tokenize` 行为一致。
         */
        fun tokenize(text: String): List<String> {
            if (text.isEmpty()) return emptyList()
            val tokens = ArrayList<String>()
            // 英文词（小写化）
            EN_REGEX.findAll(text.lowercase()).forEach { tokens.add(it.value) }
            // 数字串
            NUM_REGEX.findAll(text).forEach { tokens.add(it.value) }
            // 中文字符序列
            val cnChars = CN_REGEX.findAll(text).map { it.value }.toList()
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
