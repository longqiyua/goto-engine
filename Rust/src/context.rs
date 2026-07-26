//! 上下文层（对应 `goto-engine.js` `setContext` / `clearContext` / `getContext`）。
//!
//! 引擎在搜索时会读取当前上下文（如最近使用的 app、当前模式、地理位置等），
//! 用于 boost 已经命中的结果。

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

/// 搜索上下文（对应 JS 的 `ctx` 对象）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SearchContext_ {
    /// 最近使用的 app（用于 boost）。
    #[serde(default)]
    pub recent_apps: Vec<String>,
    /// 当前模式（standard / pro / float / smart_reminder）。
    #[serde(default)]
    pub mode: String,
    /// 当前时段（morning / afternoon / evening / night）。
    #[serde(default)]
    pub bucket: String,
    /// 当前小时（0-23）。
    #[serde(default)]
    pub hour: Option<u32>,
    /// 当前地理位置（可选，用于出行类 query）。
    #[serde(default)]
    pub location: String,
    /// 上次点击的 app（用于 chain-of-action）。
    #[serde(default)]
    pub last_app: String,
    /// 自定义键值对（用于扩展）。
    #[serde(default)]
    pub extra: Vec<(String, String)>,
}

/// 上下文管理器（线程安全）。
#[derive(Debug, Default)]
pub struct ContextManager {
    #[cfg(feature = "std")]
    inner: std::sync::RwLock<SearchContext_>,
    #[cfg(not(feature = "std"))]
    inner: spin::RwLock<SearchContext_>,
}

#[cfg(feature = "std")]
impl Clone for ContextManager {
    fn clone(&self) -> Self {
        Self {
            inner: std::sync::RwLock::new(self.get()),
        }
    }
}

#[cfg(not(feature = "std"))]
impl Clone for ContextManager {
    fn clone(&self) -> Self {
        Self {
            inner: spin::RwLock::new(self.get()),
        }
    }
}

impl ContextManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 设置当前上下文（覆盖）。
    pub fn set(&self, ctx: SearchContext_) {
        if let Ok(mut w) = self.inner.write() {
            *w = ctx;
        }
    }

    /// 清除当前上下文。
    pub fn clear(&self) {
        if let Ok(mut w) = self.inner.write() {
            *w = SearchContext_::default();
        }
    }

    /// 获取当前上下文的快照。
    pub fn get(&self) -> SearchContext_ {
        self.inner.read().map(|r| r.clone()).unwrap_or_default()
    }

    /// 更新最近使用的 app（追加到头部，去重，保留前 N 个）。
    pub fn push_recent_app(&self, app: &str, keep: usize) {
        if let Ok(mut w) = self.inner.write() {
            w.recent_apps.retain(|a| a != app);
            w.recent_apps.insert(0, app.to_string());
            if w.recent_apps.len() > keep {
                w.recent_apps.truncate(keep);
            }
        }
    }

    /// 设置当前模式。
    pub fn set_mode(&self, mode: &str) {
        if let Ok(mut w) = self.inner.write() {
            w.mode = mode.to_string();
        }
    }

    /// 设置当前时段。
    pub fn set_bucket(&self, bucket: &str, hour: u32) {
        if let Ok(mut w) = self.inner.write() {
            w.bucket = bucket.to_string();
            w.hour = Some(hour);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_set_get_clear() {
        let cm = ContextManager::new();
        let mut ctx = SearchContext_::default();
        ctx.mode = "pro".into();
        cm.set(ctx);
        assert_eq!(cm.get().mode, "pro");
        cm.clear();
        assert_eq!(cm.get().mode, "");
    }

    #[test]
    fn test_push_recent_app() {
        let cm = ContextManager::new();
        cm.push_recent_app("微信", 3);
        cm.push_recent_app("QQ", 3);
        cm.push_recent_app("微信", 3); // 去重，移到头部
        cm.push_recent_app("抖音", 3);
        cm.push_recent_app("B站", 3); // 超出 3 个，最早的 QQ 被淘汰

        let ctx = cm.get();
        assert_eq!(ctx.recent_apps, vec!["B站", "抖音", "微信"]);
    }
}
