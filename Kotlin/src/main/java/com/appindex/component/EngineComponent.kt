package com.appindex.component

import android.content.Context
import com.appindex.model.AppInfo
import com.appindex.model.SearchResult
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/**
 * GOTO Engine Kotlin 版 - 组件封套（与 JS / Rust 对齐）
 *
 * 对应 JS `GOTOEngineComponent` 和 Rust `EngineComponent`。
 *
 * ## 设计说明
 *
 * - **版本化响应**：[query] 返回 [QueryResponse]，包含 ok / data / error / requestId / latencyMs / timestamp / localOnly
 * - **错误结构化**：组件层不抛可预期异常，失败时返回 `QueryResponse.error(...)`
 * - **事件系统**：通过 [on] / [off] / [emit] 注册和触发事件
 * - **状态查询**：通过 [status] 获取组件运行状态
 * - **底层访问**：通过 [raw] 获取 [GotoEngineFacade] 实例（用于高级场景）
 *
 * ## 用法
 *
 * ```kotlin
 * val component = EngineComponent.create(context)
 * component.setAppDataset(apps)
 * val response = component.query("微信", QueryOptions(limit = 10))
 * if (response.ok) {
 *     response.data.forEach { println(it.appName) }
 * }
 * component.recordSelection("微信", "WeChat")
 * ```
 *
 * ## 线程安全
 *
 * 组件本身线程安全（使用 `AtomicBoolean` 和线程安全的事件总线）。
 * 底层引擎的线程安全由 [GotoEngineFacade] 实现保证。
 *
 * @param facade 引擎门面实例
 */
