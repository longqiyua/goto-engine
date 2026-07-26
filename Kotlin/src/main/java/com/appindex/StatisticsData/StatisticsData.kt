package com.appindex.StatisticsData

import java.io.Serializable

/**
 * 统计数据模块
 * 负责记录用户的软件使用情况，包括应用启动、搜索行为、手势操作等。
 * 为时段智能推荐、高频应用排序、使用习惯分析等功能提供数据支撑。
 */

/**
 * 时段类型：早晨、午间、晚间、夜间
 */
enum class DayPeriod {
    MORNING,    // 06:00 - 11:59
    NOON,       // 12:00 - 17:59
    EVENING,    // 18:00 - 21:59
    NIGHT       // 22:00 - 05:59
}

/**
 * 单次使用记录
 */
data class UsageRecord(
    val appId: String,
    val launchTime: Long,
    val durationMs: Long = 0L,
    val period: DayPeriod = DayPeriod.MORNING,
    val searchQuery: String? = null
) : Serializable

/**
 * 单次搜索记录
 */
data class SearchRecord(
    val query: String,
    val searchTime: Long,
    val resultCount: Int,
    val clickedAppId: String? = null,
    val clickPosition: Int = -1,
    val success: Boolean = false,
    val searchMode: String = "NORMAL"
) : Serializable

/**
 * 单次手势操作记录
 */
data class GestureRecord(
    val gestureId: String,
    val pattern: String,
    val triggerTime: Long,
    val success: Boolean,
    val targetAppId: String? = null
) : Serializable

/**
 * 应用每日使用统计
 */
data class AppDailyUsage(
    val appId: String,
    val launchCount: Int = 0,
    val totalDurationMs: Long = 0L,
    val lastUsedTime: Long = 0L,
    val periodDistribution: Map<DayPeriod, Int> = emptyMap()
) : Serializable

/**
 * 每日统计汇总
 */
data class DailyStatistics(
    val date: String,
    val totalLaunches: Int = 0,
    val totalDurationMs: Long = 0L,
    val totalSearches: Int = 0,
    val successfulSearches: Int = 0,
    val appUsageMap: Map<String, AppDailyUsage> = emptyMap(),
    val topKeywords: Map<String, Int> = emptyMap()
) : Serializable

/**
 * 关键词频次与点击映射
 */
data class KeywordStats(
    val keyword: String,
    val searchCount: Int = 0,
    val clickCount: Int = 0,
    val clickedApps: Map<String, Int> = emptyMap()
) : Serializable

/**
 * 手势使用统计
 */
data class GestureStats(
    val gestureId: String,
    val pattern: String,
    val triggerCount: Int = 0,
    val successCount: Int = 0,
    val lastTriggeredTime: Long = 0L
) : Serializable

/**
 * 全局统计摘要
 */
data class StatisticsSummary(
    val totalLaunches: Long = 0L,
    val totalSearches: Long = 0L,
    val totalDurationMs: Long = 0L,
    val activeDays: Int = 0,
    val favoriteApps: List<String> = emptyList(),
    val weeklyPattern: Map<String, Int> = emptyMap(),
    val periodPattern: Map<DayPeriod, Int> = emptyMap(),
    val topKeywords: List<KeywordStats> = emptyList(),
    val gestureStats: List<GestureStats> = emptyList()
) : Serializable
