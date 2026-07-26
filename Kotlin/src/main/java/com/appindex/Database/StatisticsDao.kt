package com.appindex.Database

import android.content.ContentValues
import android.content.Context
import com.appindex.ConfigurationData.GestureItem
import com.appindex.ConfigurationData.ShortcutItem
import com.appindex.StatisticsData.AppDailyUsage
import com.appindex.StatisticsData.DailyStatistics
import com.appindex.StatisticsData.DayPeriod
import com.appindex.StatisticsData.GestureRecord
import com.appindex.StatisticsData.GestureStats
import com.appindex.StatisticsData.KeywordStats
import com.appindex.StatisticsData.SearchRecord
import com.appindex.StatisticsData.UsageRecord

/**
 * 统计数据访问对象
 *
 * 涵盖：
 * - 使用记录（高频写入）
 * - 搜索记录
 * - 手势记录
 * - 每日统计汇总
 * - 关键词统计
 * - 手势统计
 *
 * 注意：所有写操作都在事务内执行，避免大批量写入时锁竞争。
 */
class StatisticsDao(context: Context) {

    private val db = AppDatabase.get(context)

    /* ──────────── 使用记录 ──────────── */

    fun insertUsage(record: UsageRecord): Long {
        val values = ContentValues().apply {
            put(UsageRecordTable.COL_APP_ID, record.appId)
            put(UsageRecordTable.COL_LAUNCH_TIME, record.launchTime)
            put(UsageRecordTable.COL_DURATION_MS, record.durationMs)
            put(UsageRecordTable.COL_PERIOD, record.period.name)
            put(UsageRecordTable.COL_SEARCH_QUERY, record.searchQuery)
        }
        return db.writableDatabase.insert(UsageRecordTable.NAME, null, values)
    }

    fun getRecentUsage(limit: Int = 100): List<UsageRecord> {
        val list = ArrayList<UsageRecord>()
        val cursor = db.readableDatabase.query(
            UsageRecordTable.NAME, null, null, null, null, null,
            "${UsageRecordTable.COL_LAUNCH_TIME} DESC", limit.toString()
        )
        cursor.use {
            while (it.moveToNext()) {
                val periodName = it.getString(it.getColumnIndexOrThrow(UsageRecordTable.COL_PERIOD))
                val period = runCatching { DayPeriod.valueOf(periodName) }
                    .getOrDefault(DayPeriod.MORNING)
                list.add(
                    UsageRecord(
                        appId = it.getString(it.getColumnIndexOrThrow(UsageRecordTable.COL_APP_ID)),
                        launchTime = it.getLong(it.getColumnIndexOrThrow(UsageRecordTable.COL_LAUNCH_TIME)),
                        durationMs = it.getLong(it.getColumnIndexOrThrow(UsageRecordTable.COL_DURATION_MS)),
                        period = period,
                        searchQuery = it.getString(it.getColumnIndexOrThrow(UsageRecordTable.COL_SEARCH_QUERY))
                    )
                )
            }
        }
        return list
    }

    /* ──────────── 搜索记录 ──────────── */

    fun insertSearch(record: SearchRecord): Long {
        val values = ContentValues().apply {
            put(SearchRecordTable.COL_QUERY, record.query)
            put(SearchRecordTable.COL_SEARCH_TIME, record.searchTime)
            put(SearchRecordTable.COL_RESULT_COUNT, record.resultCount)
            put(SearchRecordTable.COL_CLICKED_APP_ID, record.clickedAppId)
            put(SearchRecordTable.COL_CLICK_POSITION, record.clickPosition)
            put(SearchRecordTable.COL_SUCCESS, if (record.success) 1 else 0)
            put(SearchRecordTable.COL_SEARCH_MODE, record.searchMode)
        }
        return db.writableDatabase.insert(SearchRecordTable.NAME, null, values)
    }

    /* ──────────── 手势记录 ──────────── */

