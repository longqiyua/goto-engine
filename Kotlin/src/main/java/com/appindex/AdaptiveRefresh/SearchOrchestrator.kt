package com.appindex.AdaptiveRefresh

import com.appindex.BasicSearch.SearchService
import com.appindex.model.SearchMode
import com.appindex.Personalization.TypingSpeedTracker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.math.roundToInt

/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║              搜索编排器 / Search Orchestrator — 可丢弃搜索调度引擎               ║
 * ║                                                                              ║
 * ║  核心职责：                                                                    ║
 * ║  1. 【可丢弃搜索】新输入到来时立即取消正在进行的搜索，启动新搜索                  ║
 * ║  2. 【防抖 Debounce】用户停止输入后等待 t1 时间才开始搜索                       ║
 * ║  3. 【节流 Throttle】两次搜索之间至少间隔 t2 时间                               ║
 * ║  4. 【自适应延迟】基于 TypingSpeedTracker 的 t1/t2 动态调整                     ║
 * ║                                                                              ║
 * ║  工作流程：                                                                    ║
 * ║  用户输入"a" → 启动防抖计时器(t1) → 计时器到期 → 执行搜索"a"                   ║
 * ║  用户输入"b" → 取消旧计时器 + 取消旧搜索 → 重启防抖计时器(t1) → 搜索"ab"       ║
 * ║                                                                              ║
 * ║  示例（微信）：                                                                ║
 * ║  输入"微" → 计时器开始 → 输入"信" → 计时器重置 → 等待 → 搜索"微信"            ║
 * ║                                                                              ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */
class SearchOrchestrator(
    private val searchService: SearchService,
    private val typingSpeedTracker: TypingSpeedTracker,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
) {

    /** 防抖计时器任务 */
    private var debounceJob: Job? = null

    /** 上一次搜索触发的时间戳 */
    private var lastSearchTimestamp: Long = 0L

    /** 互斥锁，保证状态安全 */
    private val mutex = Mutex()

    /** 当前待执行的查询 */
    private var pendingQuery: String = ""

    /** 当前搜索模式 */
    private var pendingMode: SearchMode = SearchMode.STANDARD

    /** 参数更新回调（用于UI实时显示） */
    var onParamsUpdated: ((params: SearchParams) -> Unit)? = null

    /**
     * 提交搜索请求（立即触发丢弃逻辑）
     * @param query 搜索查询
     * @param mode 搜索模式
     */
    fun submitSearch(query: String, mode: SearchMode = SearchMode.STANDARD) {
        scope.launch {
            mutex.withLock {
                pendingQuery = query
                pendingMode = mode

                // 1. 取消旧的防抖计时器（核心：新输入丢弃旧搜索）
                debounceJob?.cancel()

                // 2. 记录输入到速度跟踪器
                if (query.isNotBlank()) {
                    typingSpeedTracker.recordInput(query)
                }

                // 3. 获取当前计算参数并通知UI
                val stats = typingSpeedTracker.getTimingStats()
                val params = SearchParams(
                    query = query,
                    tAvg = stats.tAvg,
                    tMin = stats.tMin,
                    stdDev = stats.stdDev,
                    errorRate = stats.errorRate,
                    debounceTime = stats.debounceTime,
                    throttleTime = stats.throttleTime,
                    adaptiveDelay = stats.adaptiveDelay,
                    sampleCount = stats.sampleCount,
                    backspaceCount = stats.backspaceCount,
                    totalKeystrokes = stats.totalKeystrokes,
                    isReady = stats.sampleCount >= 2
                )
                onParamsUpdated?.invoke(params)

                // 4. 空查询直接执行（无延迟）
                if (query.isBlank()) {
                    searchService.search("")
                    return@withLock
                }

                // 5. 启动新的防抖计时器（Debouncing）
                val delayMs = if (stats.sampleCount >= 2) {
                    stats.adaptiveDelay
                } else {
                    200L // 采样不足时使用默认延迟
                }

                debounceJob = scope.launch {
                    delay(delayMs)
                    executeSearchLocked()
                }
            }
        }
    }

    /**
     * 立即执行搜索（绕过防抖，用于快捷绑定等场景）
     */
    fun searchImmediate(query: String, mode: SearchMode = SearchMode.STANDARD) {
        scope.launch {
            mutex.withLock {
                debounceJob?.cancel()
                pendingQuery = query
                pendingMode = mode
                executeSearchLocked()
            }
        }
    }

    /**
     * 取消所有待处理搜索
     */
    fun cancelAll() {
        scope.launch {
            mutex.withLock {
                debounceJob?.cancelAndJoin()
                debounceJob = null
            }
        }
    }

    /**
     * 释放资源
     */
    fun release() {
        scope.launch {
            cancelAll()
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  内部方法（必须在 mutex 锁内调用）
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * 执行搜索（带节流检查）
     * Throttling：确保两次搜索之间至少间隔 t2 时间
     */
    private suspend fun executeSearchLocked() {
        val query = pendingQuery
        val mode = pendingMode

        // 节流检查：确保距离上次搜索至少 t2 时间
        val stats = typingSpeedTracker.getTimingStats()
        val throttleMs = if (stats.sampleCount >= 2) stats.throttleTime else 50L
        val elapsedSinceLastSearch = System.currentTimeMillis() - lastSearchTimestamp

        if (elapsedSinceLastSearch < throttleMs && lastSearchTimestamp > 0) {
            val remaining = throttleMs - elapsedSinceLastSearch
            delay(remaining)
        }

        // 再次检查：等待期间是否有新输入（可能被 debounceJob 取消）
        if (query != pendingQuery || !scope.isActive) {
            return
        }

        // 执行搜索（SearchService 内部会自动取消旧搜索）
        lastSearchTimestamp = System.currentTimeMillis()
        searchService.search(query, mode)
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  数据类
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * 搜索参数（用于UI实时显示）
     */
    data class SearchParams(
        val query: String,
        val tAvg: Double,              // 平均按键间隔
        val tMin: Double,              // 最小间隔 P_max
        val stdDev: Double,            // 标准差
        val errorRate: Double,         // 错误率 E
        val debounceTime: Long,        // 防抖时间 t1
        val throttleTime: Long,        // 节流时间 t2
        val adaptiveDelay: Long,       // 综合自适应延迟
        val sampleCount: Int,          // 样本数
        val backspaceCount: Int,       // 退格次数
        val totalKeystrokes: Int,      // 总按键次数
        val isReady: Boolean           // 是否有足够样本
    ) {
        /** 格式化显示所有参数 */
        fun formatDisplay(): String {
            if (!isReady) {
                return "采样中... ($totalKeystrokes 键)"
            }
            return buildString {
                append("T=${tAvg.roundToInt()}ms ")
                append("σ=${stdDev.roundToInt()}ms ")
                append("P=${tMin.roundToInt()}ms ")
                append("E=${(errorRate * 100).roundToInt()}% | ")
                append("t1=${debounceTime}ms ")
                append("t2=${throttleTime}ms | ")
                append("自适应=${adaptiveDelay}ms")
            }
        }
    }
}
