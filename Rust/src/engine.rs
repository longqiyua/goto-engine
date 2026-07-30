//! 引擎主入口（对应 `goto-engine.js` 的 `engine` 对象 + `installGlobals()`）。
//!
//! [`GotoEngine`] 是面向下游消费者的统一 API 入口，整合 18 个模块：
//! Storage / Index / Search / Intent / Learning / Weights / Negative /
//! Self-Healing / Association / Stats / Filter / Context / Maintenance /
//! Smart Reminder / PRO / Semantic / Bayes / NLP。
//!
//! 所有方法命名与 JS 端 `window.GOTOEngine.xxx` 一一对应（snake_case 化），
//! 以便跨平台对照移植。

use alloc::string::{String, ToString};
use alloc::sync::Arc;
use alloc::vec::Vec;
use alloc::collections::BTreeMap;

#[cfg(feature = "std")]
use std::sync::RwLock as StdRwLock;

#[cfg(not(feature = "std"))]
use spin::RwLock as StdRwLock;

use crate::association::AssociationManager;
use crate::bayes::{BayesManager, BayesPrediction};
use crate::context::{ContextManager, SearchContext_};
use crate::filter::{sanitize_query, SanitizeResult};
use crate::index::{InvertedIndex, MetaIndex, TfidfIndex, TrieIndex};
use crate::intent::{extract_tokens, primary_intent, TokenizedQuery};
use crate::learning::LearningManager;
use crate::maintenance::MaintenanceManager;
use crate::negative::NegativeManager;
use crate::pro::ProManager;
use crate::search::{run_search_pipeline, SearchConfig, SearchIndexes};
use crate::self_healing::SelfHealingManager;
use crate::smart_reminder::{SmartReminderManager, SmartReminderPrediction};
use crate::stats::StatsManager;
use crate::storage::{MemoryStorage, Storage};
use crate::types::{
    AppItem, ChainStore, HourlyStats, MaintenanceReport, MemoryRecord,
    PendingEntry, SearchContext, SearchMode, SmartReminderSuggestion,
};
use crate::utils::now_ts;
use crate::weights::WeightManager;

#[cfg(feature = "semantic")]
use crate::semantic::SemanticManager;

// ─── GotoEngine ─────────────────────────────────────────────────────────────

/// GOTO Engine 主入口。
///
/// 持有存储后端（`Arc<S>`）和搜索索引缓存，提供完整的搜索 / 学习 / 推荐 API。
///
/// # Example
///
/// ```rust,ignore
/// use goto_engine::{GotoEngine, types::AppItem};
///
/// let mut engine = GotoEngine::new();
/// let apps = vec![
///     AppItem { name: "微信".into(), py: "wei xin".into(), abbr: "wx".into(),
///               en: "WeChat".into(), cat: "通讯".into(),
///               tags: vec!["社交".into()], ..Default::default() },
/// ];
/// engine.watch_app_dataset(&apps);
/// let ctx = engine.run_search_pipeline("wx", &apps);
/// assert!(!ctx.list.is_empty());
/// ```
#[derive(Debug, Clone)]
pub struct GotoEngine<S: Storage + 'static = MemoryStorage> {
    /// 存储后端。
    storage: Arc<S>,
    /// 搜索配置（boost 参数）。
    config: SearchConfig,
    /// 上下文管理器（线程安全）。
    context: ContextManager,
    /// 当前数据集（最近一次 `watch_app_dataset`）。
    cached_apps: Arc<StdRwLock<Vec<AppItem>>>,
}

impl GotoEngine<MemoryStorage> {
    /// 创建一个使用内存存储的引擎实例（默认）。
    pub fn new() -> Self {
        Self::with_storage(MemoryStorage::new())
    }
}

impl Default for GotoEngine<MemoryStorage> {
    fn default() -> Self { Self::new() }
}

