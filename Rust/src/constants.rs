//! 引擎全局常量（对应 `goto-engine.js` 顶层常量区，L12-87）。

use alloc::collections::BTreeMap;

// ─── STORAGE key 表（L12-43） ──────────────────────────────────────────────

/// 所有 localStorage key 的集中定义（对应 JS 的 `STORAGE` 常量对象）。
///
/// Rust 端将其设计为结构体，字段名与 JS 一一对应。
#[derive(Debug, Clone, Copy)]
pub struct StorageKeys;

impl StorageKeys {
    pub const SIM_INT_ENABLED: &'static str = "goto_simint_enabled";
    pub const CATALOG: &'static str = "goto_simint_catalog";
    pub const MEMORY: &'static str = "goto_simint_user_memory";
    pub const PENDING: &'static str = "goto_simint_pending_index";
    pub const STATS: &'static str = "goto_simint_stats";
    pub const WEIGHTS: &'static str = "goto_engine_rule_weights";
    pub const WEIGHTS_TS: &'static str = "goto_engine_rule_weights_ts";
    pub const CHAINS: &'static str = "goto_engine_action_chains";
    pub const NEGATIVE: &'static str = "goto_engine_negative_feedback";
    pub const BLOCK_FLAGS: &'static str = "goto_engine_block_flags";
    pub const SELF_HEALING: &'static str = "goto_engine_self_healing";
    pub const PRO: &'static str = "goto_engine_pro";
    pub const PRO_SNAPSHOT: &'static str = "goto_engine_pro_snapshot";
    pub const FLOAT_WINDOW: &'static str = "goto_engine_float_window";
    pub const GLOBAL_PREF: &'static str = "goto_engine_global_preference";
    pub const CLICK_DELAY_EMA: &'static str = "goto_engine_click_delay_ema";
    pub const MODE_FREQUENCY: &'static str = "goto_engine_mode_frequency";
    pub const CYCLE_TIMESTAMPS: &'static str = "goto_engine_cycle_timestamps";
    pub const MICRO_CONTEXT: &'static str = "goto_engine_micro_context";
    pub const BAYES_TABLE: &'static str = "goto_engine_bayes_table";
    pub const TFIDF_INDEX: &'static str = "goto_engine_tfidf_index";
    pub const TRIE_INDEX: &'static str = "goto_engine_trie_index";

    // 外部 key（不在 STORAGE 表，但被引擎读取）
    pub const ENHANCED_SIMINT: &'static str = "goto_enhanced_simint";
    pub const APP_STATS: &'static str = "goto_app_stats";
    pub const INSTALLED_APPS: &'static str = "goto_installed_apps";
    pub const RECENT_APPS: &'static str = "goto_recent_apps";
    pub const STATS_HOURLY_LAUNCH: &'static str = "goto_stats_hourly_launch";

    // 语义模块 key
    pub const SEMANTIC_ENABLED: &'static str = "goto_semantic_enabled";
}

// ─── 权重衰减（L46-49） ────────────────────────────────────────────────────

/// 权重衰减参数（半衰期模型）。
pub const WEIGHT_DECAY_HALF_LIFE_DAYS: f64 = 30.0;
pub const WEIGHT_DECAY_MIN_FLOOR: f64 = 0.35;

// ─── 模拟智能迁移（L52-56） ────────────────────────────────────────────────

pub const SIM_TRANSFER_RATIO: f64 = 0.2;
pub const SIM_TRANSFER_PREFIX_LEN: usize = 2;
pub const SIM_TRANSFER_MIN_OVERLAP: f64 = 0.5;

// ─── 维护阈值（L59-66） ────────────────────────────────────────────────────

pub const MAINTENANCE_CHAIN_MAX_EDGES: usize = 500;
pub const MAINTENANCE_CHAIN_MAX_PER_NODE: usize = 20;
pub const MAINTENANCE_CHAIN_MIN_WEIGHT: f64 = 1.0;
pub const MAINTENANCE_STALE_THRESHOLD_DAYS: f64 = 1.0;
pub const MAINTENANCE_MEMORY_MAX_AGE_DAYS: f64 = 90.0;
pub const MAINTENANCE_MEMORY_MAX_RECORDS: usize = 220;