class EngineComponent private constructor(
    private val facade: GotoEngineFacade
) {

    private val eventBus = EventBus()
    private val destroyed = AtomicBoolean(false)

    /** 引擎版本。 */
    fun version(): String = facade.version()

    /** 底层引擎引用（高级场景使用）。 */
    fun raw(): GotoEngineFacade = facade

    /**
     * 组件状态。
     */
    fun status(): ComponentStatus = ComponentStatus(
        ready = facade.isReady(),
        datasetSize = facade.datasetSize()
    )

    /**
     * 设置应用数据集。返回应用数量。
     */
    fun setAppDataset(apps: List<AppInfo>): Int {
        checkNotDestroyed()
        return try {
            facade.setAppDataset(apps)
        } catch (t: Throwable) {
            emitError("setAppDataset failed: ${t.message}")
            0
        }
    }

    /**
     * 主查询入口（版本化响应）。
     *
     * 与 JS `component.query(query, opts)` 和 Rust `component.query(q, opts)` 对齐。
     *
     * - 触发 [EventType.BEFORE_SEARCH] 和 [EventType.AFTER_SEARCH] 事件
     * - 失败时触发 [EventType.ON_ERROR] 事件
     * - 返回 [QueryResponse]，永不抛可预期异常
     */
    fun query(query: String, options: QueryOptions = QueryOptions.DEFAULT): QueryResponse {
        checkNotDestroyed()
        val requestId = options.requestId ?: generateRequestId()
        val start = System.currentTimeMillis()

        // 事件：beforeSearch
        emit(EventType.BEFORE_SEARCH, mapOf(
            "query" to query,
            "requestId" to requestId,
            "options" to options
        ))

        if (!facade.isReady()) {
            val resp = QueryResponse.error(
                ErrorCode.ENGINE_UNAVAILABLE,
                "引擎未就绪，请先调用 setAppDataset",
                requestId,
                System.currentTimeMillis() - start
            )
            emitError(resp.error?.message ?: "engine unavailable")
            return resp
        }

        val results: List<SearchResult> = try {
            facade.search(query, options.limit)
        } catch (t: Throwable) {
            val resp = QueryResponse.error(
                ErrorCode.ENGINE_FAILURE,
                "搜索失败: ${t.message}",
                requestId,
                System.currentTimeMillis() - start
            )
            emitError(resp.error?.message ?: "engine failure")
            return resp
        }

        val latencyMs = System.currentTimeMillis() - start
        val resp = QueryResponse.ok(results, requestId, latencyMs)

        // 事件：afterSearch
        emit(EventType.AFTER_SEARCH, mapOf(
            "query" to query,
            "requestId" to requestId,
            "latencyMs" to latencyMs,
            "count" to results.size
        ))

        return resp
    }

    /**
     * 兼容旧调用（直接返回结果列表，无版本化封装）。
     * 对应 JS `component.search(query)`。
     */
    fun search(query: String): List<SearchResult> {
        return query(query).data
    }

    /**
     * 记录用户选择。
     */
    fun recordSelection(query: String, appName: String) {
        checkNotDestroyed()
        try {
            facade.recordSelection(query, appName)
            emit(EventType.ON_FEEDBACK, mapOf(
                "type" to "selection",
                "query" to query,
                "appName" to appName
            ))
        } catch (t: Throwable) {
            emitError("recordSelection failed: ${t.message}")
        }
    }

    /**
     * 记录搜索行为。
     */
    fun recordSearch(query: String) {
        checkNotDestroyed()
        try {
            facade.recordSearch(query)
            emit(EventType.ON_FEEDBACK, mapOf(
                "type" to "search",
                "query" to query
            ))
        } catch (t: Throwable) {
            emitError("recordSearch failed: ${t.message}")
        }
    }

    /**
     * 记录未匹配应用。
     */
    fun recordUnknownApp(query: String, appName: String) {
        checkNotDestroyed()
        try {
            facade.recordUnknownApp(query, appName)
        } catch (t: Throwable) {
            emitError("recordUnknownApp failed: ${t.message}")
        }
    }

    /**
     * 重建索引。
     */
    fun rebuildIndex() {
        checkNotDestroyed()
        try {
            facade.rebuildIndex()
        } catch (t: Throwable) {
            emitError("rebuildIndex failed: ${t.message}")
        }
    }

    /**
     * 设置上下文。
     */
    fun setContext(context: Map<String, String>) {
        checkNotDestroyed()
        facade.setContext(context)
    }

    /**
     * 清除上下文。
     */
    fun clearContext() {
        checkNotDestroyed()
        facade.clearContext()
    }

    /**
     * 引擎自主维护。
     */
    fun maintain() {
        checkNotDestroyed()
        try {
            facade.maintain()
        } catch (t: Throwable) {
            emitError("maintain failed: ${t.message}")
        }
    }

    /**
     * 注册事件监听器。返回 [EventHandle] 用于注销。
     */
    fun on(type: EventType, listener: EventListener): EventHandle {
        checkNotDestroyed()
        return eventBus.on(type, listener)
    }

    /**
     * 注销事件监听器。
     */
    fun off(type: EventType, listener: EventListener) {
        eventBus.off(type, listener)
    }

    /**
     * 注销事件监听器（通过句柄）。
     */
    fun off(handle: EventHandle) {
        eventBus.off(handle)
    }

    /**
     * 触发事件（高级用法，通常由组件内部调用）。
     */
    fun emit(type: EventType, payload: EventPayload) {
        eventBus.emit(type, payload)
    }

    /**
     * 销毁组件，释放资源，清空事件监听器。
     * 销毁后所有方法调用将抛出 [IllegalStateException]。
     */
    fun destroy() {
        if (destroyed.compareAndSet(false, true)) {
            eventBus.clear()
        }
    }

    // ====== 内部方法 ======

    private fun checkNotDestroyed() {
        check(!destroyed.get()) { "EngineComponent 已销毁" }
    }

    private fun emitError(message: String) {
        emit(EventType.ON_ERROR, mapOf("message" to message))
    }

    private fun generateRequestId(): String =
        "kotlin-${UUID.randomUUID().toString().take(8)}"

    companion object {
        /**
         * 工厂方法：使用 [DefaultEngineFacade] 创建组件。
         *
         * @param context Android Context
         */
        fun create(context: Context): EngineComponent {
            val facade = DefaultEngineFacade(context)
            return EngineComponent(facade)
        }

        /**
         * 工厂方法：使用自定义 [GotoEngineFacade] 创建组件（用于测试 / 替换实现）。
         */
        fun withEngine(facade: GotoEngineFacade): EngineComponent {
            return EngineComponent(facade)
        }
    }
}
