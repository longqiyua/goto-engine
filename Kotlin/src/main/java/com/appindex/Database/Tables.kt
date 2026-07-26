package com.appindex.Database

/**
 * 数据库表结构与Schema定义
 *
 * 命名规范：
 * - 表名使用 snake_case
 * - 字段名使用 snake_case
 * - 主键命名为 id（统一 TEXT 类型）
 * - 时间戳字段统一 created_at / updated_at（毫秒）
 */

/* ═══════════════════════════════════════════════════════════
 *  配置数据表
 * ═══════════════════════════════════════════════════════════ */

/**
 * 配置主表
 * 存储命名空间级别的配置项（personalization/accessibility/...）
 * key 格式：namespace.field（如 personalization.themeMode）
 */
object ConfigTable {
    const val NAME = "config"

    const val COL_ID = "id"              // 自增主键
    const val COL_NAMESPACE = "namespace" // personal/accessibility/...
    const val COL_KEY = "key"            // 字段名
    const val COL_VALUE = "value"        // 值（统一为字符串，运行时转换）
    const val COL_VALUE_TYPE = "value_type" // string/boolean/int/long/float/json
    const val COL_VERSION = "version"    // 配置版本
    const val COL_UPDATED_AT = "updated_at"

    const val SQL_CREATE = """
        CREATE TABLE $NAME (
            $COL_ID INTEGER PRIMARY KEY AUTOINCREMENT,
            $COL_NAMESPACE TEXT NOT NULL,
            $COL_KEY TEXT NOT NULL,
            $COL_VALUE TEXT NOT NULL,
            $COL_VALUE_TYPE TEXT NOT NULL DEFAULT 'string',
            $COL_VERSION INTEGER NOT NULL DEFAULT 1,
            $COL_UPDATED_AT INTEGER NOT NULL,
            UNIQUE($COL_NAMESPACE, $COL_KEY)
        )
    """

    const val SQL_INDEX_NAMESPACE = """
        CREATE INDEX idx_config_namespace ON $NAME($COL_NAMESPACE)
    """
}

/**
 * 快捷项表
 */
object ShortcutTable {
    const val NAME = "shortcut"

    const val COL_ID = "id"                  // 业务主键（如 shortcut_001）
    const val COL_KEYWORD = "keyword"
    const val COL_APP_ID = "app_id"
    const val COL_ENABLED = "enabled"        // 0/1
    const val COL_ORDER = "order_idx"
    const val COL_UPDATED_AT = "updated_at"

    const val SQL_CREATE = """
        CREATE TABLE $NAME (
            $COL_ID TEXT PRIMARY KEY,
            $COL_KEYWORD TEXT NOT NULL,
            $COL_APP_ID TEXT NOT NULL,
            $COL_ENABLED INTEGER NOT NULL DEFAULT 1,
            $COL_ORDER INTEGER NOT NULL DEFAULT 0,
            $COL_UPDATED_AT INTEGER NOT NULL
        )
    """

    const val SQL_INDEX_KEYWORD = """
        CREATE INDEX idx_shortcut_keyword ON $NAME($COL_KEYWORD)
    """
}

/**
 * 手势项表
 */
object GestureTable {
    const val NAME = "gesture"

    const val COL_ID = "id"
    const val COL_PATTERN = "pattern"
    const val COL_ACTION_TYPE = "action_type"
    const val COL_TARGET_APP_ID = "target_app_id"
    const val COL_ENABLED = "enabled"
    const val COL_UPDATED_AT = "updated_at"

    const val SQL_CREATE = """
        CREATE TABLE $NAME (
            $COL_ID TEXT PRIMARY KEY,
            $COL_PATTERN TEXT NOT NULL,
            $COL_ACTION_TYPE TEXT NOT NULL,
            $COL_TARGET_APP_ID TEXT,
            $COL_ENABLED INTEGER NOT NULL DEFAULT 1,
            $COL_UPDATED_AT INTEGER NOT NULL
        )
    """
}

/* ═══════════════════════════════════════════════════════════
 *  统计数据表
 * ═══════════════════════════════════════════════════════════ */

/**
 * 使用记录表（高频写入）
 * 单次应用启动事件
 */
object UsageRecordTable {
    const val NAME = "usage_record"

    const val COL_ID = "id"                // 自增主键
    const val COL_APP_ID = "app_id"
    const val COL_LAUNCH_TIME = "launch_time" // 毫秒时间戳
    const val COL_DURATION_MS = "duration_ms"
    const val COL_PERIOD = "period"        // morning/noon/evening/night
    const val COL_SEARCH_QUERY = "search_query"

