package com.appindex.Database

import android.content.ContentValues
import android.content.Context
import com.appindex.IndexData.AppIndexItem
import com.appindex.IndexData.CategoryInvertedIndex
import com.appindex.IndexData.CategorySynonymIndex
import com.appindex.IndexData.IndexType
import org.json.JSONObject

/**
 * 索引数据访问对象
 *
 * 涵盖：
 * - 应用索引主表（按 appId 查询）
 * - 拼音前缀树（按 path 查询）
 * - T9 数字索引
 * - 模糊匹配节点
 * - 分类倒排索引
 * - 分类近义词
 * - 中英文字典
 *
 * 设计要点：
 * - 整树序列化：以扁平化节点表存储树结构
 * - 父子引用：以 JSON 字符串存储 children 映射
 * - 启动时一次性预热，构建内存中的树/图结构供搜索引擎使用
 */
class IndexDao(context: Context) {

    private val db = AppDatabase.get(context)

    /* ──────────── 应用索引主表 ──────────── */

    fun upsertAppIndex(item: AppIndexItem) {
        val values = ContentValues().apply {
            put(AppIndexTable.COL_APP_ID, item.appId)
            put(AppIndexTable.COL_APP_NAME, item.appName)
            put(AppIndexTable.COL_PINYIN, item.pinyin)
            put(AppIndexTable.COL_PINYIN_INITIALS, item.pinyinInitials)
            put(AppIndexTable.COL_T9_DIGITS, item.t9Digits)
            put(AppIndexTable.COL_T9_FULL_DIGITS, item.t9FullDigits)
            put(AppIndexTable.COL_SHUANGPIN, item.shuangpin)
            put(AppIndexTable.COL_META_TAGS, JsonCodec.listToJson(item.metaTags))
            put(AppIndexTable.COL_CATEGORY_TAGS, JsonCodec.listToJson(item.categoryTags))
            put(AppIndexTable.COL_ENGLISH_TOKENS, JsonCodec.listToJson(item.englishTokens))
            put(AppIndexTable.COL_CHAR_SET, JsonCodec.charSetToJson(item.charSet))
            put(AppIndexTable.COL_INSTALL_TIME, item.installTime)
            put(AppIndexTable.COL_LAUNCH_COUNT, item.launchCount)
            put(AppIndexTable.COL_UPDATE_TIME, item.updateTime)
        }
        db.writableDatabase.insertWithOnConflict(
            AppIndexTable.NAME, null, values,
            android.database.sqlite.SQLiteDatabase.CONFLICT_REPLACE
        )
    }

    fun getAppIndex(appId: String): AppIndexItem? {
        val cursor = db.readableDatabase.query(
            AppIndexTable.NAME, null,
            "${AppIndexTable.COL_APP_ID} = ?", arrayOf(appId),
            null, null, null
        )
        return cursor.use { c ->
            if (!c.moveToFirst()) return null
            AppIndexItem(
                appId = appId,
                appName = c.getString(c.getColumnIndexOrThrow(AppIndexTable.COL_APP_NAME)),
                pinyin = c.getString(c.getColumnIndexOrThrow(AppIndexTable.COL_PINYIN)),
                pinyinInitials = c.getString(c.getColumnIndexOrThrow(AppIndexTable.COL_PINYIN_INITIALS)),
                t9Digits = c.getString(c.getColumnIndexOrThrow(AppIndexTable.COL_T9_DIGITS)),
                t9FullDigits = c.getString(c.getColumnIndexOrThrow(AppIndexTable.COL_T9_FULL_DIGITS)),
                shuangpin = c.getString(c.getColumnIndexOrThrow(AppIndexTable.COL_SHUANGPIN)),
                metaTags = JsonCodec.jsonToList(c.getString(c.getColumnIndexOrThrow(AppIndexTable.COL_META_TAGS))),
                categoryTags = JsonCodec.jsonToList(c.getString(c.getColumnIndexOrThrow(AppIndexTable.COL_CATEGORY_TAGS))),
                englishTokens = JsonCodec.jsonToList(c.getString(c.getColumnIndexOrThrow(AppIndexTable.COL_ENGLISH_TOKENS))),
                charSet = JsonCodec.jsonToCharSet(c.getString(c.getColumnIndexOrThrow(AppIndexTable.COL_CHAR_SET))),
                installTime = c.getLong(c.getColumnIndexOrThrow(AppIndexTable.COL_INSTALL_TIME)),
                launchCount = c.getInt(c.getColumnIndexOrThrow(AppIndexTable.COL_LAUNCH_COUNT)),
                updateTime = c.getLong(c.getColumnIndexOrThrow(AppIndexTable.COL_UPDATE_TIME))
            )
        }
    }

    fun getAllAppIds(): List<String> {
        val list = ArrayList<String>()
        val cursor = db.readableDatabase.query(
            AppIndexTable.NAME,
            arrayOf(AppIndexTable.COL_APP_ID),
            null, null, null, null, null
        )
        cursor.use { c ->
            while (c.moveToNext()) {
                list.add(c.getString(0))
            }
        }
        return list
    }

