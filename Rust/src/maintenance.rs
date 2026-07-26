//! 自主维护层（对应 `goto-engine.js` `maintain` / `_decayAllStaleQueries` /
//! `_pruneChainStore` / `_pruneOldMemory` + `clearExpiredBlockFlags`）。
//!
//! 引擎自主维护：依次执行全局衰减 → 链式边修剪 → 旧记忆清理 → 过期 block flag 清理。
//! `installGlobals()` 启动时自动调用一次，保证陈旧偏好不会无限累积。

use alloc::string::{String, ToString};
use alloc::vec::Vec;

use crate::association::AssociationManager;
use crate::constants::{
    StorageKeys, DAY_MS,
    MAINTENANCE_CHAIN_MAX_EDGES, MAINTENANCE_CHAIN_MAX_PER_NODE,
    MAINTENANCE_CHAIN_MIN_WEIGHT, MAINTENANCE_MEMORY_MAX_AGE_DAYS,
    MAINTENANCE_MEMORY_MAX_RECORDS, MAINTENANCE_STALE_THRESHOLD_DAYS,
};
use crate::negative::NegativeManager;
use crate::storage::Storage;
use crate::types::MaintenanceReport;
use crate::utils::now_ts;
use crate::weights::WeightManager;

/// 维护管理器。
#[derive(Debug)]
pub struct MaintenanceManager<'a, S: Storage + ?Sized> {
    storage: &'a S,
}

