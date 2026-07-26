//! 统计层（对应 `goto-engine.js` `getHourlyStats` / `getFullTimeStats` /
//! `getCurrentHourStats` / `getQuickBubbles` + Top N 推荐 + 热力分）。
//!
//! 数据来源：`goto_stats_hourly_launch`（小时级启动记录） +
//! `goto_simint_stats`（app 总使用次数）。

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use alloc::collections::BTreeMap;

use crate::constants::StorageKeys;
use crate::storage::Storage;
use crate::types::{HourBucket, HourlyStats, QuickBubble};
use crate::utils::{get_hour, get_hour_bucket, now_ts};

/// 统计管理器。
#[derive(Debug)]
pub struct StatsManager<'a, S: Storage + ?Sized> {
    storage: &'a S,
}

impl<'a, S: Storage + ?Sized> StatsManager<'a, S> {
    pub fn new(storage: &'a S) -> Self { Self { storage } }

    /// 获取小时级启动记录。
    pub fn get_hour_buckets(&self) -> Vec<HourBucket> {
        self.storage.read_json(StorageKeys::STATS_HOURLY_LAUNCH, Vec::new())
    }

    /// 获取 app 总使用次数。
    pub fn get_app_stats(&self) -> BTreeMap<String, u32> {
        self.storage.read_json(StorageKeys::STATS, BTreeMap::new())
    }

    /// `getHourlyStats(opts)`：四时段统计（morning/afternoon/evening/night）。
    ///
    /// 对应 JS `goto-engine.js` L3074-3132。
    pub fn get_hourly_stats(&self, top_n: usize) -> HourlyStats {
        let buckets = self.get_hour_buckets();
        let mut morning: BTreeMap<String, u32> = BTreeMap::new();
        let mut afternoon: BTreeMap<String, u32> = BTreeMap::new();
        let mut evening: BTreeMap<String, u32> = BTreeMap::new();
        let mut night: BTreeMap<String, u32> = BTreeMap::new();

        for b in &buckets {
            let hour = b.h.strip_prefix("h-").and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
            let bucket = get_hour_bucket(Some(hour));
            let target = match bucket {
                "morning" => &mut morning,
                "afternoon" => &mut afternoon,
                "evening" => &mut evening,
                _ => &mut night,
            };
            *target.entry(b.app.clone()).or_insert(0) += b.count;
        }

        HourlyStats {
            morning: sort_top_n(&morning, top_n),
            afternoon: sort_top_n(&afternoon, top_n),
            evening: sort_top_n(&evening, top_n),
            night: sort_top_n(&night, top_n),
        }
    }

    /// `getCurrentHourStats()`：当前时段的 Top N app。
    pub fn get_current_hour_stats(&self, top_n: usize) -> Vec<(String, u32)> {
        let now_hour = get_hour();
        let bucket = get_hour_bucket(Some(now_hour));
        let all = self.get_hourly_stats(top_n);
        match bucket {
            "morning" => all.morning.clone(),
            "afternoon" => all.afternoon.clone(),
            "evening" => all.evening.clone(),
            _ => all.night.clone(),
        }
    }

    /// `getFullTimeStats()`：24 小时 × app 的完整统计矩阵。
    pub fn get_full_time_stats(&self) -> Vec<Vec<u32>> {
        let buckets = self.get_hour_buckets();
        let apps: Vec<String> = buckets.iter().map(|b| b.app.clone()).collect::<Vec<_>>()
            .into_iter().collect::<BTreeSet<_>>().into_iter().collect();
        let mut matrix = vec![vec![0u32; 24]; apps.len()];
        for b in &buckets {
            let hour = b.h.strip_prefix("h-").and_then(|s| s.parse::<usize>().ok()).unwrap_or(0);
            if let Some(row) = apps.iter().position(|a| *a == b.app) {
                if hour < 24 {
                    matrix[row][hour] += b.count;
                }
            }
        }
        matrix
    }

    /// `getQuickBubbles()`：快捷气泡推荐。
    ///
    /// 融合信号：
    ///   1. 当前时段 Top N（权重 0.5）
    ///   2. 全局 Top N（权重 0.3）
    ///   3. 最近使用（权重 0.2）
    pub fn get_quick_bubbles(&self, top_n: usize) -> Vec<QuickBubble> {
        let mut scores: BTreeMap<String, f64> = BTreeMap::new();

        // 1. 当前时段
        for (app, count) in self.get_current_hour_stats(top_n) {
            *scores.entry(app).or_insert(0.0) += (count as f64) * 0.5;
        }

        // 2. 全局
        let app_stats = self.get_app_stats();
        let mut global: Vec<(String, u32)> = app_stats.into_iter().collect();
        global.sort_by(|a, b| b.1.cmp(&a.1));
        for (i, (app, count)) in global.iter().take(top_n).enumerate() {
            let weight = (top_n - i) as f64 * 0.3 / top_n as f64;
            *scores.entry(app.clone()).or_insert(0.0) += (*count as f64) * weight;
        }

        // 3. 最近使用（从 hour_buckets 取最近 5 条）
        let buckets = self.get_hour_buckets();
        let recent: Vec<String> = buckets.iter().rev().take(5).map(|b| b.app.clone()).collect();
        for (i, app) in recent.iter().enumerate() {
            let weight = (5 - i) as f64 * 0.2 / 5.0;
            *scores.entry(app.clone()).or_insert(0.0) += weight;
        }

        let mut result: Vec<QuickBubble> = scores.into_iter()
            .map(|(app, score)| QuickBubble {
                app,
                score,
                label: String::new(),
            })
            .collect();
        result.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(core::cmp::Ordering::Equal));
        result.truncate(top_n);
        result
    }

