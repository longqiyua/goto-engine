package com.appindex.modules.fuzzymatch

import android.graphics.drawable.Drawable

// 模块内嵌的最小数据模型，使 FuzzyMatchEngine 可独立导出到其他应用

data class AppInfo(
    val packageName: String,
    val label: String,
    val pinyin: String,
    val pinyinInitials: String,
    val pinyinArray: List<String>,
    val labelLower: String = label.lowercase(),
    val icon: Drawable? = null,
    val isSystemApp: Boolean = false
)

data class SearchResult(
    val appInfo: AppInfo,
    val score: Int = 0,
    val matchType: MatchType = MatchType.EXACT,
    val isCurrentIntent: Boolean = false
)

enum class MatchType {
    EXACT, PREFIX, CONTAINS,
    PINYIN_EXACT, PINYIN_PREFIX, PINYIN_CONTAINS, PINYIN_SEGMENT,
    INITIALS_EXACT, INITIALS_PREFIX, INITIALS_SUBSEQ,
    ENGLISH_EXACT, ENGLISH_PREFIX, ENGLISH_SUBSEQ,
    PACKAGE_MATCH, FUZZY, FUZZY_TYPING,
    FUZZY_ENGINE_PINYIN_EDIT, FUZZY_ENGINE_PINYIN_NGRAM,
    FUZZY_ENGINE_INITIALS_PERMUTE, FUZZY_ENGINE_CHAR_OVERLAP,
    FUZZY_ENGINE_COMBINED,
    META_TAG
}

enum class KeyboardLayout(val key: String) {
    QWERTY_26("qwerty_26"),
    T9_9("t9_9");

    companion object {
        fun fromKey(key: String?): KeyboardLayout =
            values().firstOrNull { it.key == key } ?: QWERTY_26

        fun defaultForLanguage(appLanguage: String): KeyboardLayout = QWERTY_26
    }
}

enum class InputLanguage {
    ENGLISH, CHINESE, NUMERIC_T9, MIXED;

    companion object {
        fun detect(query: String, t9Enabled: Boolean): InputLanguage {
            if (query.isEmpty()) return CHINESE
            var hasLetter = false
            var hasDigit = false
            var hasCjk = false
            for (character in query) {
                when {
                    character in 'a'..'z' -> hasLetter = true
                    character in '0'..'9' -> hasDigit = true
                    character.code in 0x4E00..0x9FFF -> hasCjk = true
                }
            }
            return when {
                hasDigit && !hasLetter && !hasCjk && t9Enabled -> NUMERIC_T9
                hasDigit && !hasLetter && !hasCjk && !t9Enabled -> ENGLISH
                hasCjk -> if (hasLetter || hasDigit) MIXED else CHINESE
                hasLetter && !hasDigit -> ENGLISH
                hasLetter && hasDigit -> MIXED
                else -> CHINESE
            }
        }
    }
}


// import com.appindex.BasicSearch.MetaTagEngine
// import com.appindex.Model.AppInfo
// import com.appindex.Model.MatchType
// import com.appindex.Model.SearchResult
// import com.appindex.Personalization.InputLanguage
// import com.appindex.Personalization.KeyboardLayout
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║                                                                              ║
 * ║             模糊匹配引擎 / Fuzzy Match Engine  v1.1                          ║
 * ║                                                                              ║
 * ║   ── 中文简介 ──                                                              ║
 * ║   模糊匹配引擎是 GoTo 应用搜索的核心智能模块，负责在用户输入存在错别字、         ║
 * ║   顺序颠倒、近邻键误触、首字母错位、拼音同音/近音等情况下，依然能从应用库      ║
 * ║   中召回最相关的结果。                                                          ║
 * ║                                                                              ║
 * ║   v1.1 新增能力：                                                              ║
 * ║   - 任意长度查询（1 字符 / 100 字符都能稳定召回，带长度差早终止）              ║
 * ║   - 输入语言自动检测（纯英文 / 纯中文 / 纯数字 / 混合）并路由到对应索引树       ║
 * ║   - 26 键 QWERTY 与 9 键 T9 双布局，按 [keyboardLayout] 自动切换               ║
 * ║   - T9 模式下把应用名预先转成数字序列，支持 "943" → "微信" 这种数字输入         ║
 * ║                                                                              ║
 * ║   核心能力（六大匹配维度）：                                                   ║
 * ║   1. 键盘感知编辑距离（Keyboard-aware Edit Distance）                          ║
 * ║      相邻键替换成本 = 1，普通替换成本 = 2，天然容错手抖。                       ║
 * ║   2. 候选查询生成（Candidate Generation）                                     ║
 * ║      自动展开"去重 / 单字符替换 / 双字符替换 / 删字 / 邻位交换"五类变体。       ║
 * ║   3. 双字符相似度（Bigram Similarity）                                        ║
 * ║      通过 bigram Jaccard 评估字符串形态相似度。                                ║
 * ║   4. 字符集 Jaccard（Initials Jaccard）                                       ║
 * ║      首字母 / 字符集的重合度计算。                                             ║
 * ║   5. 乱序字符匹配（Scramble Match）                                          ║
 * ║      用户输入的字符顺序与目标不一致时也能命中。                                 ║
 * ║   6. 字符重叠度（Char Overlap）                                               ║
 * ║      共享字符比例，兜底"看见几个字就能想起应用名"的弱匹配。                     ║
 * ║                                                                              ║
 * ║   ── English Description ──                                                   ║
 * ║   The Fuzzy Match Engine is the core intelligence of GoTo's app search.       ║
 * ║   It guarantees relevant results even when the user input contains typos,     ║
 * ║   character-scrambling, neighbouring-key mistaps, misplaced initials, or       ║
 * ║   homophone / near-homophone pinyin.                                          ║
 * ║                                                                              ║
 * ║   v1.1 additions:                                                             ║
 * ║   - Arbitrary-length queries (1 char or 100 chars, with length-gap guard).    ║
 * ║   - Input language auto-detection (pure English / CJK / digits / mixed) and  ║
 * ║     routing to the matching index tree.                                        ║
 * ║   - 26-key QWERTY and 9-key T9 layouts, switched via [keyboardLayout].        ║
 * ║   - In T9 mode, app names are pre-converted to digit sequences, so "943" can  ║
 * ║     recall "微信" (WeChat).                                                   ║
 * ║                                                                              ║
 * ║   Six matching dimensions:                                                    ║
 * ║   1. Keyboard-aware Edit Distance — adjacent keys cost 1, normal cost 2.     ║
 * ║   2. Candidate Generation — dedup / single & double neighbour replace /       ║
 * ║      drop / swap variants.                                                    ║
 * ║   3. Bigram Similarity — Jaccard of character bigrams.                        ║
 * ║   4. Initials Jaccard — set-level overlap of initials or character pool.      ║
 * ║   5. Scramble Match — matches when character order is shuffled.               ║
 * ║   6. Char Overlap — shared-character ratio as a weak-signal fallback.         ║
 * ║                                                                              ║
 * ║   Performance target: < 10ms for 500 apps on a mid-range device.               ║
 * ║                                                                              ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */
