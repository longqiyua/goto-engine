//! 学习层（对应 `goto-engine.js` `recordSearch` / `recordSelection` / `recordUnknownApp` /
//! `getMemory` / `getPendingIndex`）。
//!
//! 三类学习记录：
//!   - **Memory**：最近 220 条 query→app 选择记录（用于权重 + 关联分析）。
//!   - **Pending**：待索引库（低权重应用，多次选择后转正）。
//!   - **Stats**：每个 app 的使用次数 + 时段统计。

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use alloc::collections::BTreeMap;

use crate::constants::{StorageKeys, MEMORY_MAX_RECORDS, PENDING_MAX_ENTRIES};
use crate::intent::{extract_tokens, primary_intent};
use crate::storage::Storage;
use crate::types::{MemoryRecord, PendingEntry};
use crate::utils::{get_hour, get_hour_bucket, now_ts};
use crate::weights::WeightManager;

/// 学习管理器。
#[derive(Debug)]
pub struct LearningManager<'a, S: Storage + ?Sized> {
    storage: &'a S,
}

impl<'a, S: Storage + ?Sized> LearningManager<'a, S> {
    pub fn new(storage: &'a S) -> Self {
        Self { storage }
    }

    /// `recordSearch(query)`：记录搜索行为（仅记入 stats，不记入 memory）。
    pub fn record_search(&self, query: &str) {
        // 简化实现：仅触发 stats 计数（实际 JS 也只是写入 stats）
        let mut stats: BTreeMap<String, u32> = self.storage.read_json(StorageKeys::STATS, BTreeMap::new());
        *stats.entry(query.to_string()).or_insert(0) += 1;
        self.storage.write_json(StorageKeys::STATS, &stats);
    }

    /// `recordSelection(query, app)`：记录用户选择。
    ///
    /// 1. 写入 memory（保留最近 220 条）；
    /// 2. 增加权重（query→app +1.0）；
    /// 3. 更新 stats（app 使用次数 +1）；
    /// 4. 检测 chain-of-action（如果存在 last_app，则增加 A→B 边权重）。
    pub fn record_selection(
        &self,
        query: &str,
        app: &str,
        weights: &mut WeightManager<'a, S>,
    ) -> MemoryRecord {
        let now = now_ts();
        let hour = get_hour();
        let bucket = get_hour_bucket(Some(hour));
        let tq = extract_tokens(query);
        let intent = primary_intent(&tq).to_string();

        // 1. 写入 memory
        let record = MemoryRecord {
            query: query.to_string(),
            app: app.to_string(),
            ts: now,
            tokens: tq.tokens.clone(),
            intent,
            bucket: bucket.to_string(),
        };
        let mut memory: Vec<MemoryRecord> = self.storage.read_json(StorageKeys::MEMORY, Vec::new());
        memory.push(record.clone());
        // 保留最近 220 条
        if memory.len() > MEMORY_MAX_RECORDS {
            let start = memory.len() - MEMORY_MAX_RECORDS;
            memory = memory.split_off(start);
        }
        self.storage.write_json(StorageKeys::MEMORY, &memory);

        // 2. 增加权重
        weights.add_weight(query, app, 1.0);

        // 3. 更新 stats
        let mut stats: BTreeMap<String, u32> = self.storage.read_json(StorageKeys::STATS, BTreeMap::new());
        *stats.entry(app.to_string()).or_insert(0) += 1;
        self.storage.write_json(StorageKeys::STATS, &stats);

        // 4. 记录小时统计（用于热力图 / Top N）
        let mut hourly: Vec<crate::types::HourBucket> =
            self.storage.read_json(StorageKeys::STATS_HOURLY_LAUNCH, Vec::new());
        hourly.push(crate::types::HourBucket {
            h: alloc::format!("h-{}", hour),
            app: app.to_string(),
            count: 1,
            ts: now,
        });
        // 保留最近 5000 条
        if hourly.len() > 5000 {
            let start = hourly.len() - 5000;
            hourly = hourly.split_off(start);
        }
        self.storage.write_json(StorageKeys::STATS_HOURLY_LAUNCH, &hourly);

        record
    }

