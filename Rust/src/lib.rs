//! GOTO Engine — Local-first smart search & intent engine (Rust port).
//!
//! This is a faithful Rust reimplementation of `goto-engine.js` v3.2.0
//! (`GithubPages/GOTO-Engine/goto-engine.js`, 4029 lines of JS).
//! All 18 modules are ported: Storage / Index / Search / Intent / Learning /
//! Weights / Negative / Self-Healing / Association / Stats / Filter / Context /
//! Maintenance / Smart Reminder / PRO / Semantic / Bayes / NLP.
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
pub mod storage;

pub mod filter;
pub mod nlp;

pub mod index;
pub mod intent;
pub mod search;

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

#[cfg(feature = "semantic")]
pub mod semantic;

pub mod component;
pub mod engine;

// ─── 公开导出 ──────────────────────────────────────────────────────────────

pub use engine::GotoEngine;
pub use storage::{Storage, MemoryStorage};
pub use types::*;

/// Engine version (mirrors `goto-engine.js` `engine.version`).
pub const VERSION: &str = "3.2.0";

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
}
