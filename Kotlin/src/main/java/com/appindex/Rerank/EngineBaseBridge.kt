package com.appindex.Rerank

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * 运行时上下文（搜索时的环境信息）
 *
 * @param hour              小时 0-23，-1 表示未知
 * @param weekday           星期 0-6（0=周日），-1 表示未知
 * @param geofenceId        地理围栏 ID，空字符串表示未知
 * @param foregroundPackage 前台应用包名，空字符串表示未知
 */
data class RuntimeContext(
    val hour: Int = -1,
    val weekday: Int = -1,
    val geofenceId: String = "",
    val foregroundPackage: String = ""
)

/**
 * 反馈上下文（点击事件发生时的环境信息）
 *
 * 字段与 [RuntimeContext] 一致，用于 feedback-chain 事件记录。
 */
data class FeedbackContext(
    val hour: Int = -1,
    val weekday: Int = -1,
    val geofenceId: String = "",
    val foregroundPackage: String = ""
)

/**
 * 反馈链事件（用户点击应用时写入 Base）
 *
 * @param query            原始查询（可为空）
 * @param normalizedQuery  归一化查询（小写去空格）
 * @param clickedPackage   被点击应用包名（必填）
 * @param clickedAppName   被点击应用显示名（可选，离线分析用）
 * @param clickedRank      点击排名 0-based；-1 表示不在候选中（手动启动）
 * @param candidateCount   候选总数
 * @param matchMode        匹配模式：exact | prefix | fuzzy | rag | synonym
 * @param context          点击时的环境上下文
 */
data class FeedbackChainEvent(
    val query: String = "",
    val normalizedQuery: String = "",
    val clickedPackage: String = "",
    val clickedAppName: String = "",
    val clickedRank: Int = -1,
    val candidateCount: Int = 0,
    val matchMode: String = "fuzzy",
    val context: FeedbackContext = FeedbackContext()
)

/**
 * 桥接状态诊断信息
 */
data class BridgeStatus(
    val available: Boolean,
    val degraded: Boolean,
    val hasReader: Boolean,
    val hasWriter: Boolean,
    val lastError: String?
)

/**
 * Base 读取端口接口（6 个读取方法）
 *
 * 由 Base 层实现并注入 [EngineBaseBridge]。每个方法返回 Base 个人层的对应 schema 数据。
 * 返回类型为 [Any?]，实际为 JSON 解析后的 Map/List 结构，由 [PersonalReranker] 安全提取。
 */
interface BaseReaderPort {
    /** 读取候选包的亲和度（affinity 映射） */
    fun getAffinities(query: String, packages: List<String>): Any?

    /** 读取 heatmap schema（hour×weekday 启动密度） */
    fun getHeatmap(): Any?

    /** 读取 hourly-ranking schema（按时段排名 + smartRanking） */
    fun getHourlyRanking(): Any?

    /** 读取 transition-matrix schema（应用间转移概率） */
    fun getTransitionMatrix(): Any?

    /** 读取 user-context schema（地理围栏偏好） */
    fun getUserContext(): Any?

    /** 读取近期 feedback-chain 事件（最新在前） */
    fun getRecentFeedback(query: String, limit: Int): Any?
}

/**
 * Base 写入端口接口（1 个写入方法）
 *
 * 由 Base 层实现并注入 [EngineBaseBridge]。
 */
interface BaseWriterPort {
    /**
     * 追加一条 feedback-chain 事件。
     * @return eventId，失败返回 null
     */
    fun recordFeedbackChainEvent(event: FeedbackChainEvent): String?
}

/**
 * 个人层快照（5 schema + affinities 的只读视图）
 *
 * 由 [EngineBaseBridge.getPersonalSnapshot] 构建，供 [PersonalReranker] 消费。
 * 当 Base 不可用时使用 [degraded] 创建降级快照，重排层将跳过。
 *
 * @param degraded 是否降级（Base 不可用或读取失败）
 */
data class PersonalSnapshot(
    val version: String = "",
    val takenAt: String = "",
    val query: String = "",
    val candidatePackages: List<String> = emptyList(),
    val runtimeContext: RuntimeContext = RuntimeContext(),
    val affinities: Any? = null,
    val heatmap: Any? = null,
    val hourlyRanking: Any? = null,
    val transitionMatrix: Any? = null,
    val userContext: Any? = null,
    val recentFeedback: Any? = null,
    val degraded: Boolean = false
) {
    companion object {
        /** 创建降级快照（Base 不可用时使用） */
        fun degraded(): PersonalSnapshot = PersonalSnapshot(degraded = true)
    }
}

