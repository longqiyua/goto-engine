//! 核心数据类型（对应 `goto-engine.js` 中隐式定义的各种数据结构）。
//!
//! 所有跨模块传递的结构体集中在此处定义，便于下游消费者（Android JNI、
//! Electron IPC、WASM 绑定）一次性导入。

use alloc::string::String;
use alloc::vec::Vec;
use alloc::collections::BTreeMap;
use serde::{Deserialize, Serialize};

// ─── 应用数据集 ─────────────────────────────────────────────────────────────

/// 一个应用条目（对应 JS 中的 app 对象）。
///
/// `name` 是中文显示名，`py` 是拼音（空格分词），`abbr` 是缩写（如 "wx"），
/// `en` 是英文名，`cat` 是分类，`tags` 是标签数组。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppItem {
    /// 应用名（中文显示名，如 "微信"）。
    pub name: String,
    /// 全拼（空格分词，如 "wei xin"）。
    pub py: String,
    /// 缩写（首字母组合，如 "wx"）。
    pub abbr: String,
    /// 英文名（如 "WeChat"）。
    pub en: String,
    /// 分类（如 "通讯"、"视频"）。
    pub cat: String,
    /// 标签数组（如 ["社交","即时通讯"]）。
    #[serde(default)]
    pub tags: Vec<String>,
    /// 包名 / bundleId（可选，跨平台用）。
    #[serde(default)]
    pub pkg: String,
    /// 启动次数（可选，由外部统计模块注入）。
    #[serde(default)]
    pub launch_count: u32,
    /// 是否已安装（用于 installedBoost）。
    #[serde(default)]
    pub installed: bool,
    /// 自定义权重（可选，由 catalog 配置）。
    #[serde(default)]
    pub weight: f64,
    /// 图标 URL / data URL（可选）。
    #[serde(default)]
    pub icon: String,
}

impl AppItem {
    /// 创建一个仅含名称的占位 AppItem（用于测试）。
    pub fn new(name: &str) -> Self {
        Self {
            name: name.into(),
            ..Default::default()
        }
    }

    /// 返回用于索引的所有可搜索字段（去重）。
    pub fn search_fields(&self) -> Vec<&str> {
        let mut v: Vec<&str> = Vec::with_capacity(6);
        if !self.name.is_empty() { v.push(&self.name); }
        if !self.py.is_empty() { v.push(&self.py); }
        if !self.abbr.is_empty() { v.push(&self.abbr); }
        if !self.en.is_empty() { v.push(&self.en); }
        if !self.cat.is_empty() { v.push(&self.cat); }
        v
    }
}

// ─── 搜索结果 ───────────────────────────────────────────────────────────────

/// 匹配类型（决定基础分）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MatchType {
    /// 首字母精确匹配（如 "wx" → 微信）。
    Initial,
    /// T9 数字键盘匹配（如 "9" → 微信 w=9, x=9）。
    T9,
    /// 前缀匹配（如 "微" → 微信）。
    Prefix,
    /// 单字包含匹配（如 "信" → 微信）。
    Char,
    /// 全名乱序匹配（query 字符全部出现在 target 中）。
    Disorder,
    /// 邻位交换匹配（如 "weixni" → 微信）。
    AdjacentSwap,
    /// 元标签匹配（基于 catalog 关键词）。
    Meta,
    /// TF-IDF 倒排匹配。
    Tfidf,
    /// Trie 前缀树匹配。
    Trie,
    /// 语义联想匹配（L1/L2/L3）。
    Semantic,
    /// 未知应用 / 兜底。
    Unknown,
}

impl Default for MatchType {
    fn default() -> Self { MatchType::Unknown }
}

impl MatchType {
    /// 基础分（对应 JS 中 matchType → score 的映射）。
    pub fn base_score(&self) -> f64 {
        match self {
            MatchType::Initial => 120.0,
            MatchType::T9 => 100.0,
            MatchType::Prefix => 80.0,
            MatchType::Char => 56.0,
            MatchType::Disorder => 38.0,
            MatchType::AdjacentSwap => 60.0,
            MatchType::Meta => 56.0,
            MatchType::Tfidf => 30.0,
            MatchType::Trie => 50.0,
            MatchType::Semantic => 38.0,
            MatchType::Unknown => 0.0,
        }
    }