    fun deleteAppIndex(appId: String): Int {
        return db.writableDatabase.delete(
            AppIndexTable.NAME,
            "${AppIndexTable.COL_APP_ID} = ?", arrayOf(appId)
        )
    }

    /**
     * 批量写入：单事务
     */
    fun upsertAppIndexBatch(items: List<AppIndexItem>) {
        if (items.isEmpty()) return
        val sql = db.writableDatabase
        sql.beginTransaction()
        try {
            items.forEach { upsertAppIndex(it) }
            sql.setTransactionSuccessful()
        } finally {
            sql.endTransaction()
        }
    }

    /* ──────────── 拼音前缀树 ──────────── */

    fun upsertPinyinTrieNode(path: String, char: Char, appIds: List<String>) {
        val values = ContentValues().apply {
            put(PinyinTrieTable.COL_PATH, path)
            put(PinyinTrieTable.COL_CHAR, char.toString())
            put(PinyinTrieTable.COL_APP_IDS, JsonCodec.listToJson(appIds))
        }
        db.writableDatabase.insertWithOnConflict(
            PinyinTrieTable.NAME, null, values,
            android.database.sqlite.SQLiteDatabase.CONFLICT_REPLACE
        )
    }

    fun getPinyinTrieChildren(path: String): List<Pair<Char, List<String>>> {
        val result = ArrayList<Pair<Char, List<String>>>()
        // 注意：直接以子路径 path+char 的方式查询。这里简化：返回所有 path 以 prefix 开头的节点。
        val cursor = db.readableDatabase.query(
            PinyinTrieTable.NAME, null,
            "${PinyinTrieTable.COL_PATH} LIKE ?",
            arrayOf("$path%"),
            null, null, null
        )
        cursor.use { c ->
            while (c.moveToNext()) {
                val ch = c.getString(c.getColumnIndexOrThrow(PinyinTrieTable.COL_CHAR)).firstOrNull() ?: continue
                val ids = JsonCodec.jsonToList(
                    c.getString(c.getColumnIndexOrThrow(PinyinTrieTable.COL_APP_IDS))
                )
                result.add(ch to ids)
            }
        }
        return result
    }

    /* ──────────── T9 索引 ──────────── */

    fun upsertT9Node(path: String, digit: Char, appIds: List<String>) {
        val values = ContentValues().apply {
            put(T9IndexTable.COL_PATH, path)
            put(T9IndexTable.COL_DIGIT, digit.toString())
            put(T9IndexTable.COL_APP_IDS, JsonCodec.listToJson(appIds))
        }
        db.writableDatabase.insertWithOnConflict(
            T9IndexTable.NAME, null, values,
            android.database.sqlite.SQLiteDatabase.CONFLICT_REPLACE
        )
    }

    fun getT9Children(path: String): List<Pair<Char, List<String>>> {
        val result = ArrayList<Pair<Char, List<String>>>()
        val cursor = db.readableDatabase.query(
            T9IndexTable.NAME, null,
            "${T9IndexTable.COL_PATH} LIKE ?",
            arrayOf("$path%"),
            null, null, null
        )
        cursor.use { c ->
            while (c.moveToNext()) {
                val ch = c.getString(c.getColumnIndexOrThrow(T9IndexTable.COL_DIGIT)).firstOrNull() ?: continue
                val ids = JsonCodec.jsonToList(
                    c.getString(c.getColumnIndexOrThrow(T9IndexTable.COL_APP_IDS))
                )
                result.add(ch to ids)
            }
        }
        return result
    }

    /* ──────────── 模糊匹配节点 ──────────── */

    fun upsertFuzzyNode(
        nodeId: String,
        value: String,
        type: IndexType,
        children: Map<Char, String>,
        weight: Int,
        appIds: List<String>
    ) {
        val childrenObj = JSONObject()
        children.forEach { (k, v) -> childrenObj.put(k.toString(), v) }
        val childrenJson = childrenObj.toString()
        val values = ContentValues().apply {
            put(FuzzyIndexTable.COL_NODE_ID, nodeId)
            put(FuzzyIndexTable.COL_VALUE, value)
            put(FuzzyIndexTable.COL_TYPE, type.name)
            put(FuzzyIndexTable.COL_CHILDREN, childrenJson)
            put(FuzzyIndexTable.COL_WEIGHT, weight)
            put(FuzzyIndexTable.COL_APP_IDS, JsonCodec.listToJson(appIds))
        }
        db.writableDatabase.insertWithOnConflict(
            FuzzyIndexTable.NAME, null, values,
            android.database.sqlite.SQLiteDatabase.CONFLICT_REPLACE
        )
    }

