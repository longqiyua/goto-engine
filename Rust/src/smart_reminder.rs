//! 智能提醒模块（对应 `index.html` `_smartReminderPredict` /
//! `_smartReminderPredictTopN` / `_isSmartReminderBlocked` +
//! `goto-engine.js` `_smartReminderTryExpandAfterLaunch`）。
//!
//! 综合预测：动作链 + 时段频次 + 星期-小时联合分布 + 全局热度。
//! 数据源：
//!   1. `goto_engine_action_chains.edges[from][to]` —— 一阶马尔可夫转移（权重 0.50）
//!   2. `goto_hour_buckets` —— 当前小时历史高频应用（权重 0.25）
//!   3. `goto_app_stats[appId].hourly` —— 星期+小时联合分布（权重 0.15）
//!   4. `goto_app_stats[appId].uses` —— 全局累计热度（权重 0.10）
//! 融合策略：缺失信号自动重分配权重，保证单一信号也能给出预测。

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use alloc::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::association::AssociationManager;
use crate::constants::{StorageKeys, DAY_MS};
use crate::negative::NegativeManager;
use crate::storage::Storage;
use crate::types::SmartReminderSuggestion;
use crate::utils::{get_hour, now_ts};

// ─── 常量（对应 JS 内 WEIGHTS 对象） ─────────────────────────────────────────

/// 各信号融合权重（缺失信号会重分配）。
pub const WEIGHT_CHAIN: f64 = 0.50;
pub const WEIGHT_HOURLY: f64 = 0.25;
pub const WEIGHT_DOW_HOUR: f64 = 0.15;
pub const WEIGHT_HOT: f64 = 0.10;

/// 高概率阈值（0-1）。
pub const HIGH_CONFIDENCE_THRESHOLD: f64 = 0.6;
/// 中等置信度阈值。
pub const LOW_CONFIDENCE_THRESHOLD: f64 = 0.35;
/// 同一目标 5 分钟内不重复推荐。
pub const MIN_INTERVAL_MS: u64 = 5 * 60 * 1000;
/// 屏蔽时长：3 天。
pub const BLOCK_DURATION_MS: u64 = 3 * DAY_MS;
/// 24 小时忽略标记时长。
pub const IGNORE_24H_MS: u64 = DAY_MS;

// ─── 屏蔽状态 ───────────────────────────────────────────────────────────────

/// 智能提醒屏蔽状态。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SmartReminderBlockState {
    /// 屏蔽的 app → 屏蔽时间戳。
    #[serde(default)]
    pub blocks: BTreeMap<String, u64>,
    /// 24h 忽略的 app → 到期时间戳。
    #[serde(default)]
    pub ignores: BTreeMap<String, u64>,
}

const BLOCK_KEY: &str = "goto_smart_reminder_blocks";
const STATE_KEY: &str = "goto_smart_reminder_state";

// ─── 推荐结果 ───────────────────────────────────────────────────────────────

/// 完整的预测结果（对应 JS `_smartReminderPredict` 返回值）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SmartReminderPrediction {
    /// 推荐目标 app。
    pub target: String,
    /// 置信度 [0, 1]。
    pub confidence: f64,
    /// 来源标签拼接（如 "chain:0.50|hourly:0.30"）。
    pub source: String,
}

// ─── 管理器 ─────────────────────────────────────────────────────────────────

/// 智能提醒管理器。
#[derive(Debug)]
pub struct SmartReminderManager<'a, S: Storage + ?Sized> {
    storage: &'a S,
}