    /// 是否为 fuzzy 阶段的命中（非 meta / tfidf / semantic）。
    pub fn is_fuzzy(&self) -> bool {
        matches!(
            self,
            MatchType::Initial
                | MatchType::T9
                | MatchType::Prefix
                | MatchType::Char
                | MatchType::Disorder
                | MatchType::AdjacentSwap
                | MatchType::Trie
        )
    }
}

/// 搜索来源（用于 `SearchHit.source` 字段）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SearchSource {
    Fuzzy,
    Meta,
    Tfidf,
    Trie,
    Semantic,
    Unknown,
}

impl Default for SearchSource {
    fn default() -> Self { SearchSource::Fuzzy }
}

/// 单条搜索命中。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SearchHit {
    /// 应用名（作为唯一标识）。
    pub app: String,
    /// 总得分（基础分 + 各种 boost）。
    pub score: f64,
    /// 匹配类型。
    pub match_type: MatchType,
    /// 来源（fuzzy / meta / tfidf / ...）。
    pub source: SearchSource,
    /// 命中字段（"name" / "py" / "abbr" / "en" / "cat"）。
    pub field: String,
    /// 命中的子串（用于高亮）。
    pub matched: String,
    /// 是否为元标签 / 语义推荐的独有结果（非 fuzzy 命中）。
    #[serde(default)]
    pub is_extra: bool,
    /// 是否为已安装应用（installedBoost 命中）。
    #[serde(default)]
    pub installed: bool,
    /// 启动次数（用于排序 tiebreak）。
    #[serde(default)]
    pub launch_count: u32,
    /// 应用元数据快照（避免上游再次查找）。
    #[serde(default)]
    pub app_item: Option<AppItem>,
}

impl SearchHit {
    pub fn new(app: &str, score: f64, match_type: MatchType, source: SearchSource, field: &str) -> Self {
        Self {
            app: app.into(),
            score,
            match_type,
            source,
            field: field.into(),
            ..Default::default()
        }
    }
}

/// 搜索模式（对应 JS 的 `modeMap` 字段）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum SearchMode {
    #[default]
    Standard,
    Pro,
    Float,
    SmartReminder,
}

/// 搜索管线返回的完整上下文（对应 JS 的 `SearchContext`）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SearchContext {
    /// 原始 query（sanitize 之前）。
    pub query: String,
    /// sanitize 之后的 query。
    pub q: String,
    /// fuzzy + meta + tfidf 合并后的命中列表（已去重、已排序）。
    pub list: Vec<SearchHit>,
    /// 仅 meta 命中的列表（用于 UI 区分"智能推荐"）。
    pub meta_list: Vec<SearchHit>,
    /// 未知应用建议（query 未匹配到任何应用时）。
    pub unknown_app: Option<String>,
    /// 是否命中 fuzzy。
    pub has_fuzzy: bool,
    /// 是否命中 meta。
    pub has_meta: bool,
    /// 是否命中 tfidf。
    pub has_tfidf: bool,
    /// 是否命中 trie。
    pub has_trie: bool,
    /// 是否命中 semantic。
    pub has_semantic: bool,
    /// 搜索模式。
    pub mode: SearchMode,
    /// 模式映射（query → mode 概率，PRO 用）。
    #[serde(default)]
    pub mode_map: Vec<(String, f64)>,
    /// 分数映射（app → score，用于上游调试）。
    #[serde(default)]
    pub scores: Vec<(String, f64)>,
}

// ─── 学习层：记忆 / 待索引 ──────────────────────────────────────────────────

