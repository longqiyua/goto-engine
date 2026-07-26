//! 贝叶斯意图过滤模块（对应 `goto-engine.js` `getBayesTable` / `saveBayesTable` /
//! `recordBayesObservation` / `bayesPredict` / `_bayesHighConfidenceApps`）。
//!
//! 频率表结构：`{ query: { appName: { hour: count, total: count, lastTs } } }`。
//! 简化贝叶斯：`P(app|query,hour) ≈ count(app,hour) / sum(count(all,hour))`，
//! 时段无数据时回退到 `P(app|query) = count(app.total) / sum(all.total)`。

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use alloc::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::constants::{StorageKeys, BAYES_CONFIDENCE_THRESHOLD, BAYES_MAX_QUERIES, BAYES_MIN_SAMPLES};
use crate::storage::Storage;
use crate::utils::{get_hour_bucket, now_ts};

// ─── 频率表数据结构（与 JS 端 JSON 一致） ────────────────────────────────────

/// 单个 query 下某个 app 的时段统计。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BayesAppEntry {
    /// 各时段的命中次数：`{"morning": 3, "afternoon": 5, ...}`。
    #[serde(default)]
    pub buckets: BTreeMap<String, u32>,
    /// 总命中次数。
    #[serde(default)]
    pub total: u32,
    /// 最后命中时间戳。
    #[serde(default)]
    pub last_ts: u64,
}

/// 整张频率表：`query → (app → entry)`。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BayesFrequencyTable {
    /// query（小写） → (app → entry)。
    #[serde(default)]
    pub queries: BTreeMap<String, BTreeMap<String, BayesAppEntry>>,
}

/// 贝叶斯预测结果。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BayesPrediction {
    pub app: String,
    pub probability: f64,
    pub count: u32,
    pub hour_count: u32,
}

// ─── 管理器 ─────────────────────────────────────────────────────────────────

/// 贝叶斯意图过滤管理器。
#[derive(Debug)]
pub struct BayesManager<'a, S: Storage + ?Sized> {
    storage: &'a S,
}

