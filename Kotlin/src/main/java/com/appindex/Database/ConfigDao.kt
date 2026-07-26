package com.appindex.Database

import android.content.ContentValues
import android.content.Context
import com.appindex.ConfigurationData.ConfigEntry
import com.appindex.ConfigurationData.ConfigNamespace
import com.appindex.ConfigurationData.ConfigValueType
import com.appindex.ConfigurationData.ConfigTransaction

/**
 * 配置数据访问对象
 *
 * 负责 AppConfiguration 中所有键值型配置的持久化与读取。
 * 表设计采用 (namespace, key) 联合唯一，便于按命名空间批量查询。
 */
class ConfigDao(context: Context) {

    private val db = AppDatabase.get(context)

    /**
     * 写入单条配置（存在则替换）
     */
    fun put(entry: ConfigEntry, namespace: String = ConfigNamespace.PERSONALIZATION) {
        val values = ContentValues().apply {
            put(ConfigTable.COL_NAMESPACE, namespace)
            put(ConfigTable.COL_KEY, entry.key)
            put(ConfigTable.COL_VALUE, entry.value)
            put(ConfigTable.COL_VALUE_TYPE, entry.valueType.name)
            put(ConfigTable.COL_VERSION, entry.version)
            put(ConfigTable.COL_UPDATED_AT, entry.modifiedAt)
        }
        db.writableDatabase.insertWithOnConflict(
            ConfigTable.NAME, null, values,
            android.database.sqlite.SQLiteDatabase.CONFLICT_REPLACE
        )
    }

    /**
     * 事务化批量写入
     */
    fun putAll(transaction: ConfigTransaction) {
        val sql = db.writableDatabase
        sql.beginTransaction()
        try {
            transaction.entries.forEach { entry ->
                // entry 已包含 namespace 字段需自行维护；这里默认使用 PERSONALIZATION
                put(entry, ConfigNamespace.PERSONALIZATION)
            }
            sql.setTransactionSuccessful()
        } finally {
            sql.endTransaction()
        }
    }

    /**
     * 按命名空间获取所有配置项
     */
    fun getAllByNamespace(namespace: String): List<ConfigEntry> {
        val result = ArrayList<ConfigEntry>()
        val cursor = db.readableDatabase.query(
            ConfigTable.NAME,
            arrayOf(
                ConfigTable.COL_KEY,
                ConfigTable.COL_VALUE,
                ConfigTable.COL_VALUE_TYPE,
                ConfigTable.COL_VERSION,
                ConfigTable.COL_UPDATED_AT
            ),
            "${ConfigTable.COL_NAMESPACE} = ?",
            arrayOf(namespace),
            null, null, null
        )
        cursor.use {
            while (it.moveToNext()) {
                val typeName = it.getString(2)
                val type = runCatching { ConfigValueType.valueOf(typeName) }
                    .getOrDefault(ConfigValueType.STRING)
                result.add(
                    ConfigEntry(
                        key = it.getString(0),
                        value = it.getString(1),
                        valueType = type,
                        version = it.getInt(3),
                        modifiedAt = it.getLong(4)
                    )
                )
            }
        }
        return result
    }

    /**
     * 按命名空间+键读取单条
     */
    fun get(namespace: String, key: String): ConfigEntry? {
        val cursor = db.readableDatabase.query(
            ConfigTable.NAME,
            arrayOf(
                ConfigTable.COL_VALUE,
                ConfigTable.COL_VALUE_TYPE,
                ConfigTable.COL_VERSION,
                ConfigTable.COL_UPDATED_AT
            ),
            "${ConfigTable.COL_NAMESPACE} = ? AND ${ConfigTable.COL_KEY} = ?",
            arrayOf(namespace, key),
            null, null, null
        )
        cursor.use {
            if (!it.moveToFirst()) return null
            val typeName = it.getString(1)
            val type = runCatching { ConfigValueType.valueOf(typeName) }
                .getOrDefault(ConfigValueType.STRING)
            return ConfigEntry(
                key = key,
                value = it.getString(0),
                valueType = type,
                version = it.getInt(2),
                modifiedAt = it.getLong(3)
            )
        }
    }

    /**
     * 删除命名空间下某个键
     */
    fun delete(namespace: String, key: String): Int {
        return db.writableDatabase.delete(
            ConfigTable.NAME,
            "${ConfigTable.COL_NAMESPACE} = ? AND ${ConfigTable.COL_KEY} = ?",
            arrayOf(namespace, key)
        )
    }

    /**
     * 清空某个命名空间
     */
    fun clearNamespace(namespace: String): Int {
        return db.writableDatabase.delete(
            ConfigTable.NAME,
            "${ConfigTable.COL_NAMESPACE} = ?",
            arrayOf(namespace)
        )
    }
}
