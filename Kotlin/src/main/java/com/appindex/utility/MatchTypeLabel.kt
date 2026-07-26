package com.appindex.Utility

/**
 * 搜索匹配类型中英文标签工具
 * Bilingual labels for all MatchType enum values.
 *
 * 统一管理所有匹配类型的中英文显示名称，
 * 避免在多个 Adapter 中重复实现。
 *
 * Centralises the Chinese & English display names of every MatchType
 * so individual adapters don't reinvent the mapping.
 */
object MatchTypeLabel {

    private val LABELS = mapOf(
        // ─── 标准模式 / Standard mode ───
        "EXACT" to "精确",
        "PREFIX" to "前缀",
        "CONTAINS" to "包含",
        "PINYIN_EXACT" to "全拼",
        "PINYIN_PREFIX" to "拼音",
        "PINYIN_CONTAINS" to "拼音",
        "PINYIN_SEGMENT" to "分词拼音",
        "INITIALS_EXACT" to "首字母",
        "INITIALS_PREFIX" to "首字母",
        "INITIALS_SUBSEQ" to "乱序",
        "ENGLISH_EXACT" to "英文",
        "ENGLISH_PREFIX" to "英文",
        "ENGLISH_SUBSEQ" to "乱序",
        "PACKAGE_MATCH" to "包名",
        "FUZZY" to "模糊",
        "FUZZY_TYPING" to "容错",

        // ─── 模糊匹配引擎 / Fuzzy Match Engine ───
        "FUZZY_ENGINE_PINYIN_EDIT" to "⚡拼音模糊",
        "FUZZY_ENGINE_PINYIN_NGRAM" to "⚡拼音相似",
        "FUZZY_ENGINE_INITIALS_PERMUTE" to "⚡首字母排列",
        "FUZZY_ENGINE_CHAR_OVERLAP" to "⚡字符重叠",
        "FUZZY_ENGINE_COMBINED" to "⚡综合模糊",

        // ─── 元标签树 / Meta Tag Tree ───
        "META_TAG" to "🗂元标签"
    )

    /**
     * 获取匹配类型的中文标签
     * Get the Chinese label of a match type.
     * @param matchTypeName MatchType 枚举的 name / MatchType enum name
     * @return 中文标签，未知类型返回空字符串 / Chinese label, or "" for unknown
     */
    fun getLabel(matchTypeName: String): String {
        return LABELS[matchTypeName] ?: ""
    }
}