/// 一条记忆记录（对应 JS memory 数组中的元素）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MemoryRecord {
    pub query: String,
    pub app: String,
    /// 时间戳（毫秒）。
    pub ts: u64,
    /// 该次选择对应的 tokens（用于关联分析）。
    #[serde(default)]
    pub tokens: Vec<String>,
    /// 该次选择的意图分类。
    #[serde(default)]
    pub intent: String,
    /// 时段分桶（morning/afternoon/evening/night）。
    #[serde(default)]
    pub bucket: String,
}

/// 待索引库条目（低权重应用，等待用户多次选择后转正）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PendingEntry {
    pub app: String,
    pub query: String,
    pub count: u32,
    pub first_ts: u64,
    pub last_ts: u64,
    /// 转正阈值（达到后会被加入 catalog）。
    pub threshold: u32,
}

// ─── 权重层 ────────────────────────────────────────────────────────────────

/// 单个 query 对各 app 的偏好分。
pub type RuleWeights = Vec<(String, Vec<(String, f64)>)>;

/// 规则统计（每个 query→app 的点击次数 + 最后点击时间）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RuleStats {
    pub query: String,
    pub app: String,
    pub clicks: u32,
    pub last_ts: u64,
}

// ─── 负面层 ────────────────────────────────────────────────────────────────

/// 一条 block flag（屏蔽某 query 的某 app）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BlockFlag {
    pub query: String,
    pub app: String,
    /// 过期时间戳（毫秒），0 表示永不过期。
    pub expire_ts: u64,
    /// 创建时间戳。
    pub created_ts: u64,
    /// 屏蔽天数。
    pub days: u32,
}

/// 负面反馈状态。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NegativeState {
    #[serde(default)]
    pub flags: Vec<BlockFlag>,
    /// 用户主动踩过的 app（永久降低权重）。
    #[serde(default)]
    pub dislikes: Vec<(String, f64)>,
}

// ─── 自愈层 ────────────────────────────────────────────────────────────────

/// 自愈历史记录（每个 query 最多保留 10 条）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SelfHealingEntry {
    pub query: String,
    pub original_app: String,
    pub new_app: String,
    pub ts: u64,
    /// 临时屏蔽的原 app 列表。
    #[serde(default)]
    pub suppressed: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SelfHealingState {
    #[serde(default)]
    pub history: Vec<SelfHealingEntry>,
}

// ─── 关联层（动作链） ──────────────────────────────────────────────────────

/// 一条动作链边（A→B 的转移权重）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChainEdge {
    pub from: String,
    pub to: String,
    pub weight: f64,
    pub count: u32,
    pub last_ts: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChainStore {
    #[serde(default)]
    pub edges: Vec<ChainEdge>,
}

// ─── 统计层 ────────────────────────────────────────────────────────────────

/// 四时段统计（上午/下午/晚上/凌晨）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HourlyStats {
    pub morning: Vec<(String, u32)>,
    pub afternoon: Vec<(String, u32)>,
    pub evening: Vec<(String, u32)>,
    pub night: Vec<(String, u32)>,
}

/// 单条小时统计（用于热力图 / Top N）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HourBucket {
    /// "h-HH" 格式（如 "h-14"）。
    pub h: String,
    pub app: String,
    pub count: u32,
    pub ts: u64,
}

/// 快捷气泡推荐。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct QuickBubble {
    pub app: String,
    pub score: f64,
    pub label: String,
}

/// 单个 app 的聚合统计（对应 JS `goto_app_stats[appId]`）。
///
/// JS 端结构：`{ uses: N, lastHour: {...}, history: [[ts, appId]], hourly: {"YYYY-MM-DD-HH": count} }`。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HourlyStatsAgg {
    /// 累计启动次数。
    #[serde(default)]
    pub uses: u32,
    /// 历史 hourly 分布：`"YYYY-MM-DD-HH"` → count。
    #[serde(default)]
    pub hourly: BTreeMap<String, u32>,
    /// 最后启动小时（"h-HH"）。
    #[serde(default)]
    pub last_hour: BTreeMap<String, u32>,
    /// 启动历史：`(timestamp, appId)` 列表（最近 N 条）。
    #[serde(default)]
    pub history: Vec<(u64, String)>,
}