    const val SQL_CREATE = """
        CREATE TABLE $NAME (
            $COL_ID INTEGER PRIMARY KEY AUTOINCREMENT,
            $COL_APP_ID TEXT NOT NULL,
            $COL_LAUNCH_TIME INTEGER NOT NULL,
            $COL_DURATION_MS INTEGER NOT NULL DEFAULT 0,
            $COL_PERIOD TEXT NOT NULL,
            $COL_SEARCH_QUERY TEXT
        )
    """

    const val SQL_INDEX_APP_TIME = """
        CREATE INDEX idx_usage_app_time ON $NAME($COL_APP_ID, $COL_LAUNCH_TIME)
    """
    const val SQL_INDEX_TIME = """
        CREATE INDEX idx_usage_time ON $NAME($COL_LAUNCH_TIME)
    """
}

/**
 * 搜索记录表
 */
object SearchRecordTable {
    const val NAME = "search_record"

    const val COL_ID = "id"
    const val COL_QUERY = "query"
    const val COL_SEARCH_TIME = "search_time"
    const val COL_RESULT_COUNT = "result_count"
    const val COL_CLICKED_APP_ID = "clicked_app_id"
    const val COL_CLICK_POSITION = "click_position"
    const val COL_SUCCESS = "success"      // 0/1
    const val COL_SEARCH_MODE = "search_mode"

    const val SQL_CREATE = """
        CREATE TABLE $NAME (
            $COL_ID INTEGER PRIMARY KEY AUTOINCREMENT,
            $COL_QUERY TEXT NOT NULL,
            $COL_SEARCH_TIME INTEGER NOT NULL,
            $COL_RESULT_COUNT INTEGER NOT NULL DEFAULT 0,
            $COL_CLICKED_APP_ID TEXT,
            $COL_CLICK_POSITION INTEGER NOT NULL DEFAULT -1,
            $COL_SUCCESS INTEGER NOT NULL DEFAULT 0,
            $COL_SEARCH_MODE TEXT NOT NULL DEFAULT 'NORMAL'
        )
    """

    const val SQL_INDEX_QUERY = """
        CREATE INDEX idx_search_query ON $NAME($COL_QUERY)
    """
    const val SQL_INDEX_TIME = """
        CREATE INDEX idx_search_time ON $NAME($COL_SEARCH_TIME)
    """
}

/**
 * 手势记录表
 */
object GestureRecordTable {
    const val NAME = "gesture_record"

    const val COL_ID = "id"
    const val COL_GESTURE_ID = "gesture_id"
    const val COL_PATTERN = "pattern"
    const val COL_TRIGGER_TIME = "trigger_time"
    const val COL_SUCCESS = "success"
    const val COL_TARGET_APP_ID = "target_app_id"

    const val SQL_CREATE = """
        CREATE TABLE $NAME (
            $COL_ID INTEGER PRIMARY KEY AUTOINCREMENT,
            $COL_GESTURE_ID TEXT NOT NULL,
            $COL_PATTERN TEXT NOT NULL,
            $COL_TRIGGER_TIME INTEGER NOT NULL,
            $COL_SUCCESS INTEGER NOT NULL DEFAULT 1,
            $COL_TARGET_APP_ID TEXT
        )
    """
}

/**
 * 每日统计汇总表
 * 复合主键：(date, app_id)
 */
object DailyStatisticsTable {
    const val NAME = "daily_statistics"

    const val COL_DATE = "date"            // yyyy-MM-dd
    const val COL_APP_ID = "app_id"
    const val COL_LAUNCH_COUNT = "launch_count"
    const val COL_TOTAL_DURATION_MS = "total_duration_ms"
    const val COL_LAST_USED_TIME = "last_used_time"
    const val COL_PERIOD_DISTRIBUTION = "period_distribution" // JSON字符串

    const val SQL_CREATE = """
        CREATE TABLE $NAME (
            $COL_DATE TEXT NOT NULL,
            $COL_APP_ID TEXT NOT NULL,
            $COL_LAUNCH_COUNT INTEGER NOT NULL DEFAULT 0,
            $COL_TOTAL_DURATION_MS INTEGER NOT NULL DEFAULT 0,
            $COL_LAST_USED_TIME INTEGER NOT NULL DEFAULT 0,
            $COL_PERIOD_DISTRIBUTION TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY($COL_DATE, $COL_APP_ID)
        )
    """

