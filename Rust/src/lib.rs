//! GOTO Engine — Local-first smart search & intent engine (Rust port).
//!
//! This is a faithful Rust reimplementation of `goto-engine.js` v2.1.0
//! (`GithubPages/GOTO-Engine/goto-engine.js`).
//! All 18 modules + L4 梳理层 (personal rerank) are ported:
//! Storage / Index / Search / Intent / Learning / Weights / Negative /
//! Self-Healing / Association / Stats / Filter / Context / Maintenance /
//! Smart Reminder / PRO / Semantic / Bayes / NLP + Rerank / BaseBridge.
//!
//! The crate is `no_std`-friendly behind the `std` feature (default-on).
//! Cross-platform storage is provided via the [`storage::Storage`] trait; a
//! thread-safe in-memory implementation is bundled, and downstream consumers
//! (Android JNI, Electron IPC, browser WASM, file backend) can plug their own.
//!
//! # Example
//!
//! ```rust
//! use goto_engine::{GotoEngine, types::AppItem};
//!
//! let mut engine = GotoEngine::new();
//! let apps = vec![
//!     AppItem { name: "微信".into(), py: "wei xin".into(), abbr: "wx".into(),
//!               en: "WeChat".into(), cat: "通讯".into(),
//!               tags: vec!["社交".into()], ..Default::default() },
//! ];
//! engine.watch_app_dataset(&apps);
//! let ctx = engine.run_search_pipeline("wx", &apps);
//! assert!(!ctx.list.is_empty());
//! ```

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

// ─── 模块声明 ──────────────────────────────────────────────────────────────

pub mod constants;
pub mod utils;
pub mod types;
pub mod feature_flags;
pub mod storage;

pub mod filter;
pub mod nlp;

pub mod index;
pub mod intent;
pub mod search;

// v2.1: L1 自适应刷新（打字速度追踪 + 防抖/节流调度）
pub mod adaptive_refresh;

pub mod learning;
pub mod weights;
pub mod negative;
pub mod self_healing;
pub mod association;
pub mod stats;
pub mod context;
pub mod maintenance;
pub mod bayes;

pub mod pro;
pub mod smart_reminder;

// v2.1: L4 梳理层 + Base 桥接
pub mod rerank;
pub mod base_bridge;
// v2.1: 月度 RAG 重建 + 灰度过渡（纯函数，三语言同步）
pub mod rag_rebuilder;
pub mod rag_transition;
// v2.1: BM25 RAG 检索（基于 documentText 的自动语义检索，三语言同步）
pub mod bm25_rag;
// v2.1: 语义向量检索（cosine），与 JS SemanticSearch.js 对齐
pub mod rag_search;

#[cfg(feature = "semantic")]
pub mod semantic;

pub mod component;
pub mod engine;

// ─── 公开导出 ──────────────────────────────────────────────────────────────

pub use engine::GotoEngine;
pub use storage::{Storage, MemoryStorage};
pub use types::*;

/// Engine version (mirrors `goto-engine.js` `engine.version`).
pub const VERSION: &str = "2.1.0";

/// API version of the Component API envelope (mirrors `goto-engine-component.js`).
pub const API_VERSION: &str = "1.0.0";

/// Re-export of the most commonly used types at crate root.
pub mod prelude {
    pub use crate::engine::GotoEngine;
    pub use crate::storage::{MemoryStorage, Storage};
    pub use crate::types::{
        AppItem, SearchContext, SearchHit, SearchMode,
    };
    pub use crate::VERSION;
    // v2.1: 暴露 L4 梳理层
    pub use crate::rerank::{PersonalReranker, PersonalSnapshot, RerankResult};
    pub use crate::base_bridge::{EngineBaseBridge, BaseReaderPort, BaseWriterPort};
}

