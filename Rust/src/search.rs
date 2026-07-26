//! 搜索层（对应 `goto-engine.js` `fuzzySearch` / `metaSearch` / `runSearchPipeline`）。
//!
//! 三阶优先级：
//!   1. **fuzzySearch**：首字母 / T9 / 前缀 / 单字 / 邻位交换 / 全名乱序
//!   2. **metaSearch**：基于 catalog 关键词的语义匹配
//!   3. **tfidfSearch** + **trieSearch**：第三优先级

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use alloc::collections::BTreeMap;

use crate::constants::{GAUSS_KEY_FACTOR_SIGMA, GAUSS_KEYBOARD_SCORE_SIGMA};
use crate::filter::sanitize_query_opt;
use crate::index::{InvertedIndex, MetaIndex, TfidfIndex, TrieIndex};
use crate::intent::{extract_tokens, primary_intent, TokenizedQuery};
use crate::types::{
    AppItem, MatchType, SearchContext, SearchHit, SearchMode, SearchSource,
};
use crate::utils::{
    adjacent_swap_match, clamp, fullname_disorder_match, gaussian, now_ts,
};

/// 搜索引擎配置（用于 `fuzzy_search` 的 boost 参数）。
#[derive(Debug, Clone)]
pub struct SearchConfig {
    /// 时间衰减半衰期（天）。
    pub temporal_half_life_days: f64,
    /// 上下文 boost（最近使用的 app）。
    pub context_boost: f64,
    /// PRO 模式 boost。
    pub pro_boost: f64,
    /// 启动次数 boost 上限。
    pub launch_count_boost_max: f64,
    /// 已安装应用 boost。
    pub installed_boost: f64,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            temporal_half_life_days: 30.0,
            context_boost: 30.0,
            pro_boost: 50.0,
            launch_count_boost_max: 80.0,
            installed_boost: 60.0,
        }
    }
}

/// 搜索所需的索引集合。
#[derive(Debug, Clone, Default)]
pub struct SearchIndexes {
    pub inverted: InvertedIndex,
    pub meta: MetaIndex,
    pub tfidf: TfidfIndex,
    pub trie: TrieIndex,
}

