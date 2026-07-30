package com.appindex.Rerank

import kotlin.math.sqrt

/**
 * GOTO Base — 语义向量检索（Kotlin 版）
 *
 * 与 JS 版 `algorithms/semantic/SemanticSearch.js` 行为对齐。
 * MVP 实现：纯线性扫描 cosine 相似度。
 *
 * 设计：
 *   - L2 归一化后存入 Map<id, FloatArray>，cosine 退化为点积
 *   - [load] 接受已解析的 JSON Map（避免耦合具体 JSON 库）
 *   - [search] 在无 queryVector 时返回空（MVP 无 embedding 模型）
 *
 * 三语言行为一致：JS / Kotlin / Rust。
 *
 * v2.1 新增
 */
class SemanticSearch {
    /** id -> L2 归一化后的向量 */
    private val vectors: MutableMap<String, FloatArray> = mutableMapOf()
    /** 元信息（model / dim 等） */
    private var meta: Map<String, Any> = emptyMap()
    /** 是否已加载 */
    private var loaded: Boolean = false

    /**
     * 从 vector-store.json 解析后的 Map 加载向量。
     *
     * 兼容两种字段命名（与 JS 版一致）：
     *   - 新格式：vectors[i] = { packageName, vector }
     *   - 旧格式：vectors[i] = { id, embedding }
     *
     * 元信息优先取 `meta`，否则用 `embeddingModel` / `dimension` 构造。
     *
     * @param vectorsJson 已解析的 JSON 对象
     */
    fun load(vectorsJson: Map<String, Any>) {
        @Suppress("UNCHECKED_CAST")
        val list = vectorsJson["vectors"] as? List<Map<String, Any>> ?: emptyList()

        // 元信息：优先 meta，否则用 embeddingModel/dimension 构造
        @Suppress("UNCHECKED_CAST")
        val metaMap = vectorsJson["meta"] as? Map<String, Any>
        meta = metaMap ?: buildMap {
            put("model", vectorsJson["embeddingModel"] ?: "bge-small-zh-v1.5")
            put("dim", vectorsJson["dimension"] ?: 0)
        }
        val dim = (meta["dim"] as? Number)?.toInt() ?: 0

        vectors.clear()
        for (item in list) {
            // 新格式：packageName；旧格式：id
            val id = (item["packageName"] as? String) ?: (item["id"] as? String) ?: continue
            // 新格式：vector；旧格式：embedding
            val emb = toFloatArray(item["vector"] ?: item["embedding"]) ?: continue
            if (dim != 0 && emb.size != dim) continue  // 维度不匹配，跳过
            vectors[id] = normalize(emb)
        }
        loaded = true
    }

    /**
     * 用查询向量检索 top-K 最近邻。
     *
     * @param queryVec 查询向量（无需归一化，内部会归一化）
     * @param k 返回数量，默认 10；k<=0 时取 10（与 JS `k || 10` 一致）
     * @return 按相似度降序的 (id, score) 列表
     */
    fun searchByVector(queryVec: FloatArray, k: Int = 10): List<Pair<String, Double>> {
        if (!loaded) return emptyList()
        val q = normalize(queryVec)
        val results = ArrayList<Pair<String, Double>>(vectors.size)
        for ((id, vec) in vectors) {
            results.add(id to cosine(q, vec))
        }
        results.sortByDescending { it.second }
        val limit = if (k > 0) k else 10
        return results.take(limit)
    }

    /**
     * 用文本查询检索（MVP：依赖外部预计算的 queryVector）。
     *
     * @param query 查询文本（MVP 阶段不使用，保留参数以对齐 JS 签名）
     * @param k 返回数量
     * @param queryVector 预计算的查询向量，若提供且非空则直接走 [searchByVector]
     * @return 命中列表；无 queryVector 时返回空（避免错误匹配）
     */
    fun search(query: String, k: Int = 10, queryVector: FloatArray? = null): List<Pair<String, Double>> {
        if (queryVector != null && queryVector.isNotEmpty()) {
            return searchByVector(queryVector, k)
        }
        // MVP：无 embedding 模型时返回空
        return emptyList()
    }

    /** 是否已加载。 */
    fun isLoaded(): Boolean = loaded

    /** 已加载向量数。 */
    fun size(): Int = vectors.size

    /** 元信息。 */
    fun meta(): Map<String, Any> = meta

    // ─── 内部辅助 ──────────────────────────────────────────────────────────

    /** L2 归一化（零向量原样返回，与 JS 一致）。 */
    private fun normalize(vec: FloatArray): FloatArray {
        var sum = 0.0
        for (v in vec) sum += v.toDouble() * v.toDouble()
        val norm = sqrt(sum)
        if (norm == 0.0) return vec
        val out = FloatArray(vec.size)
        for (i in vec.indices) out[i] = (vec[i].toDouble() / norm).toFloat()
        return out
    }

    /** 点积（向量已归一化时即 cosine）。长度不一致时取较短者，避免越界。 */
    private fun cosine(a: FloatArray, b: FloatArray): Double {
        val n = minOf(a.size, b.size)
        var dot = 0.0
        for (i in 0 until n) dot += a[i].toDouble() * b[i].toDouble()
        return dot
    }

    /** 将 JSON 解析后的数值集合转为 FloatArray；不可识别时返回 null。 */
    private fun toFloatArray(raw: Any?): FloatArray? {
        return when (raw) {
            is FloatArray -> raw
            is List<*> -> {
                val out = FloatArray(raw.size)
                for (i in raw.indices) {
                    out[i] = (raw[i] as? Number)?.toFloat() ?: return null
                }
                out
            }
            else -> null
        }
    }
}
