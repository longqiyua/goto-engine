package com.appindex.component

/**
 * GOTO Engine Kotlin 版 - 错误码
 *
 * 与 JS / Rust 版对齐：
 *   - ENGINE_UNAVAILABLE  引擎不可用（未初始化 / 已销毁）
 *   - INVALID_QUERY       查询不合法（清洗失败）
 *   - ENGINE_FAILURE      引擎内部故障（异常 / 资源不可用）
 *
 * 三个版本错误码语义保持一致，保证跨语言行为契约对齐。
 */
enum class ErrorCode(val code: String, val message: String) {
    ENGINE_UNAVAILABLE("ENGINE_UNAVAILABLE", "搜索引擎不可用"),
    INVALID_QUERY("INVALID_QUERY", "查询不合法"),
    ENGINE_FAILURE("ENGINE_FAILURE", "引擎内部故障");

    companion object {
        fun fromCode(code: String): ErrorCode? = values().firstOrNull { it.code == code }
    }
}
