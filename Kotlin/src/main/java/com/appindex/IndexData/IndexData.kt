package com.appindex.IndexData

import java.io.Serializable

/**
 * 索引数据模块
 * 负责存储软件内部维护的模糊匹配索引树，为搜索引擎提供快速检索的数据基础。
 * 索引内容涵盖应用名称、拼音序列、九宫格数字映射、语义分类标签、中英文字典等多维度数据，
 * 支持前缀匹配、模糊匹配、分类检索、中英文混合检索等多种查询方式。
 */

/**
 * 应用索引项
 * 以应用包名为键，值为包含名称、拼音、数字序列、分类标签、字符集等复合对象。
 *
 * 优化点：
 * 1. charSet 使用 Set 缓存，避免搜索时重复拆分，支持 Jaccard 快速修正。
 * 2. shuangpin 预计算双拼序列，覆盖双拼输入习惯。
 * 3. englishTokens 拆分英文名字单词，支持英文全拼 / 缩写匹配。
 * 4. metaTagSet / categoryTagSet 将 List 转为 Set，contains 查询从 O(n) 降到 O(1)。
 */
data class AppIndexItem(
    val appId: String,
    val appName: String,
    val pinyin: String,
    val pinyinInitials: String,
    val t9Digits: String,
    val t9FullDigits: String = "",
    val shuangpin: String = "",
    val metaTags: List<String> = emptyList(),
    val categoryTags: List<String> = emptyList(),
    val englishTokens: List<String> = emptyList(),
    val charSet: Set<Char> = emptySet(),
    val installTime: Long = 0L,
    val launchCount: Int = 0,
    val updateTime: Long = 0L
) : Serializable {
    /** 运行时将 List 转为 HashSet，加速分类匹配判断 */
    @Transient
    val metaTagSet: Set<String> = metaTags.toHashSet()

    @Transient
    val categoryTagSet: Set<String> = categoryTags.toHashSet()

    @Transient
    val englishTokenSet: Set<String> = englishTokens.map { it.lowercase() }.toHashSet()

    companion object {
        /** 由构建器生成的标准字段 */
        fun build(
            appId: String,
            appName: String,
            pinyin: String,
            pinyinInitials: String,
            t9Digits: String,
            t9FullDigits: String = "",
            shuangpin: String = "",
            metaTags: List<String> = emptyList(),
            categoryTags: List<String> = emptyList(),
            installTime: Long = 0L,
            launchCount: Int = 0,
            updateTime: Long = 0L
        ): AppIndexItem {
            val lowerName = appName.lowercase()
            val englishTokens = mutableListOf<String>()
            if (Regex("^[a-z\\s]+$").matches(lowerName)) {
                lowerName.split(Regex("\\s+")).filter { it.isNotBlank() }.forEach { englishTokens.add(it) }
            }
            val charSet = mutableSetOf<Char>().apply {
                addAll(appName.toSet())
                addAll(pinyin.toSet())
                addAll(pinyinInitials.toSet())
                addAll(lowerName.toSet())
                metaTags.forEach { addAll(it.toSet()) }
                categoryTags.forEach { addAll(it.toSet()) }
                englishTokens.forEach { addAll(it.toSet()) }
            }
            return AppIndexItem(
                appId = appId,
                appName = appName,
                pinyin = pinyin,
                pinyinInitials = pinyinInitials,
                t9Digits = t9Digits,
                t9FullDigits = t9FullDigits,
                shuangpin = shuangpin,
                metaTags = metaTags,
                categoryTags = categoryTags,
                englishTokens = englishTokens,
                charSet = charSet,
                installTime = installTime,
                launchCount = launchCount,
                updateTime = updateTime
            )
        }
    }
}

/**
 * 拼音前缀树节点
 * 单独维护前缀树结构，支持高效的前缀匹配查询。
 *
 * 优化点：使用 LinkedHashMap 保证子节点有序且查找为 O(1)。
 */
data class PinyinTrieNode(
    val char: Char,
    val children: LinkedHashMap<Char, PinyinTrieNode> = LinkedHashMap(),
    val appIds: ArrayList<String> = ArrayList()
) : Serializable