impl<S: Storage + 'static> GotoEngine<S> {
    /// 使用指定的存储后端创建引擎。
    pub fn with_storage(storage: S) -> Self {
        Self {
            storage: Arc::new(storage),
            config: SearchConfig::default(),
            context: ContextManager::default(),
            cached_apps: Arc::new(StdRwLock::new(Vec::new())),
        }
    }

    /// 从 `Arc<S>` 创建引擎（用于共享存储）。
    pub fn from_arc(storage: Arc<S>) -> Self {
        Self {
            storage,
            config: SearchConfig::default(),
            context: ContextManager::default(),
            cached_apps: Arc::new(StdRwLock::new(Vec::new())),
        }
    }

    /// 引擎版本。
    pub fn version(&self) -> &'static str { crate::VERSION }

    /// 获取存储后端引用（供下游实现自定义存储交互）。
    pub fn storage(&self) -> &S { &self.storage }

    // ─── 过滤层 ─────────────────────────────────────────────────────────────

    /// `sanitizeQuery(query)`：脏数据清洗。
    pub fn sanitize_query(&self, query: &str) -> Option<String> {
        match sanitize_query(query) {
            SanitizeResult::Ok(q) => Some(q),
            SanitizeResult::Rejected(_) => None,
        }
    }

    // ─── 意图层 ─────────────────────────────────────────────────────────────

    /// `extractTokens(query)`：分词 + 意图识别。
    pub fn extract_tokens(&self, query: &str) -> TokenizedQuery {
        extract_tokens(query)
    }

    // ─── 索引层 ─────────────────────────────────────────────────────────────

    /// `watchAppDataset(apps)`：监听数据集变化，重建搜索索引。
    pub fn watch_app_dataset(&self, apps: &[AppItem]) {
        #[cfg(feature = "std")]
        {
            let mut cached = self.cached_apps.write().unwrap();
            *cached = apps.to_vec();
        }
        #[cfg(not(feature = "std"))]
        {
            let mut cached = self.cached_apps.write();
            *cached = apps.to_vec();
        }
    }

    /// `rebuildIndex()`：重建索引（基于当前 cached_apps）。
    pub fn rebuild_index(&self) {
        // no-op：索引在 build_indexes 时按需重建
    }

    /// 构建当前数据集的索引快照。
    fn build_indexes(&self) -> SearchIndexes {
        #[cfg(feature = "std")]
        let cached = self.cached_apps.read().unwrap().clone();
        #[cfg(not(feature = "std"))]
        let cached = self.cached_apps.read().clone();
        let mut inverted = InvertedIndex::new();
        let mut meta = MetaIndex::new();
        let mut tfidf = TfidfIndex::new();
        let mut trie = TrieIndex::new();
        inverted.build(&cached);
        meta.build(&cached);
        tfidf.build(&cached);
        trie.build(&cached);
        SearchIndexes { inverted, meta, tfidf, trie }
    }

    /// `buildSearchIndex(apps)`：构建索引（外部调用，等价于 `watch_app_dataset`）。
    pub fn build_search_index(&self, apps: &[AppItem]) {
        self.watch_app_dataset(apps);
    }

    // ─── 搜索层 ─────────────────────────────────────────────────────────────

    /// `fuzzySearch(query, apps)`：第一优先级模糊匹配。
    pub fn fuzzy_search(&self, query: &str, apps: &[AppItem]) -> Vec<crate::types::SearchHit> {
        let indexes = self.build_indexes();
        let weights: Vec<(String, Vec<(String, f64)>)> = self.storage.read_json(
            crate::constants::StorageKeys::WEIGHTS, Vec::new());
        let rule_ts: Vec<(String, u64)> = self.storage.read_json(
            crate::constants::StorageKeys::WEIGHTS_TS, Vec::new());
        crate::search::fuzzy_search(query, apps, &indexes, &self.config, &weights, &rule_ts)
    }

    /// `metaSearch(query)`：第二优先级元标签搜索。
    pub fn meta_search(&self, query: &str, apps: &[AppItem]) -> (Vec<crate::types::SearchHit>, Vec<crate::types::SearchHit>) {
        let indexes = self.build_indexes();
        crate::search::meta_search(query, apps, &indexes)
    }

    /// `runSearchPipeline(query, apps)`：搜索管线总入口。
    pub fn run_search_pipeline(&self, query: &str, apps: &[AppItem]) -> SearchContext {
        let indexes = self.build_indexes();
        let weights: Vec<(String, Vec<(String, f64)>)> = self.storage.read_json(
            crate::constants::StorageKeys::WEIGHTS, Vec::new());
        let rule_ts: Vec<(String, u64)> = self.storage.read_json(
            crate::constants::StorageKeys::WEIGHTS_TS, Vec::new());

        // 应用 bayes boost
        let bayes = BayesManager::new(&*self.storage);
        let bayes_candidates = bayes.high_confidence_apps(query);
        let _ = bayes_candidates; // bayes boost 在 fuzzy 内部应用，此处仅触发预测缓存

        run_search_pipeline(
            query, apps, &indexes, &self.config, &weights, &rule_ts, SearchMode::Standard,
        )
    }

    // ─── 学习层 ─────────────────────────────────────────────────────────────

    /// `recordSearch(query)`：记录搜索行为。
    pub fn record_search(&self, query: &str) {
        let learning = LearningManager::new(&*self.storage);
        learning.record_search(query);
    }

    /// `recordSelection(query, app)`：记录用户选择。
    pub fn record_selection(&self, query: &str, app: &str) -> MemoryRecord {
        let s = &*self.storage;
        let learning = LearningManager::new(s);
        let mut weights = WeightManager::new(s);
        let record = learning.record_selection(query, app, &mut weights);

        // 记录贝叶斯观测
        let bayes = BayesManager::new(s);
        bayes.record_observation(query, app, None);

        // 记录全局偏好
        let pro = ProManager::new(s);
        pro.bump_global_preference(app);

        // 智能提醒：触发"应用启动后预测"
        let smart = SmartReminderManager::new(s);
        let _ = smart.predict_after_launch(app);

        record
    }

    /// `recordUnknownApp(query, app)`：记录未知应用。
    pub fn record_unknown_app(&self, query: &str, app: &str) {
        let learning = LearningManager::new(&*self.storage);
        learning.record_unknown_app(query, app);
    }

    /// `getMemory()`：读取个人记忆库。
    pub fn get_memory(&self) -> Vec<MemoryRecord> {
        let learning = LearningManager::new(&*self.storage);
        learning.get_memory()
    }

    /// `getPendingIndex()`：读取待索引库。
    pub fn get_pending(&self) -> Vec<PendingEntry> {
        let learning = LearningManager::new(&*self.storage);
        learning.get_pending()
    }

    /// `getUnknownApps()`：获取未知应用列表。
    pub fn get_unknown_apps(&self) -> Vec<String> {
        let learning = LearningManager::new(&*self.storage);
        learning.get_unknown_apps()
    }

    // ─── 权重层 ─────────────────────────────────────────────────────────────

    /// `getRuleWeights()`：读取所有权重。
    pub fn get_rule_weights(&self) -> Vec<(String, Vec<(String, f64)>)> {
        self.storage.read_json(crate::constants::StorageKeys::WEIGHTS, Vec::new())
    }

    /// `saveRuleWeights(weights)`：保存权重。
    pub fn save_rule_weights(&self, weights: &[(String, Vec<(String, f64)>)]) {
        self.storage.write_json(crate::constants::StorageKeys::WEIGHTS, weights);
    }

    // ─── 负面层 ─────────────────────────────────────────────────────────────

    /// `addBlockFlag(query, app, days)`：添加屏蔽。
    pub fn add_block_flag(&self, query: &str, app: &str, days: u32) {
        let neg = NegativeManager::new(&*self.storage);
        neg.add_block_flag(query, app, days);
    }

    /// `removeBlockFlag(query, app)`：移除屏蔽。
    pub fn remove_block_flag(&self, query: &str, app: &str) {
        let neg = NegativeManager::new(&*self.storage);
        neg.remove_block_flag(query, app);
    }

    /// `isBlockFlagged(query, app)`：查询是否被屏蔽。
    pub fn is_block_flagged(&self, query: &str, app: &str) -> bool {
        let neg = NegativeManager::new(&*self.storage);
        neg.is_block_flagged(query, app)
    }

    /// `clearExpiredBlockFlags()`：清理过期屏蔽。
    pub fn clear_expired_block_flags(&self) -> usize {
        let neg = NegativeManager::new(&*self.storage);
        neg.clear_expired()
    }

    // ─── 自愈层 ─────────────────────────────────────────────────────────────

    /// `applySelfHealing(query, newDefaultApp, candidates)`：自愈。
    pub fn apply_self_healing(&self, query: &str, new_app: &str, candidates: &[String]) {
        let s = &*self.storage;
        let mut weights = WeightManager::new(s);
        let negative = NegativeManager::new(s);
        let self_healing = SelfHealingManager::new(s);
        self_healing.apply_self_healing(query, new_app, candidates, &mut weights, &negative);
    }

    /// `getSelfHealingState()`：读取自愈状态。
    pub fn get_self_healing_state(&self) -> crate::types::SelfHealingState {
        let s = &*self.storage;
        let self_healing = SelfHealingManager::new(s);
        self_healing.get_state()
    }

    // ─── 关联层 ─────────────────────────────────────────────────────────────

    /// `getChainStore()`：读取动作链。
    pub fn get_chain_store(&self) -> ChainStore {
        let assoc = AssociationManager::new(&*self.storage);
        assoc.get_store()
    }

    /// `getAssociationRecommendation(currentApp, topN)`：基于动作链推荐下一个 app。
    pub fn get_association_recommendation(&self, current_app: &str, top_n: usize) -> Vec<(String, f64)> {
        let assoc = AssociationManager::new(&*self.storage);
        assoc.recommend_next(current_app, top_n)
    }

    // ─── 统计层 ─────────────────────────────────────────────────────────────

    /// `getHourlyStats(topN)`：四时段统计。
    pub fn get_hourly_stats(&self, top_n: usize) -> HourlyStats {
        let stats = StatsManager::new(&*self.storage);
        stats.get_hourly_stats(top_n)
    }

    /// `getCurrentHourStats(topN)`：当前时段统计。
    pub fn get_current_hour_stats(&self, top_n: usize) -> Vec<(String, u32)> {
        let stats = StatsManager::new(&*self.storage);
        stats.get_current_hour_stats(top_n)
    }

    /// `getQuickBubbles()`：快捷气泡推荐。
    pub fn get_quick_bubbles(&self, top_n: usize) -> Vec<crate::types::QuickBubble> {
        let stats = StatsManager::new(&*self.storage);
        stats.get_quick_bubbles(top_n)
    }

    /// Top N 推荐（用于智能提醒 + 问候卡片右侧横排展示）。
    pub fn top_n_recommendations(&self, n: usize) -> Vec<(String, f64)> {
        let stats = StatsManager::new(&*self.storage);
        stats.top_n_recommendations(n)
    }

    // ─── 上下文层 ───────────────────────────────────────────────────────────

    /// `setContext(ctx)`：设置上下文。
    pub fn set_context(&self, ctx: SearchContext_) {
        self.context.set(ctx);
    }

    /// `clearContext()`：清除上下文。
    pub fn clear_context(&self) {
        self.context.clear();
    }

    /// `getContext()`：读取上下文。
    pub fn get_context(&self) -> SearchContext_ {
        self.context.get()
    }

    /// `pushRecentApp(app, keep)`：更新最近使用的 app。
    pub fn push_recent_app(&self, app: &str, keep: usize) {
        self.context.push_recent_app(app, keep);
    }

    // ─── 维护层 ─────────────────────────────────────────────────────────────

    /// `maintain()`：引擎自主维护。
    pub fn maintain(&self) -> MaintenanceReport {
        let s = &*self.storage;
        let mut weights = WeightManager::new(s);
        let mgr = MaintenanceManager::new(s);
        mgr.maintain(&mut weights)
    }

    /// `_decayAllStaleQueries()`：全局时间衰减。
    pub fn decay_all_stale_queries(&self) -> (usize, usize) {
        let s = &*self.storage;
        let mut weights = WeightManager::new(s);
        let mgr = MaintenanceManager::new(s);
        mgr.decay_all_stale_queries(&mut weights)
    }

    /// `_pruneChainStore()`：链式边修剪。
    pub fn prune_chain_store(&self) -> (usize, usize) {
        let mgr = MaintenanceManager::new(&*self.storage);
        mgr.prune_chain_store()
    }

    /// `_pruneOldMemory()`：旧记忆修剪。
    pub fn prune_old_memory(&self) -> (usize, usize) {
        let mgr = MaintenanceManager::new(&*self.storage);
        mgr.prune_old_memory()
    }

    // ─── PRO 层 ─────────────────────────────────────────────────────────────

    /// `isProEnabled()`：PRO 是否启用。
    pub fn is_pro_enabled(&self) -> bool {
        let pro = ProManager::new(&*self.storage);
        pro.is_enabled()
    }

    /// `setProEnabled(enabled)`：开关 PRO。
    pub fn set_pro_enabled(&self, enabled: bool) -> bool {
        let pro = ProManager::new(&*self.storage);
        pro.set_enabled(enabled)
    }

    /// `getProSnapshot()`：生成 PRO 快照。
    pub fn get_pro_snapshot(&self) -> crate::pro::ProSnapshot {
        let pro = ProManager::new(&*self.storage);
        pro.get_snapshot()
    }

    /// `_getProContextBoost(query, app)`：PRO 上下文加权。
    pub fn pro_context_boost(&self, query: &str, app: &AppItem) -> f64 {
        let pro = ProManager::new(&*self.storage);
        pro.context_boost(query, app)
    }

    /// `_getMicroContextBoost(query, app)`：微上下文加权。
    pub fn micro_context_boost(&self, query: &str, app: &AppItem) -> f64 {
        let pro = ProManager::new(&*self.storage);
        pro.micro_context_boost(query, app)
    }

    /// `getGlobalPreference()`：读取全局偏好。
    pub fn get_global_preference(&self) -> crate::types::GlobalPreference {
        let pro = ProManager::new(&*self.storage);
        pro.get_global_preference()
    }

    // ─── 贝叶斯层 ───────────────────────────────────────────────────────────

    /// `recordBayesObservation(query, app, bucket)`：记录贝叶斯观测。
    pub fn record_bayes_observation(&self, query: &str, app: &str, bucket: Option<&str>) {
        let bayes = BayesManager::new(&*self.storage);
        bayes.record_observation(query, app, bucket);
    }

    /// `bayesPredict(query, bucket)`：贝叶斯预测。
    pub fn bayes_predict(&self, query: &str, bucket: Option<&str>) -> Vec<BayesPrediction> {
        let bayes = BayesManager::new(&*self.storage);
        bayes.predict(query, bucket)
    }

    /// `_bayesHighConfidenceApps(query)`：高置信度贝叶斯候选。
    pub fn bayes_high_confidence_apps(&self, query: &str) -> Vec<BayesPrediction> {
        let bayes = BayesManager::new(&*self.storage);
        bayes.high_confidence_apps(query)
    }

    // ─── 智能提醒层 ─────────────────────────────────────────────────────────

    /// `_smartReminderPredict(fromApp)`：综合预测。
    pub fn smart_reminder_predict(&self, from_app: Option<&str>) -> Option<SmartReminderPrediction> {
        let smart = SmartReminderManager::new(&*self.storage);
        smart.predict(from_app)
    }

    /// `_smartReminderPredictTopN(n)`：Top N 推荐（用于问候卡片右侧横排展示）。
    pub fn smart_reminder_predict_top_n(&self, n: usize) -> Vec<SmartReminderSuggestion> {
        let smart = SmartReminderManager::new(&*self.storage);
        smart.predict_top_n(n)
    }

    /// `_smartReminderTryExpandAfterLaunch(appName)`：应用启动后预测下一个。
    pub fn smart_reminder_after_launch(&self, app: &str) -> Option<SmartReminderPrediction> {
        let smart = SmartReminderManager::new(&*self.storage);
        smart.predict_after_launch(app)
    }

    /// 智能提醒：用户接受推荐。
    pub fn smart_reminder_accept(&self, target: &str) {
        let smart = SmartReminderManager::new(&*self.storage);
        smart.accept(target);
    }

    /// 智能提醒：用户拒绝推荐。
    pub fn smart_reminder_reject(&self, target: &str) {
        let smart = SmartReminderManager::new(&*self.storage);
        smart.reject(target);
    }

    /// 智能提醒：用户忽略。
    pub fn smart_reminder_ignore(&self, target: &str) {
        let smart = SmartReminderManager::new(&*self.storage);
        smart.ignore(target);
    }

    // ─── 语义层（可选） ─────────────────────────────────────────────────────

    /// `GOTOSemantic.isEnabled()`：语义模块开关状态。
    pub fn semantic_is_enabled(&self) -> bool {
        #[cfg(feature = "semantic")]
        {
            let sem = SemanticManager::new(&*self.storage);
            sem.is_enabled()
        }
        #[cfg(not(feature = "semantic"))]
        { false }
    }

    /// `GOTOSemantic.setEnabled(enabled)`：开关语义模块。
    pub fn semantic_set_enabled(&self, enabled: bool) {
        #[cfg(feature = "semantic")]
        {
            let sem = SemanticManager::new(&*self.storage);
            sem.set_enabled(enabled);
        }
        #[cfg(not(feature = "semantic"))]
        { let _ = enabled; }
    }

    /// `GOTOSemantic.expand(query, asyncMode, limit)`：扩展查询。
    pub fn semantic_expand(&self, query: &str, async_mode: bool, limit: Option<usize>) -> Vec<crate::semantic::SemanticExpansion> {
        #[cfg(feature = "semantic")]
        {
            let sem = SemanticManager::new(&*self.storage);
            sem.expand(query, async_mode, limit)
        }
        #[cfg(not(feature = "semantic"))]
        { let _ = (query, async_mode, limit); Vec::new() }
    }

    /// `GOTOSemantic.findSimilar(word, topN)`：L3 词向量相似查询。
    pub fn semantic_find_similar(&self, word: &str, top_n: usize) -> Vec<crate::semantic::SemanticExpansion> {
        #[cfg(feature = "semantic")]
        {
            let sem = SemanticManager::new(&*self.storage);
            sem.find_similar(word, top_n)
        }
        #[cfg(not(feature = "semantic"))]
        { let _ = (word, top_n); Vec::new() }
    }

    // ─── 启动钩子 ───────────────────────────────────────────────────────────

    /// `installGlobals()`：启动时自动调用一次 `maintain()`，保证陈旧偏好不会无限累积。
    ///
    /// 对应 JS `installGlobals()` 末尾的 `try{ this.maintain(); }catch(_){}`。
    pub fn on_startup(&self) -> MaintenanceReport {
        self.maintain()
    }

    /// 清空所有引擎数据（用于"重置引擎"）。
    pub fn clear_all(&self) {
        self.storage.clear();
        #[cfg(feature = "std")]
        {
            self.cached_apps.write().unwrap().clear();
        }
        #[cfg(not(feature = "std"))]
        {
            self.cached_apps.write().clear();
        }
        self.context.clear();
    }
}

