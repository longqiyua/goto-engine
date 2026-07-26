//! 关联层（对应 `goto-engine.js` `getChainStore` / `saveChainStore` +
//! `getAssociationRecommendation`）。
//!
//! 动作链（Chain-of-Action Routing）：记录 A→B 的转移权重，
//! 当用户使用 app A 后，推荐下一个 app B。

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use alloc::collections::BTreeMap;

use crate::constants::StorageKeys;
use crate::storage::Storage;
use crate::types::{ChainEdge, ChainStore};
use crate::utils::now_ts;

/// 关联管理器。
#[derive(Debug)]
pub struct AssociationManager<'a, S: Storage + ?Sized> {
    storage: &'a S,
}

impl<'a, S: Storage + ?Sized> AssociationManager<'a, S> {
    pub fn new(storage: &'a S) -> Self { Self { storage } }

    /// `getChainStore()`：读取动作链。
    pub fn get_store(&self) -> ChainStore {
        self.storage.read_json(StorageKeys::CHAINS, ChainStore::default())
    }

    /// `saveChainStore(store)`：保存动作链。
    pub fn save_store(&self, store: &ChainStore) {
        self.storage.write_json(StorageKeys::CHAINS, store);
    }

    /// 记录一次 A→B 转移。
    pub fn record_transition(&self, from: &str, to: &str, weight_delta: f64) {
        let now = now_ts();
        let mut store = self.get_store();

        if let Some(edge) = store.edges.iter_mut().find(|e| e.from == from && e.to == to) {
            edge.weight += weight_delta;
            edge.count += 1;
            edge.last_ts = now;
        } else {
            store.edges.push(ChainEdge {
                from: from.to_string(),
                to: to.to_string(),
                weight: weight_delta,
                count: 1,
                last_ts: now,
            });
        }

        self.save_store(&store);
    }

    /// `getAssociationRecommendation(currentApp, topN)`：基于动作链推荐下一个 app。
    ///
    /// 返回 `[(app, score), ...]`，按权重降序。
    pub fn recommend_next(&self, current_app: &str, top_n: usize) -> Vec<(String, f64)> {
        let store = self.get_store();
        let mut candidates: Vec<(String, f64)> = store.edges.iter()
            .filter(|e| e.from == current_app && e.weight > 0.0)
            .map(|e| (e.to.clone(), e.weight))
            .collect();
        candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(core::cmp::Ordering::Equal));
        candidates.truncate(top_n);
        candidates
    }

    /// 获取所有 from→to 边。
    pub fn get_edges(&self) -> Vec<ChainEdge> {
        self.get_store().edges
    }

    /// 修剪：清理权重 < threshold 的边（对应 JS `_pruneChainStore`）。
    pub fn prune(&self, min_weight: f64, max_per_node: usize, max_total: usize) -> usize {
        let mut store = self.get_store();
        let before = store.edges.len();

        // 1. 清理低权重边
        store.edges.retain(|e| e.weight >= min_weight);

        // 2. 每个 from 节点最多保留 max_per_node 条
        let mut by_from: BTreeMap<String, Vec<ChainEdge>> = BTreeMap::new();
        for edge in store.edges.drain(..) {
            by_from.entry(edge.from.clone()).or_default().push(edge);
        }
        for (_from, edges) in by_from.iter_mut() {
            edges.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(core::cmp::Ordering::Equal));
            edges.truncate(max_per_node);
        }
        store.edges = by_from.into_values().flatten().collect();

        // 3. 全局总边数 ≤ max_total
        if store.edges.len() > max_total {
            store.edges.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(core::cmp::Ordering::Equal));
            store.edges.truncate(max_total);
        }

        let after = store.edges.len();
        if before != after {
            self.save_store(&store);
        }
        before - after
    }

    /// 清空所有动作链。
    pub fn clear(&self) {
        self.storage.remove_string(StorageKeys::CHAINS);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::MemoryStorage;

    #[test]
    fn test_record_and_recommend() {
        let s = MemoryStorage::new();
        let mgr = AssociationManager::new(&s);
        mgr.record_transition("微信", "朋友圈", 1.0);
        mgr.record_transition("微信", "朋友圈", 1.0);
        mgr.record_transition("微信", "扫一扫", 0.5);

        let r = mgr.recommend_next("微信", 2);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].0, "朋友圈");
        assert!(r[0].1 > r[1].1);
    }

    #[test]
    fn test_prune() {
        let s = MemoryStorage::new();
        let mgr = AssociationManager::new(&s);
        mgr.record_transition("A", "B", 0.5);  // 低于阈值 1.0
        mgr.record_transition("A", "C", 2.0);

        let pruned = mgr.prune(1.0, 20, 500);
        assert_eq!(pruned, 1);
        let r = mgr.recommend_next("A", 10);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].0, "C");
    }
}
