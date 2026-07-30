package com.appindex.Rerank

import java.util.UUID

/**
 * GOTO Engine · Base Bridge — Engine 与 Base 之间的无状态桥接
 *
 * 与 JS 版 `base-bridge.js` 对齐。
 *
 * 设计：
 *   - 纯委托：不缓存，不修改 Base
 *   - 优雅降级：BaseReader/BaseWriter 未注入时，所有方法降级为 no-op/null
 *   - 故障隔离：所有读写都包在 try/catch 中
 *
 * v2.1 新增
 */
class EngineBaseBridge(
    private var reader: BaseReaderPort? = null,
    private var writer: BaseWriterPort? = null
) {
    val available: Boolean
        get() = reader != null || writer != null

    val degraded: Boolean
        get() = !available

    var lastError: String? = null
        private set

    /**
     * 收集完整的个人层快照（用于梳理层重排）。
     * 5 个 schema + affinities 并行读取。
     */
    fun getPersonalSnapshot(
        query: String,
        candidatePackages: List<String>,
        runtimeContext: RuntimeContext
    ): PersonalSnapshot {
        if (degraded) return PersonalSnapshot.degraded()

        val now = System.currentTimeMillis()
        val ctx = runtimeContext

        val affinities = safeRead({ reader?.getAffinities(query, candidatePackages) }, emptyMap())
        val heatmap = safeRead({ reader?.getHeatmap() }, null)
        val hourlyRanking = safeRead({ reader?.getHourlyRanking() }, null)
        val transitionMatrix = safeRead({ reader?.getTransitionMatrix() }, null)
        val userContext = safeRead({ reader?.getUserContext() }, null)
        val recentFeedback = safeRead({ reader?.getRecentFeedback(query, 50) }, emptyList())

        return try {
            PersonalSnapshot(
                takenAt = now,
                query = query,
                candidatePackages = candidatePackages,
                runtimeContext = ctx,
                affinities = affinities,
                heatmap = heatmap,
                hourlyRanking = hourlyRanking,
                transitionMatrix = transitionMatrix,
                userContext = userContext,
                recentFeedback = recentFeedback,
                degraded = false
            )
        } catch (e: Throwable) {
            lastError = e.message ?: e.toString()
            PersonalSnapshot.degraded()
        }
    }

    /**
     * 写入 feedback-chain 事件（用户点击应用时调用）。
     * @return eventId 或 null（失败时）
     */
    fun recordFeedbackChainEvent(event: FeedbackChainEvent): String? {
        val w = writer ?: return null
        val record = FeedbackEvent(
            eventId = event.eventId.ifEmpty { UUID.randomUUID().toString() },
            timestamp = event.timestamp.ifEmpty { java.time.Instant.now().toString() },
            query = event.query,
            normalizedQuery = event.normalizedQuery.lowercase(),
            clickedPackage = event.clickedPackage,
            clickedAppName = event.clickedAppName,
            clickedRank = event.clickedRank,
            candidateCount = event.candidateCount,
            matchMode = normalizeMatchMode(event.matchMode),
            context = event.context
        )
        return try {
            w.recordFeedbackChainEvent(record)
            record.eventId
        } catch (e: Throwable) {
            lastError = e.message ?: e.toString()
            null
        }
    }

    /** 运行时配置（注入/替换组件） */
    fun configure(
        baseReader: BaseReaderPort? = null,
        baseWriter: BaseWriterPort? = null
    ): EngineBaseBridge {
        if (baseReader != null) reader = baseReader
        if (baseWriter != null) writer = baseWriter
        return this
    }

    fun status(): BridgeStatus = BridgeStatus(
        available = available,
        degraded = degraded,
        hasReader = reader != null,
        hasWriter = writer != null,
        lastError = lastError
    )

    private fun <T> safeRead(block: () -> T?, fallback: T): T {
        return try {
            block() ?: fallback
        } catch (e: Throwable) {
            lastError = e.message ?: e.toString()
            fallback
        }
    }

    private fun normalizeMatchMode(mode: String): String {
        return when (mode) {
            "exact", "prefix", "fuzzy", "rag", "synonym" -> mode
            else -> "fuzzy"
        }
    }
}

data class BridgeStatus(
    val available: Boolean,
    val degraded: Boolean,
    val hasReader: Boolean,
    val hasWriter: Boolean,
    val lastError: String?
)

/** 写入事件参数（与 JS 版 recordFeedbackChainEvent 入参对齐） */
data class FeedbackChainEvent(
    val query: String = "",
    val normalizedQuery: String = "",
    val clickedPackage: String,
    val clickedAppName: String = "",
    val clickedRank: Int = -1,            // 0-based; -1=手动启动
    val candidateCount: Int = 0,
    val matchMode: String = "fuzzy",
    val eventId: String = "",             // 空则自动生成
    val timestamp: String = "",           // 空则自动生成
    val context: FeedbackContext = FeedbackContext()
)

/**
 * BaseReader 端口接口 — 由宿主实现（映射到 GOTO Base 的 BaseReader）。
 * Engine 只依赖此接口，不直接依赖 Base。
 */
interface BaseReaderPort {
    fun getAffinities(query: String, packages: List<String>): Map<String, Affinity>
    fun getHeatmap(): HeatmapData?
    fun getHourlyRanking(): HourlyRankingData?
    fun getTransitionMatrix(): TransitionMatrixData?
    fun getUserContext(): UserContextData?
    fun getRecentFeedback(query: String, limit: Int): List<FeedbackEvent>
}

/**
 * BaseWriter 端口接口 — 由宿主实现（映射到 GOTO Base 的 BaseWriter）。
 */
interface BaseWriterPort {
    fun recordFeedbackChainEvent(event: FeedbackEvent)
}
