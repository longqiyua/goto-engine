package com.appindex.Rerank

import android.content.Context

/**
 * RAG 灰度过渡控制器
 *
 * 管理 RAG 向量库从旧版本到新版本的线性灰度过渡。
 * 过渡期为 [TRANSITION_DAYS] 天，期间新旧向量库按权重混合，
 * 权重从 0.0（纯旧库）线性增长到 1.0（全新库）。
 *
 * 对应 JS 版 `algorithms/rag/rag-transition.js`。
 *
 * @param context Android Context（用于 SharedPreferences 持久化）
 */
class RagTransitionController(private val context: Context) {

    /**
     * 启动灰度过渡：存储新向量库和索引，记录过渡起始时间。
     *
     * 调用后 [getBlendWeight] 将从 0.0 开始随天线性增长。
     *
     * @param vectorJson 新向量库 JSON（来自 [RagRebuilder.serializeVectorStore]）
     * @param indexJson  新 RAG 索引 JSON（来自 [RagRebuilder.serializeRagIndex]）
     */
    fun startTransition(vectorJson: String, indexJson: String) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
        prefs.putString(KEY_VECTOR_STORE, vectorJson)
        prefs.putString(KEY_RAG_INDEX, indexJson)
        prefs.putLong(KEY_TRANSITION_START, System.currentTimeMillis())
        prefs.apply()
    }

    /**
     * 获取当前混合权重。
     *
     * 从过渡起始时间起，按天线性插值：
     *   第 0 天 → 0.0（纯旧库）
     *   第 [TRANSITION_DAYS] 天 → 1.0（全新库）
     *
     * 未启动过渡或已结束时分别返回 0.0 / 1.0。
     *
     * @return 混合权重 [0.0, 1.0]
     */
    fun getBlendWeight(): Double {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val start = prefs.getLong(KEY_TRANSITION_START, 0L)
        if (start == 0L) return 0.0

        val elapsedMs = System.currentTimeMillis() - start
        val elapsedDays = elapsedMs.toDouble() / (24.0 * 60.0 * 60.0 * 1000.0)
        return (elapsedDays / TRANSITION_DAYS).coerceIn(0.0, 1.0)
    }

    companion object {
        /** 过渡期天数 */
        const val TRANSITION_DAYS = 15

        private const val PREFS_NAME = "goto_rag_transition"
        private const val KEY_VECTOR_STORE = "vector_store_json"
        private const val KEY_RAG_INDEX = "rag_index_json"
        private const val KEY_TRANSITION_START = "transition_start_ts"
    }
}