/// `fuzzySearch(query, apps)`：第一优先级模糊匹配。
///
/// 对应 JS `goto-engine.js` L1703-2075。
pub fn fuzzy_search(
    query: &str,
    apps: &[AppItem],
    indexes: &SearchIndexes,
    config: &SearchConfig,
    weights: &[(String, Vec<(String, f64)>)],
    rule_ts: &[(String, u64)],
) -> Vec<SearchHit> {
    let q = match sanitize_query_opt(query) {
        Some(s) => s.to_lowercase(),
        None => return Vec::new(),
    };
    let q_lower = q.to_lowercase();
    let mut hits: BTreeMap<String, SearchHit> = BTreeMap::new();

    // 应用名 → AppItem 映射
    let app_map: BTreeMap<String, &AppItem> = apps.iter().map(|a| (a.name.clone(), a)).collect();

    // ─── 1. 首字母匹配 ──────────────────────────────────────────────────
    for app_name in indexes.inverted.lookup_initial(&q_lower) {
        let score = MatchType::Initial.base_score();
        let hit = SearchHit::new(app_name, score, MatchType::Initial, SearchSource::Fuzzy, "abbr");
        hits.insert(app_name.to_string(), hit);
    }

    // ─── 2. T9 匹配 ─────────────────────────────────────────────────────
    for app_name in indexes.inverted.lookup_t9(&q_lower) {
        let base = MatchType::T9.base_score();
        let hit = hits.get(app_name).map(|h| {
            let mut nh = h.clone();
            if base > nh.score {
                nh.score = base;
                nh.match_type = MatchType::T9;
            }
            nh
        }).unwrap_or_else(|| SearchHit::new(app_name, base, MatchType::T9, SearchSource::Fuzzy, "t9"));
        hits.insert(app_name.to_string(), hit);
    }

    // ─── 3. 前缀匹配 ────────────────────────────────────────────────────
    for app_name in indexes.inverted.lookup_prefix(&q_lower) {
        let base = MatchType::Prefix.base_score();
        let hit = hits.get(app_name).map(|h| {
            let mut nh = h.clone();
            if base > nh.score {
                nh.score = base;
                nh.match_type = MatchType::Prefix;
            }
            nh
        }).unwrap_or_else(|| SearchHit::new(app_name, base, MatchType::Prefix, SearchSource::Fuzzy, "prefix"));
        hits.insert(app_name.to_string(), hit);
    }

    // ─── 4. 单字匹配 ────────────────────────────────────────────────────
    for c in q.chars() {
        let key = c.to_string();
        for app_name in indexes.inverted.lookup_char(&key) {
            let base = MatchType::Char.base_score();
            let hit = hits.get(app_name).map(|h| {
                let mut nh = h.clone();
                if base > nh.score {
                    nh.score = base;
                    nh.match_type = MatchType::Char;
                    nh.field = "char".into();
                }
                nh
            }).unwrap_or_else(|| SearchHit::new(app_name, base, MatchType::Char, SearchSource::Fuzzy, "char"));
            hits.insert(app_name.to_string(), hit);
        }
    }

    // ─── 5. 邻位交换匹配 ────────────────────────────────────────────────
    for app in apps {
        for field in app.search_fields() {
            if adjacent_swap_match(&q, field) {
                let base = MatchType::AdjacentSwap.base_score();
                let hit = hits.get(&app.name).map(|h| {
                    let mut nh = h.clone();
                    if base > nh.score {
                        nh.score = base;
                        nh.match_type = MatchType::AdjacentSwap;
                    }
                    nh
                }).unwrap_or_else(|| SearchHit::new(&app.name, base, MatchType::AdjacentSwap, SearchSource::Fuzzy, field));
                hits.insert(app.name.clone(), hit);
                break;
            }
        }
    }

    // ─── 6. 全名乱序匹配 ────────────────────────────────────────────────
    for app in apps {
        for field in app.search_fields() {
            if fullname_disorder_match(&q, field) {
                let base = MatchType::Disorder.base_score();
                let hit = hits.get(&app.name).map(|h| {
                    let mut nh = h.clone();
                    if base > nh.score {
                        nh.score = base;
                        nh.match_type = MatchType::Disorder;
                    }
                    nh
                }).unwrap_or_else(|| SearchHit::new(&app.name, base, MatchType::Disorder, SearchSource::Fuzzy, field));
                hits.insert(app.name.clone(), hit);
                break;
            }
        }
    }

    // ─── 7. Trie 前缀匹配 ───────────────────────────────────────────────
    for app_name in indexes.trie.search_prefix(&q_lower) {
        let base = MatchType::Trie.base_score();
        let hit = hits.get(&app_name).map(|h| {
            let mut nh = h.clone();
            if base > nh.score {
                nh.score = base;
                nh.match_type = MatchType::Trie;
            }
            nh
        }).unwrap_or_else(|| SearchHit::new(&app_name, base, MatchType::Trie, SearchSource::Trie, "trie"));
        hits.insert(app_name, hit);
    }

    // ─── 8. 应用 boost ──────────────────────────────────────────────────
    let now = now_ts();
    let day_ms = 86_400_000u64;
    let half_life_ms = (config.temporal_half_life_days * day_ms as f64) as u64;

    for (app_name, hit) in hits.iter_mut() {
        // 8.1 权重 boost（来自 recordSelection 累积）
        if let Some(weight_list) = weights.iter().find(|(q, _)| q == &q_lower).map(|(_, w)| w) {
            if let Some(w) = weight_list.iter().find(|(a, _)| a == app_name).map(|(_, s)| *s) {
                hit.score += w;
            }
        }

        // 8.2 时间衰减（基于最后点击时间）
        if let Some(ts) = rule_ts.iter().find(|(q, _)| q == &q_lower).map(|(_, t)| *t) {
            if ts > 0 && now > ts {
                let age_ms = now - ts;
                let decay = 0.5_f64.powf(age_ms as f64 / half_life_ms as f64);
                hit.score *= decay.max(0.35);
            }
        }

        // 8.3 启动次数 boost
        if let Some(app) = app_map.get(app_name) {
            let launch_boost = (app.launch_count as f64 * 2.0).min(config.launch_count_boost_max);
            hit.score += launch_boost;
            hit.launch_count = app.launch_count;

            // 8.4 已安装 boost
            if app.installed {
                hit.score += config.installed_boost;
                hit.installed = true;
            }
        }

        // 8.5 附加 AppItem 快照
        if let Some(app) = app_map.get(app_name) {
            hit.app_item = Some((*app).clone());
        }
    }

    let mut list: Vec<SearchHit> = hits.into_values().collect();
    list.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(core::cmp::Ordering::Equal));
    list
}