    const val SQL_INDEX_DATE = """
        CREATE INDEX idx_daily_date ON $NAME($COL_DATE)
    """
}

/**
 * 关键词统计表
 */
object KeywordStatsTable {
    const val NAME = "keyword_stats"

    const val COL_KEYWORD = "keyword"      // 主键
    const val COL_SEARCH_COUNT = "search_count"
    const val COL_CLICK_COUNT = "click_count"
    const val COL_CLICKED_APPS = "clicked_apps" // JSON: {appId: count}

    const val SQL_CREATE = """
        CREATE TABLE $NAME (
            $COL_KEYWORD TEXT PRIMARY KEY,
            $COL_SEARCH_COUNT INTEGER NOT NULL DEFAULT 0,
            $COL_CLICK_COUNT INTEGER NOT NULL DEFAULT 0,
            $COL_CLICKED_APPS TEXT NOT NULL DEFAULT '{}'
        )
    """
}

/**
 * 手势使用统计表
 */
object GestureStatsTable {
    const val NAME = "gesture_stats"

    const val COL_GESTURE_ID = "gesture_id" // 主键
    const val COL_PATTERN = "pattern"
    const val COL_TRIGGER_COUNT = "trigger_count"
    const val COL_SUCCESS_COUNT = "success_count"
    const val COL_LAST_TRIGGERED_TIME = "last_triggered_time"

    const val SQL_CREATE = """
        CREATE TABLE $NAME (
            $COL_GESTURE_ID TEXT PRIMARY KEY,
            $COL_PATTERN TEXT NOT NULL,
            $COL_TRIGGER_COUNT INTEGER NOT NULL DEFAULT 0,
            $COL_SUCCESS_COUNT INTEGER NOT NULL DEFAULT 0,
            $COL_LAST_TRIGGERED_TIME INTEGER NOT NULL DEFAULT 0
        )
    """
}

/* ═══════════════════════════════════════════════════════════
 *  索引数据表
 * ═══════════════════════════════════════════════════════════ */

/**
 * 应用索引主表
 */
object AppIndexTable {
    const val NAME = "app_index"

    const val COL_APP_ID = "app_id"           // 主键
    const val COL_APP_NAME = "app_name"
    const val COL_PINYIN = "pinyin"
    const val COL_PINYIN_INITIALS = "pinyin_initials"
    const val COL_T9_DIGITS = "t9_digits"
    const val COL_T9_FULL_DIGITS = "t9_full_digits"
    const val COL_SHUANGPIN = "shuangpin"
    const val COL_META_TAGS = "meta_tags"      // JSON数组
    const val COL_CATEGORY_TAGS = "category_tags" // JSON数组
    const val COL_ENGLISH_TOKENS = "english_tokens" // JSON数组
    const val COL_CHAR_SET = "char_set"        // JSON数组
    const val COL_INSTALL_TIME = "install_time"
    const val COL_LAUNCH_COUNT = "launch_count"
    const val COL_UPDATE_TIME = "update_time"

    const val SQL_CREATE = """
        CREATE TABLE $NAME (
            $COL_APP_ID TEXT PRIMARY KEY,
            $COL_APP_NAME TEXT NOT NULL,
            $COL_PINYIN TEXT NOT NULL,
            $COL_PINYIN_INITIALS TEXT NOT NULL,
            $COL_T9_DIGITS TEXT NOT NULL,
            $COL_T9_FULL_DIGITS TEXT NOT NULL DEFAULT '',
            $COL_SHUANGPIN TEXT NOT NULL DEFAULT '',
            $COL_META_TAGS TEXT NOT NULL DEFAULT '[]',
            $COL_CATEGORY_TAGS TEXT NOT NULL DEFAULT '[]',
            $COL_ENGLISH_TOKENS TEXT NOT NULL DEFAULT '[]',
            $COL_CHAR_SET TEXT NOT NULL DEFAULT '[]',
            $COL_INSTALL_TIME INTEGER NOT NULL DEFAULT 0,
            $COL_LAUNCH_COUNT INTEGER NOT NULL DEFAULT 0,
            $COL_UPDATE_TIME INTEGER NOT NULL DEFAULT 0
        )
    """

    const val SQL_INDEX_PINYIN = """
        CREATE INDEX idx_app_pinyin ON $NAME($COL_PINYIN)
    """
    const val SQL_INDEX_NAME = """
        CREATE INDEX idx_app_name ON $NAME($COL_APP_NAME)
    """
}

/**
 * 拼音前缀树表
 * 存的是扁平化的节点（按 (path, char) 唯一）
 * appIds 以 JSON 数组存储
 */
