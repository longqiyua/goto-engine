package com.appindex.Database

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * 应用统一数据库
 *
 * 集中存储三块数据：
 * 1. 配置数据（ConfigurationData）：个性化、无障碍、快捷、搜索、高级配置
 * 2. 统计数据（StatisticsData）：使用记录、搜索记录、手势记录、每日汇总
 * 3. 索引数据（IndexData）：应用索引项、前缀树、T9索引、模糊匹配节点、分类倒排
 *
 * 设计原则：
 * - 单库单文件，避免多库同步问题
 * - 所有表均含 created_at / updated_at 字段便于审计
 * - 主键统一使用 TEXT（应用ID、用户ID、日期等天然字符串）
 * - 复合唯一约束在表内显式声明
 *
 * 版本策略：
 * - DB_VERSION=1 为初始版本
 * - 后续升级时新增 Migration 类并在 onUpgrade 中按版本号顺序应用
 */
class AppDatabase private constructor(context: Context) : SQLiteOpenHelper(
    context.applicationContext, DB_NAME, null, DB_VERSION
) {
    companion object {
        const val DB_NAME = "appindex.db"
        const val DB_VERSION = 1

        @Volatile
        private var INSTANCE: AppDatabase? = null

        fun get(context: Context): AppDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: AppDatabase(context).also { INSTANCE = it }
            }
        }
    }

    override fun onCreate(db: SQLiteDatabase) {
        // 配置数据表
        db.execSQL(ConfigTable.SQL_CREATE)
        db.execSQL(ConfigTable.SQL_INDEX_NAMESPACE)
        db.execSQL(ShortcutTable.SQL_CREATE)
        db.execSQL(ShortcutTable.SQL_INDEX_KEYWORD)
        db.execSQL(GestureTable.SQL_CREATE)

        // 统计数据表
        db.execSQL(UsageRecordTable.SQL_CREATE)
        db.execSQL(UsageRecordTable.SQL_INDEX_APP_TIME)
        db.execSQL(UsageRecordTable.SQL_INDEX_TIME)
        db.execSQL(SearchRecordTable.SQL_CREATE)
        db.execSQL(SearchRecordTable.SQL_INDEX_QUERY)
        db.execSQL(SearchRecordTable.SQL_INDEX_TIME)
        db.execSQL(GestureRecordTable.SQL_CREATE)
        db.execSQL(DailyStatisticsTable.SQL_CREATE)
        db.execSQL(DailyStatisticsTable.SQL_INDEX_DATE)
        db.execSQL(KeywordStatsTable.SQL_CREATE)
        db.execSQL(GestureStatsTable.SQL_CREATE)

        // 索引数据表
        db.execSQL(AppIndexTable.SQL_CREATE)
        db.execSQL(AppIndexTable.SQL_INDEX_PINYIN)
        db.execSQL(AppIndexTable.SQL_INDEX_NAME)
        db.execSQL(PinyinTrieTable.SQL_CREATE)
        db.execSQL(T9IndexTable.SQL_CREATE)
        db.execSQL(FuzzyIndexTable.SQL_CREATE)
        db.execSQL(FuzzyIndexTable.SQL_INDEX_TYPE)
        db.execSQL(CategoryIndexTable.SQL_CREATE)
        db.execSQL(CategorySynonymTable.SQL_CREATE)
        db.execSQL(BilingualDictTable.SQL_CREATE)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // 未来版本升级时在此添加迁移逻辑
        // 当前为初始版本，无升级逻辑
    }

    /**
     * 通用插入/替换辅助方法
     */
    fun insertOrReplace(table: String, values: ContentValues): Long {
        val db = writableDatabase
        return db.insertWithOnConflict(table, null, values, SQLiteDatabase.CONFLICT_REPLACE)
    }
}
