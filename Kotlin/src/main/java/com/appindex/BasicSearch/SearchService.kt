package com.appindex.BasicSearch

import android.content.Context
import com.appindex.BasicSearch.AppIndexEngine
import com.appindex.BasicSearch.MetaTagEngine
import com.appindex.model.AppInfo
import com.appindex.model.SearchMode
import com.appindex.model.SearchResult
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║                    搜索服务层 — UI与搜索层完全分离                             ║
 * ║                                                                              ║
 * ║  核心特性：                                                                    ║
 * ║  1. 【完全解耦】UI层只调用服务接口，不依赖具体搜索实现                          ║
 * ║  2. 【异步优先】所有搜索操作在后台线程执行，不阻塞主线程                         ║
 * ║  3. 【请求合并】相同查询自动合并，避免重复计算                                   ║
 * ║  4. 【取消支持】新请求到来时自动取消旧请求，保证响应最新                         ║
 * ║  5. 【结果缓存】LRU缓存 + 内存缓存，毫秒级响应                                  ║
 * ║  6. 【线程安全】完整的并发控制和状态管理                                        ║
 * ║                                                                              ║
 * ║  架构设计：                                                                    ║
 * ║  ┌─────────────────────────────────────────────────────────────────────┐     ║
 * ║  │                           UI Layer                                  │     ║
 * ║  │   SearchActivity / SettingsActivity / OverlaySearchService          │     ║
 * ║  └─────────────────────────┬───────────────────────────────────────────┘     ║
 * ║                            │ 调用 SearchService API                          ║
 * ║                            ▼                                                 ║
 * ║  ┌─────────────────────────────────────────────────────────────────────┐     ║
 * ║  │                     SearchService (服务层)                           │     ║
 * ║  │  - 请求队列管理       - 缓存策略       - 搜索状态管理                 │     ║
 * ║  └─────────────────────────┬───────────────────────────────────────────┘     ║
 * ║                            │ 内部调用                                         ║
 * ║                            ▼                                                 ║
 * ║  ┌─────────────────────────────────────────────────────────────────────┐     ║
 * ║  │                     Search Engine Layer                             │     ║
 * ║  │  - AppSearchEngine    - FuzzyMatchEngine    - MetaTagIndex          │     ║
 * ║  └─────────────────────────────────────────────────────────────────────┘     ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */
