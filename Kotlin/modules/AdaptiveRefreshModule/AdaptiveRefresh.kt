package com.appindex.modules.adaptiverefresh

import android.content.Context
import android.content.SharedPreferences
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
import java.util.Locale
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * 自适应刷新模块 (AdaptiveRefreshModule)
 *
 * 该模块提供可丢弃搜索 (Discardable Search) 调度能力，结合用户打字速度实时计算
 * 防抖 (Debounce) 与节流 (Throttle) 参数，从而在保证响应速度的前提下降低搜索频率。
 *
 * 主要功能：
 * 1. 双轨打字速度测量：中文（字/分钟）与英文（WPM）
 * 2. 按键间隔分析：T_avg / σ² / P_max / 错误率 E
 * 3. 自适应防抖时间 t1 = clamp(P_max × (1+E), T_avg × 2, 400ms)
 * 4. 自适应节流时间 t2 = clamp(T_avg × (1+√σ²/T_avg), 30ms, T_avg × 1.5)
 * 5. 综合自适应延迟 = max(t1, t2)
 * 6. 搜索编排器：新输入到来时取消旧搜索，按 t1 防抖 + t2 节流执行新搜索
 *
 * 使用方式：
 * val tracker = TypingSpeedTracker(context)
 * val orchestrator = SearchOrchestrator(searchService, tracker)
 * orchestrator.submitSearch(query)
 *
 * 该模块不依赖 GoTo 主项目其他模块，可导出到其他 Android 应用中使用。
 */

// ═══════════════════════════════════════════════════════════════════════════
//  公共接口
// ═══════════════════════════════════════════════════════════════════════════

interface SearchService {
    fun search(query: String, mode: SearchMode = SearchMode.STANDARD)
}

enum class SearchMode { STANDARD, FUZZY }

// ═══════════════════════════════════════════════════════════════════════════
//  TypingSpeedTracker
// ═══════════════════════════════════════════════════════════════════════════