/**
 * Base 桥接 — 引擎与 Base 个人层之间的无状态桥梁
 *
 * 引擎从不本地存储学习状态，而是通过此桥接读写 Base 个人层 schema。
 * Base 始终是唯一数据源（single source of truth）。
 *
 * 设计原则：
 *   - 纯委托：引擎侧无缓存、不变更 Base
 *   - 优雅降级：reader/writer 未注入时所有方法降级为 no-op/null
 *   - 故障隔离：每个读写都 try/catch，读失败返回 null，写失败静默
 *
 * 对应 JS 版 `base-bridge.js`。
 *
 * @param reader Base 读取端口（可空，未注入时降级）
 * @param writer Base 写入端口（可空，未注入时降级）
 */
class EngineBaseBridge(
    private val reader: BaseReaderPort? = null,
    private val writer: BaseWriterPort? = null
) {
    /** Base 是否可用（至少有 reader 或 writer） */
    val available: Boolean
        get() = reader != null || writer != null

    /** 是否降级（reader 和 writer 都不可用） */
    val degraded: Boolean
        get() = !available

    @Volatile
    private var lastError: String? = null

    /**
     * 收集完整的个人层快照用于重排。
     * 并行读取 5 个 schema + affinities，每个读取故障隔离。
     *
     * @param query             归一化查询（可为空）
     * @param candidatePackages 引擎结果中的候选包名列表
     * @param runtimeContext    运行时上下文（hour/weekday/geofenceId/foregroundPackage）
     * @return 个人层快照，Base 不可用时返回降级快照
     */
    fun getPersonalSnapshot(
        query: String,
        candidatePackages: List<String>,
        runtimeContext: RuntimeContext
    ): PersonalSnapshot {
        if (degraded) return PersonalSnapshot.degraded()

        // 各读取故障隔离：单个 schema 失败不影响其他
        val affinities = safeRead { reader?.getAffinities(query, candidatePackages) }
        val heatmap = safeRead { reader?.getHeatmap() }
        val hourlyRanking = safeRead { reader?.getHourlyRanking() }
        val transitionMatrix = safeRead { reader?.getTransitionMatrix() }
        val userContext = safeRead { reader?.getUserContext() }
        val recentFeedback = safeRead { reader?.getRecentFeedback(query, 50) }

        return PersonalSnapshot(
            version = VERSION,
            takenAt = nowIso(),
            query = query,
            candidatePackages = candidatePackages,
            runtimeContext = runtimeContext,
            affinities = affinities,
            heatmap = heatmap,
            hourlyRanking = hourlyRanking,
            transitionMatrix = transitionMatrix,
            userContext = userContext,
            recentFeedback = recentFeedback,
            degraded = false
        )
    }

    /**
     * 追加一条 feedback-chain 事件（用户点击应用时调用）。
     *
     * @param event 反馈链事件
     * @return eventId，失败返回 null
     */
    fun recordFeedbackChainEvent(event: FeedbackChainEvent): String? {
        if (event.clickedPackage.isEmpty()) return null
        val w = writer ?: return null
        return try {
            w.recordFeedbackChainEvent(event)
        } catch (e: Throwable) {
            lastError = e.message ?: e.toString()
            null
        }
    }

    /**
     * 查询桥接状态（诊断用）。
     */
    fun status(): BridgeStatus = BridgeStatus(
        available = available,
        degraded = degraded,
        hasReader = reader != null,
        hasWriter = writer != null,
        lastError = lastError
    )

    // ============================================================
    // 内部工具
    // ============================================================

    /** 安全读取：捕获异常，失败时记录错误并返回 null */
    private fun <T> safeRead(block: () -> T?): T? = try {
        block()
    } catch (e: Throwable) {
        lastError = e.message ?: e.toString()
        null
    }

    /** 当前时间的 ISO 8601 字符串（UTC） */
    private fun nowIso(): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
            .apply { timeZone = TimeZone.getTimeZone("UTC") }
            .format(Date())

    companion object {
        const val VERSION = "1.0.0"
    }
}
