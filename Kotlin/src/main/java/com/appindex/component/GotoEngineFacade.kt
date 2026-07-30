package com.appindex.component

import com.appindex.Maintenance.MaintenanceManager
import com.appindex.model.SearchResult

/**
 * GOTO Engine Kotlin 版 - 引擎底层接口契约
 *
 * 与 JS `interface.d.ts` 的 `GOTOEngineInterface` 和 Rust `interface.rs` 的
 * `GotoEngineInterface` 对齐。
 *
 * 该接口定义引擎核心必须实现的方法集合，组件层 [EngineComponent] 通过
 * 持有该接口的实例与底层引擎解耦。
 *
 * ## 设计说明
 *
 * Kotlin 版引擎核心由多个独立类组成（AppIndexEngine / AppSearchEngine /
 * FuzzyMatchEngine / MetaTagEngine / MetaTagIndex / SmartPredictionEngine /
 * SearchService / Database DAOs），与 JS / Rust 的"单一引擎对象"不同。
 * 本接口作为"引擎门面"契约，由 [DefaultEngineFacade] 默认实现聚合各核心类，
 * 组件层只依赖本接口，便于测试替身（Mock）和未来替换实现。
 */
interface GotoEngineFacade {

    /** 引擎版本。 */
    fun version(): String = Versions.ENGINE_VERSION

    /**
     * 设置应用数据集。返回应用数量。
     * 对应 JS `component.setAppDataset(apps)` / Rust `set_app_dataset`。
     */
    fun setAppDataset(apps: List<com.appindex.model.AppInfo>): Int

    /**
     * 主搜索入口。返回原始结果列表（未经组件层封装）。
     * 对应 JS `engine.fuzzySearch` / Rust `fuzzy_search`。
     *
     * 实现可内部组合 fuzzy / meta / tfidf 多路搜索，由具体实现决定。
     */
    fun search(query: String, limit: Int = 30): List<SearchResult>

    /**
     * 记录用户选择（反馈学习）。
     * 对应 JS `engine.recordSelection` / Rust `record_selection`。
     */
    fun recordSelection(query: String, appName: String)

    /**
     * 记录搜索行为（不计入选择反馈）。
     * 对应 JS `engine.recordSearch` / Rust `record_search`。
     */
    fun recordSearch(query: String)

    /**
     * 记录未匹配的应用（用于扩充索引）。
     * 对应 JS `engine.recordUnknownApp` / Rust `record_unknown_app`。
     */
    fun recordUnknownApp(query: String, appName: String)

    /**
     * 重建索引。
     * 对应 JS `engine.buildSearchIndex` / Rust `rebuild_index`。
     */
    fun rebuildIndex()

    /**
     * 设置上下文。
     * 对应 JS `engine.setContext` / Rust `set_context`。
     */
    fun setContext(context: Map<String, String>)

    /**
     * 清除上下文。
     * 对应 JS `engine.clearContext` / Rust `clear_context`。
     */
    fun clearContext()

    /**
     * 引擎自主维护（衰减旧记忆 / 修剪链边 / 清理过期标记）。
     * 对应 JS `engine.maintain` / Rust `maintain`。
     */
    fun maintain()

    /**
     * 获取自主维护管理器实例（可选）。
     *
     * Kotlin 版引擎核心无状态，权重/链边/记忆/屏蔽标记存储由 app 层持有。
     * 当 app 层已注入存储并构造好 [MaintenanceManager] 时返回实例，否则返回 null。
     * 调用方可通过返回值手动触发 `applySelfHealing` 等需要存储的能力。
     *
     * 默认返回 null（不破坏现有实现类），由需要维护能力的实现覆盖。
     */
    fun getMaintenanceManager(): MaintenanceManager? = null

    /**
     * 引擎是否就绪（已设置数据集且索引可用）。
     */
    fun isReady(): Boolean

    /**
     * 当前数据集大小。
     */
    fun datasetSize(): Int

    /**
     * 触发 RAG 重建（月度 Worker 的手动触发入口；读应用清单 + base 个人层 → 生成向量 → 启动灰度过渡）。
     * V2.1 新增。
     * @return true 表示成功启动重建，false 表示前置条件不满足（如 embedder 未注入）
     */
    fun rebuildRag(): Boolean
}
