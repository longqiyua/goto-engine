package com.appindex.Rerank

import kotlin.math.sqrt

/**
 * 语义向量检索（Kotlin 版）— 对应 JS 版 `SemanticSearch.js`。
 *
 * MVP 实现：纯 Kotlin 线性扫描 cosine 相似度（向量已 L2 归一化，等价于点积）。
 * 生产环境可替换为 HNSW 库（如 JAHMS 或 JNI 桥接 hnswlib）。
 */
class SemanticSearch {

    /** id -> 归一化后的向量 */
    private val vectors: MutableMap<String, FloatArray> = mutableMapOf()
    private var loaded: Boolean = false

    /**
     * 从解析后的 vectors.json 加载向量。
     *
     * 接受的 Map 结构（与 embedding-index.schema.json 对齐）：
     *   - "vectors": List<Map<String, Any>>，每项含 id（或 packageName）/ embedding（或 vector）
     *   - "meta": Map（可选，含 model / dim）
     *
     * @param vectorsJson 解析后的 JSON Map
     */
    fun load(vectorsJson: Map<String, Any>) {
        @Suppress("UNCHECKED_CAST")
        val list = vectorsJson["vectors"] as? List<Map<String, Any>> ?: emptyList()
        vectors.clear()
        for (item in list) {
            // 优先 id，兼容 packageName
            val id = (item["id"] as? String) ?: (item["packageName"] as? String) ?: continue
            if (id.isEmpty()) continue
            // 优先 embedding，兼容 vector
            val emb = (item["embedding"] as? List<*>) ?: (item["vector"] as? List<*>) ?: continue
            val vec = FloatArray(emb.size) { i ->
                (emb[i] as? Number)?.toFloat() ?: 0f
            }
            vectors[id] = normalize(vec)
        }
        loaded = true
    }

    /**
     * 用查询向量检索 top-K 最近邻。
     * @param queryVec 查询向量
     * @param k 返回数量，默认 10
     * @return (id, cosine相似度) 按相似度降序
     */
    fun searchByVector(queryVec: FloatArray, k: Int = 10): List<Pair<String, Double>> {
        if (!loaded) return emptyList()
        val q = normalize(queryVec)
        val results = vectors.map { (id, v) -> id to cosine(q, v) }
        return results.sortedByDescending { it.second }.take(k)
    }

    /**
     * 用文本查询检索（MVP：需调用方提供 queryVector）。
     * @param query 查询文本
     * @param k 返回数量，默认 10
     * @param queryVector 预计算的查询向量（若有则直接走 [searchByVector]）
     * @return (id, cosine相似度) 按相似度降序
     */
    fun search(query: String, k: Int = 10, queryVector: FloatArray? = null): List<Pair<String, Double>> {
        if (queryVector != null) return searchByVector(queryVector, k)
        // MVP：无嵌入器时返回空（向量库已就绪，但端侧嵌入器尚未接入）
        return emptyList()
    }

    /** L2 归一化（cosine 相似度要求向量等长）。 */
    private fun normalize(vec: FloatArray): FloatArray {
        var norm = 0.0
        for (v in vec) norm += v.toDouble() * v.toDouble()
        norm = sqrt(norm)
        if (norm == 0.0) return vec
        return FloatArray(vec.size) { vec[it] / norm.toFloat() }
    }

    /** 已归一化向量的 cosine 相似度等价于点积。 */
    private fun cosine(a: FloatArray, b: FloatArray): Double {
        var dot = 0.0
        val len = minOf(a.size, b.size)
        for (i in 0 until len) dot += a[i].toDouble() * b[i].toDouble()
        return dot
    }

    /** 是否已加载。 */
    fun isLoaded(): Boolean = loaded

    /** 已加载向量数。 */
    fun size(): Int = vectors.size
}
