package com.appindex.component

/**
 * GOTO Engine Kotlin 版 - 事件系统
 *
 * 与 JS `component.on(type, listener)` 和 Rust `component.on(type_, listener)` 对齐。
 *
 * 支持的事件类型见 [EventType]。
 *
 * ## 线程安全
 *
 * 监听器集合使用 `CopyOnWriteArrayList`，可在任意线程注册 / 注销 / 触发，
 * 触发回调时按注册顺序同步调用（如需异步，请监听器内部自行切换线程）。
 *
 * ## 用法
 *
 * ```kotlin
 * val handle = component.on(EventType.AFTER_SEARCH) { payload ->
 *     println("search done: ${payload["latencyMs"]}")
 * }
 * // ...
 * component.off(EventType.AFTER_SEARCH, handle)
 * ```
 */

/** 事件类型。与 JS / Rust 版字符串值保持一致以便跨语言对齐。 */
enum class EventType(val value: String) {
    BEFORE_SEARCH("beforeSearch"),
    AFTER_SEARCH("afterSearch"),
    BEFORE_RENDER("beforeRender"),
    ON_FEEDBACK("onFeedback"),
    ON_ERROR("onError");

    companion object {
        fun fromValue(v: String): EventType? = values().firstOrNull { it.value == v }
    }
}

/** 事件负载。键值对形式，与 JS / Rust 一致。 */
typealias EventPayload = Map<String, Any?>

/** 事件监听器函数。 */
typealias EventListener = (EventPayload) -> Unit

/** 事件句柄。用于注销监听器。 */
data class EventHandle(val type: EventType, val listener: EventListener)

/**
 * 事件总线。组件内部持有，对外提供 [on] / [off] / [emit]。
 */
class EventBus {
    private val listeners: MutableMap<EventType, MutableList<EventListener>> =
        mutableMapOf()

    /**
     * 注册监听器，返回句柄用于注销。
     */
    fun on(type: EventType, listener: EventListener): EventHandle {
        synchronized(listeners) {
            listeners.getOrPut(type) { mutableListOf() }.add(listener)
        }
        return EventHandle(type, listener)
    }

    /**
     * 注销指定监听器。
     */
    fun off(type: EventType, listener: EventListener) {
        synchronized(listeners) {
            listeners[type]?.remove(listener)
        }
    }

    /**
     * 注销指定句柄。
     */
    fun off(handle: EventHandle) {
        off(handle.type, handle.listener)
    }

    /**
     * 触发事件。按注册顺序同步调用监听器。
     * 任意监听器抛出异常会被吞掉（避免影响其他监听器和主流程），
     * 与 JS / Rust 版的容错策略一致。
     */
    fun emit(type: EventType, payload: EventPayload) {
        val snapshot: List<EventListener>
        synchronized(listeners) {
            snapshot = listeners[type]?.toList() ?: return
        }
        for (l in snapshot) {
            try {
                l(payload)
            } catch (_: Throwable) {
                // 容错：单监听器异常不影响其他监听器
            }
        }
    }

    /**
     * 清空所有监听器（组件销毁时调用）。
     */
    fun clear() {
        synchronized(listeners) {
            listeners.clear()
        }
    }

    /**
     * 返回指定事件的监听器数量（用于测试 / 调试）。
     */
    fun listenerCount(type: EventType): Int = synchronized(listeners) {
        listeners[type]?.size ?: 0
    }
}