/// `metaSearch(query)`：第二优先级元标签匹配。
///
/// 对应 JS `goto-engine.js` L2077-2319。
pub fn meta_search(
    query: &str,
    apps: &[AppItem],
    indexes: &SearchIndexes,
) -> (Vec<SearchHit>, Vec<SearchHit>) {
    let q = match sanitize_query_opt(query) {
        Some(s) => s,
        None => return (Vec::new(), Vec::new()),
    };
    let tq = extract_tokens(&q);
    let intent = primary_intent(&tq);

    // intent → app 推荐
    let mut boost_hits: Vec<SearchHit> = Vec::new();
    let mut extra_hits: Vec<SearchHit> = Vec::new();

    let app_map: BTreeMap<String, &AppItem> = apps.iter().map(|a| (a.name.clone(), a)).collect();

    // 1. 关键词 → app
    for c in q.chars() {
        let key = c.to_string();
        for app_name in indexes.meta.lookup(&key) {
            let base = MatchType::Meta.base_score();
            let hit = SearchHit::new(app_name, base, MatchType::Meta, SearchSource::Meta, "meta");
            boost_hits.push(hit);
        }
    }

    // 2. 意图 → app（基于 catalog cat / tags）
    if intent != "UNKNOWN" {
        let intent_lower = intent.to_lowercase();
        for app in apps {
            let app_cats: Vec<String> = std_iter_tags(app);
            if app_cats.iter().any(|c| c.to_lowercase().contains(&intent_lower)) {
                let base = MatchType::Meta.base_score();
                let hit = SearchHit::new(&app.name, base, MatchType::Meta, SearchSource::Meta, "intent");
                extra_hits.push(hit);
            }
        }
    }

    // 3. target → app
    if !tq.target.is_empty() {
        for c in tq.target.chars() {
            let key = c.to_string();
            for app_name in indexes.meta.lookup(&key) {
                let base = MatchType::Meta.base_score();
                let hit = SearchHit::new(app_name, base, MatchType::Meta, SearchSource::Meta, "target");
                boost_hits.push(hit);
            }
        }
    }

    // 去重 + 附 AppItem
    for hit in boost_hits.iter_mut().chain(extra_hits.iter_mut()) {
        if let Some(app) = app_map.get(&hit.app) {
            hit.app_item = Some((*app).clone());
        }
    }

    (boost_hits, extra_hits)
}

fn std_iter_tags(app: &AppItem) -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    if !app.cat.is_empty() { v.push(app.cat.clone()); }
    for t in &app.tags { v.push(t.clone()); }
    v
}

/// TF-IDF 搜索（第三优先级）。
pub fn tfidf_search(query: &str, indexes: &SearchIndexes) -> Vec<SearchHit> {
    let scores = indexes.tfidf.search(query);
    scores.into_iter().map(|(app, score)| {
        SearchHit::new(&app, score * 30.0, MatchType::Tfidf, SearchSource::Tfidf, "tfidf")
    }).collect()
}

/// Trie 搜索（第三优先级）。
pub fn trie_search(query: &str, indexes: &SearchIndexes) -> Vec<SearchHit> {
    let apps = indexes.trie.search_prefix(query);
    apps.into_iter().map(|app| {
        SearchHit::new(&app, MatchType::Trie.base_score(), MatchType::Trie, SearchSource::Trie, "trie")
    }).collect()
}

