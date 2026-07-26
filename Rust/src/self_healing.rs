//! 自愈层（对应 `goto-engine.js` `applySelfHealing` + `getSelfHealingState`）。
//!
//! 自愈机制：用户改选后，降低其他候选 app 的权重，并临时屏蔽原默认 app。

use alloc::string::{String, ToString};
use alloc::vec::Vec;

use crate::constants::{StorageKeys, SELF_HEALING_HISTORY_PER_QUERY, BLOCK_FLAG_DEFAULT_DAYS};
use crate::negative::NegativeManager;
use crate::storage::Storage;
use crate::types::{SelfHealingEntry, SelfHealingState};
use crate::utils::now_ts;
use crate::weights::WeightManager;

/// 自愈管理器。
#[derive(Debug)]
pub struct SelfHealingManager<'a, S: Storage + ?Sized> {
    storage: &'a S,
}

impl<'a, S: Storage + ?Sized> SelfHealingManager<'a, S> {
    pub fn new(storage: &'a S) -> Self { Self { storage } }

    /// `getSelfHealingState()`：读取自愈状态。
    pub fn get_state(&self) -> SelfHealingState {
        self.storage.read_json(StorageKeys::SELF_HEALING, SelfHealingState::default())
    }

    /// `saveSelfHealingState(state)`：保存自愈状态。
    pub fn save_state(&self, state: &SelfHealingState) {
        self.storage.write_json(StorageKeys::SELF_HEALING, state);
    }

    /// `applySelfHealing(query, newDefaultApp)`：自愈。
    ///
    /// 1. 找到该 query 下所有候选 app；
    /// 2. 对非 `newDefaultApp` 的候选降低权重（-0.5）；
    /// 3. 临时屏蔽原默认 app（3 天）；
    /// 4. 记录到自愈历史（每个 query 最多 10 条）。
    pub fn apply_self_healing(
        &self,
        query: &str,
        new_app: &str,
        candidates: &[String],
        weights: &mut WeightManager<'a, S>,
        negative: &NegativeManager<'a, S>,
    ) -> SelfHealingEntry {
        let now = now_ts();
        let mut suppressed: Vec<String> = Vec::new();

        // 1. 降低其他候选权重
        for app in candidates {
            if app != new_app {
                weights.add_weight(query, app, -0.5);
                // 2. 临时屏蔽原默认 app
                negative.add_block_flag(query, app, BLOCK_FLAG_DEFAULT_DAYS);
                suppressed.push(app.clone());
            }
        }

        // 3. 提升 new_app 权重
        weights.add_weight(query, new_app, 1.0);

        // 4. 记录历史
        let entry = SelfHealingEntry {
            query: query.to_string(),
            original_app: suppressed.first().cloned().unwrap_or_default(),
            new_app: new_app.to_string(),
            ts: now,
            suppressed: suppressed.clone(),
        };

        let mut state = self.get_state();
        // 移除超出上限的旧记录（每个 query 保留 10 条）
        let per_query: Vec<SelfHealingEntry> = state.history.iter()
            .filter(|e| e.query == query)
            .cloned()
            .collect();
        if per_query.len() >= SELF_HEALING_HISTORY_PER_QUERY {
            // 移除最旧的
            let to_remove = per_query.len() - SELF_HEALING_HISTORY_PER_QUERY + 1;
            let oldest_ts: Vec<u64> = per_query.iter().take(to_remove).map(|e| e.ts).collect();
            state.history.retain(|e| {
                !(e.query == query && oldest_ts.contains(&e.ts))
            });
        }
        state.history.push(entry.clone());
        self.save_state(&state);

        entry
    }

    /// 获取某 query 的自愈历史。
    pub fn get_history(&self, query: &str) -> Vec<SelfHealingEntry> {
        let state = self.get_state();
        state.history.into_iter().filter(|e| e.query == query).collect()
    }

    /// 清空所有自愈记录。
    pub fn clear(&self) {
        self.storage.remove_string(StorageKeys::SELF_HEALING);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::MemoryStorage;

    #[test]
    fn test_apply_self_healing() {
        let s = MemoryStorage::new();
        let mut weights = WeightManager::new(&s);
        let negative = NegativeManager::new(&s);
        let sh = SelfHealingManager::new(&s);

        // 预设权重
        weights.add_weight("wx", "微信", 5.0);
        weights.add_weight("wx", "QQ", 3.0);
        weights.add_weight("wx", "钉钉", 2.0);

        let candidates = vec!["微信".to_string(), "QQ".to_string(), "钉钉".to_string()];
        sh.apply_self_healing("wx", "微信", &candidates, &mut weights, &negative);

        // QQ / 钉钉 应被屏蔽
        assert!(negative.is_block_flagged("wx", "QQ"));
        assert!(negative.is_block_flagged("wx", "钉钉"));

        // 历史应有 1 条
        let h = sh.get_history("wx");
        assert_eq!(h.len(), 1);
    }
}