// ─── 测试 ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AppItem;

    fn sample_apps() -> Vec<AppItem> {
        vec![
            AppItem {
                name: "微信".into(), py: "wei xin".into(), abbr: "wx".into(),
                en: "WeChat".into(), cat: "通讯".into(),
                tags: vec!["社交".into(), "即时通讯".into()],
                ..Default::default()
            },
            AppItem {
                name: "QQ".into(), py: "qq".into(), abbr: "qq".into(),
                en: "QQ".into(), cat: "通讯".into(),
                tags: vec!["社交".into()],
                ..Default::default()
            },
            AppItem {
                name: "抖音".into(), py: "dou yin".into(), abbr: "dy".into(),
                en: "TikTok".into(), cat: "视频".into(),
                tags: vec!["短视频".into()],
                ..Default::default()
            },
        ]
    }

    #[test]
    fn test_engine_new() {
        let engine = GotoEngine::new();
        assert_eq!(engine.version(), "2.1.0");
    }

    #[test]
    fn test_sanitize_query() {
        let engine = GotoEngine::new();
        assert!(engine.sanitize_query("wx").is_some());
        assert!(engine.sanitize_query("").is_none());
        assert!(engine.sanitize_query("a").is_none()); // too short
    }

    #[test]
    fn test_search_pipeline_basic() {
        let engine = GotoEngine::new();
        let apps = sample_apps();
        engine.watch_app_dataset(&apps);

        let ctx = engine.run_search_pipeline("wx", &apps);
        assert!(!ctx.list.is_empty(), "应能搜到微信");
        assert!(ctx.list.iter().any(|h| h.app == "微信"));
    }

    #[test]
    fn test_record_selection_persists() {
        let engine = GotoEngine::new();
        let apps = sample_apps();
        engine.watch_app_dataset(&apps);

        engine.record_selection("wx", "微信");
        let memory = engine.get_memory();
        assert_eq!(memory.len(), 1);
        assert_eq!(memory[0].app, "微信");
    }

    #[test]
    fn test_chain_recommendation() {
        let engine = GotoEngine::new();
        // 模拟：微信 → QQ 的转移
        let s = &*engine.storage;
        let assoc = AssociationManager::new(s);
        assoc.record_transition("微信", "QQ", 3.0);

        let recs = engine.get_association_recommendation("微信", 5);
        assert!(!recs.is_empty());
        assert_eq!(recs[0].0, "QQ");
    }

    #[test]
    fn test_block_flag() {
        let engine = GotoEngine::new();
        engine.add_block_flag("wx", "QQ", 3);
        assert!(engine.is_block_flagged("wx", "QQ"));
        assert!(!engine.is_block_flagged("wx", "微信"));
    }

    #[test]
    fn test_maintain() {
        let engine = GotoEngine::new();
        let report = engine.maintain();
        assert_eq!(report.decayed_queries, 0);
    }

    #[test]
    fn test_pro_toggle() {
        let engine = GotoEngine::new();
        assert!(!engine.is_pro_enabled());
        engine.set_pro_enabled(true);
        assert!(engine.is_pro_enabled());
    }

    #[test]
    fn test_bayes_predict() {
        let engine = GotoEngine::new();
        engine.record_bayes_observation("wx", "微信", Some("morning"));
        engine.record_bayes_observation("wx", "微信", Some("morning"));
        engine.record_bayes_observation("wx", "QQ", Some("morning"));

        let preds = engine.bayes_predict("wx", Some("morning"));
        assert!(!preds.is_empty());
        assert_eq!(preds[0].app, "微信");
    }

    #[test]
    fn test_smart_reminder_top_n() {
        let engine = GotoEngine::new();
        // 注入一些 stats（结构：APP_STATS → HourlyStatsAgg）
        let s = &*engine.storage;
        let mut stats: BTreeMap<String, crate::types::HourlyStatsAgg> = BTreeMap::new();
        stats.insert("微信".into(), crate::types::HourlyStatsAgg {
            uses: 10, hourly: BTreeMap::new(), last_hour: BTreeMap::new(), history: Vec::new(),
        });
        stats.insert("QQ".into(), crate::types::HourlyStatsAgg {
            uses: 5, hourly: BTreeMap::new(), last_hour: BTreeMap::new(), history: Vec::new(),
        });
        s.write_json(crate::constants::StorageKeys::APP_STATS, &stats);

        let top = engine.smart_reminder_predict_top_n(2);
        assert_eq!(top.len(), 2);
        assert_eq!(top[0].app, "微信");
    }

    #[test]
    fn test_clear_all() {
        let engine = GotoEngine::new();
        engine.record_selection("wx", "微信");
        assert!(!engine.get_memory().is_empty());

        engine.clear_all();
        assert!(engine.get_memory().is_empty());
    }

    #[test]
    fn test_semantic_disabled_by_default() {
        let engine = GotoEngine::new();
        assert!(!engine.semantic_is_enabled());
        let result = engine.semantic_expand("微信", false, None);
        assert!(result.is_empty());
    }

    #[test]
    fn test_semantic_enabled() {
        let engine = GotoEngine::new();
        engine.semantic_set_enabled(true);
        assert!(engine.semantic_is_enabled());
        let result = engine.semantic_expand("微信", false, None);
        assert!(result.iter().any(|r| r.term == "wx"));
    }

    #[test]
    fn test_extract_tokens() {
        let engine = GotoEngine::new();
        let tq = engine.extract_tokens("发微信给张三");
        // 应识别"发"为 SEND 意图
        assert!(tq.intents.iter().any(|i| i == "SEND"));
    }

    #[test]
    fn test_startup_hook() {
        let engine = GotoEngine::new();
        let report = engine.on_startup();
        // 启动钩子应返回维护报告
        assert_eq!(report.decayed_queries, 0);
    }

    #[test]
    fn test_with_custom_storage() {
        // 测试自定义 storage 注入
        let storage = MemoryStorage::new();
        let engine = GotoEngine::with_storage(storage);
        engine.record_selection("wx", "微信");
        assert_eq!(engine.get_memory().len(), 1);
    }
}