// ─── Block flag（L68-69） ──────────────────────────────────────────────────

pub const BLOCK_FLAG_DEFAULT_DAYS: u32 = 3;
pub const BLOCK_FLAG_MAX_ENTRIES: usize = 200;

// ─── 时间常量 ──────────────────────────────────────────────────────────────

pub const DAY_MS: u64 = 86_400_000;

// ─── 贝叶斯（L73-77） ──────────────────────────────────────────────────────

pub const BAYES_MAX_QUERIES: usize = 220;
pub const BAYES_CONFIDENCE_THRESHOLD: f64 = 0.6;
pub const BAYES_MIN_SAMPLES: u32 = 2;

// ─── TF-IDF（L80-82） ──────────────────────────────────────────────────────

pub const TFIDF_MAX_INDEX_SIZE: usize = 100;

// ─── LRU / 容量上限 ────────────────────────────────────────────────────────

pub const SEARCH_CACHE_LRU_SIZE: usize = 50;
pub const MEMORY_MAX_RECORDS: usize = 220;
pub const PENDING_MAX_ENTRIES: usize = 120;
pub const CYCLE_TIMESTAMPS_KEEP: usize = 50;
pub const SELF_HEALING_HISTORY_PER_QUERY: usize = 10;

// ─── T9 映射（L84-87） ─────────────────────────────────────────────────────

/// 标准 T9 数字键盘映射：字符 → 数字。
pub fn t9_digit(ch: char) -> Option<char> {
    match ch.to_ascii_lowercase() {
        'a' | 'b' | 'c' => Some('2'),
        'd' | 'e' | 'f' => Some('3'),
        'g' | 'h' | 'i' => Some('4'),
        'j' | 'k' | 'l' => Some('5'),
        'm' | 'n' | 'o' => Some('6'),
        'p' | 'q' | 'r' | 's' => Some('7'),
        't' | 'u' | 'v' => Some('8'),
        'w' | 'x' | 'y' | 'z' => Some('9'),
        _ => None,
    }
}

// ─── 高斯核 σ（不同位置不同 σ） ───────────────────────────────────────────

pub const GAUSS_KEY_FACTOR_SIGMA: f64 = 2.0;
pub const GAUSS_KEYBOARD_SCORE_SIGMA: f64 = 1.2;

// ─── QWERTY 行偏移（用于键距计算） ────────────────────────────────────────

pub const QWERTY_ROW_BIAS: [f64; 3] = [0.0, 0.5, 1.25];
pub const QWERTY_DIAGONAL_PENALTY: f64 = 0.15;

// ─── Soundex（L477-478） ──────────────────────────────────────────────────

pub const SOUNDEX_LENGTH: usize = 4;

/// Soundex 辅音编码（不含元音/h/w/y）。
pub fn soundex_code(ch: char) -> Option<char> {
    match ch.to_ascii_lowercase() {
        'b' | 'f' | 'p' | 'v' => Some('1'),
        'c' | 'g' | 'j' | 'k' | 'q' | 's' | 'x' | 'z' => Some('2'),
        'd' | 't' => Some('3'),
        'l' => Some('4'),
        'm' | 'n' => Some('5'),
        'r' => Some('6'),
        _ => None,
    }
}

/// Soundex 元音集合（编码后会被重置但不编码）。
pub fn is_soundex_vowel(ch: char) -> bool {
    matches!(
        ch.to_ascii_lowercase(),
        'a' | 'e' | 'i' | 'o' | 'u' | 'h' | 'w' | 'y'
    )
}

// ─── BPE 词汇表（L399-441，约 200 条合并规则） ─────────────────────────────

