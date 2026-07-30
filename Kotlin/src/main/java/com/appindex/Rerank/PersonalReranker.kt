package com.appindex.Rerank

import com.appindex.model.SearchResult
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * GOTO Engine · L4 梳理层 — 个人化重排器（纯函数）
 *
 * 与 JS 版 `algorithms/rerank/personal-rerank.js` 的 `rerankWithPersonalLayer` 对齐。
 *
 * 设计原则：
 *   - 纯函数：不读写 IO，不修改入参，返回新列表
 *   - 5 schema 融合：heatmap / hourly-ranking / transition-matrix / user-context / feedback-chain
 *   - 精确匹配保护：exact-match 永远排第一，不受 personalBoost 影响
 *   - 总帽保护：5 源 + affinity 总和上限 totalPersonalBoostMax
 *   - 降级模式：snapshot 为 null/degraded 时返回原序，applied=false
 *
 * v2.1 新增
 */
object PersonalReranker {

    data class Config(
        val heatmapBoostMax: Double = 0.15,
        val hourlyRankingBoostMax: Double = 0.20,
        val transitionBoostMax: Double = 0.15,
        val geofenceBoostMax: Double = 0.15,
        val feedbackBoostMax: Double = 0.20,
        val totalPersonalBoostMax: Double = 0.50,
        val feedbackHalfLifeEvents: Int = 20,
        val heatmapDensityBaseline: Int = 5,
        val transitionNoiseFloor: Double = 0.05
    )

    /**
     * 应用 L4 梳理层重排。
     *
     * @param query 归一化查询
     * @param engineResults Engine 候选（L1/L2/L3 输出）
     * @param snapshot Base 个人层快照（可为 null）
     * @param config 配置
     * @return RerankResult
     */
    fun rerank(
        query: String,
        engineResults: List<SearchResult>,
        snapshot: PersonalSnapshot?,
        config: Config = Config()
    ): RerankResult {
        // 降级：snapshot 为 null 或标记为 degraded，或输入为空
        if (snapshot == null || snapshot.degraded || engineResults.isEmpty()) {
            return RerankResult.degraded(engineResults)
        }

        // 步骤 1: 计算每个候选的 finalScore 和 boost
        data class Enriched(
            val original: SearchResult,
            val packageName: String,
            val engineScore: Double,
            val personalBoost: Double,
            val finalScore: Double,
            val isExactMatch: Boolean,
            val boostSources: List<String>
        )

        val qLower = query.lowercase().trim()
        val enriched = engineResults.map { r ->
            val pkg = r.appInfo.packageName
            val name = r.appInfo.label
            val engineScore = r.score.toDouble()

            // 精确匹配检测
            val isExact = name.lowercase().trim() == qLower && qLower.isNotEmpty()

            // 5 个 boost
            val boosts = mutableListOf<String>()
            var total = 0.0

            val b1 = heatmapBoost(pkg, snapshot, config)
            if (b1 > 0) { boosts.add("heatmap=${round4(b1)}"); total += b1 }

            val b2 = hourlyRankingBoost(pkg, snapshot, config)
            if (b2 > 0) { boosts.add("hourly=${round4(b2)}"); total += b2 }

            val b3 = transitionBoost(pkg, snapshot, config)
            if (b3 > 0) { boosts.add("transition=${round4(b3)}"); total += b3 }

            val b4 = geofenceBoost(pkg, snapshot, config)
            if (b4 > 0) { boosts.add("geofence=${round4(b4)}"); total += b4 }

            val b5 = feedbackBoost(pkg, qLower, snapshot, config)
            if (b5 > 0) { boosts.add("feedback=${round4(b5)}"); total += b5 }

            // 总帽
            val capped = clampNum(total, 0.0, config.totalPersonalBoostMax)

            Enriched(
                original = r,
                packageName = pkg,
                engineScore = engineScore,
                personalBoost = round4(capped),
                finalScore = round4(engineScore + capped),
                isExactMatch = isExact,
                boostSources = boosts
            )
        }

        // 步骤 2: 排序 — 精确匹配优先，否则 finalScore 降序（稳定排序）
        val sorted = enriched.sortedWith(compareByDescending<Enriched> { it.isExactMatch }
            .thenByDescending { it.finalScore })

        // 步骤 3: 构造结果
        val list = sorted.map { it.original }
        val scores = sorted.associate { it.packageName to it.finalScore }
        val modeMap = sorted.associate {
            it.packageName to (if (it.isExactMatch) "exact-match"
                              else if (it.boostSources.isNotEmpty()) "个人重排"
                              else "engine-only")
        }
        val explanation = sorted.filter { it.boostSources.isNotEmpty() }
            .associate { it.packageName to it.boostSources.joinToString("; ") }

        return RerankResult(
            list = list,
            scores = scores,
            modeMap = modeMap,
            explanation = explanation,
            degraded = false,
            applied = true
        )
    }

