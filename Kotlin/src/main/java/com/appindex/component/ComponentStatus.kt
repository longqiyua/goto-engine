package com.appindex.component

/**
 * GOTO Engine Kotlin 版 - 组件状态
 *
 * 与 Rust `ComponentStatus` 对齐。
 *
 * @property version       引擎版本
 * @property apiVersion    组件 API 版本
 * @property ready         引擎是否就绪（已设置数据集）
 * @property datasetSize   当前应用数据集大小
 * @property localOnly     是否纯本地（Kotlin 版始终 true）
 * @property eventTypes    支持的事件类型列表
 */
data class ComponentStatus(
    val version: String = Versions.ENGINE_VERSION,
    val apiVersion: String = Versions.API_VERSION,
    val ready: Boolean,
    val datasetSize: Int,
    val localOnly: Boolean = true,
    val eventTypes: List<String> = EventType.values().map { it.value }
)
