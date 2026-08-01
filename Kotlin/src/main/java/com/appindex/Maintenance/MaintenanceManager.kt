package com.appindex.Maintenance

import kotlin.math.abs
import kotlin.math.pow

/**
 * 引擎自主维护管理器（Kotlin 版）— 对应 JS `goto-engine.js` `maintain()` /
 * Rust `maintenance.rs`。
 *
 * 引擎核心无状态，权重 / 链边 / 记忆 / 屏蔽标记存储由 app 层持有并注入。
 * 依次执行 4 大清理：全局衰减 → 链式边修剪 → 旧记忆清理 → 过期 block flag 清理。
 *
 * 由 [com.appindex.component.GotoEngineFacade.getMaintenanceManager] 暴露给调用方。
 *
 * @param weightsStore 查询权重：queryKey -> (appName -> weight)
 * @param weightsTsStore 权重时间戳：queryKey -> 最近更新时间
 * @param chainStore 链式边：fromKey -> 边列表
 * @param memoryStore 记忆记录列表
 * @param blockFlags 屏蔽标记：queryKey -> 标记列表
 */
class MaintenanceManager(
    private val weightsStore: MutableMap<String, MutableMap<String, Double>>,
    private val weightsTsStore: MutableMap<String, Long>,
    private val chainStore: MutableMap<String, MutableList<ChainEdge>>,
    private val memoryStore: MutableList<MemoryRecord>,
    private val blockFlags: MutableMap<String, MutableList<BlockFlag>>
) {

    /** 链式边 */
    data class ChainEdge(val toKey: String, var weight: Double, var lastUsed: Long)

    /** 记忆记录 */
    data class MemoryRecord(val key: String, val timestamp: Long)

    /** 屏蔽标记 */
    data class BlockFlag(val app: String, val expireAt: Long)

    /** 维护报告 */
    data class MaintenanceReport(
        val decayedQueries: Int,
        val prunedChainEdges: Int,
        val prunedMemoryRecords: Int,
        val clearedBlockFlags: Int,
        val durationMs: Long
    )

    /** 时间衰减下限：避免权重完全消失（对应 JS WEIGHT_DECAY.MIN_FLOOR）。 */
    private val decayMinFloor: Double = 0.35

    /** 时间衰减收敛中心（对应 JS `decayed = 0.5 + (cur - 0.5) * factor`）。 */
    private val decayCenter: Double = 0.5

    /**
     * 引擎自主维护入口。
     *
     * 顺序：先全局衰减权重 → 再修剪链式边 → 再修剪旧记忆 → 最后清理过期 block flag。
     * @return 统计报告
     */
    fun maintain(): MaintenanceReport {
        val start = System.currentTimeMillis()

        val decayedQueries = decayAllStaleQueries()
        val prunedChainEdges = pruneChainStore()
        val prunedMemoryRecords = pruneOldMemory()
        val clearedBlockFlags = clearExpiredBlockFlags()

        return MaintenanceReport(
            decayedQueries = decayedQueries,
            prunedChainEdges = prunedChainEdges,
            prunedMemoryRecords = prunedMemoryRecords,
            clearedBlockFlags = clearedBlockFlags,
            durationMs = System.currentTimeMillis() - start
        )
    }

    /**
     * 全局时间衰减：对所有超过 [STALE_THRESHOLD_DAYS] 的查询权重应用半衰期衰减。
     * 解决原算法仅在用户点击时才衰减的盲点，避免历史偏好永不衰减。
     * @return 实际发生衰减的查询数
     */
    private fun decayAllStaleQueries(): Int {
        if (weightsTsStore.isEmpty()) return 0
        val now = System.currentTimeMillis()
        var decayed = 0
        for ((key, lastTs) in weightsTsStore) {
            if (lastTs == 0L) continue
            val daysSince = (now - lastTs).toDouble() / DAY_MS
            if (daysSince < STALE_THRESHOLD_DAYS) continue
            if (applyTimeDecayToQuery(key, daysSince)) decayed++
        }
        return decayed
    }

    /**
     * 对单个查询的权重应用半衰期衰减（向 [decayCenter] 指数收敛，下限 [decayMinFloor]）。
     * @return 权重是否实际变化
     */
    private fun applyTimeDecayToQuery(queryKey: String, daysSince: Double): Boolean {
        val weights = weightsStore[queryKey] ?: return false
        val decayFactor = 0.5.pow(daysSince / DECAY_HALF_LIFE_DAYS)
        var changed = false
        val it = weights.entries.iterator()
        while (it.hasNext()) {
            val entry = it.next()
            val cur = entry.value
            // 向 decayCenter 指数收敛（保留历史，不完全清除）
            var decayed = decayCenter + (cur - decayCenter) * decayFactor
            decayed = maxOf(decayMinFloor, decayed)
            if (abs(decayed - cur) > 0.001) {
                entry.setValue(decayed.coerceIn(0.0, 1.0))
                changed = true
            }
        }
        return changed
    }

    /**
     * 链式边修剪：清理低权重边、限制每节点边数、限制全局总边数。
     * 解决链边无界增长导致的内存膨胀和推荐拖慢问题。
     * @return 被修剪的边数
     */
    private fun pruneChainStore(): Int {
        var pruned = 0
        var totalEdges = 0

        // 阶段 1：每个 fromKey 内清理低权重 + 限制每节点边数
        val fromKeys = chainStore.keys.toList()
        for (fromKey in fromKeys) {
            val edges = chainStore[fromKey] ?: continue
            // 清理低于阈值的边
            val it = edges.iterator()
            while (it.hasNext()) {
                if (it.next().weight < CHAIN_MIN_WEIGHT) {
                    it.remove()
                    pruned++
                }
            }
            // 每节点超出上限时按权重降序剪掉
            if (edges.size > CHAIN_MAX_PER_NODE) {
                edges.sortByDescending { it.weight }
                val removeCount = edges.size - CHAIN_MAX_PER_NODE
                repeat(removeCount) { edges.removeAt(edges.size - 1) }
                pruned += removeCount
            }
            if (edges.isEmpty()) {
                chainStore.remove(fromKey)
            } else {
                totalEdges += edges.size
            }
        }

        // 阶段 2：总边数超限时按权重降序截断，保留全局权重最高的 CHAIN_MAX_EDGES 条
        if (totalEdges > CHAIN_MAX_EDGES) {
            val allEdges = ArrayList<Pair<String, ChainEdge>>(totalEdges)
            for ((fromKey, edges) in chainStore) {
                for (edge in edges) allEdges.add(fromKey to edge)
            }
            allEdges.sortByDescending { it.second.weight }
            val newStore: MutableMap<String, MutableList<ChainEdge>> = LinkedHashMap()
            val keepCount = minOf(CHAIN_MAX_EDGES, allEdges.size)
            for (i in 0 until keepCount) {
                val (fromKey, edge) = allEdges[i]
                newStore.getOrPut(fromKey) { mutableListOf() }.add(edge)
            }
            val kept = newStore.values.sumOf { it.size }
            chainStore.clear()
            chainStore.putAll(newStore)
            pruned += totalEdges - kept
        }

        return pruned
    }

    /**
     * 旧记忆修剪：按时间窗（[MEMORY_MAX_AGE_DAYS]）+ 条数（[MEMORY_MAX_RECORDS]）双层保险。
     * @return 被修剪的记录数
     */
    private fun pruneOldMemory(): Int {
        if (memoryStore.isEmpty()) return 0
        val now = System.currentTimeMillis()
        val cutoff = now - MEMORY_MAX_AGE_DAYS * DAY_MS
        val before = memoryStore.size
        memoryStore.removeAll { it.timestamp <= cutoff }
        // 条数超限时保留最新的 MEMORY_MAX_RECORDS 条
        if (memoryStore.size > MEMORY_MAX_RECORDS) {
            val dropCount = memoryStore.size - MEMORY_MAX_RECORDS
            repeat(dropCount) { memoryStore.removeAt(0) }
        }
        return before - memoryStore.size
    }

    /**
     * 清理过期屏蔽标记（expireAt <= now）。
     * @return 被清理的标记数
     */
    private fun clearExpiredBlockFlags(): Int {
        val now = System.currentTimeMillis()
        var cleared = 0
        val queryKeys = blockFlags.keys.toList()
        for (queryKey in queryKeys) {
            val flags = blockFlags[queryKey] ?: continue
            val it = flags.iterator()
            while (it.hasNext()) {
                if (it.next().expireAt <= now) {
                    it.remove()
                    cleared++
                }
            }
            if (flags.isEmpty()) blockFlags.remove(queryKey)
        }
        return cleared
    }

    /**
     * 自愈：用户主动选择了 [newApp]，则提升其权重；对 [candidates] 减权；
     * 对 [negativeApps] 大幅减权并加 block flag（屏蔽 [BLOCK_FLAG_DEFAULT_DAYS] 天）。
     *
     * 对应 JS `applySelfHealing`（Kotlin 版将候选与负反馈外部传入，避免依赖全局上下文）。
     *
     * @param query 查询文本
     * @param newApp 用户实际选择的应用名（提升权重）
     * @param candidates 候选应用名列表（小幅减权 *0.85）
     * @param negativeApps 负反馈应用名列表（大幅减权 *0.5 + 屏蔽）
     */
    fun applySelfHealing(
        query: String,
        newApp: String,
        candidates: List<String>,
        negativeApps: List<String>
    ) {
        val q = query.trim()
        if (q.isEmpty() || newApp.isEmpty()) return
        val queryKey = q.lowercase()
        val now = System.currentTimeMillis()
        val weights = weightsStore.getOrPut(queryKey) { mutableMapOf() }

        // 1. 候选应用小幅减权（向 0 收敛 *0.85）
        for (name in candidates) {
            if (name.isEmpty() || name == newApp) continue
            val cur = weights[name] ?: 0.5
            weights[name] = (cur * 0.85).coerceIn(0.0, 1.0)
        }

        // 2. 负反馈应用大幅减权 + 加 block flag
        for (name in negativeApps) {
            if (name.isEmpty() || name == newApp) continue
            val cur = weights[name] ?: 0.5
            weights[name] = (cur * 0.5).coerceIn(0.0, 1.0)
            val flags = blockFlags.getOrPut(queryKey) { mutableListOf() }
            // 避免重复屏蔽同一应用
            if (flags.none { it.app == name }) {
                flags.add(BlockFlag(app = name, expireAt = now + BLOCK_FLAG_DEFAULT_DAYS * DAY_MS))
            }
        }

        // 3. 提升新选择应用的权重
        val curNew = weights[newApp] ?: 0.6
        weights[newApp] = (curNew + 0.3).coerceIn(0.0, 1.0)

        // 4. 更新时间戳
        weightsTsStore[queryKey] = now
    }

    companion object {
        private const val DAY_MS = 86_400_000L

        const val STALE_THRESHOLD_DAYS = 1
        const val CHAIN_MAX_EDGES = 500
        const val CHAIN_MAX_PER_NODE = 20
        const val CHAIN_MIN_WEIGHT = 1.0
        const val MEMORY_MAX_AGE_DAYS = 90
        const val MEMORY_MAX_RECORDS = 220
        const val BLOCK_FLAG_DEFAULT_DAYS = 3
        const val DECAY_HALF_LIFE_DAYS = 30.0
    }
}