impl<'a, S: Storage + ?Sized> BayesManager<'a, S> {
    pub fn new(storage: &'a S) -> Self { Self { storage } }

    /// `getBayesTable()`：读取频率表。
    pub fn get_table(&self) -> BayesFrequencyTable {
        self.storage.read_json(StorageKeys::BAYES_TABLE, BayesFrequencyTable::default())
    }

    /// `saveBayesTable(table)`：保存频率表。
    pub fn save_table(&self, table: &BayesFrequencyTable) {
        self.storage.write_json(StorageKeys::BAYES_TABLE, table);
    }

    /// `recordBayesObservation(query, appName, hourBucket)`：记录观测。
    ///
    /// 用户在某时段搜 query 选中 app，更新频率表。
    /// 轻量淘汰：仅维护最近 220 条 query（按 lastTs 排序，超出按频率淘汰）。
    pub fn record_observation(&self, query: &str, app: &str, bucket: Option<&str>) {
        if query.is_empty() || app.is_empty() { return; }
        let q = query.to_lowercase();
        if q.is_empty() { return; }
        let bucket = bucket.unwrap_or_else(|| get_hour_bucket(None));
        let now = now_ts();

        let mut table = self.get_table();
        let app_map = table.queries.entry(q.clone()).or_default();
        let entry = app_map.entry(app.to_string()).or_default();
        *entry.buckets.entry(bucket.to_string()).or_insert(0) += 1;
        entry.total = entry.total.saturating_add(1);
        entry.last_ts = now;

        // 淘汰：超过 220 条 query 时按 (lastTs, freq) 升序删除
        if table.queries.len() > BAYES_MAX_QUERIES {
            let mut q_list: Vec<(String, u64, u32)> = table.queries.iter().map(|(k, apps)| {
                let max_total = apps.values().map(|e| e.total).max().unwrap_or(0);
                let last_ts = apps.values().map(|e| e.last_ts).max().unwrap_or(0);
                (k.clone(), last_ts, max_total)
            }).collect();
            // 升序：(lastTs, freq) 最小者排前
            q_list.sort_by(|a, b| a.1.cmp(&b.1).then(a.2.cmp(&b.2)));
            let remove = q_list.len().saturating_sub(BAYES_MAX_QUERIES);
            for (key, _, _) in q_list.into_iter().take(remove) {
                table.queries.remove(&key);
            }
        }

        self.save_table(&table);
    }

    /// `bayesPredict(query, hourBucket)`：贝叶斯预测。
    ///
    /// 返回 `P(app|query,hour)` 排序的候选列表。
    pub fn predict(&self, query: &str, bucket: Option<&str>) -> Vec<BayesPrediction> {
        if query.is_empty() { return Vec::new(); }
        let q = query.to_lowercase();
        if q.is_empty() { return Vec::new(); }
        let table = self.get_table();
        let app_map = match table.queries.get(&q) {
            Some(m) => m,
            None => return Vec::new(),
        };
        let bucket = bucket.unwrap_or_else(|| get_hour_bucket(None));

        let mut hour_total = 0u32;
        let mut all_total = 0u32;
        for entry in app_map.values() {
            hour_total += entry.buckets.get(bucket).copied().unwrap_or(0);
            all_total += entry.total;
        }

        let mut candidates: Vec<BayesPrediction> = Vec::new();
        for (app, entry) in app_map {
            if entry.total < BAYES_MIN_SAMPLES { continue; }
            let prob = if hour_total > 0 && entry.buckets.contains_key(bucket) {
                (entry.buckets.get(bucket).copied().unwrap_or(0) as f64) / (hour_total as f64)
            } else if all_total > 0 {
                (entry.total as f64) / (all_total as f64)
            } else {
                0.0
            };
            if prob > 0.0 {
                candidates.push(BayesPrediction {
                    app: app.clone(),
                    probability: prob,
                    count: entry.total,
                    hour_count: entry.buckets.get(bucket).copied().unwrap_or(0),
                });
            }
        }
        candidates.sort_by(|a, b| b.probability.partial_cmp(&a.probability).unwrap_or(core::cmp::Ordering::Equal));
        candidates
    }

    /// `_bayesHighConfidenceApps(query)`：高置信度候选（P > 阈值）。
    pub fn high_confidence_apps(&self, query: &str) -> Vec<BayesPrediction> {
        self.predict(query, None)
            .into_iter()
            .filter(|p| p.probability > BAYES_CONFIDENCE_THRESHOLD)
            .collect()
    }

    /// 清空频率表。
    pub fn clear(&self) {
        self.storage.remove_string(StorageKeys::BAYES_TABLE);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::MemoryStorage;

    #[test]
    fn test_predict_empty() {
        let s = MemoryStorage::new();
        let mgr = BayesManager::new(&s);
        assert!(mgr.predict("anything", None).is_empty());
    }

    #[test]
    fn test_record_and_predict() {
        let s = MemoryStorage::new();
        let mgr = BayesManager::new(&s);

        // 模拟：query=wx 多次选中微信（不同时段）
        for _ in 0..5 {
            mgr.record_observation("wx", "微信", Some("morning"));
        }
        for _ in 0..2 {
            mgr.record_observation("wx", "QQ", Some("morning"));
        }

        let preds = mgr.predict("wx", Some("morning"));
        assert!(!preds.is_empty());
        // 微信应排首位
        assert_eq!(preds[0].app, "微信");
        assert!(preds[0].probability > 0.5);
    }

    #[test]
    fn test_high_confidence() {
        let s = MemoryStorage::new();
        let mgr = BayesManager::new(&s);
        for _ in 0..10 {
            mgr.record_observation("tx", "微信", Some("afternoon"));
        }
        let high = mgr.high_confidence_apps("tx");
        assert!(!high.is_empty());
        assert_eq!(high[0].app, "微信");
    }

    #[test]
    fn test_lowercase_normalization() {
        let s = MemoryStorage::new();
        let mgr = BayesManager::new(&s);
        // BAYES_MIN_SAMPLES = 2，需要至少 2 次观测才能产生预测
        mgr.record_observation("WX", "微信", Some("morning"));
        mgr.record_observation("WX", "微信", Some("morning"));
        // 用小写也能查到
        let preds = mgr.predict("wx", Some("morning"));
        assert!(!preds.is_empty());
    }
}