    fun insertGestureRecord(record: GestureRecord): Long {
        val values = ContentValues().apply {
            put(GestureRecordTable.COL_GESTURE_ID, record.gestureId)
            put(GestureRecordTable.COL_PATTERN, record.pattern)
            put(GestureRecordTable.COL_TRIGGER_TIME, record.triggerTime)
            put(GestureRecordTable.COL_SUCCESS, if (record.success) 1 else 0)
            put(GestureRecordTable.COL_TARGET_APP_ID, record.targetAppId)
        }
        return db.writableDatabase.insert(GestureRecordTable.NAME, null, values)
    }

    /* ──────────── 每日统计汇总 ──────────── */

    fun upsertDailyUsage(date: String, usage: AppDailyUsage) {
        val values = ContentValues().apply {
            put(DailyStatisticsTable.COL_LAUNCH_COUNT, usage.launchCount)
            put(DailyStatisticsTable.COL_TOTAL_DURATION_MS, usage.totalDurationMs)
            put(DailyStatisticsTable.COL_LAST_USED_TIME, usage.lastUsedTime)
            put(DailyStatisticsTable.COL_PERIOD_DISTRIBUTION,
                JsonCodec.enumMapToJson(usage.periodDistribution))
        }
        val sql = db.writableDatabase
        sql.beginTransaction()
        try {
            sql.insertWithOnConflict(
                DailyStatisticsTable.NAME, null,
                values.apply {
                    put(DailyStatisticsTable.COL_DATE, date)
                    put(DailyStatisticsTable.COL_APP_ID, usage.appId)
                },
                android.database.sqlite.SQLiteDatabase.CONFLICT_REPLACE
            )
            sql.setTransactionSuccessful()
        } finally {
            sql.endTransaction()
        }
    }

    fun getDailyStatistics(date: String): DailyStatistics? {
        val sql = db.readableDatabase
        val dailyCursor = sql.query(
            DailyStatisticsTable.NAME, null,
            "${DailyStatisticsTable.COL_DATE} = ?", arrayOf(date),
            null, null, null
        )

        return dailyCursor.use { c ->
            if (!c.moveToFirst()) return null
            val totalLaunches = c.getInt(c.getColumnIndexOrThrow(DailyStatisticsTable.COL_LAUNCH_COUNT))
            val totalDuration = c.getLong(c.getColumnIndexOrThrow(DailyStatisticsTable.COL_TOTAL_DURATION_MS))
            val lastUsed = c.getLong(c.getColumnIndexOrThrow(DailyStatisticsTable.COL_LAST_USED_TIME))
            val periodJson = c.getString(c.getColumnIndexOrThrow(DailyStatisticsTable.COL_PERIOD_DISTRIBUTION))
            val appUsage = AppDailyUsage(
                appId = c.getString(c.getColumnIndexOrThrow(DailyStatisticsTable.COL_APP_ID)),
                launchCount = totalLaunches,
                totalDurationMs = totalDuration,
                lastUsedTime = lastUsed,
                periodDistribution = JsonCodec.jsonToEnumMap<DayPeriod>(periodJson)
            )
            DailyStatistics(
                date = date,
                totalLaunches = totalLaunches,
                totalDurationMs = totalDuration,
                appUsageMap = mapOf(appUsage.appId to appUsage)
            )
        }
    }

    /* ──────────── 关键词统计 ──────────── */

    fun upsertKeyword(stats: KeywordStats) {
        val values = ContentValues().apply {
            put(KeywordStatsTable.COL_KEYWORD, stats.keyword)
            put(KeywordStatsTable.COL_SEARCH_COUNT, stats.searchCount)
            put(KeywordStatsTable.COL_CLICK_COUNT, stats.clickCount)
            put(KeywordStatsTable.COL_CLICKED_APPS, JsonCodec.mapToJson(stats.clickedApps))
        }
        db.writableDatabase.insertWithOnConflict(
            KeywordStatsTable.NAME, null, values,
            android.database.sqlite.SQLiteDatabase.CONFLICT_REPLACE
        )
    }

