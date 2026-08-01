package com.appindex.Rerank

import com.appindex.model.MatchType
import com.appindex.model.SearchResult
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * GOTO Engine · 第四层（梳理层）— 个人化重排器
 *
 * 纯函数重排：融合 Base 个人层 5 个 schema 的 boost，对引擎结果做最终排序。
 * 对应 JS 版 `algorithms/rerank/personal-rerank.js`。
 *
 * 五个独立 boost（每个独立限幅，总和再限帽）：
 *   1. heatmap         — 当前 hour×weekday 的启动密度
 *   2. hourly-ranking  — smartRanking 融合的按时段候选
 *   3. transition-matrix — 前台应用→候选应用的转移概率
 *   4. user-context    — 地理围栏偏好权重
 *   5. feedback-chain  — 近期点击的时近性/频次
 *
 * 总帽保护：personalBoost 不超过原 score 的 30%。
 * 精确匹配保护：exact-match 候选始终保持在顶部。
 * 降级模式：snapshot 为降级或列表为空时返回 applied=false。
 */
object PersonalReranker {

    /** 重排结果 */
    data class RerankResult(val applied: Boolean, val list: List<SearchResult>)

    // ── 配置常量（与 JS 版 DEFAULT_CONFIG 对齐） ──

    /** boost 1 上限：heatmap */
    private const val HEATMAP_BOOST_MAX = 0.15

    /** boost 2 上限：hourly-ranking */
    private const val HOURLY_RANKING_BOOST_MAX = 0.20

    /** boost 3 上限：transition-matrix */
    private const val TRANSITION_BOOST_MAX = 0.15

    /** boost 4 上限：user-context (geofence) */
    private const val GEOFENCE_BOOST_MAX = 0.15

    /** boost 5 上限：feedback-chain */
    private const val FEEDBACK_BOOST_MAX = 0.20

    /** 五个 boost 总和上限 */
    private const val TOTAL_PERSONAL_BOOST_MAX = 0.50

    /** feedback 衰减半衰期（事件数） */
    private const val FEEDBACK_HALF_LIFE_EVENTS = 20

    /** heatmap 密度归一化基线 */
    private const val HEATMAP_DENSITY_BASELINE = 5

    /** transition 噪声阈值，低于此概率忽略 */
    private const val TRANSITION_NOISE_FLOOR = 0.05

    /** 总帽保护：personalBoost 不超过原 score 的 30% */
    private const val SCORE_CAP_RATIO = 0.30

    /**
     * 对引擎结果应用第四层个人化重排。
     *
     * @param query     归一化查询字符串
     * @param list      引擎候选结果列表
     * @param snapshot  个人层快照（来自 EngineBaseBridge）
     * @return 重排结果，[RerankResult.applied] 为 true 时 [RerankResult.list] 为重排后的列表
     */
    fun rerank(query: String, list: List<SearchResult>, snapshot: PersonalSnapshot): RerankResult {
        // 降级或空列表：直接返回，不应用重排
        if (snapshot.degraded || list.isEmpty()) {
            return RerankResult(applied = false, list = list)
        }

        val q = query.lowercase().trim()

        // 为每个候选拼装 5 个 boost，计算最终分数
        val enriched = list.mapIndexed { originalIndex, result ->
            val pkg = result.appInfo.packageName
            val originalScore = result.score.toDouble()

            // 计算 5 个 boost（各自在 [0, boostMax] 区间）
            val b1 = heatmapBoost(pkg, snapshot)
            val b2 = hourlyRankingBoost(pkg, snapshot)
            val b3 = transitionBoost(pkg, snapshot)
            val b4 = geofenceBoost(pkg, snapshot)
            val b5 = feedbackBoost(pkg, q, snapshot)

            // 求和并限帽
            val rawSum = b1 + b2 + b3 + b4 + b5
            val cappedSum = min(rawSum, TOTAL_PERSONAL_BOOST_MAX)

            // 转换为 0~1 的个人化因子，再按原 score 的 30% 上限折算实际加分
            val personalFactor = if (TOTAL_PERSONAL_BOOST_MAX > 0.0) cappedSum / TOTAL_PERSONAL_BOOST_MAX else 0.0
            val scoreBoost = personalFactor * originalScore * SCORE_CAP_RATIO
            val finalScore = originalScore + scoreBoost

            EnrichedEntry(
                originalIndex = originalIndex,
                packageName = pkg,
                finalScore = finalScore,
                isExact = result.matchType == MatchType.EXACT
            )
        }

        // 稳定排序：exact-match 优先 → finalScore 降序 → 原始顺序
        val sorted = enriched.sortedWith(
            compareByDescending<EnrichedEntry> { it.isExact }
                .thenByDescending { it.finalScore }
                .thenBy { it.originalIndex }
        )

        // 映射回原始 SearchResult，更新 score
        val reranked = sorted.map { entry ->
            val original = list[entry.originalIndex]
            val newScore = entry.finalScore.toInt()
            if (newScore != original.score) original.copy(score = newScore) else original
        }

        return RerankResult(applied = true, list = reranked)
    }

