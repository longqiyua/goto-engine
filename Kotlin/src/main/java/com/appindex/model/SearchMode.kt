package com.appindex.model

/**
 * 搜索模式 / Search Mode
 *
 * STANDARD:    标准模式（默认）— 精确 + 拼音 + 首字母 + 乱序 + 英文
 *              Standard mode (default) — exact + pinyin + initials + scramble + English
 *
 * FUZZY_ENGINE: 模糊匹配引擎模式（付费功能，默认关闭）
 *               Fuzzy Match Engine mode (premium feature, off by default)
 *               在标准模式基础上叠加六维模糊召回：
 *               On top of the standard mode, adds six-dimensional fuzzy recall:
 *               - 键盘感知编辑距离（邻位误触容错）
 *                 Keyboard-aware edit distance (neighbour mistap tolerance)
 *               - 候选查询展开（去重 / 替换 / 删字 / 交换）
 *                 Candidate query expansion (dedup / replace / drop / swap)
 *               - 双字符 Jaccard 相似度 / Bigram Jaccard similarity
 *               - 首字母 / 字符集 Jaccard / Initials / Char-set Jaccard
 *               - 乱序字符匹配 / Scramble character match
 *               - 字符重叠度 / Character overlap ratio
 */
enum class SearchMode {
    STANDARD,
    FUZZY_ENGINE
}
