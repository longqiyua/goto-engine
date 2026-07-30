//! GOTO Engine · L4 梳理层 — 个人化重排（纯函数）
//!
//! 与 JS 版 `algorithms/rerank/personal-rerank.js` 和
//! Kotlin 版 `Rerank/PersonalReranker.kt` 对齐。
//!
//! 设计原则：
//!   - 纯函数：不读写 IO，不修改入参，返回新 Vec
//!   - 5 schema 融合：heatmap / hourly-ranking / transition-matrix / user-context / feedback-chain
//!   - 精确匹配保护：exact-match 永远排第一
//!   - 总帽保护：5 源 + affinity 总和上限 total_personal_boost_max
//!   - 降级模式：snapshot 为 None/degraded 时返回原序，applied=false
//!
//! v2.1 新增

use alloc::string::{String, ToString};
use alloc::string;
use alloc::vec;
use alloc::vec::Vec;
use alloc::collections::BTreeMap;
use core::f64;

#[cfg(feature = "std")]
use std::time::{SystemTime, UNIX_EPOCH};

/// 梳理层配置（与 JS / Kotlin 对齐）
#[derive(Debug, Clone, Copy)]
pub struct RerankConfig {
    pub heatmap_boost_max: f64,
    pub hourly_ranking_boost_max: f64,
    pub transition_boost_max: f64,
    pub geofence_boost_max: f64,
    pub feedback_boost_max: f64,
    pub total_personal_boost_max: f64,
    pub feedback_half_life_events: usize,
    pub heatmap_density_baseline: f64,
    pub transition_noise_floor: f64,
}

impl Default for RerankConfig {
    fn default() -> Self {
        Self {
            heatmap_boost_max: 0.15,
            hourly_ranking_boost_max: 0.20,
            transition_boost_max: 0.15,
            geofence_boost_max: 0.15,
            feedback_boost_max: 0.20,
            total_personal_boost_max: 0.50,
            feedback_half_life_events: 20,
            heatmap_density_baseline: 5.0,
            transition_noise_floor: 0.05,
        }
    }
}

/// 运行时上下文
#[derive(Debug, Clone, Default)]
pub struct RuntimeContext {
    pub hour: i32,         // 0-23
    pub weekday: i32,      // 0=周日 ... 6=周六
    pub geofence_id: String,
    pub foreground_package: String,
}

/// 个人层亲和度
#[derive(Debug, Clone, Default)]
pub struct Affinity {
    pub package_name: String,
    pub current_weight: f64,
    pub confidence: f64,
}

// ─── Base 个人层 schema 精简数据结构 ───