impl<'a, S: Storage + ?Sized> SmartReminderManager<'a, S> {
    pub fn new(storage: &'a S) -> Self { Self { storage } }

    /// 读取屏蔽状态。
    pub fn get_block_state(&self) -> SmartReminderBlockState {
        self.storage.read_json(BLOCK_KEY, SmartReminderBlockState::default())
    }

    /// 写入屏蔽状态。
    pub fn save_block_state(&self, state: &SmartReminderBlockState) {
        self.storage.write_json(BLOCK_KEY, state);
    }

    /// `_isSmartReminderBlocked(target)`：屏蔽检查。
    pub fn is_blocked(&self, target: &str) -> bool {
        if target.is_empty() { return false; }
        let state = self.get_block_state();
        let now = now_ts();
        // 3 天内的否决目标不再主推
        if let Some(ts) = state.blocks.get(target) {
            if now.saturating_sub(*ts) < BLOCK_DURATION_MS {
                return true;
            }
        }
        // 24h 忽略检查
        if let Some(expire) = state.ignores.get(target) {
            if now < *expire {
                return true;
            }
        }
        false
    }

    /// 屏蔽某 app（点"否"时调用）。
    pub fn block(&self, target: &str) {
        let mut state = self.get_block_state();
        state.blocks.insert(target.to_string(), now_ts());
        self.save_block_state(&state);
    }

    /// 24 小时忽略某 app。
    pub fn ignore_24h(&self, target: &str) {
        let mut state = self.get_block_state();
        state.ignores.insert(target.to_string(), now_ts() + IGNORE_24H_MS);
        self.save_block_state(&state);
    }

    /// `_smartReminderPredict(fromApp)`：综合预测。
    ///
    /// 返回 `{ target, confidence, source }` 或 `None`。
    pub fn predict(&self, from_app: Option<&str>) -> Option<SmartReminderPrediction> {
        let mut candidates: BTreeMap<String, (f64, Vec<String>)> = BTreeMap::new();
        let mut active_weight_sum = 0.0f64;

        // ───── 信号 1：动作链转移概率（一阶马尔可夫） ─────
        let mut chain_available = false;
        let assoc = AssociationManager::new(self.storage);
        let edges = assoc.get_edges();

        if let Some(from) = from_app {
            // 场景 (b)：已知"刚启动的应用"，预测后继
            let next: Vec<&crate::types::ChainEdge> = edges.iter()
                .filter(|e| e.from == from && e.weight > 0.0)
                .collect();
            let total: f64 = next.iter().map(|e| e.weight).sum();
            if total > 0.0 && !next.is_empty() {
                chain_available = true;
                for e in &next {
                    let conf = e.weight / total;
                    let entry = candidates.entry(e.to.clone()).or_insert((0.0, Vec::new()));
                    entry.0 += WEIGHT_CHAIN * conf;
                    entry.1.push(alloc::format!("chain:{:.2}", conf));
                }
            }
        } else {
            // 场景 (a)：用户打开应用前，从全局转移矩阵中找最高置信度的边
            // 全局边置信度打折（因为不知道当前 fromApp），保留 0.4 系数
            let mut by_from: BTreeMap<String, Vec<&crate::types::ChainEdge>> = BTreeMap::new();
            for e in &edges {
                if e.weight > 0.0 {
                    by_from.entry(e.from.clone()).or_default().push(e);
                }
            }
            for (_from, group) in &by_from {
                let total: f64 = group.iter().map(|e| e.weight).sum();
                if total <= 0.0 { continue; }
                chain_available = true;
                for e in group {
                    let conf = e.weight / total;
                    let entry = candidates.entry(e.to.clone()).or_insert((0.0, Vec::new()));
                    entry.0 += WEIGHT_CHAIN * 0.4 * conf;
                    entry.1.push(alloc::format!("chain_global:{:.2}", conf));
                }
            }
        }
        if chain_available { active_weight_sum += WEIGHT_CHAIN; }

        // ───── 信号 2：当前小时高频应用 ─────
        let buckets: Vec<crate::types::HourBucket> =
            self.storage.read_json(StorageKeys::STATS_HOURLY_LAUNCH, Vec::new());
        if !buckets.is_empty() {
            let cur_hour = get_hour();
            let mut hour_freq: BTreeMap<String, u32> = BTreeMap::new();
            let mut hour_total = 0u32;
            for b in &buckets {
                let h = b.h.strip_prefix("h-").and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
                if h == cur_hour && !b.app.is_empty() {
                    *hour_freq.entry(b.app.clone()).or_insert(0) += b.count;
                    hour_total += b.count;
                }
            }
            if hour_total > 0 {
                for (app, freq) in &hour_freq {
                    let conf = (*freq as f64) / (hour_total as f64);
                    let entry = candidates.entry(app.clone()).or_insert((0.0, Vec::new()));
                    entry.0 += WEIGHT_HOURLY * conf;
                    entry.1.push(alloc::format!("hourly:{:.2}", conf));
                }
                active_weight_sum += WEIGHT_HOURLY;
            }
        }

        // ───── 信号 3：星期+小时联合分布（goto_app_stats[appId].hourly 历史聚合） ─────
        // 注：JS 端通过 Date 解析字符串形如 "YYYY-MM-DD-HH"。
        // Rust 端采用相同的字符串格式，但简化处理：在 stats 中存储该聚合。
        let app_stats: BTreeMap<String, crate::types::HourlyStatsAgg> =
            self.storage.read_json(StorageKeys::APP_STATS, BTreeMap::new());
        if !app_stats.is_empty() {
            let cur_dow = current_day_of_week();
            let cur_hour = get_hour();
            let mut dow_hour_freq: BTreeMap<String, u32> = BTreeMap::new();
            let mut dow_hour_total = 0u32;
            for (app, agg) in &app_stats {
                for (key, cnt) in &agg.hourly {
                    // key 形如 "YYYY-MM-DD-HH"，拆分后取 dow + hour
                    let parts: Vec<&str> = key.split('-').collect();
                    if parts.len() < 4 { continue; }
                    let hour = parts[3].parse::<u32>().unwrap_or(0);
                    if hour != cur_hour { continue; }
                    let date_str = alloc::format!("{}-{}-{}", parts[0], parts[1], parts[2]);
                    if let Some(dow) = parse_dow_from_ymd(&date_str) {
                        if dow == cur_dow {
                            *dow_hour_freq.entry(app.clone()).or_insert(0) += cnt;
                            dow_hour_total += cnt;
                        }
                    }
                }
            }
            if dow_hour_total > 0 {
                for (app, freq) in &dow_hour_freq {
                    let conf = (*freq as f64) / (dow_hour_total as f64);
                    let entry = candidates.entry(app.clone()).or_insert((0.0, Vec::new()));
                    entry.0 += WEIGHT_DOW_HOUR * conf;
                    entry.1.push(alloc::format!("dowHour:{:.2}", conf));
                }
                active_weight_sum += WEIGHT_DOW_HOUR;
            }
        }

        // ───── 信号 4：全局累计热度（goto_app_stats[appId].uses） ─────
        let mut hot_freq: BTreeMap<String, u32> = BTreeMap::new();
        let mut hot_total = 0u32;
        for (app, agg) in &app_stats {
            if agg.uses > 0 {
                hot_freq.insert(app.clone(), agg.uses);
                hot_total += agg.uses;
            }
        }
        if hot_total > 0 {
            for (app, freq) in &hot_freq {
                let conf = (*freq as f64) / (hot_total as f64);
                let entry = candidates.entry(app.clone()).or_insert((0.0, Vec::new()));
                entry.0 += WEIGHT_HOT * conf;
                entry.1.push(alloc::format!("hot:{:.2}", conf));
            }
            active_weight_sum += WEIGHT_HOT;
        }

        // ───── 融合：归一化得分 ─────
        if active_weight_sum == 0.0 { return None; }

        let mut best_app: Option<String> = None;
        let mut best_score = 0.0f64;
        let mut best_sources: Vec<String> = Vec::new();
        for (app, (score, sources)) in &candidates {
            if self.is_blocked(app) { continue; }
            let normalized = *score / active_weight_sum;
            if normalized > best_score {
                best_score = normalized;
                best_app = Some(app.clone());
                best_sources = sources.clone();
            }
        }

        let target = best_app?;
        let confidence = best_score.clamp(0.0, 1.0);
        Some(SmartReminderPrediction {
            target,
            confidence,
            source: best_sources.join("|"),
        })
    }

    /// `_smartReminderPredictTopN(n)`：返回 top N 推荐应用（用于问候卡片右侧横排展示）。
    ///
    /// 简化实现：基于全局热度 + 24h 频次融合，过滤被屏蔽项，取 top N。
    pub fn predict_top_n(&self, n: usize) -> Vec<SmartReminderSuggestion> {
        let n = if n == 0 { 2 } else { n };
        let stats: BTreeMap<String, crate::types::HourlyStatsAgg> =
            self.storage.read_json(StorageKeys::APP_STATS, BTreeMap::new());
        let buckets: Vec<crate::types::HourBucket> =
            self.storage.read_json(StorageKeys::STATS_HOURLY_LAUNCH, Vec::new());

        let cur_hour = get_hour();
        let mut scores: BTreeMap<String, f64> = BTreeMap::new();

        // 信号 1：全局热度
        for (app, agg) in &stats {
            if agg.uses > 0 {
                *scores.entry(app.clone()).or_insert(0.0) += (agg.uses as f64) * 0.4;
            }
        }

        // 信号 2：当前小时频次
        for b in &buckets {
            let h = b.h.strip_prefix("h-").and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
            if h == cur_hour && !b.app.is_empty() {
                *scores.entry(b.app.clone()).or_insert(0.0) += (b.count as f64) * 0.6;
            }
        }

        // 排序取 top N，过滤被屏蔽项
        let mut arr: Vec<(String, f64)> = scores.into_iter()
            .filter(|(app, _)| !self.is_blocked(app))
            .collect();
        arr.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(core::cmp::Ordering::Equal));
        arr.truncate(n);

        arr.into_iter().map(|(app, score)| SmartReminderSuggestion {
            app,
            score,
            reason: "智能推荐".to_string(),
            source: "topN".to_string(),
        }).collect()
    }