class TypingSpeedTracker(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)

    val isChineseLocale: Boolean
        get() {
            val lang = Locale.getDefault().language
            return lang == Locale.CHINESE.language ||
                    lang == Locale.SIMPLIFIED_CHINESE.language ||
                    lang == Locale.TRADITIONAL_CHINESE.language ||
                    lang == "zh"
        }

    private val keystrokeIntervals = ConcurrentLinkedQueue<Long>()
    private val INTERVAL_WINDOW_SIZE = 20
    private var lastKeystrokeTime: Long = 0L
    private var backspaceCount = 0
    private var totalKeystrokes = 0

    private val sessionRecords = ConcurrentLinkedQueue<InputRecord>()
    private val WINDOW_SIZE = 10
    private var sessionStartTime: Long = 0L
    private var sessionChineseChars = 0
    private var sessionWordCount = 0
    private var isTracking = false
    private var lastInputTime: Long = 0L
    private val SESSION_TIMEOUT_MS = 30000L

    data class InputRecord(
        val timestamp: Long,
        val chineseCharCount: Int,
        val wordCount: Int,
        val durationMs: Long
    )

    val avgChineseSpeed: Int get() = prefs.getInt(KEY_AVG_CHINESE_SPEED, 0)
    val avgWpmSpeed: Int get() = prefs.getInt(KEY_AVG_WPM_SPEED, 0)
    val totalSessions: Int get() = prefs.getInt(KEY_TOTAL_SESSIONS, 0)
    val totalChineseChars: Int get() = prefs.getInt(KEY_TOTAL_CHINESE_CHARS, 0)
    val totalWordCount: Int get() = prefs.getInt(KEY_TOTAL_WORD_COUNT, 0)

    fun startTracking() {
        val now = System.currentTimeMillis()
        if (lastInputTime > 0 && now - lastInputTime > SESSION_TIMEOUT_MS) {
            endSession()
        }
        if (!isTracking) {
            sessionStartTime = now
            sessionChineseChars = 0
            sessionWordCount = 0
            backspaceCount = 0
            totalKeystrokes = 0
            keystrokeIntervals.clear()
            lastKeystrokeTime = 0L
            isTracking = true
        }
    }

    fun recordInput(input: String, isBackspace: Boolean = false) {
        val now = System.currentTimeMillis()
        lastInputTime = now
        if (!isTracking) startTracking()

        if (isBackspace) {
            backspaceCount++
            totalKeystrokes++
            return
        }

        if (lastKeystrokeTime > 0) {
            val interval = now - lastKeystrokeTime
            if (interval in 10..5000) {
                keystrokeIntervals.add(interval)
                while (keystrokeIntervals.size > INTERVAL_WINDOW_SIZE) {
                    keystrokeIntervals.poll()
                }
            }
        }
        lastKeystrokeTime = now
        totalKeystrokes++

        val chineseCount = countChineseChars(input)
        val words = countWords(input)
        sessionChineseChars += chineseCount
        sessionWordCount += words

        sessionRecords.add(
            InputRecord(
                timestamp = now,
                chineseCharCount = chineseCount,
                wordCount = words,
                durationMs = now - sessionStartTime
            )
        )
        while (sessionRecords.size > WINDOW_SIZE) {
            sessionRecords.poll()
        }
    }

    fun endSession(): SpeedResult {
        if (!isTracking || sessionStartTime == 0L) return SpeedResult(0, 0)
        val durationMinutes = (lastInputTime - sessionStartTime).coerceAtLeast(1000L) / 60000.0
        val safeDuration = durationMinutes.coerceAtLeast(1.0 / 60.0)
        val chineseSpeed = (sessionChineseChars / safeDuration).roundToInt()
        val wpmSpeed = (sessionWordCount / safeDuration).roundToInt()
        updatePersistentStats(chineseSpeed, wpmSpeed)
        isTracking = false
        sessionStartTime = 0L
        sessionChineseChars = 0
        sessionWordCount = 0
        return SpeedResult(chineseSpeed, wpmSpeed)
    }

    fun getCurrentSpeed(): SpeedResult {
        if (sessionRecords.isEmpty()) return SpeedResult(avgChineseSpeed, avgWpmSpeed)
        val totalChinese = sessionRecords.sumOf { it.chineseCharCount.toLong() }.toInt()
        val totalWords = sessionRecords.sumOf { it.wordCount.toLong() }.toInt()
        val firstTime = sessionRecords.first().timestamp
        val lastTime = sessionRecords.last().timestamp
        val durationMinutes = (lastTime - firstTime).coerceAtLeast(1000L) / 60000.0
        val safeDuration = durationMinutes.coerceAtLeast(1.0 / 60.0)
        val chineseSpeed = (totalChinese / safeDuration).roundToInt()
        val wpmSpeed = (totalWords / safeDuration).roundToInt()
        return SpeedResult(chineseSpeed, wpmSpeed)
    }

    fun calculateDebounceTime(): Long {
        val intervals = keystrokeIntervals.toList()
        if (intervals.size < 2) return 200L
        val tAvg = intervals.average()
        val pMax = intervals.minOrNull()?.toDouble() ?: tAvg
        val e = calculateErrorRate()
        val t1 = pMax * (1.0 + e)
        return t1.coerceIn(tAvg * 2.0, 400.0).roundToInt().toLong()
    }

    fun calculateThrottleTime(): Long {
        val intervals = keystrokeIntervals.toList()
        if (intervals.size < 2) return 100L
        val tAvg = intervals.average()
        val variance = calculateVariance(intervals, tAvg)
        val stdDev = sqrt(variance)
        val t2 = tAvg * (1.0 + stdDev / tAvg)
        return t2.coerceIn(30.0, tAvg * 1.5).roundToInt().toLong()
    }

    fun calculateAdaptiveDelay(): Long = maxOf(calculateDebounceTime(), calculateThrottleTime())

    fun getTimingStats(): TimingStats {
        val intervals = keystrokeIntervals.toList()
        if (intervals.size < 2) return TimingStats.EMPTY
        val tAvg = intervals.average()
        val tMin = intervals.minOrNull()?.toDouble() ?: tAvg
        val tMax = intervals.maxOrNull()?.toDouble() ?: tAvg
        val variance = calculateVariance(intervals, tAvg)
        val stdDev = sqrt(variance)
        val e = calculateErrorRate()
        val t1 = calculateDebounceTime()
        val t2 = calculateThrottleTime()
        return TimingStats(
            tAvg = tAvg, tMin = tMin, tMax = tMax,
            variance = variance, stdDev = stdDev, errorRate = e,
            debounceTime = t1, throttleTime = t2, adaptiveDelay = maxOf(t1, t2),
            sampleCount = intervals.size, backspaceCount = backspaceCount,
            totalKeystrokes = totalKeystrokes
        )
    }

    fun getParamsDisplay(): String {
        val stats = getTimingStats()
        if (stats.sampleCount < 2) return "采样中... 输入更多字符以激活自适应"
        val speed = getCurrentSpeed()
        return buildString {
            append("T=${stats.tAvg.roundToInt()}ms ")
            append("σ=${stats.stdDev.roundToInt()}ms ")
            append("P=${stats.tMin.roundToInt()}ms ")
            append("E=${(stats.errorRate * 100).roundToInt()}% | ")
            append("t1=${stats.debounceTime}ms ")
            append("t2=${stats.throttleTime}ms | ")
            append("自适应=${stats.adaptiveDelay}ms | ")
            append(if (isChineseLocale) "${speed.chineseCharsPerMinute}字/min" else "${speed.wpm}WPM")
        }
    }

    fun calculateAdaptiveInterval(): Int = calculateAdaptiveDelay().toInt().coerceIn(80, 400)

    fun getDisplaySpeed(speed: SpeedResult = getCurrentSpeed()): String =
        if (isChineseLocale) "${speed.chineseCharsPerMinute} 字/分钟 | ${speed.wpm} WPM"
        else "${speed.wpm} WPM | ${speed.chineseCharsPerMinute} 字/min"

    fun getPrimarySpeed(speed: SpeedResult = getCurrentSpeed()): Int =
        if (isChineseLocale) speed.chineseCharsPerMinute else speed.wpm

    fun getPrimaryUnit(): String = if (isChineseLocale) "字/分钟" else "WPM"

    fun getSecondarySpeed(speed: SpeedResult = getCurrentSpeed()): Int =
        if (isChineseLocale) speed.wpm else speed.chineseCharsPerMinute

    fun getSecondaryUnit(): String = if (isChineseLocale) "WPM" else "字/分钟"

    fun resetStats() {
        prefs.edit().apply {
            putInt(KEY_AVG_CHINESE_SPEED, 0)
            putInt(KEY_AVG_WPM_SPEED, 0)
            putInt(KEY_TOTAL_SESSIONS, 0)
            putInt(KEY_TOTAL_CHINESE_CHARS, 0)
            putInt(KEY_TOTAL_WORD_COUNT, 0)
            apply()
        }
        sessionRecords.clear()
        keystrokeIntervals.clear()
        isTracking = false
        sessionStartTime = 0L
        sessionChineseChars = 0
        sessionWordCount = 0
        lastInputTime = 0L
        lastKeystrokeTime = 0L
        backspaceCount = 0
        totalKeystrokes = 0
    }

    private fun calculateErrorRate(): Double =
        if (totalKeystrokes == 0) 0.0 else (backspaceCount.toDouble() / totalKeystrokes).coerceIn(0.0, 1.0)

    private fun calculateVariance(values: List<Long>, mean: Double): Double {
        if (values.size < 2) return 0.0
        return values.sumOf { (it - mean) * (it - mean) } / values.size
    }

    private fun countChineseChars(text: String): Int {
        var count = 0
        for (c in text) {
            if (isChineseChar(c)) count++
        }
        return count
    }

    private fun isChineseChar(c: Char): Boolean {
        val code = c.code
        return (code in 0x4E00..0x9FFF) ||
                (code in 0x3400..0x4DBF) ||
                (code in 0x20000..0x2A6DF) ||
                (code in 0xF900..0xFAFF) ||
                (code in 0x2F800..0x2FA1F)
    }

    private fun countWords(text: String): Int {
        val nonSpaceChars = text.count { !it.isWhitespace() }
        return (nonSpaceChars / 5.0).roundToInt().coerceAtLeast(1)
    }

    private fun updatePersistentStats(chineseSpeed: Int, wpmSpeed: Int) {
        val currentSessions = totalSessions
        val newSessions = currentSessions + 1
        val newAvgChinese = if (currentSessions == 0) chineseSpeed
        else ((avgChineseSpeed * currentSessions + chineseSpeed) / newSessions).coerceAtLeast(0)
        val newAvgWpm = if (currentSessions == 0) wpmSpeed
        else ((avgWpmSpeed * currentSessions + wpmSpeed) / newSessions).coerceAtLeast(0)
        prefs.edit().apply {
            putInt(KEY_AVG_CHINESE_SPEED, newAvgChinese)
            putInt(KEY_AVG_WPM_SPEED, newAvgWpm)
            putInt(KEY_TOTAL_SESSIONS, newSessions)
            putInt(KEY_TOTAL_CHINESE_CHARS, totalChineseChars + sessionChineseChars)
            putInt(KEY_TOTAL_WORD_COUNT, totalWordCount + sessionWordCount)
            apply()
        }
    }

    data class SpeedResult(val chineseCharsPerMinute: Int, val wpm: Int)

    data class TimingStats(
        val tAvg: Double,
        val tMin: Double,
        val tMax: Double,
        val variance: Double,
        val stdDev: Double,
        val errorRate: Double,
        val debounceTime: Long,
        val throttleTime: Long,
        val adaptiveDelay: Long,
        val sampleCount: Int,
        val backspaceCount: Int,
        val totalKeystrokes: Int
    ) {
        companion object {
            val EMPTY = TimingStats(
                tAvg = 0.0, tMin = 0.0, tMax = 0.0,
                variance = 0.0, stdDev = 0.0, errorRate = 0.0,
                debounceTime = 200L, throttleTime = 100L, adaptiveDelay = 200L,
                sampleCount = 0, backspaceCount = 0, totalKeystrokes = 0
            )
        }
    }

    companion object {
        private const val PREF_NAME = "typing_speed_tracker"
        private const val KEY_AVG_CHINESE_SPEED = "avg_chinese_speed"
        private const val KEY_AVG_WPM_SPEED = "avg_wpm_speed"
        private const val KEY_TOTAL_SESSIONS = "total_sessions"
        private const val KEY_TOTAL_CHINESE_CHARS = "total_chinese_chars"
        private const val KEY_TOTAL_WORD_COUNT = "total_word_count"
        const val DEFAULT_INTERVAL_MS = 200
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SearchOrchestrator
// ═══════════════════════════════════════════════════════════════════════════

class SearchOrchestrator(
    private val searchService: SearchService,
    private val typingSpeedTracker: TypingSpeedTracker,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
) {

    private var debounceJob: Job? = null
    private var lastSearchTimestamp: Long = 0L
    private val mutex = Mutex()
    private var pendingQuery: String = ""
    private var pendingMode: SearchMode = SearchMode.STANDARD
    var onParamsUpdated: ((params: SearchParams) -> Unit)? = null

    fun submitSearch(query: String, mode: SearchMode = SearchMode.STANDARD) {
        scope.launch {
            mutex.withLock {
                pendingQuery = query
                pendingMode = mode
                debounceJob?.cancel()
                if (query.isNotBlank()) typingSpeedTracker.recordInput(query)
                val stats = typingSpeedTracker.getTimingStats()
                val params = SearchParams(
                    query = query,
                    tAvg = stats.tAvg, tMin = stats.tMin, stdDev = stats.stdDev,
                    errorRate = stats.errorRate, debounceTime = stats.debounceTime,
                    throttleTime = stats.throttleTime, adaptiveDelay = stats.adaptiveDelay,
                    sampleCount = stats.sampleCount, backspaceCount = stats.backspaceCount,
                    totalKeystrokes = stats.totalKeystrokes,
                    isReady = stats.sampleCount >= 2
                )
                onParamsUpdated?.invoke(params)

                if (query.isBlank()) {
                    searchService.search("")
                    return@withLock
                }
                val delayMs = if (stats.sampleCount >= 2) stats.adaptiveDelay else 200L
                debounceJob = scope.launch {
                    delay(delayMs)
                    executeSearchLocked()
                }
            }
        }
    }

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

    fun cancelAll() {
        scope.launch {
            mutex.withLock {
                debounceJob?.cancelAndJoin()
                debounceJob = null
            }
        }
    }

    fun release() {
        scope.launch { cancelAll() }
    }

    private suspend fun executeSearchLocked() {
        val query = pendingQuery
        val mode = pendingMode
        val stats = typingSpeedTracker.getTimingStats()
        val throttleMs = if (stats.sampleCount >= 2) stats.throttleTime else 50L
        val elapsedSinceLastSearch = System.currentTimeMillis() - lastSearchTimestamp
        if (elapsedSinceLastSearch < throttleMs && lastSearchTimestamp > 0) {
            delay(throttleMs - elapsedSinceLastSearch)
        }
        if (query != pendingQuery || !scope.isActive) return
        lastSearchTimestamp = System.currentTimeMillis()
        searchService.search(query, mode)
    }

    data class SearchParams(
        val query: String,
        val tAvg: Double,
        val tMin: Double,
        val stdDev: Double,
        val errorRate: Double,
        val debounceTime: Long,
        val throttleTime: Long,
        val adaptiveDelay: Long,
        val sampleCount: Int,
        val backspaceCount: Int,
        val totalKeystrokes: Int,
        val isReady: Boolean
    ) {
        fun formatDisplay(): String {
            if (!isReady) return "采样中... ($totalKeystrokes 键)"
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