#[derive(Debug, Clone, Default)]
pub struct HeatmapData {
    pub cells: Vec<HeatmapCell>,
    pub last_updated: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HeatmapCell {
    pub hour: i32,
    pub weekday: i32,
    pub launch_count: i32,
    pub top_apps: Vec<HeatmapApp>,
}

#[derive(Debug, Clone)]
pub struct HeatmapApp {
    pub package_name: String,
    pub count: i32,
}

#[derive(Debug, Clone, Default)]
pub struct HourlyRankingData {
    pub hourly_ranking: BTreeMap<String, Vec<HourlyApp>>,
    pub smart_ranking: Option<SmartRanking>,
}

#[derive(Debug, Clone)]
pub struct HourlyApp {
    pub package_name: String,
    pub count: i32,
    pub recency_score: f64,
}

#[derive(Debug, Clone)]
pub struct SmartRanking {
    pub algorithm: String,
    pub top_candidates: Vec<SmartCandidate>,
}

#[derive(Debug, Clone)]
pub struct SmartCandidate {
    pub package_name: String,
    pub score: f64,
}

#[derive(Debug, Clone, Default)]
pub struct TransitionMatrixData {
    pub transitions: BTreeMap<String, Vec<TransitionEdge>>,
    pub last_updated: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TransitionEdge {
    pub to_package: String,
    pub probability: f64,
    pub last_occurred: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct UserContextData {
    pub preferred_apps: Vec<PreferredApp>,
    pub last_updated: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PreferredApp {
    pub geofence_id: String,
    pub package_name: String,
    pub weight: f64,
}

#[derive(Debug, Clone)]
pub struct FeedbackEvent {
    pub event_id: String,
    pub timestamp: String,
    pub query: String,
    pub clicked_package: String,
    pub clicked_rank: i32,   // 0-based; -1=手动启动
    pub match_mode: String,
    pub context: FeedbackContext,
}

#[derive(Debug, Clone, Default)]
pub struct FeedbackContext {
    pub hour: i32,
    pub weekday: i32,
    pub geofence_id: String,
    pub foreground_package: String,
}

/// Base 个人层快照
#[derive(Debug, Clone, Default)]
pub struct PersonalSnapshot {
    pub taken_at: u64,
    pub query: String,
    pub candidate_packages: Vec<String>,
    pub runtime_context: RuntimeContext,
    pub affinities: BTreeMap<String, Affinity>,
    pub heatmap: Option<HeatmapData>,
    pub hourly_ranking: Option<HourlyRankingData>,
    pub transition_matrix: Option<TransitionMatrixData>,
    pub user_context: Option<UserContextData>,
    pub recent_feedback: Vec<FeedbackEvent>,
    pub degraded: bool,
}

impl PersonalSnapshot {
    /// 降级快照
    pub fn degraded() -> Self {
        Self {
            degraded: true,
            ..Default::default()
        }
    }
}

/// 重排结果
#[derive(Debug, Clone)]
pub struct RerankResult<T> {
    pub list: Vec<T>,
    pub scores: BTreeMap<String, f64>,
    pub mode_map: BTreeMap<String, String>,
    pub explanation: BTreeMap<String, String>,
    pub degraded: bool,
    pub applied: bool,
}

impl<T> RerankResult<T> {
    /// 降级结果：原样返回
    pub fn degraded(list: Vec<T>) -> Self {
        Self {
            list,
            scores: BTreeMap::new(),
            mode_map: BTreeMap::new(),
            explanation: BTreeMap::new(),
            degraded: true,
            applied: false,
        }
    }
}

/// 候选项 trait：梳理层通过此 trait 抽象访问候选应用的 packageName/name/score
pub trait RerankCandidate {
    fn package_name(&self) -> &str;
    fn name(&self) -> &str;
    fn score(&self) -> f64;
}

/// 梳理层重排器（纯函数）
pub struct PersonalReranker;

impl PersonalReranker {
    /// 应用 L4 梳理层重排。
    ///
    /// - `query`：归一化查询
    /// - `engine_results`：Engine 候选（L1/L2/L3 输出）
    /// - `snapshot`：Base 个人层快照
    /// - `config`：配置
    pub fn rerank<C: RerankCandidate + Clone>(
        query: &str,
        engine_results: Vec<C>,
        snapshot: Option<&PersonalSnapshot>,
        config: RerankConfig,
    ) -> RerankResult<C> {
        // 降级检查
        match snapshot {
            None => return RerankResult::degraded(engine_results),
            Some(s) if s.degraded => return RerankResult::degraded(engine_results),
            Some(s) if engine_results.is_empty() => return RerankResult::degraded(engine_results),
            _ => {}
        }
        let snap = snapshot.unwrap();

        let q_lower = query.to_lowercase();
        let q_trimmed = q_lower.trim();

        // 步骤 1: 计算每个候选的 finalScore 和 boost
        struct Enriched<C: Clone> {
            original: C,
            package_name: String,
            engine_score: f64,
            personal_boost: f64,
            final_score: f64,
            is_exact_match: bool,
            boost_sources: Vec<String>,
        }

        let mut enriched: Vec<Enriched<C>> = engine_results
            .iter()
            .map(|r| {
                let pkg = string::String::from(r.package_name());
                let name = r.name();
                let engine_score = r.score();
                let is_exact = !q_trimmed.is_empty() && name.to_lowercase().trim() == q_trimmed;

                let mut boosts: Vec<String> = Vec::new();
                let mut total = 0.0_f64;

                let b1 = heatmap_boost(&pkg, snap, &config);
                if b1 > 0.0 { boosts.push(format!("heatmap={}", round4(b1))); total += b1; }

                let b2 = hourly_ranking_boost(&pkg, snap, &config);
                if b2 > 0.0 { boosts.push(format!("hourly={}", round4(b2))); total += b2; }

                let b3 = transition_boost(&pkg, snap, &config);
                if b3 > 0.0 { boosts.push(format!("transition={}", round4(b3))); total += b3; }

                let b4 = geofence_boost(&pkg, snap, &config);
                if b4 > 0.0 { boosts.push(format!("geofence={}", round4(b4))); total += b4; }

                let b5 = feedback_boost(&pkg, &q_lower, snap, &config);
                if b5 > 0.0 { boosts.push(format!("feedback={}", round4(b5))); total += b5; }

                let capped = clamp_num(total, 0.0, config.total_personal_boost_max);
                Enriched {
                    original: r.clone(),
                    package_name: pkg,
                    engine_score,
                    personal_boost: round4(capped),
                    final_score: round4(engine_score + capped),
                    is_exact_match: is_exact,
                    boost_sources: boosts,
                }
            })
            .collect();

        // 步骤 2: 排序 — 精确匹配优先，否则 finalScore 降序（稳定排序）
        enriched.sort_by(|a, b| {
            // exact-match 优先
            match (a.is_exact_match, b.is_exact_match) {
                (true, false) => return core::cmp::Ordering::Less,
                (false, true) => return core::cmp::Ordering::Greater,
                _ => {}
            }
            // finalScore 降序
            b.final_score.partial_cmp(&a.final_score)
                .unwrap_or(core::cmp::Ordering::Equal)
        });

        // 步骤 3: 构造结果
        let mut list: Vec<C> = Vec::with_capacity(enriched.len());
        let mut scores: BTreeMap<String, f64> = BTreeMap::new();
        let mut mode_map: BTreeMap<String, String> = BTreeMap::new();
        let mut explanation: BTreeMap<String, String> = BTreeMap::new();

        for e in enriched {
            let mode = if e.is_exact_match {
                string::String::from("exact-match")
            } else if !e.boost_sources.is_empty() {
                string::String::from("个人重排")
            } else {
                string::String::from("engine-only")
            };
            if !e.boost_sources.is_empty() {
                explanation.insert(e.package_name.clone(), e.boost_sources.join("; "));
            }
            scores.insert(e.package_name.clone(), e.final_score);
            mode_map.insert(e.package_name.clone(), mode);
            list.push(e.original);
        }

        RerankResult {
            list,
            scores,
            mode_map,
            explanation,
            degraded: false,
            applied: true,
        }
    }
}

// ============================================================
// Boost 1 — Heatmap
// ============================================================
fn heatmap_boost(pkg: &str, snap: &PersonalSnapshot, cfg: &RerankConfig) -> f64 {
    let heatmap = match &snap.heatmap { Some(h) => h, None => return 0.0 };
    let hour = snap.runtime_context.hour;
    let weekday = snap.runtime_context.weekday;
    let cell = heatmap.cells.iter().find(|c| c.hour == hour && c.weekday == weekday);
    let cell = match cell { Some(c) => c, None => return 0.0 };
    if cell.launch_count <= 0 { return 0.0; }
    let pkg_count = cell.top_apps.iter().find(|a| a.package_name == pkg).map(|a| a.count).unwrap_or(0);
    if pkg_count <= 0 { return 0.0; }
    let density = pkg_count as f64 / cfg.heatmap_density_baseline.max(cell.launch_count as f64);
    clamp_num(density, 0.0, 1.0) * cfg.heatmap_boost_max
}

// ============================================================
// Boost 2 — Hourly Ranking
// ============================================================
fn hourly_ranking_boost(pkg: &str, snap: &PersonalSnapshot, cfg: &RerankConfig) -> f64 {
    let hr = match &snap.hourly_ranking { Some(h) => h, None => return 0.0 };
    let hour = snap.runtime_context.hour;

    // 1) per-hour ranking
    if let Some(list) = hr.hourly_ranking.get(&hour.to_string()) {
        if let Some(e) = list.iter().find(|a| a.package_name == pkg) {
            let freq = clamp_num(e.count as f64 / 10.0, 0.0, 1.0);
            let rec = clamp_num(e.recency_score, 0.0, 1.0);
            return clamp_num(freq * 0.5 + rec * 0.5, 0.0, 1.0) * cfg.hourly_ranking_boost_max;
        }
    }

    // 2) smartRanking fallback
    if let Some(smart) = &hr.smart_ranking {
        let top = &smart.top_candidates;
        if let Some(idx) = top.iter().position(|c| c.package_name == pkg) {
            let pos_factor = clamp_num(1.0 - idx as f64 / top.len().max(1) as f64, 0.0, 1.0);
            let norm = clamp_num(top[idx].score / 10.0, 0.0, 1.0);
            return clamp_num(pos_factor * 0.6 + norm * 0.4, 0.0, 1.0) * cfg.hourly_ranking_boost_max;
        }
    }
    0.0
}

// ============================================================
// Boost 3 — Transition Matrix
// ============================================================
fn transition_boost(pkg: &str, snap: &PersonalSnapshot, cfg: &RerankConfig) -> f64 {
    let tm = match &snap.transition_matrix { Some(t) => t, None => return 0.0 };
    let from = &snap.runtime_context.foreground_package;
    if from.is_empty() { return 0.0; }
    let list = match tm.transitions.get(from) { Some(l) => l, None => return 0.0 };
    let edge = match list.iter().find(|e| e.to_package == pkg) { Some(e) => e, None => return 0.0 };
    if edge.probability < cfg.transition_noise_floor { return 0.0; }
    let mut rec_factor = 1.0;
    if let Some(ts) = &edge.last_occurred {
        if let Some(last_occ) = parse_iso_time(ts) {
            #[cfg(feature = "std")]
            {
                let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
                let days_since = (now.saturating_sub(last_occ)) as f64 / (24.0 * 60.0 * 60.0 * 1000.0);
                rec_factor = clamp_num(0.5_f64.powf(days_since / 30.0), 0.0, 1.0);
            }
            #[cfg(not(feature = "std"))]
            { let _ = last_occ; }
        }
    }
    clamp_num(edge.probability * rec_factor, 0.0, 1.0) * cfg.transition_boost_max
}

// ============================================================
// Boost 4 — Geofence / User Context
// ============================================================
fn geofence_boost(pkg: &str, snap: &PersonalSnapshot, cfg: &RerankConfig) -> f64 {
    let uc = match &snap.user_context { Some(u) => u, None => return 0.0 };
    let geo_id = &snap.runtime_context.geofence_id;
    if geo_id.is_empty() { return 0.0; }
    let pref = uc.preferred_apps.iter().find(|p| p.geofence_id == *geo_id && p.package_name == pkg);
    match pref {
        Some(p) => clamp_num(p.weight, 0.0, 1.0) * cfg.geofence_boost_max,
        None => 0.0,
    }
}

// ============================================================
// Boost 5 — Feedback Chain
// ============================================================
fn feedback_boost(pkg: &str, query: &str, snap: &PersonalSnapshot, cfg: &RerankConfig) -> f64 {
    let events = &snap.recent_feedback;
    if events.is_empty() { return 0.0; }
    let half_life = cfg.feedback_half_life_events.max(1) as f64;
    let mut boost = 0.0_f64;
    for (i, e) in events.iter().enumerate() {
        if e.clicked_package != pkg { continue; }
        if !query.is_empty() && !e.query.is_empty() && e.query.to_lowercase() != query {
            continue;
        }
        let factor = 0.5_f64.powf(i as f64 / half_life);
        let rank_bonus = match e.clicked_rank {
            -1 => 1.2,
            0 => 1.0,
            _ if e.clicked_rank > 0 => 0.7,
            _ => 1.0,
        };
        boost += factor * rank_bonus;
    }
    clamp_num(boost / 3.0, 0.0, 1.0) * cfg.feedback_boost_max
}

// ============================================================
// 工具函数
// ============================================================
fn clamp_num(v: f64, lo: f64, hi: f64) -> f64 {
    if v.is_nan() { return lo; }
    v.max(lo).min(hi)
}

fn round4(v: f64) -> f64 {
    if v.is_nan() { return 0.0; }
    (v * 10000.0).round() / 10000.0
}

#[cfg(feature = "std")]
fn parse_iso_time(iso: &str) -> Option<u64> {
    // 简化版 ISO 8601 解析：尝试解析 "yyyy-MM-dd'T'HH:mm:ss" 前缀
    // 完整实现依赖 chrono，此处仅做粗略解析
    if iso.len() < 19 { return None; }
    let bytes = iso.as_bytes();
    let parse = |start: usize, len: usize| -> Option<u64> {
        core::str::from_utf8(&bytes[start..start+len]).ok()?.parse::<u64>().ok()
    };
    let y = parse(0, 4)?;
    let mo = parse(5, 2)?;
    let d = parse(8, 2)?;
    let h = parse(11, 2)?;
    let mi = parse(14, 2)?;
    let s = parse(17, 2)?;
    // 粗略时间戳（非精确，仅用于衰减计算）
    let days = (y - 1970) * 365 + (mo - 1) * 30 + (d - 1);
    Some(((days * 24 + h) * 60 + mi) * 60 + s)
}

#[cfg(not(feature = "std"))]
fn parse_iso_time(_iso: &str) -> Option<u64> { None }

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct DummyCandidate {
        pkg: String,
        name: String,
        score: f64,
    }
    impl RerankCandidate for DummyCandidate {
        fn package_name(&self) -> &str { &self.pkg }
        fn name(&self) -> &str { &self.name }
        fn score(&self) -> f64 { self.score }
    }

    #[test]
    fn test_degraded_no_snapshot() {
        let results = vec![DummyCandidate { pkg: "com.a".into(), name: "A".into(), score: 80.0 }];
        let r = PersonalReranker::rerank("a", results.clone(), None, RerankConfig::default());
        assert!(r.degraded);
        assert!(!r.applied);
        assert_eq!(r.list.len(), 1);
    }

    #[test]
    fn test_degraded_snapshot_degraded() {
        let results = vec![DummyCandidate { pkg: "com.a".into(), name: "A".into(), score: 80.0 }];
        let snap = PersonalSnapshot::degraded();
        let r = PersonalReranker::rerank("a", results.clone(), Some(&snap), RerankConfig::default());
        assert!(r.degraded);
    }

    #[test]
    fn test_normal_rerank_exact_match_protection() {
        let results = vec![
            DummyCandidate { pkg: "com.b".into(), name: "B".into(), score: 100.0 },
            DummyCandidate { pkg: "com.a".into(), name: "wx".into(), score: 80.0 },
        ];
        let snap = PersonalSnapshot {
            taken_at: 1,
            query: "wx".into(),
            candidate_packages: vec!["com.a".into()],
            runtime_context: RuntimeContext { hour: 9, weekday: 1, ..Default::default() },
            affinities: BTreeMap::new(),
            heatmap: Some(HeatmapData {
                cells: vec![HeatmapCell {
                    hour: 9, weekday: 1, launch_count: 10,
                    top_apps: vec![HeatmapApp { package_name: "com.a".into(), count: 8 }],
                }],
                last_updated: None,
            }),
            hourly_ranking: None,
            transition_matrix: None,
            user_context: None,
            recent_feedback: Vec::new(),
            degraded: false,
        };
        let r = PersonalReranker::rerank("wx", results, Some(&snap), RerankConfig::default());
        assert!(r.applied);
        assert!(!r.degraded);
        // exact-match 的 com.a 应排第一（即使分数低于 com.b）
        assert_eq!(r.list[0].package_name(), "com.a");
    }
}
