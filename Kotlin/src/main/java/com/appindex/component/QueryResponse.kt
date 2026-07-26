package com.appindex.component

import com.appindex.model.SearchResult

/**
 * GOTO Engine Kotlin 版 - 查询选项
 *
 * 与 JS `EngineEnvelope` 的查询选项、Rust `QueryOptions` 对齐。
 *
 * @property limit     最多返回结果数（默认 30，与 JS / Rust 一致）
 * @property requestId 请求 ID（用于追踪 / 取消），为空时自动生成
 * @property context   附加上下文（最近 app / 时段 / 设备信息等）
 */
data class QueryOptions(
    val limit: Int = 30,
    val requestId: String? = null,
    val context: Map<String, String> = emptyMap()
) {
    companion object {
        val DEFAULT = QueryOptions()
    }
}

/**
 * GOTO Engine Kotlin 版 - 版本化查询响应（EngineEnvelope）
 *
 * 与 JS `EngineEnvelope { ok, data, requestId, latency, timestamp, localOnly }`
 * 和 Rust `QueryResponse` 字段一一对应。
 *
 * 组件层永不抛可预期异常，失败时返回 [QueryResponse.error]。
 *
 * @property ok         是否成功
 * @property data       成功时的搜索结果列表
 * @property error      失败时的错误码 + 描述
 * @property requestId  请求 ID（与 [QueryOptions.requestId] 对应）
 * @property latencyMs  引擎耗时（毫秒）
 * @property timestamp  时间戳（毫秒，epoch）
 * @property localOnly  是否纯本地结果（Kotlin 版始终为 true，无云端依赖）
 */
data class QueryResponse(
    val ok: Boolean,
    val data: List<SearchResult> = emptyList(),
    val error: EngineError? = null,
    val requestId: String,
    val latencyMs: Long,
    val timestamp: Long,
    val localOnly: Boolean = true
) {

    /**
     * 引擎错误（结构化失败包）。
     *
     * @property code    错误码（[ErrorCode]）
     * @property message 人类可读描述
     */
    data class EngineError(val code: ErrorCode, val message: String)

    companion object {
        fun ok(
            data: List<SearchResult>,
            requestId: String,
            latencyMs: Long,
            timestamp: Long = System.currentTimeMillis(),
            localOnly: Boolean = true
        ): QueryResponse = QueryResponse(
            ok = true,
            data = data,
            error = null,
            requestId = requestId,
            latencyMs = latencyMs,
            timestamp = timestamp,
            localOnly = localOnly
        )

        fun error(
            code: ErrorCode,
            message: String,
            requestId: String,
            latencyMs: Long,
            timestamp: Long = System.currentTimeMillis()
        ): QueryResponse = QueryResponse(
            ok = false,
            data = emptyList(),
            error = EngineError(code, message),
            requestId = requestId,
            latencyMs = latencyMs,
            timestamp = timestamp,
            localOnly = true
        )
    }
}
