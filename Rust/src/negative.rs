//! 负面层（对应 `goto-engine.js` `addBlockFlag` / `removeBlockFlag` /
//! `isBlockFlagged` / `clearExpiredBlockFlags` + `getNegativeState`）。
//!
//! 屏蔽机制：用户对某 query 的某 app 点踩后，临时屏蔽 N 天（默认 3 天）。

use alloc::string::{String, ToString};
use alloc::vec::Vec;

use crate::constants::{StorageKeys, BLOCK_FLAG_DEFAULT_DAYS, BLOCK_FLAG_MAX_ENTRIES, DAY_MS};
use crate::storage::Storage;
use crate::types::{BlockFlag, NegativeState};
use crate::utils::now_ts;

/// 负面反馈管理器。
#[derive(Debug)]
pub struct NegativeManager<'a, S: Storage + ?Sized> {
    storage: &'a S,
}

impl<'a, S: Storage + ?Sized> NegativeManager<'a, S> {
    pub fn new(storage: &'a S) -> Self { Self { storage } }

    /// `getNegativeState()`：读取负面状态。
    pub fn get_state(&self) -> NegativeState {
        self.storage.read_json(StorageKeys::NEGATIVE, NegativeState::default())
    }

    /// `saveNegativeState(state)`：保存负面状态。
    pub fn save_state(&self, state: &NegativeState) {
        self.storage.write_json(StorageKeys::NEGATIVE, state);
    }

    /// `addBlockFlag(query, app, days)`：添加屏蔽。
    pub fn add_block_flag(&self, query: &str, app: &str, days: u32) {
        let days = if days == 0 { BLOCK_FLAG_DEFAULT_DAYS } else { days };
        let now = now_ts();
        let expire = now + (days as u64) * DAY_MS;

        let mut state = self.get_state();
        // 去重：相同 (query, app) 移除旧的
        state.flags.retain(|f| !(f.query == query && f.app == app));
        state.flags.push(BlockFlag {
            query: query.to_string(),
            app: app.to_string(),
            expire_ts: expire,
            created_ts: now,
            days,
        });

        // 限制总条数
        if state.flags.len() > BLOCK_FLAG_MAX_ENTRIES {
            let start = state.flags.len() - BLOCK_FLAG_MAX_ENTRIES;
            state.flags = state.flags.split_off(start);
        }

        self.save_state(&state);
    }

    /// `removeBlockFlag(query, app)`：移除屏蔽。
    pub fn remove_block_flag(&self, query: &str, app: &str) {
        let mut state = self.get_state();
        state.flags.retain(|f| !(f.query == query && f.app == app));
        self.save_state(&state);
    }

    /// `isBlockFlagged(query, app)`：查询是否被屏蔽。
    pub fn is_block_flagged(&self, query: &str, app: &str) -> bool {
        let now = now_ts();
        let state = self.get_state();
        state.flags.iter().any(|f| {
            f.query == query && f.app == app && (f.expire_ts == 0 || f.expire_ts > now)
        })
    }

    /// `clearExpiredBlockFlags()`：清理过期屏蔽。
    pub fn clear_expired(&self) -> usize {
        let now = now_ts();
        let mut state = self.get_state();
        let before = state.flags.len();
        state.flags.retain(|f| f.expire_ts == 0 || f.expire_ts > now);
        let after = state.flags.len();
        if before != after {
            self.save_state(&state);
        }
        before - after
    }

    /// 添加 dislike（永久降低权重）。
    pub fn add_dislike(&self, app: &str, weight: f64) {
        let mut state = self.get_state();
        if let Some(item) = state.dislikes.iter_mut().find(|(a, _)| a == app) {
            item.1 += weight;
        } else {
            state.dislikes.push((app.to_string(), weight));
        }
        self.save_state(&state);
    }

    /// 获取某 app 的 dislike 权重。
    pub fn get_dislike(&self, app: &str) -> f64 {
        let state = self.get_state();
        state.dislikes.iter()
            .find(|(a, _)| a == app)
            .map(|(_, w)| *w)
            .unwrap_or(0.0)
    }

    /// 清空所有负面记录。
    pub fn clear(&self) {
        self.storage.remove_string(StorageKeys::NEGATIVE);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::MemoryStorage;

    #[test]
    fn test_block_flag() {
        let s = MemoryStorage::new();
        let mgr = NegativeManager::new(&s);
        mgr.add_block_flag("wx", "QQ", 3);
        assert!(mgr.is_block_flagged("wx", "QQ"));
        assert!(!mgr.is_block_flagged("wx", "微信"));
    }

    #[test]
    fn test_remove_block_flag() {
        let s = MemoryStorage::new();
        let mgr = NegativeManager::new(&s);
        mgr.add_block_flag("wx", "QQ", 3);
        mgr.remove_block_flag("wx", "QQ");
        assert!(!mgr.is_block_flagged("wx", "QQ"));
    }

    #[test]
    fn test_dislike() {
        let s = MemoryStorage::new();
        let mgr = NegativeManager::new(&s);
        mgr.add_dislike("抖音", -2.0);
        assert_eq!(mgr.get_dislike("抖音"), -2.0);
        assert_eq!(mgr.get_dislike("微信"), 0.0);
    }
}