    /// `recordUnknownApp(query, app)`：记录未知应用，进入待索引库。
    pub fn record_unknown_app(&self, query: &str, app: &str) {
        let now = now_ts();
        let mut pending: Vec<PendingEntry> = self.storage.read_json(StorageKeys::PENDING, Vec::new());

        if let Some(entry) = pending.iter_mut().find(|e| e.app == app && e.query == query) {
            entry.count += 1;
            entry.last_ts = now;
        } else {
            pending.push(PendingEntry {
                app: app.to_string(),
                query: query.to_string(),
                count: 1,
                first_ts: now,
                last_ts: now,
                threshold: 3,
            });
        }

        // 保留最近 120 条
        if pending.len() > PENDING_MAX_ENTRIES {
            let start = pending.len() - PENDING_MAX_ENTRIES;
            pending = pending.split_off(start);
        }
        self.storage.write_json(StorageKeys::PENDING, &pending);
    }

    /// `getMemory()`：读取所有记忆记录。
    pub fn get_memory(&self) -> Vec<MemoryRecord> {
        self.storage.read_json(StorageKeys::MEMORY, Vec::new())
    }

    /// `saveMemory(list)`：保存记忆记录。
    pub fn save_memory(&self, memory: &[MemoryRecord]) {
        self.storage.write_json(StorageKeys::MEMORY, memory);
    }

    /// `getPendingIndex()`：读取待索引库。
    pub fn get_pending(&self) -> Vec<PendingEntry> {
        self.storage.read_json(StorageKeys::PENDING, Vec::new())
    }

    /// `getUnknownApps()`：获取未知应用列表（去重）。
    pub fn get_unknown_apps(&self) -> Vec<String> {
        let pending = self.get_pending();
        let mut apps: Vec<String> = pending.iter().map(|e| e.app.clone()).collect();
        apps.sort();
        apps.dedup();
        apps
    }

    /// `getStats()`：读取所有 app 的使用次数。
    pub fn get_stats(&self) -> BTreeMap<String, u32> {
        self.storage.read_json(StorageKeys::STATS, BTreeMap::new())
    }

    /// 获取小时统计（用于热力图 / Top N）。
    pub fn get_hour_buckets(&self) -> Vec<crate::types::HourBucket> {
        self.storage.read_json(StorageKeys::STATS_HOURLY_LAUNCH, Vec::new())
    }

    /// 清空所有学习记录（用于"重置引擎"）。
    pub fn clear(&self) {
        self.storage.remove_string(StorageKeys::MEMORY);
        self.storage.remove_string(StorageKeys::PENDING);
        self.storage.remove_string(StorageKeys::STATS);
        self.storage.remove_string(StorageKeys::STATS_HOURLY_LAUNCH);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::MemoryStorage;

    #[test]
    fn test_record_selection() {
        let s = MemoryStorage::new();
        let mut weights = WeightManager::new(&s);
        let learning = LearningManager::new(&s);
        learning.record_selection("wx", "微信", &mut weights);
        let m = learning.get_memory();
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].app, "微信");
    }

    #[test]
    fn test_record_unknown_app() {
        let s = MemoryStorage::new();
        let learning = LearningManager::new(&s);
        learning.record_unknown_app("newquery", "NewApp");
        learning.record_unknown_app("newquery", "NewApp");
        let p = learning.get_pending();
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].count, 2);
    }

    #[test]
    fn test_stats() {
        let s = MemoryStorage::new();
        let mut weights = WeightManager::new(&s);
        let learning = LearningManager::new(&s);
        learning.record_selection("wx", "微信", &mut weights);
        learning.record_selection("wx", "微信", &mut weights);
        let stats = learning.get_stats();
        assert_eq!(stats.get("微信"), Some(&2));
    }
}
