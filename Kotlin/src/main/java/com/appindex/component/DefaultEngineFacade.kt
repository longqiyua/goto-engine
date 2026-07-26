package com.appindex.component

import android.content.Context
import com.appindex.AdaptiveRefresh.SearchOrchestrator
import com.appindex.BasicSearch.AppIndexEngine
import com.appindex.BasicSearch.AppSearchEngine
import com.appindex.BasicSearch.MetaTagEngine
import com.appindex.BasicSearch.MetaTagIndex
import com.appindex.model.AppInfo
import com.appindex.model.SearchResult

/**
 * GOTO Engine Kotlin 版 - 默认引擎门面实现
 *
 * 聚合 Kotlin 版各核心类（[AppIndexEngine] / [AppSearchEngine] /
 * [MetaTagEngine] / [MetaTagIndex] / [SearchOrchestrator]），
 * 实现 [GotoEngineFacade] 接口，供 [EngineComponent] 使用。
 *
 * ## 设计说明
 *
 * JS / Rust 版引擎核心是"单一对象"，Kotlin 版是"多类协作"。
 * 本门面把多类协作封装为单一接口，使组件层与 JS / Rust 行为对齐。
 *
 * ## 线程安全
 *
 * - [AppSearchEngine] / [MetaTagEngine] / [MetaTagIndex] 内部使用协程 + 并发集合，线程安全。
 * - [AppIndexEngine] 的应用列表使用 `CopyOnWriteArrayList`，可安全并发读。
 * - 本门面本身无额外可变状态，线程安全由底层类保证。
 *
 * @param context Android Context（用于 [AppIndexEngine] 扫描 PackageManager 和数据库初始化）
 */
class DefaultEngineFacade(private val context: Context) : GotoEngineFacade {

    private val indexEngine: AppIndexEngine = AppIndexEngine(context)
    private val searchEngine: AppSearchEngine = AppSearchEngine()
    private val metaTagEngine: MetaTagEngine = MetaTagEngine
    private val metaTagIndex: MetaTagIndex = MetaTagIndex()
    private val orchestrator: SearchOrchestrator = SearchOrchestrator()

    @Volatile
    private var dataset: List<AppInfo> = emptyList()

    @Volatile
    private var contextMap: Map<String, String> = emptyMap()

    @Volatile
    private var indexBuilt: Boolean = false

    override fun setAppDataset(apps: List<AppInfo>): Int {
        dataset = apps
        indexBuilt = false
        rebuildIndex()
        return apps.size
    }

    override fun search(query: String, limit: Int): List<SearchResult> {
        if (!indexBuilt) rebuildIndex()
        // 1. 主搜索引擎（18 层匹配维度 + 并行协程）
        val mainResults = searchEngine.search(query, dataset)
        // 2. 元标签搜索（MECE 分类 + 同义词簇），结果合并去重
        val metaResults = metaTagEngine.search(query)
        // 3. 元标签索引（语义召回）
        val metaIndexResults = metaTagIndex.search(query)
        // 合并：主结果优先，元标签结果补充（去重）
        val seen = HashSet<String>()
        val merged = ArrayList<SearchResult>(mainResults.size + metaResults.size + metaIndexResults.size)
        for (r in mainResults) {
            if (seen.add(r.appName)) merged.add(r)
        }
        for (r in metaResults) {
            if (seen.add(r.appName)) merged.add(r)
        }
        for (r in metaIndexResults) {
            if (seen.add(r.appName)) merged.add(r)
        }
        return merged.take(limit)
    }

    override fun recordSelection(query: String, appName: String) {
        // 委托给 SearchService / StatisticsDao 处理（Kotlin 版统计写入数据库）
        // 此处保留接口对齐，具体写入由调用方通过 DAO 完成
    }

    override fun recordSearch(query: String) {
        // 同上，由调用方通过 DAO 完成统计写入
    }

    override fun recordUnknownApp(query: String, appName: String) {
        // Kotlin 版目前无对应实现（JS / Rust 独有），保留接口对齐
    }

    override fun rebuildIndex() {
        indexEngine.buildIndex()
        indexBuilt = true
    }

    override fun setContext(context: Map<String, String>) {
        contextMap = context
    }

    override fun clearContext() {
        contextMap = emptyMap()
    }

    override fun maintain() {
        // Kotlin 版无对应维护逻辑（JS / Rust 的衰减/修剪由 Storage 层处理）
        // 保留接口对齐
    }

    override fun isReady(): Boolean = indexBuilt && dataset.isNotEmpty()

    override fun datasetSize(): Int = dataset.size

    /** 暴露底层 SearchOrchestrator 供调用方使用自适应刷新调度。 */
    fun orchestrator(): SearchOrchestrator = orchestrator

    /** 暴露底层 AppIndexEngine 供调用方使用索引功能。 */
    fun indexEngine(): AppIndexEngine = indexEngine

    /** 暴露底层 AppSearchEngine 供调用方使用高级搜索功能。 */
    fun searchEngine(): AppSearchEngine = searchEngine
}
