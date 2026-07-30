//! GOTO Engine 模块开关 — 三语言必须一致
//!
//! 与 Javascript/goto-engine.js 的 _featureFlags 和
//! Kotlin/.../EngineFeatureFlags.kt 保持同步
//!
//! v2.1 新增：personal_rerank（第四层：梳理层）

/// Engine 模块开关
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineFeatureFlags {
    /// L2 模糊匹配（Jaccard + 顺序恢复 + 缩写）
    pub fuzzy_match: bool,
    /// L2 索引树（英文单词树 + 中文汉字树 + 拼音树）
    pub index_tree: bool,
    /// L1 自适应刷新（打字速度 + 防抖节流）
    pub adaptive_refresh: bool,
    /// L3 模拟智能（微观上下文 + 时段加分）
    pub sim_int: bool,
    /// L2 T9 模式
    pub t9: bool,
    /// L3 RAG 兜底（最后调用，预留）
    pub rag_fallback: bool,
    /// L4 梳理层（读 Base 个人层 5 schema 重排）— v2.1 新增
    pub personal_rerank: bool,
    /// V2.1: 月度 RAG 自动重建（对齐 Kotlin ragAutoRebuild）
    pub rag_auto_rebuild: bool,
    /// V2.1: RAG 新旧库灰度过渡（对齐 Kotlin ragTransitionEnabled）
    pub rag_transition_enabled: bool,
}

impl Default for EngineFeatureFlags {
    fn default() -> Self {
        Self {
            fuzzy_match: true,
            index_tree: true,
            adaptive_refresh: true,
            sim_int: false,
            t9: false,
            rag_fallback: false,
            personal_rerank: true,
            rag_auto_rebuild: true,
            rag_transition_enabled: true,
        }
    }
}

impl EngineFeatureFlags {
    /// 创建默认配置
    pub fn new() -> Self {
        Self::default()
    }
}