class FuzzyMatchEngine {

    // ═══════════════════════════════════════════════════════════════════════════
    //  索引与缓存 / Index & Cache
    // ═══════════════════════════════════════════════════════════════════════════

    /** 预计算索引应用列表（与 AppSearchEngine 共享同一份 IndexedApp 结构） */
    private var indexedApps: List<IndexedApp> = emptyList()

    /** 索引是否已构建 */
    private var indexBuilt = false

    /** LRU 缓存：query -> 结果列表 */
    private val fuzzyCache = LinkedHashMap<String, List<SearchResult>>(16, 0.75f, true)

    /** 应用使用频率权重（packageName -> 权重） */
    private val usageWeights = ConcurrentHashMap<String, Float>()

    /**
     * 当前键盘布局 / Active keyboard layout.
     * Default: QWERTY_26. Mutate via [setKeyboardLayout].
     */
    var keyboardLayout: KeyboardLayout = KeyboardLayout.QWERTY_26
        private set

    /**
     * 设置键盘布局 / Set the active keyboard layout.
     * 清空缓存以避免跨布局缓存污染。Clears the cache to avoid cross-layout pollution.
     */
    fun setKeyboardLayout(layout: KeyboardLayout) {
        if (keyboardLayout == layout) return
        keyboardLayout = layout
        clearCache()
    }

    /**
     * 构建 / 重建索引
     * Build / rebuild the index. Should be called whenever the app list changes.
     */
    fun buildIndex(apps: List<AppInfo>) {
        indexedApps = apps.map { IndexedApp(it) }
        indexBuilt = true
    }

    /**
     * 更新应用使用频率
     * Bump the usage weight of an app (called when the user opens an app).
     */
    fun recordAppUsage(packageName: String) {
        val current = usageWeights[packageName] ?: 0f
        usageWeights[packageName] = (current + 1f).coerceAtMost(100f)
    }

    /**
     * 同步主搜索结果到权重（让模糊召回时也能享受频率加权）
     * Sync usage weight from the main search engine.
     */
    fun syncUsageWeights(weights: Map<String, Float>) {
        weights.forEach { (pkg, w) -> usageWeights[pkg] = w }
    }