    fun getKeyword(keyword: String): KeywordStats? {
        val cursor = db.readableDatabase.query(
            KeywordStatsTable.NAME, null,
            "${KeywordStatsTable.COL_KEYWORD} = ?", arrayOf(keyword),
            null, null, null
        )
        return cursor.use { c ->
            if (!c.moveToFirst()) return null
            KeywordStats(
                keyword = keyword,
                searchCount = c.getInt(c.getColumnIndexOrThrow(KeywordStatsTable.COL_SEARCH_COUNT)),
                clickCount = c.getInt(c.getColumnIndexOrThrow(KeywordStatsTable.COL_CLICK_COUNT)),
                clickedApps = JsonCodec.jsonToMap(
                    c.getString(c.getColumnIndexOrThrow(KeywordStatsTable.COL_CLICKED_APPS))
                )
            )
        }
    }

    fun getAllKeywords(): List<KeywordStats> {
        val list = ArrayList<KeywordStats>()
        val cursor = db.readableDatabase.query(
            KeywordStatsTable.NAME, null, null, null, null, null,
            "${KeywordStatsTable.COL_SEARCH_COUNT} DESC"
        )
        cursor.use { c ->
            while (c.moveToNext()) {
                list.add(
                    KeywordStats(
                        keyword = c.getString(c.getColumnIndexOrThrow(KeywordStatsTable.COL_KEYWORD)),
                        searchCount = c.getInt(c.getColumnIndexOrThrow(KeywordStatsTable.COL_SEARCH_COUNT)),
                        clickCount = c.getInt(c.getColumnIndexOrThrow(KeywordStatsTable.COL_CLICK_COUNT)),
                        clickedApps = JsonCodec.jsonToMap(
                            c.getString(c.getColumnIndexOrThrow(KeywordStatsTable.COL_CLICKED_APPS))
                        )
                    )
                )
            }
        }
        return list
    }

    /* ──────────── 手势统计 ──────────── */

    fun upsertGestureStats(stats: GestureStats) {
        val values = ContentValues().apply {
            put(GestureStatsTable.COL_GESTURE_ID, stats.gestureId)
            put(GestureStatsTable.COL_PATTERN, stats.pattern)
            put(GestureStatsTable.COL_TRIGGER_COUNT, stats.triggerCount)
            put(GestureStatsTable.COL_SUCCESS_COUNT, stats.successCount)
            put(GestureStatsTable.COL_LAST_TRIGGERED_TIME, stats.lastTriggeredTime)
        }
        db.writableDatabase.insertWithOnConflict(
            GestureStatsTable.NAME, null, values,
            android.database.sqlite.SQLiteDatabase.CONFLICT_REPLACE
        )
    }

    fun getAllGestureStats(): List<GestureStats> {
        val list = ArrayList<GestureStats>()
        val cursor = db.readableDatabase.query(
            GestureStatsTable.NAME, null, null, null, null, null,
            "${GestureStatsTable.COL_TRIGGER_COUNT} DESC"
        )
        cursor.use { c ->
            while (c.moveToNext()) {
                list.add(
                    GestureStats(
                        gestureId = c.getString(c.getColumnIndexOrThrow(GestureStatsTable.COL_GESTURE_ID)),
                        pattern = c.getString(c.getColumnIndexOrThrow(GestureStatsTable.COL_PATTERN)),
                        triggerCount = c.getInt(c.getColumnIndexOrThrow(GestureStatsTable.COL_TRIGGER_COUNT)),
                        successCount = c.getInt(c.getColumnIndexOrThrow(GestureStatsTable.COL_SUCCESS_COUNT)),
                        lastTriggeredTime = c.getLong(c.getColumnIndexOrThrow(GestureStatsTable.COL_LAST_TRIGGERED_TIME))
                    )
                )
            }
        }
        return list
    }