object PinyinTrieTable {
    const val NAME = "pinyin_trie"

    const val COL_PATH = "path"           // 主键：从根到当前节点的字符路径
    const val COL_CHAR = "char"           // 当前节点字符
    const val COL_APP_IDS = "app_ids"      // JSON 数组

    const val SQL_CREATE = """
        CREATE TABLE $NAME (
            $COL_PATH TEXT PRIMARY KEY,
            $COL_CHAR TEXT NOT NULL,
            $COL_APP_IDS TEXT NOT NULL DEFAULT '[]'
        )
    """
}

/**
 * T9 数字索引表
 */
object T9IndexTable {
    const val NAME = "t9_index"

    const val COL_PATH = "path"
    const val COL_DIGIT = "digit"
    const val COL_APP_IDS = "app_ids"

    const val SQL_CREATE = """
        CREATE TABLE $NAME (
            $COL_PATH TEXT PRIMARY KEY,
            $COL_DIGIT TEXT NOT NULL,
            $COL_APP_IDS TEXT NOT NULL DEFAULT '[]'
        )
    """
}

/**
 * 模糊匹配索引表
 */
object FuzzyIndexTable {
    const val NAME = "fuzzy_index"

    const val COL_NODE_ID = "node_id"     // 主键
    const val COL_VALUE = "value"
    const val COL_TYPE = "type"           // pinyin/initials/meta_tag/app_name/t9_digits/...
    const val COL_CHILDREN = "children"   // JSON Map<Char, nodeId>
    const val COL_WEIGHT = "weight"
    const val COL_APP_IDS = "app_ids"

    const val SQL_CREATE = """
        CREATE TABLE $NAME (
            $COL_NODE_ID TEXT PRIMARY KEY,
            $COL_VALUE TEXT NOT NULL,
            $COL_TYPE TEXT NOT NULL,
            $COL_CHILDREN TEXT NOT NULL DEFAULT '{}',
            $COL_WEIGHT INTEGER NOT NULL DEFAULT 0,
            $COL_APP_IDS TEXT NOT NULL DEFAULT '[]'
        )
    """

    const val SQL_INDEX_TYPE = """
        CREATE INDEX idx_fuzzy_type ON $NAME($COL_TYPE)
    """
}

/**
 * 分类倒排索引表
 */
object CategoryIndexTable {
    const val NAME = "category_index"

    const val COL_CATEGORY = "category"   // 主键：分类词
    const val COL_CANONICAL_NAME = "canonical_name"
    const val COL_APP_IDS = "app_ids"     // JSON 数组
    const val COL_SYNONYMS = "synonyms"   // JSON 数组
    const val COL_PRIORITY = "priority"

    const val SQL_CREATE = """
        CREATE TABLE $NAME (
            $COL_CATEGORY TEXT PRIMARY KEY,
            $COL_CANONICAL_NAME TEXT NOT NULL,
            $COL_APP_IDS TEXT NOT NULL DEFAULT '[]',
            $COL_SYNONYMS TEXT NOT NULL DEFAULT '[]',
            $COL_PRIORITY INTEGER NOT NULL DEFAULT 0
        )
    """
}

/**
 * 分类近义词表
 */
object CategorySynonymTable {
    const val NAME = "category_synonym"

    const val COL_CANONICAL_NAME = "canonical_name" // 主键
    const val COL_SYNONYMS = "synonyms"             // JSON 数组

    const val SQL_CREATE = """
        CREATE TABLE $NAME (
            $COL_CANONICAL_NAME TEXT PRIMARY KEY,
            $COL_SYNONYMS TEXT NOT NULL DEFAULT '[]'
        )
    """
}

/**
 * 中英文字典表
 */
object BilingualDictTable {
    const val NAME = "bilingual_dict"

    const val COL_KEY = "key"             // 主键
    const val COL_LANG = "lang"           // zh / en
    const val COL_ALIASES = "aliases"     // JSON 数组
    const val COL_TARGET_APP_IDS = "target_app_ids" // JSON 数组

    const val SQL_CREATE = """
        CREATE TABLE $NAME (
            $COL_KEY TEXT NOT NULL,
            $COL_LANG TEXT NOT NULL,
            $COL_ALIASES TEXT NOT NULL DEFAULT '[]',
            $COL_TARGET_APP_IDS TEXT NOT NULL DEFAULT '[]',
            PRIMARY KEY($COL_KEY, $COL_LANG)
        )
    """
}