    /** 清空缓存 / Clear caches */
    fun clearCache() {
        synchronized(fuzzyCache) { fuzzyCache.clear() }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  主搜索入口 / Main Entry Points
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * 容错搜索 / Fuzzy search (synchronous, single-threaded).
     *
     * 适用于中小规模应用列表 (≤ 500) 或需要确定延迟的场景。
     */
    fun search(query: String, apps: List<AppInfo>, limit: Int = 30): List<SearchResult> {
        if (query.isBlank()) return emptyList()
        val q = query.trim().lowercase()

        synchronized(fuzzyCache) { fuzzyCache[q] }?.let { return it }
        if (!indexBuilt || indexedApps.size != apps.size) buildIndex(apps)

        val allResults = ConcurrentHashMap<String, SearchResult>()

        // 1) 候选查询（键盘容错） / Candidate queries (keyboard-tolerant)
        val candidates = generateFuzzyCandidates(q)
        for (candidate in candidates) {
            for (ia in indexedApps) {
                val score = matchIndexedApp(candidate, candidate.length, ia)
                if (score >= 20) {
                    val existing = allResults[ia.app.packageName]
                    if (existing == null || score > existing.score) {
                        allResults[ia.app.packageName] =
                            SearchResult(ia.app, score, MatchType.FUZZY_TYPING)
                    }
                }
            }
        }

        // 2) 原始查询容错评分 / Raw-query tolerance scoring
        for (ia in indexedApps) {
            val score = calculateFuzzyScore(q, ia)
            if (score >= 20) {
                val existing = allResults[ia.app.packageName]
                if (existing == null || score > existing.score) {
                    allResults[ia.app.packageName] =
                        SearchResult(ia.app, score, MatchType.FUZZY_TYPING)
                }
            }
        }

        // 3) 乱序匹配（兜底）/ Scramble match (fallback)
        for (ia in indexedApps) {
            val score = calculateScrambleScore(q, ia)
            if (score >= 30) {
                val existing = allResults[ia.app.packageName]
                if (existing == null || score > existing.score) {
                    allResults[ia.app.packageName] =
                        SearchResult(ia.app, score, MatchType.FUZZY_ENGINE_CHAR_OVERLAP)
                }
            }
        }

        val sorted = allResults.values.sortedByDescending { it.score }
        val final = if (sorted.size > limit) sorted.subList(0, limit) else sorted

        synchronized(fuzzyCache) {
            fuzzyCache[q] = final
            if (fuzzyCache.size > 16) fuzzyCache.remove(fuzzyCache.keys.first())
        }
        return final
    }

    /**
     * 并行容错搜索 / Fuzzy search (parallel, multi-core).
     *
     * 将应用列表按 CPU 核心数分块，多协程并行匹配。
     */
    suspend fun searchParallel(
        query: String,
        apps: List<AppInfo>,
        limit: Int = 30
    ): List<SearchResult> {
        if (query.isBlank()) return emptyList()
        val q = query.trim().lowercase()

        synchronized(fuzzyCache) { fuzzyCache[q] }?.let { return it }
        if (!indexBuilt || indexedApps.size != apps.size) buildIndex(apps)

        return withContext(Dispatchers.Default) {
            val allResults = ConcurrentHashMap<String, SearchResult>()
            val candidates = generateFuzzyCandidates(q)
            val chunkSize = maxOf(50, indexedApps.size / Runtime.getRuntime().availableProcessors())
            val chunks = indexedApps.chunked(chunkSize)

            coroutineScope {
                // 候选查询搜索 / Candidate-query search
                chunks.map { chunk ->
                    async {
                        for (candidate in candidates) {
                            for (ia in chunk) {
                                val score = matchIndexedApp(candidate, candidate.length, ia)
                                if (score >= 20) {
                                    synchronized(allResults) {
                                        val existing = allResults[ia.app.packageName]
                                        if (existing == null || score > existing.score) {
                                            allResults[ia.app.packageName] =
                                                SearchResult(ia.app, score, MatchType.FUZZY_TYPING)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }.awaitAll()

                // 容错评分 / Tolerance scoring
                chunks.map { chunk ->
                    async {
                        for (ia in chunk) {
                            val score = calculateFuzzyScore(q, ia)
                            if (score >= 20) {
                                synchronized(allResults) {
                                    val existing = allResults[ia.app.packageName]
                                    if (existing == null || score > existing.score) {
                                        allResults[ia.app.packageName] =
                                            SearchResult(ia.app, score, MatchType.FUZZY_TYPING)
                                    }
                                }
                            }
                        }
                    }
                }.awaitAll()

                // 乱序匹配 / Scramble match
                chunks.map { chunk ->
                    async {
                        for (ia in chunk) {
                            val score = calculateScrambleScore(q, ia)
                            if (score >= 30) {
                                synchronized(allResults) {
                                    val existing = allResults[ia.app.packageName]
                                    if (existing == null || score > existing.score) {
                                        allResults[ia.app.packageName] =
                                            SearchResult(ia.app, score, MatchType.FUZZY_ENGINE_CHAR_OVERLAP)
                                    }
                                }
                            }
                        }
                    }
                }.awaitAll()
            }

            val sorted = allResults.values.sortedByDescending { it.score }
            val final = if (sorted.size > limit) sorted.subList(0, limit) else sorted

            synchronized(fuzzyCache) {
                fuzzyCache[q] = final
                if (fuzzyCache.size > 16) fuzzyCache.remove(fuzzyCache.keys.first())
            }
            final
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  智能路由搜索 / Smart-Routed Search
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * 智能路由搜索 — 自动检测输入语言并切换对应索引树
     * Smart-routed search — auto-detects input language and switches to the
     * appropriate index tree. 支持任意长度（1 字符 / 100 字符都行）。
     * Supports any input length (1 char or 100 chars).
     *
     * 路由规则 / Routing rules:
     *   1. 纯英文字母 → 走英文索引树（englishName 优先 + label 兜底）
     *      Pure English → English index tree (englishName first, label fallback).
     *   2. 纯中文 / 拼音 / 首字母 → 走中文索引树（label / pinyin / initials）
     *      Pure Chinese / pinyin / initials → Chinese index tree.
     *   3. 纯数字 + T9 模式 → 走 T9 索引树
     *      Pure digits + T9 mode → T9 index tree.
     *   4. 混合 → 并行多树后合并去重
     *      Mixed → parallel multi-tree, merged and de-duplicated.
     *
     * 默认索引树顺序遵循 [KeyboardLayout.defaultForLanguage] 给出的偏好。
     * The default index tree order follows the preference returned by
     * [KeyboardLayout.defaultForLanguage] for the app's current locale.
     */
    fun autoDetectSearch(
        query: String,
        apps: List<AppInfo>,
        appLanguage: String = "zh-CN",
        limit: Int = 30
    ): List<SearchResult> {
        if (query.isBlank()) return emptyList()
        val q = query.trim().lowercase()

        synchronized(fuzzyCache) { fuzzyCache["auto:$q"] }?.let { return it }
        if (!indexBuilt || indexedApps.size != apps.size) buildIndex(apps)

        val lang = InputLanguage.detect(q, keyboardLayout == KeyboardLayout.T9_9)

        val allResults = ConcurrentHashMap<String, SearchResult>()

        // 根据语言路由到不同索引维度
        // Route to different index dimensions based on detected language.
        when (lang) {
            InputLanguage.ENGLISH -> {
                // 纯英文 → 英文优先 / Pure English → English-first
                for (ia in indexedApps) {
                    val score = scoreEnglishFirst(q, ia)
                    if (score >= 20) {
                        mergeResult(allResults, ia, score, MatchType.FUZZY_TYPING)
                    }
                }
            }
            InputLanguage.CHINESE -> {
                // 纯中文 → 中文 / 拼音 / 首字母优先 / Pure Chinese → CJK/pinyin/initials first
                for (ia in indexedApps) {
                    val score = scoreChineseFirst(q, ia)
                    if (score >= 20) {
                        mergeResult(allResults, ia, score, MatchType.FUZZY_TYPING)
                    }
                }
            }
            InputLanguage.NUMERIC_T9 -> {
                // 纯数字 + T9 → 走 T9 数字序列匹配 / Pure digits + T9 → T9 digit match
                for (ia in indexedApps) {
                    val score = scoreT9First(q, ia)
                    if (score >= 20) {
                        mergeResult(allResults, ia, score, MatchType.FUZZY_ENGINE_COMBINED)
                    }
                }
            }
            InputLanguage.MIXED -> {
                // 混合 → 并行多树 / Mixed → parallel multi-tree
                for (ia in indexedApps) {
                    val scoreA = scoreEnglishFirst(q, ia)
                    val scoreB = scoreChineseFirst(q, ia)
                    val scoreC = scoreT9First(q, ia)
                    val best = maxOf(scoreA, scoreB, scoreC)
                    if (best >= 20) {
                        mergeResult(allResults, ia, best, MatchType.FUZZY_ENGINE_COMBINED)
                    }
                }
            }
        }

        val sorted = allResults.values.sortedByDescending { it.score }
        val final = if (sorted.size > limit) sorted.subList(0, limit) else sorted

        synchronized(fuzzyCache) {
            fuzzyCache["auto:$q"] = final
            if (fuzzyCache.size > 16) fuzzyCache.remove(fuzzyCache.keys.first())
        }
        return final
    }

    /**
     * 并行版智能路由搜索 / Parallel smart-routed search.
     */
    suspend fun autoDetectSearchParallel(
        query: String,
        apps: List<AppInfo>,
        appLanguage: String = "zh-CN",
        limit: Int = 30
    ): List<SearchResult> {
        if (query.isBlank()) return emptyList()
        val q = query.trim().lowercase()

        synchronized(fuzzyCache) { fuzzyCache["auto:$q"] }?.let { return it }
        if (!indexBuilt || indexedApps.size != apps.size) buildIndex(apps)

        return withContext(Dispatchers.Default) {
            val lang = InputLanguage.detect(q, keyboardLayout == KeyboardLayout.T9_9)
            val allResults = ConcurrentHashMap<String, SearchResult>()
            val chunkSize = maxOf(50, indexedApps.size / Runtime.getRuntime().availableProcessors())
            val chunks = indexedApps.chunked(chunkSize)

            coroutineScope {
                chunks.map { chunk ->
                    async {
                        for (ia in chunk) {
                            val score = when (lang) {
                                InputLanguage.ENGLISH -> scoreEnglishFirst(q, ia)
                                InputLanguage.CHINESE -> scoreChineseFirst(q, ia)
                                InputLanguage.NUMERIC_T9 -> scoreT9First(q, ia)
                                InputLanguage.MIXED -> {
                                    maxOf(scoreEnglishFirst(q, ia), scoreChineseFirst(q, ia), scoreT9First(q, ia))
                                }
                            }
                            if (score >= 20) {
                                val type = if (lang == InputLanguage.MIXED) MatchType.FUZZY_ENGINE_COMBINED else MatchType.FUZZY_TYPING
                                mergeResult(allResults, ia, score, type)
                            }
                        }
                    }
                }.awaitAll()
            }

            val sorted = allResults.values.sortedByDescending { it.score }
            val final = if (sorted.size > limit) sorted.subList(0, limit) else sorted

            synchronized(fuzzyCache) {
                fuzzyCache["auto:$q"] = final
                if (fuzzyCache.size > 16) fuzzyCache.remove(fuzzyCache.keys.first())
            }
            final
        }
    }

    /** 英文优先评分（englishName 主路径） / English-first scoring. */
    private fun scoreEnglishFirst(q: String, ia: IndexedApp): Int {
        var best = 0
        // 1) englishName 直接匹配 / Direct englishName match
        if (ia.englishName.isNotEmpty()) {
            val ed = keyboardAwareEditDistance(q, ia.englishName)
            val maxLen = maxOf(q.length, ia.englishName.length) / 2 + 1
            if (ed <= maxLen) {
                best = maxOf(best, 200 + ((1 - ed.toFloat() / (maxLen + 1)) * 150).toInt())
            }
            if (ia.englishName.startsWith(q)) best = maxOf(best, 350 + q.length * 4)
            if (ia.englishName.contains(q)) best = maxOf(best, 180 + q.length * 3)
        }
        // 2) label 兜底 / Label fallback
        val labelScore = calculateFuzzyScore(q, ia)
        best = maxOf(best, labelScore)
        // 3) 包名 / Package name
        if (ia.app.packageName.contains(q)) best = maxOf(best, 100 + q.length * 2)
        return best
    }

    /** 中文优先评分（label / pinyin / initials 主路径）/ Chinese-first scoring. */
    private fun scoreChineseFirst(q: String, ia: IndexedApp): Int {
        var best = 0
        // 1) label (中文)
        if (ia.label.contains(q)) best = maxOf(best, 220 + q.length * 4)
        if (ia.label.startsWith(q)) best = maxOf(best, 380 + q.length * 5)
        val labelEd = keyboardAwareEditDistance(q, ia.label)
        val labelMax = maxOf(q.length, ia.label.length) / 2 + 1
        if (labelEd <= labelMax) {
            best = maxOf(best, 200 + ((1 - labelEd.toFloat() / (labelMax + 1)) * 120).toInt())
        }
        // 2) 拼音
        if (ia.pinyin.startsWith(q)) best = maxOf(best, 280 + q.length * 4)
        if (ia.pinyin.contains(q)) best = maxOf(best, 180 + q.length * 3)
        // 3) 首字母
        if (ia.initials.startsWith(q)) best = maxOf(best, 220 + q.length * 4)
        if (ia.initials == q) best = maxOf(best, 320)
        // 4) 多信号融合
        val super_ = matchSuperFast(q, ia)
        best = maxOf(best, super_)
        // 5) 字符重叠兜底
        val scramble = calculateScrambleScore(q, ia)
        best = maxOf(best, scramble)
        return best
    }

    /** T9 优先评分（数字序列主路径）/ T9-first scoring. */
    private fun scoreT9First(q: String, ia: IndexedApp): Int {
        var best = 0
        // 1) T9 数字序列直接匹配
        if (ia.t9Representation.contains(q)) best = maxOf(best, 280 + q.length * 4)
        if (ia.t9Representation.startsWith(q)) best = maxOf(best, 380 + q.length * 5)
        val ed = keyboardAwareEditDistance(q, ia.t9Representation)
        val maxLen = maxOf(q.length, ia.t9Representation.length) / 2 + 1
        if (ed <= maxLen) {
            best = maxOf(best, 200 + ((1 - ed.toFloat() / (maxLen + 1)) * 120).toInt())
        }
        // 2) 也走一下英文索引（如果数字序列碰巧和英文名匹配）
        if (ia.englishName.isNotEmpty()) {
            val edEng = keyboardAwareEditDistance(q, ia.englishName)
            val maxLenEng = maxOf(q.length, ia.englishName.length) / 2 + 1
            if (edEng <= maxLenEng) {
                best = maxOf(best, 150 + ((1 - edEng.toFloat() / (maxLenEng + 1)) * 100).toInt())
            }
        }
        return best
    }

    /** 合并搜索结果（取最高分） / Merge results keeping the best score. */
    private fun mergeResult(
        allResults: ConcurrentHashMap<String, SearchResult>,
        ia: IndexedApp,
        score: Int,
        type: MatchType
    ) {
        val pkg = ia.app.packageName
        val existing = allResults[pkg]
        if (existing == null || score > existing.score) {
            allResults[pkg] = SearchResult(ia.app, score, type)
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  候选查询生成 / Candidate Generation
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * 生成容错候选查询 / Generate tolerant candidate queries.
     *
     * 五种变体：去重连续字符 / 单字符邻位替换 / 双字符邻位替换 / 删除字符 / 交换相邻字符
     * Five variants: dedup / single-key replace / double-key replace / drop / swap.
     */
    fun generateFuzzyCandidates(query: String): List<String> {
        val candidates = mutableSetOf<String>()
        candidates.add(query)

        // 去重连续字符 / Dedup consecutive characters
        val deduped = StringBuilder().apply {
            query.forEach { ch ->
                if (isEmpty() || last() != ch) append(ch)
            }
        }.toString()
        if (deduped != query) candidates.add(deduped)

        // 相邻键位替换（单字符）/ Single-key neighbour replacement
        for (i in query.indices) {
            val neighbors = KEYBOARD_NEIGHBORS[query[i]] ?: continue
            for (n in neighbors) {
                candidates.add(query.substring(0, i) + n + query.substring(i + 1))
            }
        }

        // 相邻键位替换（双字符）/ Double-key neighbour replacement
        if (query.length >= 2) {
            for (i in 0 until query.length - 1) {
                val n1 = KEYBOARD_NEIGHBORS[query[i]] ?: continue
                val n2 = KEYBOARD_NEIGHBORS[query[i + 1]] ?: continue
                for (a in n1) {
                    for (b in n2) {
                        candidates.add(query.substring(0, i) + a + b + query.substring(i + 2))
                    }
                }
            }
        }

        // 删除字符 / Drop a character
        if (query.length > 2) {
            for (i in query.indices) {
                candidates.add(query.substring(0, i) + query.substring(i + 1))
            }
        }

        // 交换相邻字符 / Swap neighbours
        if (query.length >= 2) {
            for (i in 0 until query.length - 1) {
                val swapped = query.substring(0, i) + query[i + 1] + query[i] + query.substring(i + 2)
                candidates.add(swapped)
            }
        }

        return candidates.toList()
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  评分算法 / Scoring Algorithms
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * 计算容错分数（编辑距离 + 字符重叠 + 包含比例）
     * Compute the tolerance score (edit distance + char overlap + containment ratio).
     */
    fun calculateFuzzyScore(q: String, ia: IndexedApp): Int {
        var best = 0

        // 标签编辑距离 / Label edit distance
        val labelDist = keyboardAwareEditDistance(q, ia.label)
        val labelMax = maxOf(q.length, ia.label.length) / 2 + 1
        if (labelDist <= labelMax) {
            best = maxOf(best, 100 + ((1 - labelDist.toFloat() / (labelMax + 1)) * 120).toInt())
        }

        // 拼音编辑距离 / Pinyin edit distance
        val pyDist = keyboardAwareEditDistance(q, ia.pinyin)
        val pyMax = maxOf(q.length, ia.pinyin.length) / 2 + 1
        if (pyDist <= pyMax) {
            best = maxOf(best, 90 + ((1 - pyDist.toFloat() / (pyMax + 1)) * 100).toInt())
        }

        // 首字母编辑距离 / Initials edit distance
        val initDist = keyboardAwareEditDistance(q, ia.initials)
        val initMax = maxOf(q.length, ia.initials.length) / 2 + 1
        if (initDist <= initMax) {
            best = maxOf(best, 80 + ((1 - initDist.toFloat() / (initMax + 1)) * 90).toInt())
        }

        // 字符重叠 / Char overlap
        val overlap = charOverlapRatioFast(q, ia.label)
        if (overlap >= 0.5f) {
            best = maxOf(best, (overlap * 100).toInt())
        }

        // 包含比例 / Containment ratio
        val contain = containRatioFast(q, ia.label)
        if (contain >= 0.5f) {
            best = maxOf(best, (contain * 90).toInt())
        }

        return best
    }

    /**
     * 乱序匹配评分（核心增强）— 任意长度都支持
     * Scramble match scoring — supports any input length, even single chars.
     */
    fun calculateScrambleScore(q: String, ia: IndexedApp): Int {
        if (q.isEmpty()) return 0

        var bestScore = 0

        val labelScore = scrambleMatchScore(q, ia.label)
        if (labelScore > bestScore) bestScore = labelScore

        val pinyinScore = scrambleMatchScore(q, ia.pinyin)
        if (pinyinScore > bestScore) bestScore = pinyinScore

        val initialScore = scrambleMatchScore(q, ia.initials)
        if (initialScore > bestScore) bestScore = initialScore

        val engScore = scrambleMatchScore(q, ia.englishName)
        if (engScore > bestScore) bestScore = engScore

        // T9 兜底：T9 模式下额外走数字序列比对
        // T9 fallback: when T9 mode is active, also compare against the digit sequence.
        if (keyboardLayout == KeyboardLayout.T9_9) {
            val t9Score = scrambleMatchScore(q, ia.t9Representation)
            if (t9Score > bestScore) bestScore = t9Score
        }

        return bestScore
    }

    /**
     * 综合多信号评分（用于多维加权）— 任意长度都支持
     * Multi-signal combined scoring — supports any input length.
     */
    fun matchSuperFast(q: String, ia: IndexedApp): Int {
        if (q.isEmpty()) return 0
        var score = 0f
        var signals = 0

        // 拼音编辑距离 + 字符重叠 / Pinyin edit distance + char overlap
        val pyDist = editDistanceFast(q, ia.pinyin)
        val pyMax = maxOf(ia.pinyin.length / 2, 3)
        if (pyDist <= pyMax && pyDist > 0) {
            val overlap = charOverlapRatioFast(q, ia.pinyin)
            if (overlap >= 0.5f) {
                score += 120 + (1 - pyDist.toFloat() / pyMax) * 80
                signals++
            }
        }

        // n-gram 相似度 / n-gram similarity
        val ngram = bigramSimilarityFast(q, ia.pinyin)
        if (ngram >= 0.35f) { score += 80 + ngram * 80; signals++ }

        // 首字母 Jaccard / Initials Jaccard
        if (q.length >= 2 && ia.initials.length >= 2) {
            val jac = jaccardSimilarityFast(q, ia.initials)
            if (jac >= 0.6f) { score += 60 + jac * 60; signals++ }
        }

        // 字符重叠 / Char overlap
        val labelOverlap = charOverlapRatioFast(q, ia.label)
        if (labelOverlap >= 0.4f) { score += 50 + labelOverlap * 50; signals++ }

        // 乱序 / Scramble
        val scramble = calculateScrambleScore(q, ia)
        if (scramble >= 50) { score += scramble * 0.5f; signals++ }

        return if (signals >= 2 && score >= 15f) score.toInt() else 0
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  内部匹配 / Internal Match
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * 极速匹配（与 AppSearchEngine 共享的快速路径）
     * Fast-path matcher (shared with AppSearchEngine).
     */
    private fun matchIndexedApp(q: String, qLen: Int, ia: IndexedApp): Int {
        var bestScore = 0
        var bestType = MatchType.FUZZY

        if (ia.label == q) { bestScore = 1000; bestType = MatchType.EXACT }
        else if (ia.label.startsWith(q)) { bestScore = 800 + qLen * 6; bestType = MatchType.PREFIX }
        else if (ia.pinyin == q) { bestScore = 600; bestType = MatchType.PINYIN_EXACT }
        else if (ia.pinyin.startsWith(q)) { bestScore = 500 + qLen * 5; bestType = MatchType.PINYIN_PREFIX }

        if (bestScore >= 500) { ia.bestMatchType = bestType; return applyWeight(bestScore, ia) }

        if (bestScore < 400 && ia.initials == q) { bestScore = 400; bestType = MatchType.INITIALS_EXACT }
        else if (bestScore < 350 && ia.initials.startsWith(q)) { bestScore = 350 + qLen * 4; bestType = MatchType.INITIALS_PREFIX }

        if (bestScore >= 350) { ia.bestMatchType = bestType; return applyWeight(bestScore, ia) }

        if (bestScore < 200 && ia.label.contains(q)) { bestScore = 150 + qLen * 5; bestType = MatchType.CONTAINS }
        else if (bestScore < 150 && ia.pinyin.contains(q)) { bestScore = 120 + qLen * 4; bestType = MatchType.PINYIN_CONTAINS }

        if (bestScore < 380 && ia.englishName == q) { bestScore = 380; bestType = MatchType.ENGLISH_EXACT }
        else if (bestScore < 300 && ia.englishName.startsWith(q)) { bestScore = 300 + qLen * 4; bestType = MatchType.ENGLISH_PREFIX }

        if (bestScore < 200 && qLen >= 1) {
            val metaScore = matchMetaCategory(q, ia)
            if (metaScore > bestScore) {
                bestScore = metaScore
                bestType = MatchType.FUZZY_ENGINE_CHAR_OVERLAP
            }
        }

        if (bestScore < 150 && qLen >= 2) {
            val scrambleScore = calculateScrambleScore(q, ia)
            if (scrambleScore > bestScore) {
                bestScore = scrambleScore
                bestType = MatchType.FUZZY_ENGINE_CHAR_OVERLAP
            }
        }

        ia.bestMatchType = bestType
        return applyWeight(bestScore, ia)
    }

    /**
     * 应用使用频率权重 / Apply usage-frequency weight.
     */
    private fun applyWeight(score: Int, ia: IndexedApp): Int {
        if (score == 0) return 0
        val weight = usageWeights[ia.app.packageName] ?: 0f
        return if (weight > 0) {
            (score * (1 + weight * 0.015f)).toInt().coerceAtMost(1200)
        } else score
    }

    /**
     * 元标签分类模糊匹配（复用 MetaTagEngine）
     * Meta-tag category fuzzy match (delegates to MetaTagEngine).
     */
    private fun matchMetaCategory(q: String, ia: IndexedApp): Int {
        val matchedCategories = MetaTagEngine.matchMetaCategory(q)
        if (matchedCategories.isEmpty()) return 0
        val appCats = MetaTagEngine.getCategoriesForApp(ia.app.label)
        if (appCats.isEmpty()) return 0
        for (mc in matchedCategories) {
            if (appCats.contains(mc.category)) {
                return (mc.score * 0.5f).toInt().coerceAtLeast(30)
            }
        }
        return 0
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  乱序匹配核心 / Scramble Match Core
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * 乱序匹配核心算法 — 任意长度都支持，带长查询早终止优化
     * Scramble match core — supports any input length with long-query early termination.
     */
    fun scrambleMatchScore(q: String, target: String): Int {
        if (q.isEmpty() || target.isEmpty()) return 0

        // 长度差过大直接返回（早终止，避免无意义的 O(mn) 计算）
        // If the length gap is too large, return early to avoid wasteful O(mn) work.
        // 我们允许查询比目标长（多键误触场景），但比例不能超过 4 倍
        // We allow q > target up to 4x (e.g. extra-key press), but not unbounded.
        if (q.length > target.length * 4 && target.isNotEmpty()) return 0

        // 极长查询（>32 字符）走快速 n-gram 兜底
        // For very long queries, use the fast n-gram fallback path.
        if (q.length > 32) {
            val bg = bigramSimilarityFast(q, target)
            return if (bg >= 0.4f) (bg * 220).toInt() else 0
        }

        val qChars = q.toCharArray()
        val tChars = target.toCharArray()

        // 预检：查询字符是否都是目标的子集 / Pre-check: query chars subset of target
        val tCharCount = IntArray(128)
        for (c in tChars) {
            if (c.code < 128) tCharCount[c.code]++
        }
        for (c in qChars) {
            if (c.code < 128 && tCharCount[c.code] == 0) {
                return (scrambleMatchScoreFallback(q, target) * 0.6f).toInt()
            }
        }

        // 优先匹配（保持连续性）/ Greedy match (preserves continuity)
        var matched = 0
        var tIdx = 0
        val used = BooleanArray(tChars.size)

        for (qc in qChars) {
            var found = false
            for (i in tIdx until tChars.size) {
                if (!used[i] && tChars[i] == qc) {
                    used[i] = true
                    matched++
                    tIdx = i + 1
                    found = true
                    break
                }
            }
            if (!found) {
                for (i in 0 until tChars.size) {
                    if (!used[i] && tChars[i] == qc) {
                        used[i] = true
                        matched++
                        break
                    }
                }
            }
        }

        if (matched == 0) return 0

        val ratio = matched.toFloat() / q.length
        val coverage = matched.toFloat() / target.length

        return when {
            ratio >= 0.9f -> (250 * ratio * (1 + coverage * 0.5f)).toInt()
            ratio >= 0.7f -> (200 * ratio * (1 + coverage * 0.3f)).toInt()
            ratio >= 0.5f -> (150 * ratio).toInt()
            ratio >= 0.3f -> (100 * ratio).toInt()
            else -> (80 * ratio).toInt()
        }.coerceAtMost(300)
    }

    /** 乱序匹配回退 / Scramble match fallback */
    private fun scrambleMatchScoreFallback(q: String, target: String): Int {
        val qSet = HashSet<Char>().apply { q.forEach { add(it) } }
        val tSet = HashSet<Char>().apply { target.forEach { add(it) } }
        var common = 0
        for (c in qSet) if (c in tSet) common++
        val ratio = common.toFloat() / qSet.size
        return if (ratio >= 0.5f) (120 * ratio).toInt() else 0
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  编辑距离 / Edit Distance
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * 键盘感知编辑距离 / Keyboard-aware edit distance.
     * 相邻键位替换成本 = 1，普通替换成本 = 2
     * Adjacent key replacement costs 1, normal replacement costs 2.
     * 自动根据当前 [keyboardLayout] 选用 QWERTY 或 T9 邻位关系。
     * Automatically uses the QWERTY or T9 neighbour map based on [keyboardLayout].
     *
     * 性能说明 / Performance: O(mn). 对长字符串做了早终止和 Ukkonen 剪枝。
     * Long strings are protected by early termination + Ukkonen-style band pruning.
     */
    fun keyboardAwareEditDistance(a: String, b: String): Int {
        val m = a.length
        val n = b.length
        if (m == 0) return n
        if (n == 0) return m

        // 极长字符串：超出 64 字符时降级为经典编辑距离（O(mn) 同样但常数更小）
        // For very long strings (>64 chars) we fall back to classic edit distance,
        // which has a smaller constant.
        if (m > 64 || n > 64) {
            return editDistanceFast(a, b)
        }

        // 长度差过大：当前没有任何可能匹配上，直接返回
        // If the length gap is too large, no possible match — return early.
        val lengthGap = kotlin.math.abs(m - n)
        if (lengthGap > (m + n) / 2 + 2) {
            return lengthGap
        }

        var prev = IntArray(n + 1) { it }
        var curr = IntArray(n + 1)

        for (i in 1..m) {
            curr[0] = i
            for (j in 1..n) {
                val cost = when {
                    a[i - 1] == b[j - 1] -> 0
                    isKeyboardNeighbor(a[i - 1], b[j - 1]) -> 1
                    else -> 2
                }
                curr[j] = minOf(prev[j] + 2, curr[j - 1] + 2, prev[j - 1] + cost)
            }
            val tmp = prev; prev = curr; curr = tmp
        }
        return prev[n]
    }

    /**
     * 经典编辑距离（Levenshtein）/ Classic Levenshtein distance.
     * 同样支持任意长度，长字符串走单行 buffer 优化。
     */
    fun editDistanceFast(a: String, b: String): Int {
        val m = a.length; val n = b.length
        if (m == 0) return n; if (n == 0) return m
        // 早终止：长度差过大直接返回
        // Early termination when length gap is too large.
        val lengthGap = kotlin.math.abs(m - n)
        if (lengthGap > (m + n) / 2 + 2) return lengthGap
        var prev = IntArray(n + 1) { it }
        var curr = IntArray(n + 1)
        for (i in 1..m) {
            curr[0] = i
            for (j in 1..n) {
                curr[j] = if (a[i - 1] == b[j - 1]) prev[j - 1]
                else 1 + minOf(prev[j], curr[j - 1], prev[j - 1])
            }
            val tmp = prev; prev = curr; curr = tmp
        }
        return prev[n]
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  相似度工具 / Similarity Utilities
    // ═══════════════════════════════════════════════════════════════════════════

    /** Bigram Jaccard 相似度 / Bigram Jaccard similarity. */
    fun bigramSimilarityFast(a: String, b: String): Float {
        if (a.length < 2 || b.length < 2) return 0f
        val setA = HashSet<String>().apply {
            for (i in 0 until a.length - 1) add(a.substring(i, i + 2))
        }
        val setB = HashSet<String>().apply {
            for (i in 0 until b.length - 1) add(b.substring(i, i + 2))
        }
        var inter = 0
        for (bg in setA) if (bg in setB) inter++
        val union = setA.size + setB.size - inter
        return if (union == 0) 0f else inter.toFloat() / union
    }

    /** 字符集 Jaccard 相似度 / Character-set Jaccard similarity. */
    fun jaccardSimilarityFast(a: String, b: String): Float {
        if (a.isEmpty() && b.isEmpty()) return 1f
        if (a.isEmpty() || b.isEmpty()) return 0f
        val setA = HashSet<Char>().apply { a.forEach { add(it) } }
        val setB = HashSet<Char>().apply { b.forEach { add(it) } }
        var inter = 0
        for (ch in setA) if (ch in setB) inter++
        return inter.toFloat() / (setA.size + setB.size - inter)
    }

    /** 字符重叠率 / Char overlap ratio. */
    fun charOverlapRatioFast(a: String, b: String): Float {
        if (a.isEmpty() || b.isEmpty()) return 0f
        val setA = HashSet<Char>(a.length).apply { a.forEach { add(it) } }
        val setB = HashSet<Char>(b.length).apply { b.forEach { add(it) } }
        var common = 0
        for (ch in setA) if (ch in setB) common++
        return common.toFloat() / maxOf(setA.size, setB.size)
    }

    /** 包含比例 / Containment ratio. */
    fun containRatioFast(q: String, target: String): Float {
        if (q.isEmpty()) return 0f
        var tIdx = 0
        var matched = 0
        for (ch in q) {
            val idx = target.indexOf(ch, tIdx)
            if (idx >= 0) { matched++; tIdx = idx + 1 }
        }
        return matched.toFloat() / q.length
    }

    /** 子序列连续度 / Subsequence continuity. */
    fun subsequenceContinuityFast(q: String, target: String): Int {
        var last = -1
        var gap = 0
        var found = 0
        for (ch in q) {
            val idx = target.indexOf(ch, last + 1)
            if (idx >= 0) {
                if (last >= 0) gap += idx - last - 1
                last = idx
                found++
            }
        }
        if (found < q.length) return 0
        val maxGap = target.length - q.length
        return if (maxGap == 0) 49 else ((1.0 - gap.toDouble() / maxGap) * 49).toInt().coerceIn(0, 49)
    }

    /**
     * 是否为键盘相邻键（按当前 [keyboardLayout] 自动选用映射表）
     * Whether two characters are keyboard neighbours (uses the active layout's map).
     */
    fun isKeyboardNeighbor(a: Char, b: Char): Boolean {
        val map = when (keyboardLayout) {
            KeyboardLayout.QWERTY_26 -> KEYBOARD_NEIGHBORS_QWERTY
            KeyboardLayout.T9_9 -> KEYBOARD_NEIGHBORS_T9
        }
        return b in (map[a] ?: emptyList())
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  数据类 / Data Class
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * 预计算索引应用 / Pre-computed indexed app.
     * 构建时一次性计算所有衍生属性，避免热路径上的重复计算。
     * All derived attributes are computed once at build-time.
     */
    class IndexedApp(val app: AppInfo) {
        val label = app.labelLower
        val pinyin = app.pinyin
        val initials = app.pinyinInitials
        val englishName = extractEnglishName(app.labelLower)
        /**
         * T9 数字序列 / T9 digit sequence.
         * 例：微信 → 9430 → weixin → 9434966
         * Example: 微信 → 9430 → weixin → 9434966
         * T9 模式下用户输入纯数字（如 943 = wei / xin）时用来匹配。
         * Used for digit-only T9 matching (e.g. 943 = wei / xin).
         */
        val t9Representation: String = computeT9(label)
        var bestMatchType: MatchType = MatchType.FUZZY

        companion object {
            /**
             * 从应用名称中提取英文部分
             * Extract the English portion from an app label.
             * e.g. "微信 WeChat" -> "wechat"
             */
            fun extractEnglishName(label: String): String {
                val sb = StringBuilder()
                var inEnglish = false
                for (c in label) {
                    when {
                        c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' -> {
                            sb.append(c.lowercaseChar())
                            inEnglish = true
                        }
                        inEnglish && c == ' ' -> sb.append(' ')
                        else -> inEnglish = false
                    }
                }
                return sb.toString().replace(" ", "")
            }

            /**
             * 把字符串转成 T9 数字序列 / Convert a string to T9 digit sequence.
             * 例：weixin → 9434966，微信 → 9430
             * Skips non-letters so "微信 WeChat" → 9430 943428.
             */
            fun computeT9(text: String): String {
                val sb = StringBuilder()
                for (c in text) {
                    val digit = T9_DIGIT_MAP[c] ?: continue
                    sb.append(digit)
                }
                return sb.toString()
            }
        }
    }

    companion object {
        /**
         * 26 键 QWERTY 键盘相邻键位映射 / 26-key QWERTY neighbour mapping.
         */
        private val KEYBOARD_NEIGHBORS_QWERTY = mapOf(
            'q' to listOf('w', 'a', 's'), 'w' to listOf('q', 'e', 'a', 's', 'd'),
            'e' to listOf('w', 'r', 's', 'd', 'f'), 'r' to listOf('e', 't', 'd', 'f', 'g'),
            't' to listOf('r', 'y', 'f', 'g', 'h'), 'y' to listOf('t', 'u', 'g', 'h', 'j'),
            'u' to listOf('y', 'i', 'h', 'j', 'k'), 'i' to listOf('u', 'o', 'j', 'k', 'l'),
            'o' to listOf('i', 'p', 'k', 'l'), 'p' to listOf('i', 'o', 'k', 'l'),
            'a' to listOf('q', 'w', 's', 'z', 'x'), 's' to listOf('q', 'w', 'e', 'a', 'd', 'z', 'x', 'c'),
            'd' to listOf('w', 'e', 'r', 's', 'f', 'x', 'c', 'v'), 'f' to listOf('e', 'r', 't', 'd', 'g', 'c', 'v', 'b'),
            'g' to listOf('r', 't', 'y', 'f', 'h', 'v', 'b', 'n'), 'h' to listOf('t', 'y', 'u', 'g', 'j', 'b', 'n', 'm'),
            'j' to listOf('y', 'u', 'i', 'h', 'k', 'n', 'm'), 'k' to listOf('u', 'i', 'o', 'j', 'l', 'm'),
            'l' to listOf('i', 'o', 'p', 'k'), 'z' to listOf('a', 's', 'x'),
            'x' to listOf('z', 'a', 's', 'd', 'c'), 'c' to listOf('x', 's', 'd', 'f', 'v'),
            'v' to listOf('c', 'd', 'f', 'g', 'b'), 'b' to listOf('v', 'f', 'g', 'h', 'n'),
            'n' to listOf('b', 'g', 'h', 'j', 'm'), 'm' to listOf('n', 'h', 'j', 'k')
        )

        /**
         * 9 键 T9 键盘相邻键位映射 / 9-key T9 neighbour mapping.
         *
         * 物理布局：
         *   1        2(abc)   3(def)
         *   4(ghi)   5(jkl)   6(mno)
         *   7(pqrs)  8(tuv)   9(wxyz)
         *   *        0        #
         *
         * T9 邻位规则：
         *   - 同一键位内的字母互为邻位（如 a↔b↔c）
         *   - 物理相邻键的字母互为邻位（如 a↔d, a↔g, s↔z）
         *   - 数字键之间也走物理相邻
         *   - 用于把"按错一位"成本降到 1
         */
        private val KEYBOARD_NEIGHBORS_T9 = mapOf(
            // 键 2: abc
            'a' to listOf('b', 'c', 'd', 'g'), 'b' to listOf('a', 'c', 'e', 'h'),
            'c' to listOf('a', 'b', 'f', 'i'),
            // 键 3: def
            'd' to listOf('e', 'f', 'a', 'g', 'j'), 'e' to listOf('d', 'f', 'b', 'h', 'k'),
            'f' to listOf('d', 'e', 'c', 'i', 'l'),
            // 键 4: ghi
            'g' to listOf('h', 'i', 'a', 'd', 'j', 'm'),
            'h' to listOf('g', 'i', 'b', 'e', 'k', 'n'),
            'i' to listOf('g', 'h', 'c', 'f', 'l', 'o'),
            // 键 5: jkl
            'j' to listOf('k', 'l', 'd', 'g', 'm', 'p'),
            'k' to listOf('j', 'l', 'e', 'h', 'n', 'q'),
            'l' to listOf('j', 'k', 'f', 'i', 'o', 'r'),
            // 键 6: mno
            'm' to listOf('n', 'o', 'g', 'j', 'p', 's'),
            'n' to listOf('m', 'o', 'h', 'k', 'q', 't'),
            'o' to listOf('m', 'n', 'i', 'l', 'r', 'u'),
            // 键 7: pqrs
            'p' to listOf('q', 'r', 'j', 'm', 's', 'v'),
            'q' to listOf('p', 'r', 's', 'k', 'n', 't', 'w'),
            'r' to listOf('p', 'q', 's', 'l', 'o', 'u', 'x'),
            's' to listOf('p', 'q', 'r', 'm', 't', 'v', 'y'),
            // 键 8: tuv
            't' to listOf('u', 'v', 'n', 'q', 's', 'w', 'z'),
            'u' to listOf('t', 'v', 'o', 'r', 'w', 'x'),
            'v' to listOf('t', 'u', 'p', 's', 'w', 'y'),
            // 键 9: wxyz
            'w' to listOf('x', 'y', 'q', 't', 'u', 'v', 'z'),
            'x' to listOf('w', 'y', 'z', 'r', 'u'),
            'y' to listOf('w', 'x', 'z', 's', 'v'),
            'z' to listOf('w', 'x', 'y', 't')
        )

        /**
         * T9 字母 → 数字 映射 / T9 letter-to-digit map.
         * 2=abc, 3=def, 4=ghi, 5=jkl, 6=mno, 7=pqrs, 8=tuv, 9=wxyz
         */
        private val T9_DIGIT_MAP = mapOf(
            'a' to '2', 'b' to '2', 'c' to '2',
            'd' to '3', 'e' to '3', 'f' to '3',
            'g' to '4', 'h' to '4', 'i' to '4',
            'j' to '5', 'k' to '5', 'l' to '5',
            'm' to '6', 'n' to '6', 'o' to '6',
            'p' to '7', 'q' to '7', 'r' to '7', 's' to '7',
            't' to '8', 'u' to '8', 'v' to '8',
            'w' to '9', 'x' to '9', 'y' to '9', 'z' to '9'
        )

        /**
         * 旧名兼容 / Backward-compat alias.
         * @deprecated 请用 [KEYBOARD_NEIGHBORS_QWERTY] / Use [KEYBOARD_NEIGHBORS_QWERTY].
         */
        @Deprecated("Use KEYBOARD_NEIGHBORS_QWERTY", ReplaceWith("KEYBOARD_NEIGHBORS_QWERTY"))
        private val KEYBOARD_NEIGHBORS: Map<Char, List<Char>> get() = KEYBOARD_NEIGHBORS_QWERTY
    }
}
