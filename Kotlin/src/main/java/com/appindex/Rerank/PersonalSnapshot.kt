package com.appindex.Rerank

/**
 * GOTO Engine · L4 梳理层 — Base 个人层快照
 *
 * 对应 Base 个人层 5 个 schema + affinities：
 *   1. feedback-chain.schema.json    → recentFeedback
 *   2. heatmap.schema.json           → heatmap
 *   3. hourly-ranking.schema.json    → hourlyRanking
 *   4. transition-matrix.schema.json → transitionMatrix
 *   5. user-context.schema.json      → userContext
 *
 * 与 JS 版 `base-bridge.js` 的 `getPersonalSnapshot()` 返回结构对齐。
 *
 * v2.1 新增
 */
data class PersonalSnapshot(
    val takenAt: Long,                          // 快照时间戳（ms）
    val query: String,                          // 触发快照的查询
    val candidatePackages: List<String>,        // 候选包名列表
    val runtimeContext: RuntimeContext,         // 运行时上下文
    val affinities: Map<String, Affinity>,      // packageName → affinity
    val heatmap: HeatmapData?,                  // Base heatmap schema
    val hourlyRanking: HourlyRankingData?,      // Base hourly-ranking schema
    val transitionMatrix: TransitionMatrixData?,// Base transition-matrix schema
    val userContext: UserContextData?,          // Base user-context schema
    val recentFeedback: List<FeedbackEvent>,    // Base feedback-chain 最近事件
    val degraded: Boolean = false               // 是否降级
) {
    companion object {
        /** 降级快照：所有字段为空，梳理层将 no-op */
        fun degraded(): PersonalSnapshot = PersonalSnapshot(
            takenAt = 0L,
            query = "",
            candidatePackages = emptyList(),
            runtimeContext = RuntimeContext(),
            affinities = emptyMap(),
            heatmap = null,
            hourlyRanking = null,
            transitionMatrix = null,
            userContext = null,
            recentFeedback = emptyList(),
            degraded = true
        )
    }
}

data class RuntimeContext(
    val hour: Int = 0,                  // 0-23
    val weekday: Int = 0,               // 0=周日, 1=周一, ... 6=周六
    val geofenceId: String = "",
    val foregroundPackage: String = ""
)

data class Affinity(
    val packageName: String,
    val currentWeight: Double = 0.0,
    val confidence: Double = 1.0
)

// ─── Base 个人层 schema 数据结构（精简版，仅保留梳理层所需字段） ───

data class HeatmapData(
    val cells: List<HeatmapCell>,           // 24h × 7d 单元格
    val lastUpdated: String? = null
)

data class HeatmapCell(
    val hour: Int,
    val weekday: Int,
    val launchCount: Int,
    val topApps: List<HeatmapApp>
)

data class HeatmapApp(
    val packageName: String,
    val count: Int
)

data class HourlyRankingData(
    val globalRanking: List<HourlyGlobalRank> = emptyList(),
    val hourlyRanking: Map<String, List<HourlyApp>> = emptyMap(),   // key=hour "0".."23"
    val smartRanking: SmartRanking? = null
)

data class HourlyGlobalRank(
    val packageName: String,
    val totalLaunches: Int,
    val weightedScore: Double
)

data class HourlyApp(
    val packageName: String,
    val count: Int,
    val recencyScore: Double
)

data class SmartRanking(
    val algorithm: String,
    val weights: SmartRankingWeights,
    val topCandidates: List<SmartCandidate>
)

data class SmartRankingWeights(
    val timeOfDay: Double,
    val weekday: Double,
    val recency: Double
)

data class SmartCandidate(
    val packageName: String,
    val score: Double
)

data class TransitionMatrixData(
    val transitions: Map<String, List<TransitionEdge>>,   // fromPackage → edges
    val totalTransitions: Int = 0,
    val lastUpdated: String? = null
)

data class TransitionEdge(
    val toPackage: String,
    val count: Int,
    val probability: Double,
    val avgDelaySec: Double = 0.0,
    val lastOccurred: String? = null
)

data class UserContextData(
    val timezone: String = "",
    val geofences: List<Geofence> = emptyList(),
    val preferredApps: List<PreferredApp> = emptyList(),
    val lastUpdated: String? = null
)

data class Geofence(
    val geofenceId: String,
    val cityCode: String = "",
    val label: String = "",
    val visitCount: Int = 0,
    val lastVisit: String? = null
)

data class PreferredApp(
    val geofenceId: String,
    val packageName: String,
    val weight: Double
)

data class FeedbackEvent(
    val eventId: String,
    val timestamp: String,
    val query: String,
    val normalizedQuery: String = "",
    val clickedPackage: String,
    val clickedAppName: String = "",
    val clickedRank: Int = -1,            // 0-based; -1=手动启动
    val candidateCount: Int = 0,
    val matchMode: String = "fuzzy",      // exact|prefix|fuzzy|rag|synonym
    val context: FeedbackContext
)

data class FeedbackContext(
    val hour: Int = 0,
    val weekday: Int = 0,
    val geofenceId: String = "",
    val foregroundPackage: String = ""
)