impl<'a, S: Storage + ?Sized> MaintenanceManager<'a, S> {
    pub fn new(storage: &'a S) -> Self { Self { storage } }

    /// `_decayAllStaleQueries()`：全局时间衰减。
    ///
    /// 对所有 > 1 天的查询权重复用 `apply_time_decay`，
    /// 解决原算法仅在用户点击时才衰减的盲点。
    pub fn decay_all_stale_queries(&self, weights: &mut WeightManager<'a, S>) -> (usize, usize) {
        let ts_map: Vec<(String, u64)> =
            self.storage.read_json(StorageKeys::WEIGHTS_TS, Vec::new());

        if ts_map.is_empty() {
            return (0, 0);
        }

        let now = now_ts();
        let mut decayed = 0usize;

        for (key, last_ts) in &ts_map {
            if *last_ts == 0 { continue; }
            let days_since = (now - last_ts) as f64 / DAY_MS as f64;
            if days_since < MAINTENANCE_STALE_THRESHOLD_DAYS { continue; }

            // 检查衰减前后权重是否变化
            let before = weights.get_query_weights(key);
            weights.apply_time_decay(key);
            let after = weights.get_query_weights(key);
            if before != after {
                decayed += 1;
            }
        }

        (decayed, ts_map.len())
    }

    /// `_pruneChainStore()`：链式边修剪。
    ///
    /// 清理权重 < 1 的边；每个 from-key 最多保留 20 个 to-key；
    /// 全局总边数 ≤ 500，超出按权重降序截断。
    pub fn prune_chain_store(&self) -> (usize, usize) {
        let assoc = AssociationManager::new(self.storage);
        let before = assoc.get_edges().len();
        let pruned = assoc.prune(
            MAINTENANCE_CHAIN_MIN_WEIGHT,
            MAINTENANCE_CHAIN_MAX_PER_NODE,
            MAINTENANCE_CHAIN_MAX_EDGES,
        );
        let after = assoc.get_edges().len();
        let _ = before; let _ = after;
        (pruned, after)
    }

    /// `_pruneOldMemory()`：旧记忆修剪。
    ///
    /// 清理 > 90 天的记忆记录，并按 220 条上限双层保险。
    pub fn prune_old_memory(&self) -> (usize, usize) {
        let memory: Vec<crate::types::MemoryRecord> =
            self.storage.read_json(StorageKeys::MEMORY, Vec::new());

        if memory.is_empty() {
            return (0, 0);
        }

        let cutoff = now_ts().saturating_sub(
            (MAINTENANCE_MEMORY_MAX_AGE_DAYS * DAY_MS as f64) as u64
        );
        let before = memory.len();

        let mut filtered: Vec<crate::types::MemoryRecord> = memory
            .into_iter()
            .filter(|r| r.ts > cutoff)
            .collect();

        if filtered.len() > MAINTENANCE_MEMORY_MAX_RECORDS {
            let start = filtered.len() - MAINTENANCE_MEMORY_MAX_RECORDS;
            filtered = filtered.split_off(start);
        }

        let pruned = before - filtered.len();
        self.storage.write_json(StorageKeys::MEMORY, &filtered);

        (pruned, filtered.len())
    }

    /// `clearExpiredBlockFlags()`：清理过期屏蔽标记。
    pub fn clear_expired_block_flags(&self) -> usize {
        let neg = NegativeManager::new(self.storage);
        neg.clear_expired()
    }

    /// `maintain()`：引擎自主维护入口。
    ///
    /// 顺序：先全局衰减权重 → 再修剪链式边 → 再修剪旧记忆 → 最后清理过期 block flag。
    /// 返回统计报告（对应 JS `maintain()` 返回值）。
    pub fn maintain(&self, weights: &mut WeightManager<'a, S>) -> MaintenanceReport {
        let start = now_ts();

        let (decayed_queries, total_checked) = self.decay_all_stale_queries(weights);
        let _ = total_checked;
        let (pruned_chain_edges, remaining_chain_edges) = self.prune_chain_store();
        let _ = remaining_chain_edges;
        let (pruned_memory_records, remaining_memory) = self.prune_old_memory();
        let _ = remaining_memory;
        let cleared_block_flags = self.clear_expired_block_flags();

        MaintenanceReport {
            decayed_queries,
            pruned_chain_edges,
            pruned_memory_records,
            cleared_block_flags,
            duration_ms: now_ts().saturating_sub(start),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::MemoryStorage;
    use crate::types::{BlockFlag, ChainEdge, ChainStore, MemoryRecord, NegativeState};

    #[test]
    fn test_maintain_empty() {
        let storage = MemoryStorage::new();
        let mut weights = WeightManager::new(&storage);
        let mgr = MaintenanceManager::new(&storage);
        let report = mgr.maintain(&mut weights);
        assert_eq!(report.decayed_queries, 0);
        assert_eq!(report.pruned_chain_edges, 0);
        assert_eq!(report.pruned_memory_records, 0);
    }

    #[test]
    fn test_prune_old_memory() {
        let storage = MemoryStorage::new();
        let now = now_ts();
        let old_ts = now - 100 * DAY_MS;
        let memory = vec![
            MemoryRecord { query: "old".into(), app: "A".into(), ts: old_ts, ..Default::default() },
            MemoryRecord { query: "new".into(), app: "B".into(), ts: now, ..Default::default() },
        ];
        storage.write_json(StorageKeys::MEMORY, &memory);

        let mgr = MaintenanceManager::new(&storage);
        let (pruned, remaining) = mgr.prune_old_memory();
        assert_eq!(pruned, 1);
        assert_eq!(remaining, 1);
    }

    #[test]
    fn test_prune_chain_store() {
        let storage = MemoryStorage::new();
        let store = ChainStore {
            edges: vec![
                ChainEdge { from: "A".into(), to: "B".into(), weight: 0.5, count: 1, last_ts: 0 },
                ChainEdge { from: "A".into(), to: "C".into(), weight: 2.0, count: 5, last_ts: 0 },
            ],
        };
        storage.write_json(StorageKeys::CHAINS, &store);

        let mgr = MaintenanceManager::new(&storage);
        let (pruned, _remaining) = mgr.prune_chain_store();
        assert!(pruned >= 1);
    }

    #[test]
    fn test_clear_expired_block_flags() {
        let storage = MemoryStorage::new();
        let now = now_ts();
        let state = NegativeState {
            flags: vec![
                BlockFlag {
                    query: "q".into(), app: "old".into(),
                    expire_ts: now - 1000, created_ts: now - 2000, days: 3,
                },
                BlockFlag {
                    query: "q".into(), app: "new".into(),
                    expire_ts: now + DAY_MS * 3, created_ts: now, days: 3,
                },
            ],
            dislikes: Vec::new(),
        };
        storage.write_json(StorageKeys::NEGATIVE, &state);

        let mgr = MaintenanceManager::new(&storage);
        let cleared = mgr.clear_expired_block_flags();
        assert_eq!(cleared, 1);
    }
}