    // ============================================================
    // 内部数据结构
    // ============================================================

    private data class EnrichedEntry(
        val originalIndex: Int,
        val packageName: String,
        val finalScore: Double,
        val isExact: Boolean
    )

    // ============================================================
    // Boost 1 — Heatmap（当前 hour×weekday 启动密度）
    // ============================================================

    private fun heatmapBoost(packageName: String, snapshot: PersonalSnapshot): Double {
        val heatmapObj = asMap(snapshot.heatmap) ?: return 0.0
        val cells = asList(heatmapObj["heatmap"]) ?: return 0.0
        val ctx = snapshot.runtimeContext
        if (ctx.hour < 0 || ctx.weekday < 0) return 0.0

        // 查找匹配 hour×weekday 的格子
        val cell = cells.mapNotNull { asMap(it) }.firstOrNull { c ->
            asInt(c["hour"]) == ctx.hour && asInt(c["weekday"]) == ctx.weekday
        } ?: return 0.0

        val total = asInt(cell["launchCount"])
        if (total <= 0) return 0.0

        val topApps = asList(cell["topApps"]) ?: return 0.0
        val pkgCount = topApps.mapNotNull { asMap(it) }.firstOrNull { a ->
            asString(a["packageName"]) == packageName
        }?.let { asInt(it["count"]) } ?: 0
        if (pkgCount <= 0) return 0.0

        val density = pkgCount.toDouble() / max(HEATMAP_DENSITY_BASELINE, total).toDouble()
        return clamp(density, 0.0, 1.0) * HEATMAP_BOOST_MAX
    }

    // ============================================================
    // Boost 2 — Hourly Ranking（smartRanking 融合候选）
    // ============================================================

    private fun hourlyRankingBoost(packageName: String, snapshot: PersonalSnapshot): Double {
        val hr = asMap(snapshot.hourlyRanking) ?: return 0.0
        val ctx = snapshot.runtimeContext
        if (ctx.hour < 0) return 0.0

        // 1) 优先查按时段的逐小时排名
        val hourly = asMap(hr["hourlyRanking"])
        if (hourly != null) {
            val hourList = asList(hourly[ctx.hour.toString()])
            if (hourList != null) {
                for (item in hourList) {
                    val e = asMap(item) ?: continue
                    if (asString(e["packageName"]) == packageName) {
                        val recency = asDouble(e["recencyScore"])
                        val count = asInt(e["count"])
                        // 频次（归一化到 0~1）与时近性各占 50%
                        val freq = clamp(count.toDouble() / 10.0, 0.0, 1.0)
                        return clamp(freq * 0.5 + recency * 0.5, 0.0, 1.0) * HOURLY_RANKING_BOOST_MAX
                    }
                }
            }
        }

        // 2) 回退到 smartRanking.topCandidates（全局融合排名）
        val smart = asMap(hr["smartRanking"])
        if (smart != null) {
            val top = asList(smart["topCandidates"])
            if (top != null) {
                for ((idx, item) in top.withIndex()) {
                    val c = asMap(item) ?: continue
                    if (asString(c["packageName"]) == packageName) {
                        // 按位置衰减：rank 1 → 满分，线性递减
                        val pos = idx + 1
                        val posFactor = clamp(1.0 - (pos - 1) / max(1, top.size).toDouble(), 0.0, 1.0)
                        val raw = asDouble(c["score"])
                        // 假设 raw 分数典型范围 [0, 10]，做防御性归一化
                        val norm = clamp(raw / 10.0, 0.0, 1.0)
                        return clamp(posFactor * 0.6 + norm * 0.4, 0.0, 1.0) * HOURLY_RANKING_BOOST_MAX
                    }
                }
            }
        }
        return 0.0
    }

    // ============================================================
    // Boost 3 — Transition Matrix（前台应用→候选转移概率）
    // ============================================================

