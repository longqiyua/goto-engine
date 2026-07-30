package com.appindex.Maintenance

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.pow

/**
 * 引擎自主维护管理器（Kotlin 版）
 *
 * 对应 JS `goto-engine.js` 的 `maintain()` / `_decayAllStaleQueries()` /
 * `_pruneChainStore()` / `_pruneOldMemory()` / `clearExpiredBlockFlags()` /
 * `applySelfHealing()`，以及 Rust `maintenance.rs` + `self_healing.rs`。
 *
 * ## 设计说明
 *
 * 与 JS / Rust 的“单一引擎对象 + Storage 层”不同，Kotlin 版引擎核心
 * （[com.appindex.component.DefaultEngineFacade]）本身无状态，权重 / 链边 /
 * 记忆 / 屏蔽标记等存储由 app 层或 base 层持有。因此本类采用“注入式存储”
 * 设计：调用方把四类可变存储的引用传入构造函数，本类直接在其上执行清理。
 *
 * 行为与 JS / Rust 严格对齐（三语言一致）：
 * 1. 全局衰减：> 1 天未访问的 query 权重按半衰期模型衰减（向 0.5 收敛，floor 0.35）
 * 2. 链式边修剪：清理 weight < 1 的边；每 from-key 最多 20 个 to-key；全局 ≤ 500
 * 3. 旧记忆修剪：> 90 天清理，按 220 条上限双层保险
 * 4. 过期 block flag 清理
 *
 * @param weightsStore   query -> {app -> weight}，规则权重表
 * @param weightsTsStore query -> 最后访问时间戳（毫秒），衰减所必需
 * @param chainStore     from-key -> 边列表，链式关联存储
 * @param memoryStore    记忆记录列表（按时间顺序追加）
 * @param blockFlags     query-key -> 屏蔽标记列表
 */