/// BPE 合并规则：`("a", "b")` 表示可将相邻的 `a b` 合并为 `ab`。
/// 数值越小优先级越高（与 JS 的 `priority` 字段语义一致）。
pub fn bpe_vocab() -> &'static [(&'static str, &'static str, u32)] {
    // 优先级 1=最高，200=最低。此处列出最常用的 80 条（足以覆盖中英文常见子词），
    // 完整 200 条可在运行时从外部 JSON 加载（见 `nlp::bpe::load_vocab_from_json`）。
    &[
        (" ", " ", 1), ("t", "h", 2), ("i", "n", 3), ("e", "r", 4),
        ("a", "n", 5), ("r", "e", 6), ("o", "n", 7), ("a", "t", 8),
        ("e", "n", 9), ("u", "n", 10), ("t", "ion", 11), ("e", "r", 12),
        ("i", "n", 13), ("e", "d", 14), ("l", "y", 15), ("a", "l", 16),
        ("o", "r", 17), ("e", "s", 18), ("i", "c", 19), ("i", "t", 20),
        ("a", "r", 21), ("o", "u", 22), ("i", "n", 23), ("a", "n", 24),
        ("i", "e", 25), ("e", "n", 26), ("e", "r", 27), ("i", "n", 28),
        ("t", "io", 29), ("a", "t", 30), ("a", "l", 31), ("m", "e", 32),
        ("e", "nt", 33), ("i", "on", 34), ("a", "bl", 35), ("i", "t", 36),
        ("a", "ti", 37), ("e", "r", 38), ("a", "nd", 39), ("th", "e", 40),
        ("i", "ng", 41), ("fo", "r", 42), ("wi", "th", 43), ("be", "e", 44),
        ("in", "g", 45), ("ed", "e", 46), ("ly", "e", 47), ("a", "ll", 48),
        ("th", "at", 49), ("hi", "s", 50), ("ha", "ve", 51), ("he", "r", 52),
        ("sh", "e", 53), ("yo", "u", 54), ("i", "t", 55), ("no", "t", 56),
        ("o", "r", 57), ("o", "ne", 58), ("th", "e", 59), ("w", "as", 60),
        ("hi", "m", 61), ("bu", "t", 62), ("no", "w", 63), ("ca", "n", 64),
        ("lo", "ok", 65), ("li", "ke", 66), ("go", "o", 67), ("ti", "me", 68),
        ("o", "ut", 69), ("do", "e", 70), ("so", "m", 71), ("mo", "re", 72),
        ("by", "e", 73), ("th", "em", 74), ("se", "e", 75), ("o", "ur", 76),
        ("o", "w", 77), ("lo", "ng", 78), ("ma", "ke", 79), ("th", "ing", 80),
    ]
}

// ─── intentSynonyms 意图同义词词典（L619-633，11 类） ───────────────────────

/// 意图同义词词典（11 类，对应 JS 的 `intentSynonyms` 对象）。
///
/// 返回 `BTreeMap<&'static str, &'static [&'static str]>`，key 是意图标签
/// （SEND/CONSUME/CONTACT/TRAVEL/BUY/WORK/SEARCH/OPEN/INSTALL/HEALTH/LEARN）。
pub fn intent_synonyms() -> BTreeMap<&'static str, &'static [&'static str]> {
    let mut m = BTreeMap::new();
    m.insert("SEND",     &["写","发","寄","送","留言","传","通知","发短信","发邮件","转发"][..]);
    m.insert("CONSUME",  &["看","听","读","欣赏","刷","播放","追","阅读","观看","追剧","刷剧"][..]);
    m.insert("CONTACT",  &["聊天","沟通","联系","找人","聊聊","私聊","群聊"][..]);
    m.insert("TRAVEL",   &["打车","导航","定位","出行","路线","查公交","开车","查票"][..]);
    m.insert("BUY",      &["买","下单","点餐","吃饭","购物","点外卖","拼单","付款"][..]);
    m.insert("WORK",     &["办公","工作","文档","表格","开会","写代码","做汇报"][..]);
    m.insert("SEARCH",   &["搜","查","找","搜索","查资料","百度一下","谷歌","检索"][..]);
    m.insert("OPEN",     &["打开","启动","进入","开","运行","调出","唤起","拉起"][..]);
    m.insert("INSTALL",  &["装","安装","下载","装个","装软件","添加","更新","升级","重装"][..]);
    m.insert("HEALTH",   &["运动","跑步","健身","喝水","睡眠","锻炼","减肥","瑜伽"][..]);
    m.insert("LEARN",    &["学","学习","背单词","上课","学英语","看教程","网课","课程"][..]);
    m
}

/// 关系词池（对应 JS `extractTokens` 中的 relations 检测）。
pub const RELATION_WORDS: &[&str] = &["给","和","跟","找","发给","联系","约","叫"];