    /* ──────────── 快捷项 ──────────── */

    fun insertShortcut(item: ShortcutItem) {
        val values = ContentValues().apply {
            put(ShortcutTable.COL_ID, item.id)
            put(ShortcutTable.COL_KEYWORD, item.keyword)
            put(ShortcutTable.COL_APP_ID, item.appId)
            put(ShortcutTable.COL_ENABLED, if (item.enabled) 1 else 0)
            put(ShortcutTable.COL_ORDER, item.order)
            put(ShortcutTable.COL_UPDATED_AT, System.currentTimeMillis())
        }
        db.writableDatabase.insertWithOnConflict(
            ShortcutTable.NAME, null, values,
            android.database.sqlite.SQLiteDatabase.CONFLICT_REPLACE
        )
    }

    fun getAllShortcuts(): List<ShortcutItem> {
        val list = ArrayList<ShortcutItem>()
        val cursor = db.readableDatabase.query(
            ShortcutTable.NAME, null, null, null, null, null,
            "${ShortcutTable.COL_ORDER} ASC"
        )
        cursor.use { c ->
            while (c.moveToNext()) {
                list.add(
                    ShortcutItem(
                        id = c.getString(c.getColumnIndexOrThrow(ShortcutTable.COL_ID)),
                        keyword = c.getString(c.getColumnIndexOrThrow(ShortcutTable.COL_KEYWORD)),
                        appId = c.getString(c.getColumnIndexOrThrow(ShortcutTable.COL_APP_ID)),
                        enabled = c.getInt(c.getColumnIndexOrThrow(ShortcutTable.COL_ENABLED)) == 1,
                        order = c.getInt(c.getColumnIndexOrThrow(ShortcutTable.COL_ORDER))
                    )
                )
            }
        }
        return list
    }

    fun deleteShortcut(id: String): Int {
        return db.writableDatabase.delete(
            ShortcutTable.NAME,
            "${ShortcutTable.COL_ID} = ?", arrayOf(id)
        )
    }

    /* ──────────── 手势项 ──────────── */

    fun insertGestureItem(item: GestureItem) {
        val values = ContentValues().apply {
            put(GestureTable.COL_ID, item.id)
            put(GestureTable.COL_PATTERN, item.pattern)
            put(GestureTable.COL_ACTION_TYPE, item.actionType)
            put(GestureTable.COL_TARGET_APP_ID, item.targetAppId)
            put(GestureTable.COL_ENABLED, if (item.enabled) 1 else 0)
            put(GestureTable.COL_UPDATED_AT, System.currentTimeMillis())
        }
        db.writableDatabase.insertWithOnConflict(
            GestureTable.NAME, null, values,
            android.database.sqlite.SQLiteDatabase.CONFLICT_REPLACE
        )
    }

    fun getAllGestures(): List<GestureItem> {
        val list = ArrayList<GestureItem>()
        val cursor = db.readableDatabase.query(
            GestureTable.NAME, null, null, null, null, null, null
        )
        cursor.use { c ->
            while (c.moveToNext()) {
                list.add(
                    GestureItem(
                        id = c.getString(c.getColumnIndexOrThrow(GestureTable.COL_ID)),
                        pattern = c.getString(c.getColumnIndexOrThrow(GestureTable.COL_PATTERN)),
                        actionType = c.getString(c.getColumnIndexOrThrow(GestureTable.COL_ACTION_TYPE)),
                        targetAppId = c.getString(c.getColumnIndexOrThrow(GestureTable.COL_TARGET_APP_ID)),
                        enabled = c.getInt(c.getColumnIndexOrThrow(GestureTable.COL_ENABLED)) == 1
                    )
                )
            }
        }
        return list
    }

    fun deleteGesture(id: String): Int {
        return db.writableDatabase.delete(
            GestureTable.NAME,
            "${GestureTable.COL_ID} = ?", arrayOf(id)
        )
    }
}