    /// `_smartReminderTryExpandAfterLaunch(appName)`：应用启动后预测下一个。
    ///
    /// 在 `recordSelection` / `recordAppLaunch` 时调用。
    /// 返回预测结果或 `None`。
    pub fn predict_after_launch(&self, app_name: &str) -> Option<SmartReminderPrediction> {
        if app_name.is_empty() { return None; }
        self.predict(Some(app_name))
    }

    /// 用户接受推荐（点"是"）：清空屏蔽，可选触发权重提升（由 weights 模块处理）。
    pub fn accept(&self, target: &str) {
        let mut state = self.get_block_state();
        state.blocks.remove(target);
        state.ignores.remove(target);
        self.save_block_state(&state);
    }

    /// 用户拒绝推荐（点"否"）：屏蔽 3 天。
    pub fn reject(&self, target: &str) {
        self.block(target);
    }

    /// 用户忽略（超时未点）：24 小时不再主推。
    pub fn ignore(&self, target: &str) {
        self.ignore_24h(target);
    }

    /// 读取上次推荐时间戳。
    pub fn get_last_shown_at(&self) -> u64 {
        let v: u64 = self.storage.read_json(STATE_KEY, 0u64);
        v
    }

    /// 写入上次推荐时间戳。
    pub fn set_last_shown_at(&self, ts: u64) {
        self.storage.write_json(STATE_KEY, &ts);
    }

