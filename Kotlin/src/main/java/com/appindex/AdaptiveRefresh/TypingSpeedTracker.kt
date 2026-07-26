package com.appindex.Personalization

import android.content.Context
import android.content.SharedPreferences
import java.util.Locale
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║         双轨制打字速度跟踪器 v2 — 防抖/节流自适应刷新引擎                       ║
 * ║                                                                              ║
 * ║  核心特性：                                                                    ║
 * ║  1. 【双轨制】同时统计中文字数速度和英文WPM速度                                ║
 * ║  2. 【按键间隔分析】T_avg 平均间隔 / σ² 方差 / P_max 最大速度                  ║
 * ║  3. 【错误率检测】退格键频率 → 错误率 E                                       ║
 * ║  4. 【防抖计算】t1 = clamp(P_max × (1+E), T_avg × 2, 400ms)                  ║
 * ║  5. 【节流计算】t2 = clamp(T_avg × (1+√σ²/T_avg), 30ms, T_avg × 1.5)       ║
 * ║  6. 【系统语言感知】中文系统主显"字/分钟"，英文系统主显"WPM"                   ║
 * ║                                                                              ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */
class TypingSpeedTracker(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)

    /** 系统语言是否为中文 */
    val isChineseLocale: Boolean
        get() {
            val lang = Locale.getDefault().language
            return lang == Locale.CHINESE.language || lang == Locale.SIMPLIFIED_CHINESE.language ||
                    lang == Locale.TRADITIONAL_CHINESE.language || lang == "zh"
        }

    // ═══════════════════════════════════════════════════════════════════════════
    //  按键间隔跟踪（用于防抖/节流公式）
    // ═══════════════════════════════════════════════════════════════════════════

    /** 按键间隔历史（毫秒） */
    private val keystrokeIntervals = ConcurrentLinkedQueue<Long>()

    /** 间隔窗口大小 */
    private val INTERVAL_WINDOW_SIZE = 20

    /** 上次按键时间 */
    private var lastKeystrokeTime: Long = 0L

    /** 退格键计数 */
    private var backspaceCount = 0

    /** 总按键次数 */
    private var totalKeystrokes = 0

    // ═══════════════════════════════════════════════════════════════════════════
    //  会话级输入跟踪
    // ═══════════════════════════════════════════════════════════════════════════

    private val sessionRecords = ConcurrentLinkedQueue<InputRecord>()
    private val WINDOW_SIZE = 10
    private var sessionStartTime: Long = 0L
    private var sessionChineseChars = 0
    private var sessionWordCount = 0
    private var sessionTotalChars = 0
    private var isTracking = false
    private var lastInputTime: Long = 0L
    private val SESSION_TIMEOUT_MS = 30000L

    data class InputRecord(
        val timestamp: Long,
        val chineseCharCount: Int,
        val wordCount: Int,
        val totalCharCount: Int,
        val durationMs: Long
    )

    // ═══════════════════════════════════════════════════════════════════════════
    //  持久化统计数据
    // ═══════════════════════════════════════════════════════════════════════════

    val avgChineseSpeed: Int get() = prefs.getInt(KEY_AVG_CHINESE_SPEED, 0)
    val avgWpmSpeed: Int get() = prefs.getInt(KEY_AVG_WPM_SPEED, 0)
    val totalSessions: Int get() = prefs.getInt(KEY_TOTAL_SESSIONS, 0)
    val totalChineseChars: Int get() = prefs.getInt(KEY_TOTAL_CHINESE_CHARS, 0)
    val totalWordCount: Int get() = prefs.getInt(KEY_TOTAL_WORD_COUNT, 0)

    // ═══════════════════════════════════════════════════════════════════════════
    //  公共 API
    // ═══════════════════════════════════════════════════════════════════════════

    fun startTracking() {
        val now = System.currentTimeMillis()
        if (lastInputTime > 0 && now - lastInputTime > SESSION_TIMEOUT_MS) {
            endSession()
        }
        if (!isTracking) {
            sessionStartTime = now
            sessionChineseChars = 0
            sessionWordCount = 0
            sessionTotalChars = 0
            backspaceCount = 0
            totalKeystrokes = 0
            keystrokeIntervals.clear()
            lastKeystrokeTime = 0L
            isTracking = true
        }
    }

    /**
     * 记录输入内容
     * @param input 用户输入的字符串
     * @param isBackspace 是否为退格操作
     */
    fun recordInput(input: String, isBackspace: Boolean = false) {
        val now = System.currentTimeMillis()
        lastInputTime = now

        if (!isTracking) startTracking()

        // 统计退格键
        if (isBackspace) {
            backspaceCount++
            totalKeystrokes++
            return
        }

        // 记录按键间隔
        if (lastKeystrokeTime > 0) {
            val interval = now - lastKeystrokeTime
            if (interval in 10..5000) { // 过滤异常值
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
        val totalChars = input.length

        sessionChineseChars += chineseCount
        sessionWordCount += words
        sessionTotalChars += totalChars

        val record = InputRecord(
            timestamp = now,
            chineseCharCount = chineseCount,
            wordCount = words,
            totalCharCount = totalChars,
            durationMs = now - sessionStartTime
        )
        sessionRecords.add(record)
        while (sessionRecords.size > WINDOW_SIZE) {
            sessionRecords.poll()
        }
    }

    fun endSession(): SpeedResult {
        if (!isTracking || sessionStartTime == 0L) {
            return SpeedResult(0, 0)
        }
        val durationMinutes = (lastInputTime - sessionStartTime).coerceAtLeast(1000L) / 60000.0
        val safeDuration = durationMinutes.coerceAtLeast(1.0 / 60.0)
        val chineseSpeed = (sessionChineseChars / safeDuration).roundToInt()
        val wpmSpeed = (sessionWordCount / safeDuration).roundToInt()
        updatePersistentStats(chineseSpeed, wpmSpeed)
        isTracking = false
        sessionStartTime = 0L
        sessionChineseChars = 0
        sessionWordCount = 0
        sessionTotalChars = 0
        return SpeedResult(chineseSpeed, wpmSpeed)
    }

    fun getCurrentSpeed(): SpeedResult {
        if (sessionRecords.isEmpty()) {
            return SpeedResult(avgChineseSpeed, avgWpmSpeed)
        }
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

    // ═══════════════════════════════════════════════════════════════════════════
    //  核心公式：防抖 t1 和 节流 t2
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * 计算防抖时间 t1（毫秒）
     * 公式: t1 = clamp(P_max × (1 + E), T_avg × 2, 400ms)
     * 含义: 用户停止输入后等待多久才开始搜索
     */
    fun calculateDebounceTime(): Long {
        val intervals = keystrokeIntervals.toList()
        if (intervals.size < 2) return 200L

        val tAvg = intervals.average()
        val pMax = intervals.minOrNull()?.toDouble() ?: tAvg
        val e = calculateErrorRate()

        val t1 = pMax * (1.0 + e)
        val lowerBound = tAvg * 2.0
        val upperBound = 400.0

        return t1.coerceIn(lowerBound, upperBound).roundToInt().toLong()
    }

    /**
     * 计算节流时间 t2（毫秒）
     * 公式: t2 = clamp(T_avg × (1 + sqrt(σ²) / T_avg), 30ms, T_avg × 1.5)
     * 含义: 两次搜索之间的最小间隔
     */
    fun calculateThrottleTime(): Long {
        val intervals = keystrokeIntervals.toList()
        if (intervals.size < 2) return 100L

        val tAvg = intervals.average()
        val variance = calculateVariance(intervals, tAvg)
        val stdDev = sqrt(variance)

        val t2 = tAvg * (1.0 + stdDev / tAvg)
        val lowerBound = 30.0
        val upperBound = tAvg * 1.5

        return t2.coerceIn(lowerBound, upperBound).roundToInt().toLong()
    }

    /**
     * 综合自适应延迟 = max(t1, t2)
     * 同时满足防抖和节流要求
     */
    fun calculateAdaptiveDelay(): Long {
        val t1 = calculateDebounceTime()
        val t2 = calculateThrottleTime()
        return maxOf(t1, t2)
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  统计参数暴露（用于UI显示）
    // ═══════════════════════════════════════════════════════════════════════════

    /** 获取所有计算参数的完整信息 */
    fun getTimingStats(): TimingStats {
        val intervals = keystrokeIntervals.toList()
        if (intervals.size < 2) {
            return TimingStats.EMPTY
        }

        val tAvg = intervals.average()
        val tMin = intervals.minOrNull()?.toDouble() ?: tAvg
        val tMax = intervals.maxOrNull()?.toDouble() ?: tAvg
        val variance = calculateVariance(intervals, tAvg)
        val stdDev = sqrt(variance)
        val e = calculateErrorRate()
        val t1 = calculateDebounceTime()
        val t2 = calculateThrottleTime()
        val adaptiveDelay = calculateAdaptiveDelay()

        return TimingStats(
            tAvg = tAvg,
            tMin = tMin,
            tMax = tMax,
            variance = variance,
            stdDev = stdDev,
            errorRate = e,
            debounceTime = t1,
            throttleTime = t2,
            adaptiveDelay = adaptiveDelay,
            sampleCount = intervals.size,
            backspaceCount = backspaceCount,
            totalKeystrokes = totalKeystrokes
        )
    }

    /** 参数显示字符串（一体化UI） */
    fun getParamsDisplay(): String {
        val stats = getTimingStats()
        if (stats.sampleCount < 2) {
            return "采样中... 输入更多字符以激活自适应"
        }

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

    // ═══════════════════════════════════════════════════════════════════════════
    //  兼容旧版 API
    // ═══════════════════════════════════════════════════════════════════════════

    fun calculateAdaptiveInterval(): Int {
        return calculateAdaptiveDelay().toInt().coerceIn(80, 400)
    }

    fun getDisplaySpeed(speed: SpeedResult = getCurrentSpeed()): String {
        return if (isChineseLocale) {
            "${speed.chineseCharsPerMinute} 字/分钟 | ${speed.wpm} WPM"
        } else {
            "${speed.wpm} WPM | ${speed.chineseCharsPerMinute} 字/min"
        }
    }

    fun getPrimarySpeed(speed: SpeedResult = getCurrentSpeed()): Int {
        return if (isChineseLocale) speed.chineseCharsPerMinute else speed.wpm
    }

    fun getPrimaryUnit(): String = if (isChineseLocale) "字/分钟" else "WPM"

    fun getSecondarySpeed(speed: SpeedResult = getCurrentSpeed()): Int {
        return if (isChineseLocale) speed.wpm else speed.chineseCharsPerMinute
    }

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
        sessionTotalChars = 0
        lastInputTime = 0L
        lastKeystrokeTime = 0L
        backspaceCount = 0
        totalKeystrokes = 0
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  内部计算
    // ═══════════════════════════════════════════════════════════════════════════

    private fun calculateErrorRate(): Double {
        if (totalKeystrokes == 0) return 0.0
        return (backspaceCount.toDouble() / totalKeystrokes).coerceIn(0.0, 1.0)
    }

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

    // ═══════════════════════════════════════════════════════════════════════════
    //  数据类
    // ═══════════════════════════════════════════════════════════════════════════

    data class SpeedResult(val chineseCharsPerMinute: Int, val wpm: Int) {
        fun format(isChineseLocale: Boolean): String =
            if (isChineseLocale) "$chineseCharsPerMinute 字/分钟 | $wpm WPM"
            else "$wpm WPM | $chineseCharsPerMinute 字/min"
    }

    /**
     * 完整计时统计参数（用于UI显示和公式验证）
     */
    data class TimingStats(
        val tAvg: Double,           // 平均按键间隔 (ms)
        val tMin: Double,           // 最小按键间隔 = P_max (ms)
        val tMax: Double,           // 最大按键间隔 (ms)
        val variance: Double,       // 方差 σ²
        val stdDev: Double,         // 标准差 √σ²
        val errorRate: Double,      // 错误率 E
        val debounceTime: Long,     // 防抖时间 t1 (ms)
        val throttleTime: Long,     // 节流时间 t2 (ms)
        val adaptiveDelay: Long,    // 综合自适应延迟 (ms)
        val sampleCount: Int,       // 样本数
        val backspaceCount: Int,    // 退格次数
        val totalKeystrokes: Int    // 总按键次数
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
        const val MIN_INTERVAL_MS = 80
        const val MAX_INTERVAL_MS = 400
    }
}