/**
 * 九宫格数字映射节点
 * 将拼音/首字母映射为 T9 数字序列，支持数字键盘输入检索。
 *
 * 优化点：使用 LinkedHashMap 保证子节点有序且查找为 O(1)。
 */
data class T9IndexNode(
    val digit: Char,
    val children: LinkedHashMap<Char, T9IndexNode> = LinkedHashMap(),
    val appIds: ArrayList<String> = ArrayList()
) : Serializable

/**
 * 模糊匹配索引节点
 *
 * 优化点：
 * 1. children 从 MutableList 改为 LinkedHashMap<Char, FuzzyIndexNode>，前缀查找从 O(n) 降到 O(1)。
 * 2. appIds 使用 ArrayList 并在构建完成后视情况排序/去重，序列化更稳定。
 */
data class FuzzyIndexNode(
    val nodeId: String,
    val value: String,
    val type: IndexType,
    val children: LinkedHashMap<Char, FuzzyIndexNode> = LinkedHashMap(),
    val weight: Int = 0,
    val appIds: ArrayList<String> = ArrayList()
) : Serializable

enum class IndexType {
    PINYIN,
    INITIALS,
    META_TAG,
    APP_NAME,
    T9_DIGITS,
    CATEGORY,
    SHUANGPIN,
    ENGLISH_TOKEN
}

/**
 * 语义分类倒排索引
 * 分类词指向对应的应用集合。
 *
 * 优化点：
 * 1. appIds 使用 LinkedHashSet 保证去重且迭代顺序稳定。
 * 2. 增加 synonyms 字段，支持分类近义词延伸。
 * 3. 增加 canonicalName 标准名，近义词映射到同一分类。
 */
data class CategoryInvertedIndex(
    val category: String,
    val canonicalName: String,
    val appIds: LinkedHashSet<String> = LinkedHashSet(),
    val synonyms: List<String> = emptyList(),
    val priority: Int = 0
) : Serializable

/**
 * 分类近义词映射
 * 记录每个标准分类名对应的近义词列表，便于索引构建与搜索扩展。
 */
data class CategorySynonymIndex(
    val canonicalName: String,
    val synonyms: List<String> = emptyList()
) : Serializable

/**
 * 中英文字典条目
 * 用于中英文混合搜索，一个中文名可对应多个英文别名，反之亦然。
 */
data class BilingualDictEntry(
    val key: String,
    val targets: LinkedHashSet<String> = LinkedHashSet()
) : Serializable

/**
 * 键盘布局枚举
 */
enum class KeyboardLayout {
    QWERTY_26,
    T9_9
}

/**
 * QWERTY 键位坐标，用于键盘距离扣分
 */
data class QwertyKeyCoord(
    val key: Char,
    val x: Float,
    val y: Float
) : Serializable

/**
 * 索引树
 */
data class IndexTree(
    val type: IndexType,
    val root: FuzzyIndexNode,
    val version: Int = 1,
    val buildTime: Long = System.currentTimeMillis()
) : Serializable

/**
 * 完整索引快照
 * 内存驻留加本地快照的双层架构。
 *
 * 优化点：
 * 1. 新增 bilingualDict 与 categorySynonyms，支持中英文混合与分类近义词。
 * 2. 新增 keyboardLayout，记录构建时的键盘布局。
 * 3. 新增 shuangpinTree / englishTokenTree，分别支持双拼与英文单词索引。
 */
data class AppIndexSnapshot(
    val version: Int = 1,
    val buildTime: Long = System.currentTimeMillis(),
    val appMap: Map<String, AppIndexItem> = emptyMap(),
    val pinyinTrie: PinyinTrieNode? = null,
    val t9Trie: T9IndexNode? = null,
    val categoryIndex: Map<String, CategoryInvertedIndex> = emptyMap(),
    val categorySynonyms: Map<String, CategorySynonymIndex> = emptyMap(),
    val bilingualDict: Map<String, BilingualDictEntry> = emptyMap(),
    val fuzzyTrees: List<IndexTree> = emptyList(),
    val shuangpinTree: IndexTree? = null,
    val englishTokenTree: IndexTree? = null,
    val keyboardLayout: KeyboardLayout = KeyboardLayout.QWERTY_26
) : Serializable
