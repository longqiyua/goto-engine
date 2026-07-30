package com.appindex.Rerank

import com.appindex.model.SearchResult

/**
 * GOTO Engine · L4 梳理层 — 个人化重排数据模型
 *
 * 与 JS 版 `algorithms/rerank/personal-rerank.js` 的返回结构对齐。
 * 三语言字段名必须一致，便于跨语言事件序列化对齐。
 *
 * v2.1 新增
 */
data class RerankResult(
    val list: List<SearchResult>,            // 重排后的结果列表
    val scores: Map<String, Double>,         // packageName → finalScore
    val modeMap: Map<String, String>,        // packageName → matchedBy / boost source
    val explanation: Map<String, String>,    // packageName → 解释字符串
    val degraded: Boolean,                   // 是否降级（snapshot 缺失时 true）
    val applied: Boolean                     // 是否真正应用了重排
) {
    companion object {
        /** 降级结果：原样返回，不重排 */
        fun degraded(list: List<SearchResult>): RerankResult = RerankResult(
            list = list,
            scores = emptyMap(),
            modeMap = emptyMap(),
            explanation = emptyMap(),
            degraded = true,
            applied = false
        )
    }
}
