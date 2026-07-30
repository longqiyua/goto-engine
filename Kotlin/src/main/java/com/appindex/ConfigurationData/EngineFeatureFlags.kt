package com.appindex.ConfigurationData

/**
 * GOTO Engine 模块开关 — 三语言必须一致
 *
 * 与 Javascript/goto-engine.js 的 _featureFlags 和 Rust/src/feature_flags.rs 的 EngineFeatureFlags 保持同步
 *
 * v2.1 新增：personalRerank（第四层：梳理层）
 */
data class EngineFeatureFlags(
    val fuzzyMatch: Boolean = true,        // L2 模糊匹配（Jaccard + 顺序恢复 + 缩写）
    val indexTree: Boolean = true,         // L2 索引树（英文单词树 + 中文汉字树 + 拼音树）
    val adaptiveRefresh: Boolean = true,   // L1 自适应刷新（打字速度 + 防抖节流）
    val simInt: Boolean = false,           // L3 模拟智能（微观上下文 + 时段加分）
    val t9: Boolean = false,               // L2 T9 模式
    val ragFallback: Boolean = false,      // L3 RAG 兜底（最后调用，预留）
    val personalRerank: Boolean = true,      // L4 梳理层（读 Base 个人层 5 schema 重排）
    val ragAutoRebuild: Boolean = true,      // V2.1: 月度 RAG 自动重建（WorkManager 30天周期）
    val ragTransitionEnabled: Boolean = true // V2.1: RAG 新旧库灰度过渡（15天线性权重）
) {
    companion object {
        @JvmStatic
        val DEFAULT = EngineFeatureFlags()
    }
}

