//! 存储层（对应 `goto-engine.js` 的 `readJSON` / `writeJSON` + `STORAGE` 常量）。
//!
//! 引擎所有持久化数据通过 [`Storage`] trait 读写，下游消费者可注入自定义实现：
//!
//! - [`MemoryStorage`]：线程安全的内存实现（默认，用于测试 / WASM）。
//! - 文件系统后端、Android SharedPreferences、Electron localStorage、
//!   浏览器 localStorage 等均可通过实现该 trait 接入。

use alloc::string::{String, ToString};
use alloc::sync::Arc;
use alloc::vec::Vec;
use core::fmt::Debug;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

#[cfg(feature = "std")]
use std::sync::RwLock;

#[cfg(not(feature = "std"))]
use spin::RwLock;

/// 存储后端 trait（对应 JS 的 `localStorage` 抽象）。
///
/// 实现者只需提供 `get_string` / `set_string` / `remove_string` 三个原语，
/// `read_json` / `write_json` 等 JSON 便捷方法由 trait 默认实现提供。
pub trait Storage: Send + Sync + Debug {
    /// 读取原始字符串（对应 `localStorage.getItem`）。
    fn get_string(&self, key: &str) -> Option<String>;

    /// 写入原始字符串（对应 `localStorage.setItem`）。
    fn set_string(&self, key: &str, value: &str);

    /// 删除 key（对应 `localStorage.removeItem`）。
    fn remove_string(&self, key: &str);

    /// 读取 JSON 并反序列化，失败返回 fallback（对应 JS `readJSON(key, fallback)`）。
    fn read_json<T: DeserializeOwned>(&self, key: &str, fallback: T) -> T {
        match self.get_string(key) {
            Some(s) => serde_json::from_str(&s).unwrap_or(fallback),
            None => fallback,
        }
    }

    /// 读取 JSON，返回 `Option<T>`（不存在或解析失败均返回 None）。
    fn read_json_opt<T: DeserializeOwned>(&self, key: &str) -> Option<T> {
        self.get_string(key)
            .and_then(|s| serde_json::from_str(&s).ok())
    }

    /// 序列化为 JSON 并写入（对应 JS `writeJSON(key, value)`）。
    ///
    /// 接受 `?Sized` 类型，以便传入 slice（如 `&[(String, f64)]`）。
    fn write_json<T: Serialize + ?Sized>(&self, key: &str, value: &T) {
        match serde_json::to_string(value) {
            Ok(s) => self.set_string(key, &s),
            Err(_) => { /* JS 端 writeJSON 失败静默，保持一致 */ }
        }
    }

    /// 读取布尔值（"true" / "1" 视为 true）。
    fn read_bool(&self, key: &str, fallback: bool) -> bool {
        match self.get_string(key) {
            Some(s) => matches!(s.as_str(), "true" | "1"),
            None => fallback,
        }
    }

    /// 写入布尔值。
    fn write_bool(&self, key: &str, value: bool) {
        self.set_string(key, if value { "true" } else { "false" });
    }

    /// 读取数值（解析失败返回 fallback）。
    fn read_u64(&self, key: &str, fallback: u64) -> u64 {
        self.get_string(key)
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(fallback)
    }

    /// 写入数值。
    fn write_u64(&self, key: &str, value: u64) {
        self.set_string(key, &value.to_string());
    }

    /// 清空所有 key（用于"重置引擎"）。
    fn clear(&self) {
        // 默认实现：遍历已知 STORAGE key 删除
        // 子类可重写为更高效的批量清空
        for key in crate::constants::StorageKeys::all_keys() {
            self.remove_string(key);
        }
    }

    /// 返回所有 key（用于调试 / 导出）。
    fn keys(&self) -> Vec<String>;
}

// ─── MemoryStorage（默认实现） ──────────────────────────────────────────────

/// 线程安全的内存存储实现。
///
/// 内部使用 `RwLock<BTreeMap<String, String>>`，所有操作 O(log n)。
/// 适用于测试、WASM、桌面应用的临时缓存场景。
#[derive(Debug, Default, Clone)]
pub struct MemoryStorage {
    #[cfg(feature = "std")]
    inner: Arc<RwLock<std::collections::BTreeMap<String, String>>>,
    #[cfg(not(feature = "std"))]
    inner: Arc<RwLock<alloc::collections::BTreeMap<String, String>>>,
}

impl MemoryStorage {
    pub fn new() -> Self {
        Self::default()
    }
}