/// `runSearchPipeline(query, apps)`：搜索管线总入口。
///
/// 对应 JS `goto-engine.js` L2320-2448。
pub fn run_search_pipeline(
    query: &str,
    apps: &[AppItem],
    indexes: &SearchIndexes,
    config: &SearchConfig,
    weights: &[(String, Vec<(String, f64)>)],
    rule_ts: &[(String, u64)],
    mode: SearchMode,
) -> SearchContext {
    let mut ctx = SearchContext::default();
    ctx.query = query.to_string();
    ctx.mode = mode;

    let q = match sanitize_query_opt(query) {
        Some(s) => s,
        None => {
            ctx.unknown_app = Some(query.to_string());
            return ctx;
        }
    };
    ctx.q = q.clone();

    // 1. fuzzy 优先
    let fuzzy = fuzzy_search(&q, apps, indexes, config, weights, rule_ts);
    if !fuzzy.is_empty() { ctx.has_fuzzy = true; }

    // 2. meta 补充
    let (meta_boost, meta_extra) = meta_search(&q, apps, indexes);
    if !meta_boost.is_empty() || !meta_extra.is_empty() { ctx.has_meta = true; }

    // 3. tfidf 第三优先级
    let tfidf = tfidf_search(&q, indexes);
    if !tfidf.is_empty() { ctx.has_tfidf = true; }

    // 4. trie 第三优先级
    let trie = trie_search(&q, indexes);
    if !trie.is_empty() { ctx.has_trie = true; }

    // 合并：fuzzy 已命中 → 应用 meta_boost；meta_extra 追加末尾
    let mut merged: BTreeMap<String, SearchHit> = BTreeMap::new();
    for h in fuzzy { merged.insert(h.app.clone(), h); }

    // 应用 meta_boost
    for mb in meta_boost {
        if let Some(h) = merged.get_mut(&mb.app) {
            h.score += mb.score * 0.5; // boost 系数
        }
    }

    // 追加 meta_extra（独有结果）
    for me in meta_extra {
        if !merged.contains_key(&me.app) {
            let mut nh = me;
            nh.is_extra = true;
            merged.insert(nh.app.clone(), nh);
        }
    }

    // 追加 tfidf（独有结果）
    for t in tfidf {
        if !merged.contains_key(&t.app) {
            let mut nh = t;
            nh.is_extra = true;
            merged.insert(nh.app.clone(), nh);
        }
    }

    // 追加 trie（独有结果）
    for t in trie {
        if !merged.contains_key(&t.app) {
            let mut nh = t;
            nh.is_extra = true;
            merged.insert(nh.app.clone(), nh);
        }
    }

    // 排序输出
    let mut list: Vec<SearchHit> = merged.into_values().collect();
    list.sort_by(|a, b| {
        b.score.partial_cmp(&a.score).unwrap_or(core::cmp::Ordering::Equal)
            .then_with(|| b.launch_count.cmp(&a.launch_count))
    });

    // 拆分 meta_list
    let meta_list: Vec<SearchHit> = list.iter().filter(|h| h.is_extra).cloned().collect();

    ctx.list = list;
    ctx.meta_list = meta_list;
    ctx.scores = ctx.list.iter().map(|h| (h.app.clone(), h.score)).collect();

    if ctx.list.is_empty() {
        ctx.unknown_app = Some(query.to_string());
    }

    ctx
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::fingerprint;

    fn sample_apps() -> Vec<AppItem> {
        vec![
            AppItem {
                name: "微信".into(),
                py: "wei xin".into(),
                abbr: "wx".into(),
                en: "WeChat".into(),
                cat: "通讯".into(),
                tags: vec!["社交".into()],
                ..Default::default()
            },
            AppItem {
                name: "网易云音乐".into(),
                py: "wang yi yun yin le".into(),
                abbr: "wyy".into(),
                en: "NetEase Music".into(),
                cat: "音乐".into(),
                tags: vec!["音乐".into()],
                ..Default::default()
            },
        ]
    }

    fn build_indexes(apps: &[AppItem]) -> SearchIndexes {
        let mut inv = InvertedIndex::new(); inv.build(apps);
        let mut meta = MetaIndex::new(); meta.build(apps);
        let mut tfidf = TfidfIndex::new(); tfidf.build(apps);
        let mut trie = TrieIndex::new(); trie.build(apps);
        SearchIndexes { inverted: inv, meta, tfidf, trie }
    }

    #[test]
    fn test_fuzzy_search_initial() {
        let apps = sample_apps();
        let idx = build_indexes(&apps);
        let cfg = SearchConfig::default();
        let hits = fuzzy_search("wx", &apps, &idx, &cfg, &[], &[]);
        assert!(hits.iter().any(|h| h.app == "微信"));
    }

    #[test]
    fn test_fuzzy_search_prefix() {
        let apps = sample_apps();
        let idx = build_indexes(&apps);
        let cfg = SearchConfig::default();
        // sanitize 要求长度 >= 2，使用 "微信" 作为前缀查询
        let hits = fuzzy_search("微信", &apps, &idx, &cfg, &[], &[]);
        assert!(hits.iter().any(|h| h.app == "微信"));
    }

    #[test]
    fn test_run_search_pipeline() {
        let apps = sample_apps();
        let idx = build_indexes(&apps);
        let cfg = SearchConfig::default();
        let ctx = run_search_pipeline("wx", &apps, &idx, &cfg, &[], &[], SearchMode::Standard);
        assert!(!ctx.list.is_empty());
        assert!(ctx.list[0].app == "微信");
    }

    #[test]
    fn test_run_search_pipeline_unknown() {
        let apps = sample_apps();
        let idx = build_indexes(&apps);
        let cfg = SearchConfig::default();
        let ctx = run_search_pipeline("zzz", &apps, &idx, &cfg, &[], &[], SearchMode::Standard);
        assert!(ctx.unknown_app.is_some());
    }
}