    /// 是否应展示（5 分钟内同一目标不重复推荐）。
    pub fn should_show(&self) -> bool {
        let last = self.get_last_shown_at();
        if last == 0 { return true; }
        now_ts().saturating_sub(last) >= MIN_INTERVAL_MS
    }
}

// ─── 时间辅助 ───────────────────────────────────────────────────────────────

/// 当前星期（0=周日，1=周一...，与 JS `Date.getDay()` 一致）。
#[cfg(feature = "std")]
pub fn current_day_of_week() -> u32 {
    use chrono::{Datelike, Local};
    Local::now().weekday().num_days_from_sunday()
}

#[cfg(not(feature = "std"))]
pub fn current_day_of_week() -> u32 { 0 }

/// 从 "YYYY-MM-DD" 字符串解析星期（0=周日）。
#[cfg(feature = "std")]
pub fn parse_dow_from_ymd(s: &str) -> Option<u32> {
    use chrono::{Datelike, NaiveDate};
    let date = NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()?;
    Some(date.weekday().num_days_from_sunday())
}

#[cfg(not(feature = "std"))]
pub fn parse_dow_from_ymd(_s: &str) -> Option<u32> { None }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::MemoryStorage;
    use crate::types::{ChainEdge, ChainStore, HourBucket};

    #[test]
    fn test_predict_empty() {
        let s = MemoryStorage::new();
        let mgr = SmartReminderManager::new(&s);
        assert!(mgr.predict(None).is_none());
    }

    #[test]
    fn test_predict_with_chain() {
        let s = MemoryStorage::new();
        let store = ChainStore {
            edges: vec![
                ChainEdge { from: "微信".into(), to: "QQ".into(), weight: 5.0, count: 5, last_ts: 0 },
                ChainEdge { from: "微信".into(), to: "抖音".into(), weight: 1.0, count: 1, last_ts: 0 },
            ],
        };
        s.write_json(StorageKeys::CHAINS, &store);

        let mgr = SmartReminderManager::new(&s);
        let pred = mgr.predict(Some("微信")).expect("应有预测");
        assert_eq!(pred.target, "QQ");
        assert!(pred.confidence > 0.0);
    }

    #[test]
    fn test_block_unblock() {
        let s = MemoryStorage::new();
        let mgr = SmartReminderManager::new(&s);
        assert!(!mgr.is_blocked("微信"));
        mgr.block("微信");
        assert!(mgr.is_blocked("微信"));
        mgr.accept("微信");
        assert!(!mgr.is_blocked("微信"));
    }

    #[test]
    fn test_predict_top_n() {
        let s = MemoryStorage::new();
        let mut stats: BTreeMap<String, crate::types::HourlyStatsAgg> = BTreeMap::new();
        stats.insert("微信".into(), crate::types::HourlyStatsAgg { uses: 10, hourly: BTreeMap::new(), last_hour: BTreeMap::new(), history: Vec::new() });
        stats.insert("QQ".into(), crate::types::HourlyStatsAgg { uses: 5, hourly: BTreeMap::new(), last_hour: BTreeMap::new(), history: Vec::new() });
        s.write_json(StorageKeys::APP_STATS, &stats);

        let mgr = SmartReminderManager::new(&s);
        let top = mgr.predict_top_n(2);
        assert_eq!(top.len(), 2);
        assert_eq!(top[0].app, "微信");
    }

    #[test]
    fn test_ignore_24h() {
        let s = MemoryStorage::new();
        let mgr = SmartReminderManager::new(&s);
        mgr.ignore_24h("抖音");
        assert!(mgr.is_blocked("抖音"));
    }

    #[test]
    fn test_predict_after_launch() {
        let s = MemoryStorage::new();
        let store = ChainStore {
            edges: vec![
                ChainEdge { from: "A".into(), to: "B".into(), weight: 3.0, count: 3, last_ts: 0 },
            ],
        };
        s.write_json(StorageKeys::CHAINS, &store);

        let mgr = SmartReminderManager::new(&s);
        let pred = mgr.predict_after_launch("A").expect("应有预测");
        assert_eq!(pred.target, "B");
    }

    #[test]
    fn test_hourly_bucket_signal() {
        let s = MemoryStorage::new();
        let cur_hour = get_hour();
        let buckets = vec![
            HourBucket { h: alloc::format!("h-{}", cur_hour), app: "微信".into(), count: 3, ts: 0 },
            HourBucket { h: alloc::format!("h-{}", cur_hour), app: "QQ".into(), count: 1, ts: 0 },
        ];
        s.write_json(StorageKeys::STATS_HOURLY_LAUNCH, &buckets);

        let mgr = SmartReminderManager::new(&s);
        let pred = mgr.predict(None).expect("应有预测");
        assert_eq!(pred.target, "微信");
    }
}