impl Storage for MemoryStorage {
    fn get_string(&self, key: &str) -> Option<String> {
        self.inner.read().ok()?.get(key).cloned()
    }

    fn set_string(&self, key: &str, value: &str) {
        if let Ok(mut w) = self.inner.write() {
            w.insert(key.to_string(), value.to_string());
        }
    }

    fn remove_string(&self, key: &str) {
        if let Ok(mut w) = self.inner.write() {
            w.remove(key);
        }
    }

    fn keys(&self) -> Vec<String> {
        self.inner
            .read()
            .map(|r| r.keys().cloned().collect())
            .unwrap_or_default()
    }
}

// ─── 所有 STORAGE key 列表（用于 clear / 导出 / 导入） ─────────────────────

impl crate::constants::StorageKeys {
    /// 返回所有内部 STORAGE key（不含外部 key）。
    pub fn all_keys() -> &'static [&'static str] {
        &[
            Self::SIM_INT_ENABLED,
            Self::CATALOG,
            Self::MEMORY,
            Self::PENDING,
            Self::STATS,
            Self::WEIGHTS,
            Self::WEIGHTS_TS,
            Self::CHAINS,
            Self::NEGATIVE,
            Self::BLOCK_FLAGS,
            Self::SELF_HEALING,
            Self::PRO,
            Self::PRO_SNAPSHOT,
            Self::FLOAT_WINDOW,
            Self::GLOBAL_PREF,
            Self::CLICK_DELAY_EMA,
            Self::MODE_FREQUENCY,
            Self::CYCLE_TIMESTAMPS,
            Self::MICRO_CONTEXT,
            Self::BAYES_TABLE,
            Self::TFIDF_INDEX,
            Self::TRIE_INDEX,
            Self::SEMANTIC_ENABLED,
        ]
    }

    /// 返回所有外部 key（不在 STORAGE 表，但被引擎读取）。
    pub fn external_keys() -> &'static [&'static str] {
        &[
            Self::ENHANCED_SIMINT,
            Self::APP_STATS,
            Self::INSTALLED_APPS,
            Self::RECENT_APPS,
            Self::STATS_HOURLY_LAUNCH,
        ]
    }
}

// ─── 导入 / 导出 ───────────────────────────────────────────────────────────

/// 引擎所有持久化数据的快照（用于导出 / 导入 / 备份）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EngineSnapshot {
    pub kv: Vec<(String, String)>,
}

impl EngineSnapshot {
    /// 从存储后端导出快照。
    pub fn export<S: Storage + ?Sized>(storage: &S) -> Self {
        let kv = storage.keys()
            .into_iter()
            .filter_map(|k| storage.get_string(&k).map(|v| (k, v)))
            .collect();
        Self { kv }
    }

    /// 导入快照到存储后端（覆盖现有值）。
    pub fn import<S: Storage + ?Sized>(&self, storage: &S) {
        for (k, v) in &self.kv {
            storage.set_string(k, v);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_memory_storage_basic() {
        let s = MemoryStorage::new();
        s.set_string("foo", "bar");
        assert_eq!(s.get_string("foo"), Some("bar".into()));
        s.remove_string("foo");
        assert_eq!(s.get_string("foo"), None);
    }

    #[test]
    fn test_json_roundtrip() {
        #[derive(Serialize, Deserialize, PartialEq, Debug)]
        struct Foo { a: u32, b: String }
        let s = MemoryStorage::new();
        let v = Foo { a: 42, b: "hi".into() };
        s.write_json("foo", &v);
        let r: Foo = s.read_json("foo", Foo { a: 0, b: "".into() });
        assert_eq!(r, v);
    }

    #[test]
    fn test_read_json_fallback() {
        let s = MemoryStorage::new();
        let r: u32 = s.read_json("missing", 99);
        assert_eq!(r, 99);
    }

    #[test]
    fn test_snapshot_export_import() {
        let s1 = MemoryStorage::new();
        s1.set_string("a", "1");
        s1.set_string("b", "2");
        let snap = EngineSnapshot::export(&s1);

        let s2 = MemoryStorage::new();
        snap.import(&s2);
        assert_eq!(s2.get_string("a"), Some("1".into()));
        assert_eq!(s2.get_string("b"), Some("2".into()));
    }

    #[test]
    fn test_bool() {
        let s = MemoryStorage::new();
        assert!(!s.read_bool("x", false));
        s.write_bool("x", true);
        assert!(s.read_bool("x", false));
    }
}
