package com.appindex.StatisticsData

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar

/**
 * 使用统计管理器 / Usage Statistics Manager（会员功能）
 *
 * 统计维度：
 * 1. 搜索次数 — 用户每次提交搜索 query 计数
 * 2. 打开次数 — 应用冷启动计数
 * 3. 使用时长 — 每次打开的累计使用时间（秒）
 * 4. 字符数 — 每次搜索输入的字符数累计
 * 5. App_Launches — 各应用启动次数 [{packageName, label, OpenTimes}]
 *
 * 数据持久化：SharedPreferences
 */
class UsageStatisticsManager(context: Context) {

    private val preferences: SharedPreferences =
        context.getSharedPreferences("appindex_stats", Context.MODE_PRIVATE)

    private var sessionStartTime: Long = 0L

    /** 搜索总次数 */
    val totalSearchCount: Int
        get() = preferences.getInt(KEY_SEARCH_COUNT, 0)

    /** 应用打开总次数 */
    val totalOpenCount: Int
        get() = preferences.getInt(KEY_OPEN_COUNT, 0)

    /** 累计使用时长（秒） */
    val totalUsageSeconds: Long
        get() = preferences.getLong(KEY_USAGE_SECONDS, 0)

    /** 累计输入字符数 */
    val totalCharacterCount: Int
        get() = preferences.getInt(KEY_CHARACTER_COUNT, 0)