    fun getFuzzyNodesByType(type: IndexType): List<FuzzyNodeRecord> {
        val list = ArrayList<FuzzyNodeRecord>()
        val cursor = db.readableDatabase.query(
            FuzzyIndexTable.NAME, null,
            "${FuzzyIndexTable.COL_TYPE} = ?", arrayOf(type.name),
            null, null, null
        )
        cursor.use { c ->
            while (c.moveToNext()) {
                val childrenJson = c.getString(c.getColumnIndexOrThrow(FuzzyIndexTable.COL_CHILDREN))
                val childrenObj = JSONObject(childrenJson)
                val children = LinkedHashMap<Char, String>()
                val childKeys = childrenObj.keys()
                while (childKeys.hasNext()) {
                    val k = childKeys.next()
                    val ch = k.firstOrNull() ?: ' '
                    children[ch] = childrenObj.optString(k)
                }
                list.add(
                    FuzzyNodeRecord(
                        nodeId = c.getString(c.getColumnIndexOrThrow(FuzzyIndexTable.COL_NODE_ID)),
                        value = c.getString(c.getColumnIndexOrThrow(FuzzyIndexTable.COL_VALUE)),
                        type = type,
                        children = children,
                        weight = c.getInt(c.getColumnIndexOrThrow(FuzzyIndexTable.COL_WEIGHT)),
                        appIds = JsonCodec.jsonToList(
                            c.getString(c.getColumnIndexOrThrow(FuzzyIndexTable.COL_APP_IDS))
                        )
                    )
                )
            }
        }
        return list
    }

    /* ──────────── 分类倒排索引 ──────────── */

    fun upsertCategoryIndex(category: CategoryInvertedIndex) {
        val values = ContentValues().apply {
            put(CategoryIndexTable.COL_CATEGORY, category.category)
            put(CategoryIndexTable.COL_CANONICAL_NAME, category.canonicalName)
            put(CategoryIndexTable.COL_APP_IDS, JsonCodec.listToJson(category.appIds.toList()))
            put(CategoryIndexTable.COL_SYNONYMS, JsonCodec.listToJson(category.synonyms))
            put(CategoryIndexTable.COL_PRIORITY, category.priority)
        }
        db.writableDatabase.insertWithOnConflict(
            CategoryIndexTable.NAME, null, values,
            android.database.sqlite.SQLiteDatabase.CONFLICT_REPLACE
        )
    }

    fun getCategoryIndex(category: String): CategoryInvertedIndex? {
        val cursor = db.readableDatabase.query(
            CategoryIndexTable.NAME, null,
            "${CategoryIndexTable.COL_CATEGORY} = ?", arrayOf(category),
            null, null, null
        )
        return cursor.use { c ->
            if (!c.moveToFirst()) return null
            CategoryInvertedIndex(
                category = category,
                canonicalName = c.getString(c.getColumnIndexOrThrow(CategoryIndexTable.COL_CANONICAL_NAME)),
                appIds = LinkedHashSet(JsonCodec.jsonToList(
                    c.getString(c.getColumnIndexOrThrow(CategoryIndexTable.COL_APP_IDS))
                )),
                synonyms = JsonCodec.jsonToList(
                    c.getString(c.getColumnIndexOrThrow(CategoryIndexTable.COL_SYNONYMS))
                ),
                priority = c.getInt(c.getColumnIndexOrThrow(CategoryIndexTable.COL_PRIORITY))
            )
        }
    }

    /* ──────────── 分类近义词 ──────────── */

    fun upsertCategorySynonym(index: CategorySynonymIndex) {
        val values = ContentValues().apply {
            put(CategorySynonymTable.COL_CANONICAL_NAME, index.canonicalName)
            put(CategorySynonymTable.COL_SYNONYMS, JsonCodec.listToJson(index.synonyms))
        }
        db.writableDatabase.insertWithOnConflict(
            CategorySynonymTable.NAME, null, values,
            android.database.sqlite.SQLiteDatabase.CONFLICT_REPLACE
        )
    }

    /* ──────────── 清理所有索引（重建前调用） ──────────── */

    fun clearAllIndices() {
        val sql = db.writableDatabase
        sql.beginTransaction()
        try {
            sql.execSQL("DELETE FROM ${AppIndexTable.NAME}")
            sql.execSQL("DELETE FROM ${PinyinTrieTable.NAME}")
            sql.execSQL("DELETE FROM ${T9IndexTable.NAME}")
            sql.execSQL("DELETE FROM ${FuzzyIndexTable.NAME}")
            sql.execSQL("DELETE FROM ${CategoryIndexTable.NAME}")
            sql.execSQL("DELETE FROM ${CategorySynonymTable.NAME}")
            sql.execSQL("DELETE FROM ${BilingualDictTable.NAME}")
            sql.setTransactionSuccessful()
        } finally {
            sql.endTransaction()
        }
    }
}

/**
 * 模糊节点读取结果
 */
data class FuzzyNodeRecord(
    val nodeId: String,
    val value: String,
    val type: IndexType,
    val children: Map<Char, String>,
    val weight: Int,
    val appIds: List<String>
)