class SearchService private constructor(
    context: Context,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default
) {

    // ─── 核心引擎 ───
    private val indexEngine = AppIndexEngine(context)
    private val searchEngine = AppSearchEngine()

    // ─── 协程作用域 ───
    private val serviceScope = CoroutineScope(SupervisorJob() + dispatcher)

    // ─── 请求管理 ───
    private val currentSearchJob = AtomicReference<Job?>(null)
    private val pendingQueries = ConcurrentLinkedQueue<String>()
    private val isProcessing = AtomicBoolean(false)

    // ─── 搜索状态 ───
    private val _isIndexing = MutableSharedFlow<Boolean>(replay = 1)
    val isIndexing = _isIndexing.asSharedFlow()

    private val _searchResults = MutableSharedFlow<List<SearchResult>>(replay = 1)
    val searchResults = _searchResults.asSharedFlow()

    private val _searchTime = MutableSharedFlow<Long>(replay = 1)
    val searchTime = _searchTime.asSharedFlow()

    private val _allApps = MutableSharedFlow<List<AppInfo>>(replay = 1)
    val allApps = _allApps.asSharedFlow()

    // ─── 搜索模式 ───
    private val currentSearchMode = AtomicReference(SearchMode.STANDARD)

    // ─── 缓存策略 ───
    private val searchCache = ConcurrentHashMap<String, CacheEntry>()
    private val CACHE_MAX_SIZE = 64
    private val CACHE_TTL_MS = 5 * 60 * 1000 // 5分钟

    // ─── 统计信息 ───
    private val searchCount = AtomicInteger(0)
    private val cacheHitCount = AtomicInteger(0)

    // ─── 内部类 ───
    private data class CacheEntry(
        val results: List<SearchResult>,
        val timestamp: Long,
        val searchMode: SearchMode
    )

    private class AtomicReference<T>(initial: T) {
        private val value = java.util.concurrent.atomic.AtomicReference(initial)
        fun get() = value.get()
        fun set(newValue: T) = value.set(newValue)
        fun compareAndSet(expected: T, newValue: T) = value.compareAndSet(expected, newValue)
    }

    // ─── 初始化 ───
    init {
        initialize()
    }

    /**
     * 初始化搜索服务
     */
    private fun initialize() {
        serviceScope.launch {
            performInitialIndex()
        }
    }

    /**
     * 执行初始索引
     */
    private suspend fun performInitialIndex() {
        _isIndexing.emit(true)
        try {
            val apps = indexEngine.indexAllApps()
            searchEngine.buildIndex(apps)
            MetaTagEngine.buildAppCategories(apps)
            _allApps.emit(apps)
        } finally {
            _isIndexing.emit(false)
        }
    }

    // ─── 公共 API ───

    /**
     * 执行搜索（异步）
     * @param query 搜索查询字符串
     * @param mode 搜索模式（可选，默认使用当前模式）
     */
    fun search(query: String, mode: SearchMode? = null) {
        val effectiveMode = mode ?: currentSearchMode.get()
        
        // 快速路径：空查询直接返回
        if (query.isBlank()) {
            serviceScope.launch {
                _searchResults.emit(emptyList())
                _searchTime.emit(0)
            }
            return
        }

        // 检查缓存
        val cached = getCachedResult(query, effectiveMode)
        if (cached != null) {
            cacheHitCount.incrementAndGet()
            serviceScope.launch {
                _searchResults.emit(cached)
                _searchTime.emit(0)
            }
            return
        }

        // 取消当前正在执行的搜索
        currentSearchJob.get()?.cancel()

        // 提交新搜索请求
        val job = serviceScope.launch {
            performSearch(query, effectiveMode)
        }
        currentSearchJob.set(job)
    }

    /**
     * 获取缓存的搜索结果
     */
    private fun getCachedResult(query: String, mode: SearchMode): List<SearchResult>? {
        val entry = searchCache[query]
        return if (entry != null && 
            entry.searchMode == mode && 
            System.currentTimeMillis() - entry.timestamp < CACHE_TTL_MS) {
            entry.results
        } else {
            null
        }
    }

    /**
     * 执行实际搜索（后台线程）
     */
    private suspend fun performSearch(query: String, mode: SearchMode) {
        searchCount.incrementAndGet()
        
        val startTime = System.nanoTime()
        
        try {
            // 获取当前应用列表
            val apps = indexEngine.indexedApps
            if (apps.isEmpty()) {
                _searchResults.emit(emptyList())
                _searchTime.emit(0)
                return
            }

            // 确保索引已构建
            searchEngine.searchMode = mode
            
            // 执行搜索
            val results = withContext(dispatcher) {
                // 检测是否为追加搜索
                val isAppendSearch = query.length >= 4 && detectAppendSearch(query, apps)
                
                if (isAppendSearch) {
                    // 使用追加搜索
                    val (_, appendResults) = searchEngine.appendSearch(query, apps, 50)
                    appendResults
                } else {
                    // 标准搜索流程
                    val exactResults = searchEngine.searchParallel(query, apps, 30)
                    
                    if (exactResults.size < 6 && query.length >= 2) {
                        val fuzzyResults = searchEngine.fuzzySearchParallel(query, apps, 30)
                        mergeResults(exactResults, fuzzyResults)
                    } else {
                        exactResults
                    }
                }
            }

            // 缓存结果
            cacheResult(query, results, mode)

            // 计算耗时
            val elapsed = (System.nanoTime() - startTime) / 1_000_000

            // 发送结果
            _searchResults.emit(results)
            _searchTime.emit(elapsed)
            
        } catch (e: Exception) {
            // 搜索失败时返回空结果
            _searchResults.emit(emptyList())
            _searchTime.emit(0)
        }
    }

    /**
     * 缓存搜索结果
     */
    private fun cacheResult(query: String, results: List<SearchResult>, mode: SearchMode) {
        synchronized(searchCache) {
            // 清理过期缓存
            val now = System.currentTimeMillis()
            searchCache.entries.removeIf { 
                now - it.value.timestamp > CACHE_TTL_MS 
            }
            
            // 如果缓存已满，移除最旧的条目
            if (searchCache.size >= CACHE_MAX_SIZE) {
                val oldestKey = searchCache.minByOrNull { it.value.timestamp }?.key
                oldestKey?.let { searchCache.remove(it) }
            }
            
            // 添加新缓存
            searchCache[query] = CacheEntry(results, now, mode)
        }
    }

    /**
     * 检测是否为追加搜索模式
     */
    private fun detectAppendSearch(query: String, apps: List<AppInfo>): Boolean {
        if (apps.isEmpty()) return false
        searchEngine.buildIndex(apps)
        val intents = searchEngine.extractIntents(query)
        return intents.size >= 2
    }

    /**
     * 合并搜索结果（精确匹配优先）
     */
    private fun mergeResults(
        exactResults: List<SearchResult>,
        fuzzyResults: List<SearchResult>
    ): List<SearchResult> {
        val merged = mutableListOf<SearchResult>()
        val seenPackages = mutableSetOf<String>()

        // 添加精确匹配结果
        for (r in exactResults) {
            merged.add(r)
            seenPackages.add(r.appInfo.packageName)
        }

        // 添加模糊匹配结果（去重）
        for (r in fuzzyResults) {
            if (r.appInfo.packageName !in seenPackages) {
                merged.add(r)
            }
        }

        // 按分数排序并限制数量
        return merged.sortedByDescending { it.score }.take(50)
    }

    /**
     * 设置搜索模式
     */
    fun setSearchMode(mode: SearchMode) {
        currentSearchMode.set(mode)
        searchEngine.searchMode = mode
        // 清除缓存（模式改变时缓存失效）
        clearCache()
    }

    /**
     * 获取当前搜索模式
     */
    fun getSearchMode(): SearchMode = currentSearchMode.get()

    /**
     * 重新索引应用列表
     */
    fun rebuildIndex() {
        serviceScope.launch {
            _isIndexing.emit(true)
            try {
                searchEngine.clearCache()
                val apps = indexEngine.indexAllApps()
                searchEngine.buildIndex(apps)
                MetaTagEngine.buildAppCategories(apps)
                _allApps.emit(apps)
                clearCache() // 索引改变时清除搜索缓存
            } finally {
                _isIndexing.emit(false)
            }
        }
    }

    /**
     * 清除搜索缓存
     */
    fun clearCache() {
        synchronized(searchCache) {
            searchCache.clear()
        }
        searchEngine.clearCache()
    }

    /**
     * 记录应用使用（用于频率加权）
     */
    fun recordAppUsage(packageName: String) {
        searchEngine.recordAppUsage(packageName)
    }

    /**
     * 获取应用总数
     */
    fun getAppCount(): Int = indexEngine.getAppCount()

    /**
     * 获取搜索统计信息
     */
    fun getStatistics(): Statistics {
        return Statistics(
            totalSearches = searchCount.get(),
            cacheHits = cacheHitCount.get(),
            cacheSize = searchCache.size
        )
    }

    /**
     * 搜索统计信息
     */
    data class Statistics(
        val totalSearches: Int,
        val cacheHits: Int,
        val cacheSize: Int
    )

    /**
     * 释放资源
     */
    fun release() {
        serviceScope.coroutineContext.cancelChildren()
        clearCache()
    }

    // ─── 单例模式 ───
    companion object {
        @Volatile
        private var instance: SearchService? = null

        /**
         * 获取搜索服务实例（延迟初始化）
         */
        fun getInstance(context: Context): SearchService {
            return instance ?: synchronized(this) {
                instance ?: SearchService(context.applicationContext).also { instance = it }
            }
        }

        /**
         * 获取搜索服务实例（指定调度器，用于测试）
         */
        fun getInstance(context: Context, dispatcher: CoroutineDispatcher): SearchService {
            return SearchService(context.applicationContext, dispatcher)
        }
    }
}