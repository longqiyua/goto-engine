//! 权重层（对应 `goto-engine.js` `getRuleWeights` / `saveRuleWeights` / `getRuleWeightsTs`）。
//!
//! 记录每个 query 对各 app 的偏好分（由 `recordSelection` 累积）。
//! 权重会随时间衰减（30 天半衰期），下限 0.35。

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use alloc::collections::BTreeMap;

use crate::constants::{StorageKeys, WEIGHT_DECAY_HALF_LIFE_DAYS, WEIGHT_DECAY_MIN_FLOOR, DAY_MS};
use crate::storage::Storage;
use crate::types::RuleWeights;
use crate::utils::now_ts;

/// 权重管理器。
#[derive(Debug)]
pub struct WeightManager<'a, S: Storage + ?Sized> {
    storage: &'a S,
    /// 内存缓存（首次读后缓存）。
    cached_weights: BTreeMap<String, Vec<(String, f64)>>,
    cached_ts: BTreeMap<String, u64>,
    loaded: bool,
}

impl<'a, S: Storage + ?Sized> WeightManager<'a, S> {
    pub fn new(storage: &'a S) -> Self {
        Self {
            storage,
            cached_weights: BTreeMap::new(),
            cached_ts: BTreeMap::new(),
            loaded: false,
        }
    }

    /// 从 storage 加载权重到内存缓存。
    pub fn load(&mut self) {
        let weights: RuleWeights = self.storage.read_json(StorageKeys::WEIGHTS, Vec::new());
        let ts: Vec<(String, u64)> = self.storage.read_json(StorageKeys::WEIGHTS_TS, Vec::new());
        self.cached_weights = weights.into_iter().collect();
        self.cached_ts = ts.into_iter().collect();
        self.loaded = true;
    }

    /// 保存内存缓存到 storage。
    pub fn flush(&self) {
        let weights: RuleWeights = self.cached_weights.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let ts: Vec<(String, u64)> = self.cached_ts.iter().map(|(k, v)| (k.clone(), *v)).collect();
        self.storage.write_json(StorageKeys::WEIGHTS, &weights);
        self.storage.write_json(StorageKeys::WEIGHTS_TS, &ts);
    }

    /// `getRuleWeights()`：读取所有权重。
    pub fn get_all(&mut self) -> &BTreeMap<String, Vec<(String, f64)>> {
        if !self.loaded { self.load(); }
        &self.cached_weights
    }

    /// `getRuleWeightsTs()`：读取所有时间戳。
    pub fn get_all_ts(&mut self) -> &BTreeMap<String, u64> {
        if !self.loaded { self.load(); }
        &self.cached_ts
    }

    /// 获取某 query 的权重列表。
    pub fn get_query_weights(&mut self, query: &str) -> Vec<(String, f64)> {
        if !self.loaded { self.load(); }
        self.cached_weights.get(query).cloned().unwrap_or_default()
    }

    /// 增加某 query→app 的权重（增量更新）。
    pub fn add_weight(&mut self, query: &str, app: &str, delta: f64) {
        if !self.loaded { self.load(); }
        let entry = self.cached_weights.entry(query.to_string()).or_default();
        if let Some(item) = entry.iter_mut().find(|(a, _)| a == app) {
            item.1 += delta;
        } else {
            entry.push((app.to_string(), delta));
        }
        self.cached_ts.insert(query.to_string(), now_ts());
        self.flush();
    }

    /// 设置某 query→app 的权重（绝对值）。
    pub fn set_weight(&mut self, query: &str, app: &str, weight: f64) {
        if !self.loaded { self.load(); }
        let entry = self.cached_weights.entry(query.to_string()).or_default();
        if let Some(item) = entry.iter_mut().find(|(a, _)| a == app) {
            item.1 = weight;
        } else {
            entry.push((app.to_string(), weight));
        }
        self.cached_ts.insert(query.to_string(), now_ts());
        self.flush();
    }

    /// 应用时间衰减（对应 JS `_applyTimeDecayToQuery`）。
    pub fn apply_time_decay(&mut self, query: &str) -> usize {
        if !self.loaded { self.load(); }
        let now = now_ts();
        let ts = match self.cached_ts.get(query) {
            Some(t) => *t,
            None => return 0,
        };
        if ts == 0 || now <= ts { return 0; }
        let age_days = (now - ts) as f64 / DAY_MS as f64;
        if age_days < 1.0 { return 0; }
        let decay = 0.5_f64.powf(age_days / WEIGHT_DECAY_HALF_LIFE_DAYS);
        let decay = decay.max(WEIGHT_DECAY_MIN_FLOOR);

        let mut count = 0usize;
        if let Some(entry) = self.cached_weights.get_mut(query) {
            for (_app, w) in entry.iter_mut() {
                *w *= decay;
                count += 1;
            }
        }
        self.cached_ts.insert(query.to_string(), now);
        self.flush();
        count
    }

    /// 全局衰减（对应 JS `_decayAllStaleQueries`）。
    pub fn decay_all_stale(&mut self) -> usize {
        if !self.loaded { self.load(); }
        let now = now_ts();
        let stale_threshold = DAY_MS; // > 1 天
        let queries: Vec<String> = self.cached_ts.iter()
            .filter(|(_, ts)| **ts > 0 && now > **ts && now - **ts > stale_threshold)
            .map(|(q, _)| q.clone())
            .collect();
        let mut total = 0usize;
        for q in queries {
            total += self.apply_time_decay(&q);
        }
        total
    }

    /// 清空所有权重。
    pub fn clear(&mut self) {
        self.cached_weights.clear();
        self.cached_ts.clear();
        self.storage.remove_string(StorageKeys::WEIGHTS);
        self.storage.remove_string(StorageKeys::WEIGHTS_TS);
        self.loaded = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::MemoryStorage;

    #[test]
    fn test_add_and_get_weight() {
        let s = MemoryStorage::new();
        let mut mgr = WeightManager::new(&s);
        mgr.add_weight("wx", "微信", 5.0);
        let w = mgr.get_query_weights("wx");
        assert_eq!(w, vec![("微信".to_string(), 5.0)]);
    }

    #[test]
    fn test_persistence() {
        let s = MemoryStorage::new();
        {
            let mut mgr = WeightManager::new(&s);
            mgr.add_weight("wx", "微信", 5.0);
        }
        // 新建 manager 应能读取之前保存的权重
        let mut mgr2 = WeightManager::new(&s);
        let w = mgr2.get_query_weights("wx");
        assert_eq!(w, vec![("微信".to_string(), 5.0)]);
    }

    #[test]
    fn test_clear() {
        let s = MemoryStorage::new();
        let mut mgr = WeightManager::new(&s);
        mgr.add_weight("wx", "微信", 5.0);
        mgr.clear();
        assert!(mgr.get_query_weights("wx").is_empty());
    }
}