    // ============================================================
    // Boost 1 — Heatmap
    // ============================================================
    private fun heatmapBoost(pkg: String, snap: PersonalSnapshot, cfg: Config): Double {
        val heatmap = snap.heatmap ?: return 0.0
        val hour = snap.runtimeContext.hour
        val weekday = snap.runtimeContext.weekday
        val cell = heatmap.cells.find { it.hour == hour && it.weekday == weekday } ?: return 0.0
        if (cell.launchCount <= 0) return 0.0
        val pkgCount = cell.topApps.find { it.packageName == pkg }?.count ?: 0
        if (pkgCount <= 0) return 0.0
        val density = pkgCount.toDouble() / max(cfg.heatmapDensityBaseline, cell.launchCount).toDouble()
        return clampNum(density, 0.0, 1.0) * cfg.heatmapBoostMax
    }

    // ============================================================
    // Boost 2 — Hourly Ranking
    // ============================================================
    private fun hourlyRankingBoost(pkg: String, snap: PersonalSnapshot, cfg: Config): Double {
        val hr = snap.hourlyRanking ?: return 0.0
        val hour = snap.runtimeContext.hour

        // 1) per-hour ranking
        val hourList = hr.hourlyRanking[hour.toString()]
        if (hourList != null) {
            val e = hourList.find { it.packageName == pkg }
            if (e != null) {
                val freq = clampNum(e.count.toDouble() / 10.0, 0.0, 1.0)
                val rec = clampNum(e.recencyScore, 0.0, 1.0)
                return clampNum(freq * 0.5 + rec * 0.5, 0.0, 1.0) * cfg.hourlyRankingBoostMax
            }
        }

        // 2) smartRanking fallback
        val smart = hr.smartRanking ?: return 0.0
        val top = smart.topCandidates
        val idx = top.indexOfFirst { it.packageName == pkg }
        if (idx < 0) return 0.0
        val posFactor = clampNum(1.0 - idx.toDouble() / max(1, top.size).toDouble(), 0.0, 1.0)
        val norm = clampNum(top[idx].score / 10.0, 0.0, 1.0)
        return clampNum(posFactor * 0.6 + norm * 0.4, 0.0, 1.0) * cfg.hourlyRankingBoostMax
    }

    // ============================================================
    // Boost 3 — Transition Matrix
    // ============================================================
    private fun transitionBoost(pkg: String, snap: PersonalSnapshot, cfg: Config): Double {
        val tm = snap.transitionMatrix ?: return 0.0
        val from = snap.runtimeContext.foregroundPackage
        if (from.isEmpty()) return 0.0
        val list = tm.transitions[from] ?: return 0.0
        val edge = list.find { it.toPackage == pkg } ?: return 0.0
        if (edge.probability < cfg.transitionNoiseFloor) return 0.0
        var recFactor = 1.0
        edge.lastOccurred?.let { ts ->
            val lastOcc = parseIsoTime(ts)
            if (lastOcc > 0) {
                val daysSince = (System.currentTimeMillis() - lastOcc) / (24.0 * 60 * 60 * 1000)
                recFactor = clampNum(0.5.pow(daysSince / 30.0), 0.0, 1.0)
            }
        }
        return clampNum(edge.probability * recFactor, 0.0, 1.0) * cfg.transitionBoostMax
    }

    // ============================================================
    // Boost 4 — Geofence / User Context
    // ============================================================
    private fun geofenceBoost(pkg: String, snap: PersonalSnapshot, cfg: Config): Double {
        val uc = snap.userContext ?: return 0.0
        val geoId = snap.runtimeContext.geofenceId
        if (geoId.isEmpty()) return 0.0
        val pref = uc.preferredApps.find { it.geofenceId == geoId && it.packageName == pkg }
            ?: return 0.0
        return clampNum(pref.weight, 0.0, 1.0) * cfg.geofenceBoostMax
    }

    // ============================================================
    // Boost 5 — Feedback Chain
    // ============================================================
    private fun feedbackBoost(pkg: String, query: String, snap: PersonalSnapshot, cfg: Config): Double {
        val events = snap.recentFeedback
        if (events.isEmpty()) return 0.0
        val halfLife = cfg.feedbackHalfLifeEvents.coerceAtLeast(1)
        var boost = 0.0
        events.forEachIndexed { i, e ->
            if (e.clickedPackage != pkg) return@forEachIndexed
            if (query.isNotEmpty() && e.query.isNotEmpty() && e.query.lowercase() != query) {
                return@forEachIndexed
            }
            val factor = 0.5.pow(i.toDouble() / halfLife.toDouble())
            var rankBonus = 1.0
            when (e.clickedRank) {
                -1 -> rankBonus = 1.2
                0 -> rankBonus = 1.0
                else -> if (e.clickedRank > 0) rankBonus = 0.7
            }
            boost += factor * rankBonus
        }
        return clampNum(boost / 3.0, 0.0, 1.0) * cfg.feedbackBoostMax
    }

    // ============================================================
    // 工具函数
    // ============================================================
    private fun clampNum(v: Double, lo: Double, hi: Double): Double {
        if (v.isNaN()) return lo
        return max(lo, min(hi, v))
    }

    private fun round4(v: Double): Double {
        if (v.isNaN()) return 0.0
        return Math.round(v * 10000.0) / 10000.0
    }

    private fun parseIsoTime(iso: String): Long {
        return try {
            java.time.Instant.parse(iso).toEpochMilli()
        } catch (_: Throwable) {
            try { java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX").parse(iso)?.time ?: 0L }
            catch (_: Throwable) { 0L }
        }
    }
}