    /// Top N 推荐（用于智能提醒 + 问候卡片右侧横排展示）。
    ///
    /// 融合信号：
    ///   1. 全局热度（权重 0.4）
    ///   2. 当前小时频次（权重 0.6）
    pub fn top_n_recommendations(&self, n: usize) -> Vec<(String, f64)> {
        let app_stats = self.get_app_stats();
        let buckets = self.get_hour_buckets();
        let cur_hour = get_hour();

        let mut scores: BTreeMap<String, f64> = BTreeMap::new();

        // 1. 全局热度
        for (app, count) in &app_stats {
            *scores.entry(app.clone()).or_insert(0.0) += (*count as f64) * 0.4;
        }

        // 2. 当前小时频次
        for b in &buckets {
            let h = b.h.strip_prefix("h-").and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
            if h == cur_hour {
                *scores.entry(b.app.clone()).or_insert(0.0) += (b.count as f64) * 0.6;
            }
        }

        let mut result: Vec<(String, f64)> = scores.into_iter().collect();
        result.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(core::cmp::Ordering::Equal));
        result.truncate(n);
        result
    }

    /// 热力分（GitHub-style 6 级：0-5）。
    ///
    /// `count == 0` → 0
    /// `count == 1` → 1
    /// `count <= 3` → 2
    /// `count <= 6` → 3
    /// `count <= 10` → 4
    /// `count > 10` → 5
    pub fn heat_level(count: u32) -> u8 {
        match count {
            0 => 0,
            1 => 1,
            2..=3 => 2,
            4..=6 => 3,
            7..=10 => 4,
            _ => 5,
        }
    }

    /// 生成热力图数据（按天 × app）。
    pub fn heatmap_data(&self, days: usize) -> Vec<Vec<(String, u32, u8)>> {
        let buckets = self.get_hour_buckets();
        let now = now_ts();
        let day_ms = 86_400_000u64;
        let mut result: Vec<Vec<(String, u32, u8)>> = Vec::with_capacity(days);

        for d in 0..days {
            let day_start = now - (d as u64) * day_ms;
            let day_end = day_start + day_ms;
            let mut day_apps: BTreeMap<String, u32> = BTreeMap::new();
            for b in &buckets {
                if b.ts >= day_start && b.ts < day_end {
                    *day_apps.entry(b.app.clone()).or_insert(0) += b.count;
                }
            }
            let day_vec: Vec<(String, u32, u8)> = day_apps.into_iter()
                .map(|(app, count)| (app, count, Self::heat_level(count)))
                .collect();
            result.push(day_vec);
        }
        result
    }
}

fn sort_top_n(map: &BTreeMap<String, u32>, top_n: usize) -> Vec<(String, u32)> {
    let mut v: Vec<(String, u32)> = map.iter().map(|(k, v)| (k.clone(), *v)).collect();
    v.sort_by(|a, b| b.1.cmp(&a.1));
    v.truncate(top_n);
    v
}

// 引入 BTreeSet 用于 get_full_time_stats
use alloc::collections::BTreeSet;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::MemoryStorage;
    use crate::types::HourBucket;

    #[test]
    fn test_hourly_stats() {
        let s = MemoryStorage::new();
        let buckets = vec![
            HourBucket { h: "h-9".into(), app: "微信".into(), count: 1, ts: 0 },
            HourBucket { h: "h-9".into(), app: "微信".into(), count: 1, ts: 0 },
            HourBucket { h: "h-14".into(), app: "QQ".into(), count: 1, ts: 0 },
        ];
        s.write_json(StorageKeys::STATS_HOURLY_LAUNCH, &buckets);

        let mgr = StatsManager::new(&s);
        let stats = mgr.get_hourly_stats(5);
        assert!(stats.morning.iter().any(|(a, _)| a == "微信"));
        assert!(stats.afternoon.iter().any(|(a, _)| a == "QQ"));
    }

    #[test]
    fn test_heat_level() {
        assert_eq!(StatsManager::<crate::storage::MemoryStorage>::heat_level(0), 0);
        assert_eq!(StatsManager::<crate::storage::MemoryStorage>::heat_level(1), 1);
        assert_eq!(StatsManager::<crate::storage::MemoryStorage>::heat_level(3), 2);
        assert_eq!(StatsManager::<crate::storage::MemoryStorage>::heat_level(5), 3);
        assert_eq!(StatsManager::<crate::storage::MemoryStorage>::heat_level(8), 4);
        assert_eq!(StatsManager::<crate::storage::MemoryStorage>::heat_level(20), 5);
    }

    #[test]
    fn test_top_n_recommendations() {
        let s = MemoryStorage::new();
        let buckets = vec![
            HourBucket { h: "h-9".into(), app: "微信".into(), count: 1, ts: 0 },
        ];
        s.write_json(StorageKeys::STATS_HOURLY_LAUNCH, &buckets);
        let mut stats: BTreeMap<String, u32> = BTreeMap::new();
        stats.insert("微信".into(), 5);
        s.write_json(StorageKeys::STATS, &stats);

        let mgr = StatsManager::new(&s);
        let r = mgr.top_n_recommendations(3);
        assert!(!r.is_empty());
    }
}