    /** 格式化的使用时长 */
    val formattedUsageTime: String
        get() {
            val total = totalUsageSeconds
            val hours = total / SECONDS_PER_HOUR
            val minutes = (total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE
            return when {
                hours > 0 -> "${hours}小时${minutes}分钟"
                minutes > 0 -> "${minutes}分钟"
                else -> "${total}秒"
            }
        }

    /**
     * 记录一次搜索
     */
    fun recordSearch() {
        val count = preferences.getInt(KEY_SEARCH_COUNT, 0)
        preferences.edit().putInt(KEY_SEARCH_COUNT, count + 1).apply()
    }

    /**
     * 记录搜索字符数
     */
    fun recordCharacters(count: Int) {
        val total = preferences.getInt(KEY_CHARACTER_COUNT, 0)
        preferences.edit().putInt(KEY_CHARACTER_COUNT, total + count).apply()
    }

    /**
     * 记录一次应用打开（在 Application.onCreate 或 Activity.onCreate 调用）
     */
    fun recordApplicationOpen() {
        val count = preferences.getInt(KEY_OPEN_COUNT, 0)
        preferences.edit().putInt(KEY_OPEN_COUNT, count + 1).apply()
        sessionStartTime = System.currentTimeMillis()
    }

    /**
     * 记录会话结束（在 Activity.onPause/onStop 调用）
     */
    fun recordSessionEnd() {
        if (sessionStartTime > 0) {
            val elapsed = (System.currentTimeMillis() - sessionStartTime) / 1000
            if (elapsed > 0) {
                val total = preferences.getLong(KEY_USAGE_SECONDS, 0)
                preferences.edit().putLong(KEY_USAGE_SECONDS, total + elapsed).apply()
            }
            sessionStartTime = 0
        }
    }

    /**
     * 记录一次应用启动（从搜索结果点击打开）
     * 同时记录时段统计用于智能预测
     */
    fun recordApplicationLaunch(packageName: String, label: String) {
        val launchesJson = preferences.getString(KEY_APPLICATION_LAUNCHES, "[]")
        val launches = JSONArray(launchesJson)

        // 查找是否已有该应用
        var found = false
        for (index in 0 until launches.length()) {
            val item = launches.getJSONObject(index)
            if (item.getString(KEY_PACKAGE_NAME) == packageName) {
                item.put(KEY_OPEN_TIMES, item.getInt(KEY_OPEN_TIMES) + 1)
                found = true
                break
            }
        }

        if (!found) {
            launches.put(JSONObject().apply {
                put(KEY_PACKAGE_NAME, packageName)
                put(KEY_LABEL, label)
                put(KEY_OPEN_TIMES, 1)
            })
        }

        preferences.edit().putString(KEY_APPLICATION_LAUNCHES, launches.toString()).apply()

        // 记录时段统计
        recordTimeSlotLaunch(packageName, label)
    }

    /**
     * 记录时段启动统计（用于软稳定预测）
     * 时段划分：早(6-12) 午(12-18) 晚(18-24) 夜(0-6)
     */
    private fun recordTimeSlotLaunch(packageName: String, label: String) {
        val hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
        val timeSlot = when (hour) {
            in 6..11 -> TIMESLOT_MORNING
            in 12..17 -> TIMESLOT_AFTERNOON
            in 18..23 -> TIMESLOT_EVENING
            else -> TIMESLOT_NIGHT
        }

        val key = "${KEY_TIME_SLOT_PREFIX}_${timeSlot}"
        val slotJson = preferences.getString(key, "[]")
        val slotData = JSONArray(slotJson)

        var slotFound = false
        for (index in 0 until slotData.length()) {
            val item = slotData.getJSONObject(index)
            if (item.getString(KEY_PACKAGE_NAME) == packageName) {
                item.put(KEY_COUNT, item.getInt(KEY_COUNT) + 1)
                item.put(KEY_LAST_USED, System.currentTimeMillis())
                slotFound = true
                break
            }
        }

        if (!slotFound) {
            slotData.put(JSONObject().apply {
                put(KEY_PACKAGE_NAME, packageName)
                put(KEY_LABEL, label)
                put(KEY_COUNT, 1)
                put(KEY_LAST_USED, System.currentTimeMillis())
            })
        }

        preferences.edit().putString(key, slotData.toString()).apply()
    }

    /**
     * 获取本时段高频应用（3个）
     */
    fun getCurrentTimeSlotTopApplications(limit: Int = 3): List<ApplicationLaunchStatistic> {
        val hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
        val timeSlot = when (hour) {
            in 6..11 -> TIMESLOT_MORNING
            in 12..17 -> TIMESLOT_AFTERNOON
            in 18..23 -> TIMESLOT_EVENING
            else -> TIMESLOT_NIGHT
        }
        return getTimeSlotTopApplications(timeSlot, limit)
    }

    /**
     * 获取全天高频应用（2个）
     */
    fun getAllDayTopApplications(limit: Int = 2): List<ApplicationLaunchStatistic> {
        val launchesJson = preferences.getString(KEY_APPLICATION_LAUNCHES, "[]") ?: "[]"
        val launches = JSONArray(launchesJson)
        val statistics = mutableListOf<ApplicationLaunchStatistic>()

        for (index in 0 until launches.length()) {
            val item = launches.getJSONObject(index)
            statistics.add(
                ApplicationLaunchStatistic(
                    packageName = item.getString(KEY_PACKAGE_NAME),
                    label = item.getString(KEY_LABEL),
                    count = item.getInt(KEY_OPEN_TIMES)
                )
            )
        }

        return statistics.sortedByDescending { it.count }.take(limit)
    }

    /**
     * 获取指定时段的高频应用
     */
    private fun getTimeSlotTopApplications(timeSlot: String, limit: Int): List<ApplicationLaunchStatistic> {
        val key = "${KEY_TIME_SLOT_PREFIX}_${timeSlot}"
        val slotJson = preferences.getString(key, "[]") ?: "[]"
        val slotData = JSONArray(slotJson)
        val statistics = mutableListOf<ApplicationLaunchStatistic>()

        for (index in 0 until slotData.length()) {
            val item = slotData.getJSONObject(index)
            statistics.add(
                ApplicationLaunchStatistic(
                    packageName = item.getString(KEY_PACKAGE_NAME),
                    label = item.getString(KEY_LABEL),
                    count = item.getInt(KEY_COUNT)
                )
            )
        }

        return statistics.sortedByDescending { it.count }.take(limit)
    }

    /**
     * 获取 App_Launches JSON 数组（用于云端回传）
     */
    fun getApplicationLaunches(): JSONArray {
        val json = preferences.getString(KEY_APPLICATION_LAUNCHES, "[]") ?: "[]"
        return JSONArray(json)
    }

    /**
     * 获取自上次回传以来的增量数据（用于云端 update）
     */
    fun getDeltaSinceLastSync(): DeltaData {
        val lastSyncSearch = preferences.getInt(KEY_LAST_SYNC_SEARCH, 0)
        val lastSyncCharacter = preferences.getInt(KEY_LAST_SYNC_CHARACTER, 0)
        val lastSyncTime = preferences.getLong(KEY_LAST_SYNC_TIME, 0)

        val deltaSearch = totalSearchCount - lastSyncSearch
        val deltaCharacter = totalCharacterCount - lastSyncCharacter
        val deltaTime = (totalUsageSeconds - lastSyncTime).toInt().coerceAtLeast(0)

        return DeltaData(
            addDay = if (deltaSearch > 0 || deltaTime > 0) 1 else 0,
            addCharacter = deltaCharacter,
            addTime = deltaTime,
            applicationLaunches = getApplicationLaunches()
        )
    }

    /**
     * 标记已同步（回传成功后调用）
     */
    fun markSynced() {
        preferences.edit().apply {
            putInt(KEY_LAST_SYNC_SEARCH, totalSearchCount)
            putInt(KEY_LAST_SYNC_CHARACTER, totalCharacterCount)
            putLong(KEY_LAST_SYNC_TIME, totalUsageSeconds)
        }.apply()
    }

    /**
     * 清空所有统计数据
     */
    fun clearAll() {
        preferences.edit().clear().apply()
        sessionStartTime = 0
    }

    data class DeltaData(
        val addDay: Int,
        val addCharacter: Int,
        val addTime: Int,
        val applicationLaunches: JSONArray
    )

    /**
     * 应用启动统计数据
     */
    data class ApplicationLaunchStatistic(
        val packageName: String,
        val label: String,
        val count: Int
    )

    companion object {
        // SharedPreferences Key 常量
        private const val KEY_SEARCH_COUNT = "stat_search_count"
        private const val KEY_OPEN_COUNT = "stat_open_count"
        private const val KEY_USAGE_SECONDS = "stat_usage_seconds"
        private const val KEY_CHARACTER_COUNT = "stat_char_count"
        private const val KEY_APPLICATION_LAUNCHES = "stat_app_launches"
        private const val KEY_LAST_SYNC_SEARCH = "last_sync_search"
        private const val KEY_LAST_SYNC_CHARACTER = "last_sync_char"
        private const val KEY_LAST_SYNC_TIME = "last_sync_time"
        private const val KEY_TIME_SLOT_PREFIX = "stat_timeslot"

        // JSON 字段 Key
        private const val KEY_PACKAGE_NAME = "packageName"
        private const val KEY_LABEL = "label"
        private const val KEY_COUNT = "count"
        private const val KEY_LAST_USED = "lastUsed"
        private const val KEY_OPEN_TIMES = "OpenTimes"

        // 时段标识
        private const val TIMESLOT_MORNING = "morning"
        private const val TIMESLOT_AFTERNOON = "afternoon"
        private const val TIMESLOT_EVENING = "evening"
        private const val TIMESLOT_NIGHT = "night"

        // 时间换算常量
        private const val SECONDS_PER_MINUTE = 60L
        private const val SECONDS_PER_HOUR = 3600L
    }
}
