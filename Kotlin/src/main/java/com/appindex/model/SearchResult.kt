package com.appindex.model

/**
 * 搜索结果，包含匹配分数用于排序
 *
 * @param isCurrentIntent 是否为追加搜索中的最新意图（追加搜索时置顶高亮）
 */
data class SearchResult(
    val appInfo: AppInfo,
    val score: Int = 0,          // 匹配分数，越高越相关
    val matchType: MatchType = MatchType.EXACT,
    val isCurrentIntent: Boolean = false  // 追加搜索：是否为最新意图匹配
)

enum class MatchType {
    // ─── 标准模式匹配 ───
    EXACT,              // 完全匹配
    PREFIX,             // 前缀匹配
    CONTAINS,           // 包含匹配（子串）
    PINYIN_EXACT,       // 拼音完全匹配
    PINYIN_PREFIX,      // 拼音前缀匹配
    PINYIN_CONTAINS,    // 拼音包含匹配
    PINYIN_SEGMENT,     // 纯拼音分词匹配（如 "weixin" 匹配 "微信"）
    INITIALS_EXACT,     // 首字母完全匹配
    INITIALS_PREFIX,    // 首字母前缀匹配
    INITIALS_SUBSEQ,    // 首字母乱序子序列匹配（如 "xw" 匹配 "微信"）
    ENGLISH_EXACT,      // 英文完全匹配
    ENGLISH_PREFIX,     // 英文前缀匹配
    ENGLISH_SUBSEQ,     // 英文乱序子序列匹配
    PACKAGE_MATCH,      // 包名匹配
    FUZZY,              // 模糊匹配（编辑距离兜底）
    FUZZY_TYPING,       // 键盘误触容错匹配（免费）

    // ─── 模糊匹配引擎模式匹配（付费） / Fuzzy Match Engine (premium) ───
    FUZZY_ENGINE_PINYIN_EDIT,      // 拼音编辑距离模糊（"东京"dongjing → "京东"jingdong）
                                   // Pinyin edit distance (dongjing → jingdong)
    FUZZY_ENGINE_PINYIN_NGRAM,     // 拼音 n-gram 相似度（"mojinuoyafangzhou" → "mingrifangzhou"）
                                   // Pinyin n-gram similarity
    FUZZY_ENGINE_INITIALS_PERMUTE, // 首字母排列模糊（首字母字符集高度重叠）
                                   // Initials permutation fuzzy
    FUZZY_ENGINE_CHAR_OVERLAP,     // 字符重叠度匹配（共享字符比例高）
                                   // Char-overlap ratio match
    FUZZY_ENGINE_COMBINED,         // 综合模糊匹配（多维度加权）
                                   // Combined fuzzy match (multi-dimension weighted)

    // ─── 元标签树匹配（核心特色） / Meta Tag Tree ───
    META_TAG                       // 语义分类召回：用户输入概括词（如"邮箱"/"email"）
                                   // → 命中同义词簇 → 一次性召回该分类下所有应用
                                   // Semantic category recall: user types a general term
                                   // (e.g. "邮箱" / "email") → synonym cluster hit →
                                   // batch-recalls all apps in the category
}