// ─── PRO / 上下文层 ─────────────────────────────────────────────────────────

/// 65 维用户偏好向量（PRO 模式核心）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UserPreference {
    /// 65 维向量（每个维度对应一个意图 / 分类 / 时段 / 操作习惯）。
    #[serde(default)]
    pub vector: Vec<f64>,
    /// 最后更新时间。
    pub last_ts: u64,
    /// 总样本数。
    pub samples: u32,
}

/// 微上下文（最近 N 次操作）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MicroContext {
    #[serde(default)]
    pub recent_apps: Vec<String>,
    #[serde(default)]
    pub recent_queries: Vec<String>,
    pub click_delay_ema: f64,
    pub last_mode: String,
    pub last_ts: u64,
}

/// 悬浮窗状态。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FloatWindowState {
    pub enabled: bool,
    pub current_app: String,
    pub suggested_app: String,
    pub suggestion_score: f64,
    pub last_ts: u64,
}

/// 全局偏好（跨 query 的全局权重）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GlobalPreference {
    #[serde(default)]
    pub app_weights: Vec<(String, f64)>,
    #[serde(default)]
    pub cat_weights: Vec<(String, f64)>,
    pub last_ts: u64,
}

/// 模式频次（Standard/Pro/Float/SmartReminder 各自的使用次数）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModeFrequency {
    pub standard: u32,
    pub pro: u32,
    pub float: u32,
    pub smart_reminder: u32,
}

/// 周期时间戳（用于检测使用周期，如每日 / 每周）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CycleTimestamps {
    #[serde(default)]
    pub timestamps: Vec<u64>,
}

// ─── 贝叶斯 ────────────────────────────────────────────────────────────────

/// 一条贝叶斯规则（query → app 的条件概率）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BayesRule {
    pub query: String,
    pub app: String,
    /// P(app|query)。
    pub probability: f64,
    /// 样本数。
    pub samples: u32,
    /// 时段分桶（4 桶，每桶一个概率）。
    #[serde(default)]
    pub bucket_probs: Vec<(String, f64)>,
    pub first_ts: u64,
    pub last_ts: u64,
    /// 意图分类。
    #[serde(default)]
    pub intent: String,
    /// 来源（user / smart / system）。
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BayesTable {
    #[serde(default)]
    pub rules: Vec<BayesRule>,
}

// ─── 智能提醒 ───────────────────────────────────────────────────────────────

/// 智能提醒推荐结果。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SmartReminderSuggestion {
    pub app: String,
    pub score: f64,
    /// 推荐理由（用于通知文案）。
    pub reason: String,
    /// 来源（hourly / chain / global / bayes）。
    pub source: String,
}

// ─── 维护报告 ──────────────────────────────────────────────────────────────

/// 维护报告（对应 JS `maintain()` 返回值）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MaintenanceReport {
    pub decayed_queries: usize,
    pub pruned_chain_edges: usize,
    pub pruned_memory_records: usize,
    pub cleared_block_flags: usize,
    pub duration_ms: u64,
}

// ─── Component API ─────────────────────────────────────────────────────────

/// Component API 的事件类型。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum EngineEvent {
    Search { query: String },
    Selection { query: String, app: String },
    IndexRebuilt,
    MaintenanceDone,
    SmartReminderShown { app: String },
    SmartReminderAccepted { app: String },
    SmartReminderRejected { app: String },
    FloatWindowShown { app: String },
    BayesUpdated { query: String, app: String },
}

/// Component API 的统一响应封装。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComponentResponse<T: Serialize> {
    pub ok: bool,
    pub data: Option<T>,
    pub error: Option<String>,
    pub version: &'static str,
}

impl<T: Serialize> ComponentResponse<T> {
    pub fn ok(data: T) -> Self {
        Self {
            ok: true,
            data: Some(data),
            error: None,
            version: crate::API_VERSION,
        }
    }

    pub fn err(msg: &str) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(msg.into()),
            version: crate::API_VERSION,
        }
    }
}