    private fun transitionBoost(packageName: String, snapshot: PersonalSnapshot): Double {
        val tm = asMap(snapshot.transitionMatrix) ?: return 0.0
        val ctx = snapshot.runtimeContext
        val from = ctx.foregroundPackage
        if (from.isEmpty()) return 0.0

        val transitions = asMap(tm["transitions"]) ?: return 0.0
        val list = asList(transitions[from]) ?: return 0.0

        for (item in list) {
            val t = asMap(item) ?: continue
            if (asString(t["toPackage"]) == packageName) {
                val p = asDouble(t["probability"])
                if (p < TRANSITION_NOISE_FLOOR) return 0.0
                // 时近性折扣：超过 30 天的转移按半衰衰减
                val lastOcc = asString(t["lastOccurred"])
                var recFactor = 1.0
                val lastMs = parseIsoTimestamp(lastOcc)
                if (lastMs > 0) {
                    val daysSince = (System.currentTimeMillis() - lastMs) / (24.0 * 60.0 * 60.0 * 1000.0)
                    recFactor = clamp(0.5.pow(daysSince / 30.0), 0.0, 1.0)
                }
                return clamp(p * recFactor, 0.0, 1.0) * TRANSITION_BOOST_MAX
            }
        }
        return 0.0
    }

    // ============================================================
    // Boost 4 — User Context（地理围栏偏好权重）
    // ============================================================

    private fun geofenceBoost(packageName: String, snapshot: PersonalSnapshot): Double {
        val uc = asMap(snapshot.userContext) ?: return 0.0
        val ctx = snapshot.runtimeContext
        val geoId = ctx.geofenceId
        if (geoId.isEmpty()) return 0.0

        val prefs = asList(uc["preferredApps"]) ?: return 0.0
        for (item in prefs) {
            val p = asMap(item) ?: continue
            if (asString(p["geofenceId"]) == geoId && asString(p["packageName"]) == packageName) {
                return clamp(asDouble(p["weight"]), 0.0, 1.0) * GEOFENCE_BOOST_MAX
            }
        }
        return 0.0
    }

    // ============================================================
    // Boost 5 — Feedback Chain（近期点击时近性/频次）
    // ============================================================

    private fun feedbackBoost(packageName: String, query: String, snapshot: PersonalSnapshot): Double {
        val events = asList(snapshot.recentFeedback) ?: return 0.0
        if (events.isEmpty()) return 0.0

        var boost = 0.0
        // 事件按最新在前排列，按时近性衰减
        for ((i, item) in events.withIndex()) {
            val e = asMap(item) ?: continue
            if (asString(e["clickedPackage"]) != packageName) continue

            // 可选的 query 精化匹配
            val evtQuery = asString(e["query"])
            if (query.isNotEmpty() && evtQuery.isNotEmpty() && evtQuery.lowercase() != query) {
                continue
            }

            // 时近性衰减：rank 0 → factor 1，每 halfLife 个事件衰减一半
            val factor = 0.5.pow(i.toDouble() / max(1, FEEDBACK_HALF_LIFE_EVENTS).toDouble())

            // 排名加成：rank 0（顶部）确认强意图，rank -1（手动启动）更强
            val rank = asInt(e["clickedRank"])
            val rankBonus = when {
                rank == -1 -> 1.2   // 手动启动
                rank == 0 -> 1.0    // 已在顶部
                rank > 0 -> 0.7     // 用户需要扫描
                else -> 1.0
            }
            boost += factor * rankBonus
        }
        // 饱和求和：超过 ~3 个匹配事件后边际递减
        return clamp(boost / 3.0, 0.0, 1.0) * FEEDBACK_BOOST_MAX
    }

    // ============================================================
    // 安全类型提取工具（处理 Base 返回的动态 JSON 结构）
    // ============================================================

    @Suppress("UNCHECKED_CAST")
    private fun asMap(obj: Any?): Map<String, Any?>? = obj as? Map<String, Any?>

    @Suppress("UNCHECKED_CAST")
    private fun asList(obj: Any?): List<Any?>? = obj as? List<Any?>

    private fun asInt(obj: Any?): Int = when (obj) {
        is Number -> obj.toInt()
        is String -> obj.toIntOrNull() ?: -1
        else -> -1
    }

    private fun asDouble(obj: Any?): Double = when (obj) {
        is Number -> obj.toDouble()
        is String -> obj.toDoubleOrNull() ?: 0.0
        else -> 0.0
    }

    private fun asString(obj: Any?): String = obj?.toString() ?: ""

    private fun clamp(v: Double, lo: Double, hi: Double): Double = max(lo, min(hi, v))

    /** 解析 ISO 8601 时间戳为毫秒，失败返回 -1 */
    private fun parseIsoTimestamp(iso: String): Long {
        if (iso.isEmpty()) return -1
        return try {
            // 简单解析：兼容 "2026-07-30T09:00:00Z" 格式
            val cleaned = iso.replace("Z", "+00:00")
            java.time.OffsetDateTime.parse(cleaned).toInstant().toEpochMilli()
        } catch (_: Throwable) {
            try {
                java.time.LocalDateTime.parse(iso)
                    .toInstant(java.time.ZoneOffset.UTC).toEpochMilli()
            } catch (_: Throwable) {
                -1
            }
        }
    }
}