class MaintenanceManager(
    private val weightsStore: MutableMap<String, MutableMap<String, Double>>,
    private val weightsTsStore: MutableMap<String, Long>,
    private val chainStore: MutableMap<String, MutableList<ChainEdge>>,
    private val memoryStore: MutableList<MemoryRecord>,
    private val blockFlags: MutableMap<String, MutableList<BlockFlag>>
) {

    // ─── 数据类型（与 JS / Rust 对齐） ─────────────────────────────────────

    /** 链式关联边（对应 Rust `ChainEdge` / JS `edges[from][to]`）。 */
    data class ChainEdge(val toKey: String, var weight: Double, var lastUsed: Long)

    /** 记忆记录（对应 JS `memory[]` 条目的时间戳部分）。 */
    data class MemoryRecord(val key: String, val timestamp: Long)

    /** 屏蔽标记（对应 JS `blockFlags[query][app]` / Rust `BlockFlag`）。 */
    data class BlockFlag(val app: String, val expireAt: Long)

    // ─── 公共入口 ─────────────────────────────────────────────────────────

    /**
     * 引擎自主维护入口（对应 JS `maintain()` / Rust `MaintenanceManager::maintain`）。
     *
     * 顺序：先全局衰减权重 → 再修剪链式边 → 再修剪旧记忆 → 最后清理过期 block flag。
     * 任一步骤异常不影响后续步骤（与 JS `try{ clearExpiredBlockFlags() }catch` 容错一致）。
     *
     * @return 维护统计报告
     */
    fun maintain(): MaintenanceReport {
        val startMs = System.currentTimeMillis()

        val decayed = try { decayAllStaleQueries() } catch (_: Throwable) { 0 }
        val prunedChain = try { pruneChainStore() } catch (_: Throwable) { 0 }
        val prunedMemory = try { pruneOldMemory() } catch (_: Throwable) { 0 }
        val clearedFlags = try { clearExpiredBlockFlags() } catch (_: Throwable) { 0 }

        return MaintenanceReport(
            decayedQueries = decayed,
            prunedChainEdges = prunedChain,
            prunedMemoryRecords = prunedMemory,
            clearedBlockFlags = clearedFlags,
            durationMs = System.currentTimeMillis() - startMs
        )
    }

    /**
     * 自愈机制（对应 JS `applySelfHealing()` / Rust `SelfHealingManager::apply_self_healing`）。
     *
     * 用户改选 [newApp] 后：
     * 1. 对非 [newApp] 的候选 app 降低权重（-0.5）；
     * 2. 临时屏蔽原默认 app（[negativeApps]）3 天；
     * 3. 提升 [newApp] 权重（+1.0）。
     *
     * @param query        查询文本
     * @param newApp       用户改选的目标 app
     * @param candidates   本次候选 app 列表
     * @param negativeApps 需临时屏蔽的 app 列表（通常为原默认 app）
     */
    fun applySelfHealing(
        query: String,
        newApp: String,
        candidates: List<String>,
        negativeApps: List<String>
    ) {
        if (query.isBlank() || newApp.isBlank()) return
        val queryKey = query.lowercase()

        // 1. 降低其他候选权重（-0.5），对齐 Rust self_healing.rs
        val weights = weightsStore.getOrPut(queryKey) { mutableMapOf() }
        for (app in candidates) {
            if (app != newApp) {
                weights[app] = (weights[app] ?: 0.5) - 0.5
            }
        }

        // 2. 临时屏蔽原默认 app 3 天
        val now = System.currentTimeMillis()
        val expireAt = now + BLOCK_FLAG_DEFAULT_DAYS * DAY_MS
        val flags = blockFlags.getOrPut(queryKey) { mutableListOf() }
        for (app in negativeApps) {
            if (app != newApp && flags.none { it.app == app }) {
                flags.add(BlockFlag(app = app, expireAt = expireAt))
            }
        }

        // 3. 提升 newApp 权重（+1.0）
        weights[newApp] = (weights[newApp] ?: 0.6) + 1.0

        // 更新该 query 的访问时间戳
        weightsTsStore[queryKey] = now
    }

    // ─── 四大清理子过程 ───────────────────────────────────────────────────

    /**
     * 全局时间衰减（对应 JS `_decayAllStaleQueries` / Rust `decay_all_stale_queries`）。
     *
     * 对所有 > 1 天未访问的 query 权重复用半衰期衰减模型，解决原算法仅在
     * 用户点击时才衰减的盲点。衰减向 0.5 指数收敛（保留历史，不完全清除），
     * 并受 MIN_FLOOR 下限保护。
     *
     * @return 权重发生变化的 query 数
     */
    private fun decayAllStaleQueries(): Int {
        if (weightsTsStore.isEmpty()) return 0
        val now = System.currentTimeMillis()
        var decayedCount = 0

        for ((queryKey, lastTs) in weightsTsStore) {
            if (lastTs <= 0L) continue
            val daysSince = (now - lastTs).toDouble() / DAY_MS
            if (daysSince < STALE_THRESHOLD_DAYS) continue

            val weights = weightsStore[queryKey] ?: continue
            // 半衰期衰减因子：0.5^(days/30)
            val decayFactor = 0.5.pow(daysSince / DECAY_HALF_LIFE_DAYS)
            var changed = false

            for ((app, cur) in weights.toMap()) {
                // 向 0.5 指数收敛（与 JS `_applyTimeDecayToQuery` 一致）
                var decayed = 0.5 + (cur - 0.5) * decayFactor
                decayed = max(WEIGHT_DECAY_MIN_FLOOR, decayed)
                decayed = decayed.coerceIn(0.0, 1.0)
                if (abs(decayed - cur) > 0.001) {
                    weights[app] = decayed
                    changed = true
                }
            }
            if (changed) decayedCount++
        }
        return decayedCount
    }

    /**
     * 链式边修剪（对应 JS `_pruneChainStore` / Rust `prune_chain_store`）。
     *
     * 阶段 1：每个 from-key 内清理 weight < 1 的边，且每节点最多保留 20 个 to-key
     *         （超出按权重降序截断）；
     * 阶段 2：全局总边数 > 500 时按权重降序截断。
     *
     * @return 被修剪的边数
     */
    private fun pruneChainStore(): Int {
        var prunedEdges = 0

        // 阶段 1：每 from-key 内清理低权重 + 限制每节点边数
        val emptyKeys = mutableListOf<String>()
        for ((fromKey, edges) in chainStore) {
            // 清理低于阈值的边
            val lowWeightIt = edges.iterator()
            while (lowWeightIt.hasNext()) {
                if (lowWeightIt.next().weight < CHAIN_MIN_WEIGHT) {
                    lowWeightIt.remove()
                    prunedEdges++
                }
            }
            // 每节点超出上限时按权重降序剪掉
            if (edges.size > CHAIN_MAX_PER_NODE) {
                val keepCount = edges.size - CHAIN_MAX_PER_NODE
                // 降序排序后移除末尾 keepCount 个（权重最低的）
                edges.sortByDescending { it.weight }
                val removed = edges.subList(edges.size - keepCount, edges.size).toList()
                prunedEdges += removed.size
                edges.subList(edges.size - keepCount, edges.size).clear()
            }
            if (edges.isEmpty()) emptyKeys.add(fromKey)
        }
        for (k in emptyKeys) chainStore.remove(k)

        // 阶段 2：总边数超限时按权重降序截断
        var totalEdges = chainStore.values.sumOf { it.size }
        if (totalEdges > CHAIN_MAX_EDGES) {
            val allEdges = mutableListOf<Triple<String, ChainEdge, Double>>()
            for ((fromKey, edges) in chainStore) {
                for (e in edges) allEdges.add(Triple(fromKey, e, e.weight))
            }
            allEdges.sortByDescending { it.third }
            val keepList = allEdges.take(CHAIN_MAX_EDGES)
            prunedEdges += totalEdges - keepList.size

            // 重建 chainStore
            chainStore.clear()
            val grouped = keepList.groupBy { it.first }
            for ((fromKey, list) in grouped) {
                chainStore[fromKey] = list.map { it.second }.toMutableList()
            }
            totalEdges = chainStore.values.sumOf { it.size }
        }
        @Suppress("UNUSED_VARIABLE")
        val _remaining = totalEdges
        return prunedEdges
    }

    /**
     * 旧记忆修剪（对应 JS `_pruneOldMemory` / Rust `prune_old_memory`）。
     *
     * 清理 > 90 天的记忆记录，并按 220 条上限双层保险（保留最新的 220 条）。
     *
     * @return 被清理的记忆记录数
     */
    private fun pruneOldMemory(): Int {
        if (memoryStore.isEmpty()) return 0
        val cutoff = System.currentTimeMillis() - MEMORY_MAX_AGE_DAYS * DAY_MS
        val before = memoryStore.size

        // 阶段 1：按时间窗过滤
        memoryStore.removeAll { it.timestamp <= cutoff }

        // 阶段 2：按条数上限保险（保留最新的 N 条）
        if (memoryStore.size > MEMORY_MAX_RECORDS) {
            val dropCount = memoryStore.size - MEMORY_MAX_RECORDS
            repeat(dropCount) { memoryStore.removeAt(0) }
        }
        return before - memoryStore.size
    }

    /**
     * 清理过期屏蔽标记（对应 JS `clearExpiredBlockFlags` / Rust `clear_expired_block_flags`）。
     *
     * @return 被清理的标记数
     */
    private fun clearExpiredBlockFlags(): Int {
        if (blockFlags.isEmpty()) return 0
        val now = System.currentTimeMillis()
        var cleared = 0
        val emptyKeys = mutableListOf<String>()

        for ((queryKey, flags) in blockFlags) {
            val it = flags.iterator()
            while (it.hasNext()) {
                if (it.next().expireAt <= now) {
                    it.remove()
                    cleared++
                }
            }
            if (flags.isEmpty()) emptyKeys.add(queryKey)
        }
        for (k in emptyKeys) blockFlags.remove(k)
        return cleared
    }

    // ─── 数据类与常量 ─────────────────────────────────────────────────────

    /** 维护统计报告（对应 Rust `MaintenanceReport` / JS `maintain()` 返回值）。 */
    data class MaintenanceReport(
        val decayedQueries: Int,
        val prunedChainEdges: Int,
        val prunedMemoryRecords: Int,
        val clearedBlockFlags: Int,
        val durationMs: Long
    )

    companion object {
        /** 1 天的毫秒数。 */
        private const val DAY_MS = 86_400_000L

        /** 衰减过期阈值（天）：超过此天数未访问的 query 才衰减。 */
        const val STALE_THRESHOLD_DAYS = 1.0

        /** 链式边全局总上限。 */
        const val CHAIN_MAX_EDGES = 500
        /** 每个 from-key 最多保留的 to-key 数。 */
        const val CHAIN_MAX_PER_NODE = 20
        /** 链式边最低权重阈值，低于此值的边被清理。 */
        const val CHAIN_MIN_WEIGHT = 1.0

        /** 旧记忆保留天数。 */
        const val MEMORY_MAX_AGE_DAYS = 90.0
        /** 记忆记录条数上限。 */
        const val MEMORY_MAX_RECORDS = 220

        /** 屏蔽标记默认天数。 */
        const val BLOCK_FLAG_DEFAULT_DAYS = 3L

        /**
         * 权重衰减半衰期（天）。
         * 注意：与 JS `WEIGHT_DECAY.HALF_LIFE_DAYS` / Rust `WEIGHT_DECAY_HALF_LIFE_DAYS` 一致（30 天），
         * 保证三语言行为一致。
         */
        const val DECAY_HALF_LIFE_DAYS = 30.0

        /** 权重衰减下限：避免权重完全消失（保留一些历史）。 */
        const val WEIGHT_DECAY_MIN_FLOOR = 0.35
    }
}
