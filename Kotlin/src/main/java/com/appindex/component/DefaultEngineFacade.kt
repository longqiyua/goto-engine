package com.appindex.component

import android.content.Context
import com.appindex.AdaptiveRefresh.SearchOrchestrator
import com.appindex.BasicSearch.AppIndexEngine
import com.appindex.BasicSearch.AppSearchEngine
import com.appindex.BasicSearch.MetaTagEngine
import com.appindex.BasicSearch.MetaTagIndex
import com.appindex.BasicSearch.SearchService
import com.appindex.Personalization.TypingSpeedTracker
import com.appindex.Rerank.EngineBaseBridge
import com.appindex.Rerank.PersonalReranker
import com.appindex.Rerank.PersonalSnapshot
import com.appindex.Rerank.RuntimeContext
import com.appindex.Rerank.RagEmbedderHolder
import com.appindex.Rerank.RagRebuilder
import com.appindex.Rerank.RagTransitionController
import com.appindex.AppRegistry.AppListStore
import com.appindex.model.AppInfo
import com.appindex.model.MatchType
import com.appindex.model.SearchResult
import java.util.Calendar

/**
 * GOTO Engine Kotlin 版 - 默认引擎门面实现
 *
 * 聚合 Kotlin 版各核心类（[AppIndexEngine] / [AppSearchEngine] /
 * [MetaTagEngine] / [MetaTagIndex] / [SearchOrchestrator]），
 * 实现 [GotoEngineFacade] 接口，供 [EngineComponent] 使用。
 *
 * v2.1 新增：第四层（梳理层 PersonalReranker）+ Base 桥接（EngineBaseBridge）。
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
    private val orchestrator: SearchOrchestrator = SearchOrchestrator(
        searchService = SearchService.getInstance(context),
        typingSpeedTracker = TypingSpeedTracker(context)
    )

    @Volatile
    private var dataset: List<AppInfo> = emptyList()

    @Volatile
    private var contextMap: Map<String, String> = emptyMap()

    @Volatile
    private var indexBuilt: Boolean = false

    // v2.1: L4 梳理层 — Base 桥接 + 快照缓存
    @Volatile
    private var baseBridge: EngineBaseBridge? = null

    @Volatile
    private var personalRerankEnabled: Boolean = true

    @Volatile
    private var personalSnapshot: PersonalSnapshot? = null

    @Volatile
    private var personalSnapshotTs: Long = 0L

    private val personalSnapshotTTL: Long = 30_000L  // 30s 内复用快照

    override fun setAppDataset(apps: List<AppInfo>): Int {
        dataset = apps
        indexBuilt = false
        rebuildIndex()
        return apps.size
    }

    override fun search(query: String, limit: Int): List<SearchResult> {
        if (!indexBuilt) rebuildIndex()
        // L2: 主搜索引擎（18 层匹配维度 + 并行协程）
        val mainResults = searchEngine.search(query, dataset)
        // L3: 元标签搜索（MECE 分类 + 同义词簇），结果合并去重
        val metaResults = metaTagEngine.searchByCategory(query, dataset).map { (app, score) ->
            SearchResult(appInfo = app, score = score, matchType = MatchType.META_TAG)
        }
        val metaIndexResults = metaTagIndex.searchAsSearchResults(query)
        // 合并：主结果优先，元标签结果补充（去重）
        val seen = HashSet<String>()
        val merged = ArrayList<SearchResult>(mainResults.size + metaResults.size + metaIndexResults.size)
        for (r in mainResults) {
            if (seen.add(r.appInfo.packageName)) merged.add(r)
        }
        for (r in metaResults) {
            if (seen.add(r.appInfo.packageName)) merged.add(r)
        }
        for (r in metaIndexResults) {
            if (seen.add(r.appInfo.packageName)) merged.add(r)
        }
        val limited = merged.take(limit)

        // v2.1: L4 梳理层（personal rerank）
        return applyPersonalRerankSync(query, limited)
    }

    /**
     * v2.1: L4 梳理层 — 同步消费缓存快照（保证零延迟）。
     * 快照过期则跳过（等待异步刷新）。
     */
    private fun applyPersonalRerankSync(query: String, list: List<SearchResult>): List<SearchResult> {
        if (!personalRerankEnabled || list.isEmpty()) return list
        val snap = personalSnapshot ?: return list
        if (snap.degraded) return list
        val now = System.currentTimeMillis()
        if (now - personalSnapshotTs > personalSnapshotTTL) return list

        val result = PersonalReranker.rerank(query, list, snap)
        return if (result.applied) result.list else list
    }

    /**
     * v2.1: 异步刷新梳理层快照（由调用方在搜索后触发，不阻塞当前返回）。
     * 在 Kotlin 协程中推荐：launch(Dispatchers.IO) { refreshPersonalSnapshotAsync(...) }
     */
    fun refreshPersonalSnapshotAsync(query: String, list: List<SearchResult>) {
        val bridge = baseBridge ?: return
        if (bridge.degraded) return
        val packages = list.map { it.appInfo.packageName }.filter { it.isNotEmpty() }
        if (packages.isEmpty()) return

        val cal = Calendar.getInstance()
        val ctx = RuntimeContext(
            hour = cal.get(Calendar.HOUR_OF_DAY),
            weekday = cal.get(Calendar.DAY_OF_WEEK) - 1,  // Calendar 周日=1 → 转 0-based
            geofenceId = contextMap["geofenceId"] ?: "",
            foregroundPackage = contextMap["previousAppPackage"] ?: ""
        )
        try {
            val snap = bridge.getPersonalSnapshot(query, packages, ctx)
            if (!snap.degraded) {
                personalSnapshot = snap
                personalSnapshotTs = System.currentTimeMillis()
            }
        } catch (_: Throwable) {
            // 快照刷新失败静默
        }
    }

    /**
     * v2.1: 注入 Base 桥接（由宿主在 Base 加载完成后调用）。
     */
    fun setBaseBridge(bridge: EngineBaseBridge?) {
        baseBridge = bridge
    }

    /**
     * v2.1: 用户点击 → 写入 Base feedback-chain。
     * 误操作（搜索→点击间隔过短）请由调用方判断后决定是否调用此方法。
     */
    fun recordSelectionToBase(
        query: String,
        clickedPackage: String,
        clickedAppName: String,
        clickedRank: Int,            // 0-based; -1=手动启动
        candidateCount: Int,
        matchMode: String
    ): String? {
        val bridge = baseBridge ?: return null
        if (bridge.degraded) return null

        val cal = Calendar.getInstance()
        val evt = com.appindex.Rerank.FeedbackChainEvent(
            query = query,
            normalizedQuery = query.lowercase().trim(),
            clickedPackage = clickedPackage,
            clickedAppName = clickedAppName,
            clickedRank = clickedRank,
            candidateCount = candidateCount,
            matchMode = matchMode,
            context = com.appindex.Rerank.FeedbackContext(
                hour = cal.get(Calendar.HOUR_OF_DAY),
                weekday = cal.get(Calendar.DAY_OF_WEEK) - 1,
                geofenceId = contextMap["geofenceId"] ?: "",
                foregroundPackage = contextMap["previousAppPackage"] ?: ""
            )
        )
        return try {
            bridge.recordFeedbackChainEvent(evt)
        } catch (_: Throwable) { null }
    }

    /** v2.1: 查询 Base 桥接状态 */
    fun baseBridgeStatus(): com.appindex.Rerank.BridgeStatus =
        baseBridge?.status() ?: com.appindex.Rerank.BridgeStatus(
            available = false, degraded = true, hasReader = false, hasWriter = false, lastError = null
        )

    /** v2.1: 运行时开关 L4 梳理层 */
    fun setPersonalRerankEnabled(enabled: Boolean) {
        personalRerankEnabled = enabled
    }

    override fun recordSelection(query: String, appName: String) {
        // 委托给 SearchService / StatisticsDao 处理（Kotlin 版统计写入数据库）
        // v2.1: 同时写入 Base feedback-chain（梳理层反馈源）
        try {
            val pkg = dataset.find { it.label == appName }?.packageName ?: appName
            recordSelectionToBase(
                query = query,
                clickedPackage = pkg,
                clickedAppName = appName,
                clickedRank = -1,   // 通过 facade.recordSelection 调用时未知排名
                candidateCount = dataset.size,
                matchMode = "fuzzy"
            )
        } catch (_: Throwable) {
            // Base 写入失败不影响主流程
        }
    }

    override fun recordSearch(query: String) {
        // 同上，由调用方通过 DAO 完成统计写入
    }

    override fun recordUnknownApp(query: String, appName: String) {
        // Kotlin 版目前无对应实现（JS / Rust 独有），保留接口对齐
    }

    override fun rebuildIndex() {
        searchEngine.buildIndex(dataset)
        indexBuilt = true
    }

    override fun setContext(context: Map<String, String>) {
        contextMap = context
    }

    override fun clearContext() {
        contextMap = emptyMap()
    }

    override fun maintain() {
        // Kotlin 版引擎核心无状态，权重/链边/记忆/屏蔽标记存储由 app 层或 base 层持有。
        // 自主维护逻辑（衰减/修剪/自愈）由 app 层通过
        // [com.appindex.Maintenance.MaintenanceManager] 注入存储后执行，
        // 可通过 [GotoEngineFacade.getMaintenanceManager] 获取实例（未注入时返回 null）。
        // 此处保留空实现以维持接口对齐，不破坏现有编译。
    }

    override fun isReady(): Boolean = indexBuilt && dataset.isNotEmpty()

    override fun datasetSize(): Int = dataset.size

    /**
     * V2.1: 触发 RAG 重建（手动入口）。
     * 读应用清单 + base 个人层 → 生成向量 → 启动灰度过渡。
     * embedder 由 app 层通过 [RagEmbedderHolder] 注入；未注入返回 false。
     */
    override fun rebuildRag(): Boolean {
        val embedder = RagEmbedderHolder.embedder ?: return false
        val store = AppListStore(context)
        var apps = store.snapshot()
        if (apps.isEmpty()) apps = store.load()

        val bridge = baseBridge
        val snapshot = if (bridge != null && !bridge.degraded) {
            bridge.getPersonalSnapshot(
                query = "",
                candidatePackages = apps.map { it.packageName },
                runtimeContext = RuntimeContext()
            )
        } else PersonalSnapshot.degraded()

        val buildResult = RagRebuilder.rebuild(apps, snapshot, embedder)
        val vectorJson = RagRebuilder.serializeVectorStore(buildResult)
        val indexJson = RagRebuilder.serializeRagIndex(buildResult)
        RagTransitionController(context).startTransition(vectorJson, indexJson)
        return true
    }

    /** 暴露底层 SearchOrchestrator 供调用方使用自适应刷新调度。 */
    fun orchestrator(): SearchOrchestrator = orchestrator

    /** 暴露底层 AppIndexEngine 供调用方使用索引功能。 */
    fun indexEngine(): AppIndexEngine = indexEngine

    /** 暴露底层 AppSearchEngine 供调用方使用高级搜索功能。 */
    fun searchEngine(): AppSearchEngine = searchEngine
}

