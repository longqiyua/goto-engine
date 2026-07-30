package com.appindex.component

/**
 * GOTO Engine Kotlin 版 - 版本常量
 *
 * 与 JS 版（goto-engine.js v2.1.0）和 Rust 版（v2.1.0）对齐。
 *
 * - ENGINE_VERSION：引擎核心算法版本
 * - API_VERSION：组件 API 契约版本（与 Rust EngineComponent / JS GOTOEngineComponent 对齐）
 * - PROTOCOL_VERSION：跨语言协议版本（用于双版本对齐校验）
 *
 * v2.1 新增：第四层（梳理层 PersonalRerank）
 */
object Versions {
    const val ENGINE_VERSION = "v2.1.0"
    const val API_VERSION = "1.0.0"
    const val PROTOCOL_VERSION = "goto-engine-v2.1"

    /**
     * 返回完整版本信息字符串（用于日志、调试、健康检查）。
     */
    fun fullInfo(): String =
        "GOTO Engine Kotlin (engine=$ENGINE_VERSION, api=$API_VERSION, protocol=$PROTOCOL_VERSION)"
}

