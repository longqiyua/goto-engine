//! PRO 进阶模式（对应 `goto-engine.js` `getProState` / `saveProState` /
//! `enablePro` / `disablePro` / `getProSnapshot` / `refreshProSnapshot` /
//! `_getProContextBoost` / `_getMicroContextBoost` / `_bumpGlobalPreference` +
//! 65 维用户偏好向量）。
//!
//! PRO 模式联合设备信号（电量 / 信号 / 位置）+ 微上下文（屏幕使用 / 应用切换 /
//! 剪贴板 / 设备型号）+ 65 维用户偏好向量，给出更激进的 boost。

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use alloc::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::constants::StorageKeys;
use crate::storage::Storage;
use crate::types::{AppItem, GlobalPreference, MicroContext, ModeFrequency, UserPreference};
use crate::utils::{get_hour, now_ts};

// ─── PRO 状态 ───────────────────────────────────────────────────────────────

/// PRO 模式状态（对应 JS `getProState()`）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProState {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub location: Option<ProLocation>,
    #[serde(default)]
    pub battery: Option<ProBattery>,
    #[serde(default)]
    pub signal: Option<ProSignal>,
    #[serde(default)]
    pub last_refresh: u64,
}

/// 位置信息。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProLocation {
    pub lat: f64,
    pub lng: f64,
    pub accuracy: f64,
    pub granted: bool,
    pub granted_at: u64,
    pub mode: String,
}

/// 电量信息。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProBattery {
    pub level: f64,
    pub charging: bool,
    pub granted: bool,
    pub updated: u64,
}

/// 信号信息。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProSignal {
    pub effective_type: String,
    pub downlink: f64,
    pub rtt: u32,
    pub updated: u64,
}

/// PRO 快照（对应 JS `getProSnapshot()`）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProSnapshot {
    pub time: String,
    pub hour: u32,
    pub language: String,
    pub online: bool,
    pub memory: Option<f64>,
    pub cores: Option<u32>,
    pub connection: Option<ProSignal>,
    pub pro_enabled: bool,
    pub location: Option<ProLocation>,
    pub battery: Option<ProBattery>,
    pub signal: Option<ProSignal>,
}

// ─── 65 维偏好向量 ─────────────────────────────────────────────────────────

/// 65 维偏好向量的维度定义（与 JS 端 `_ensurePreferenceVector` 一致）。
///
/// 维度分布：
/// - 0..=10  : 11 类意图（SEND/CONSUME/CONTACT/TRAVEL/BUY/WORK/SEARCH/OPEN/INSTALL/HEALTH/LEARN）
/// - 11..=29 : 19 类应用分类（通讯/视频/音乐/购物/办公/游戏/浏览器/工具/社交/学习/健康/旅行/新闻/阅读/拍照/支付/系统/生活/其他）
/// - 30..=53 : 24 小时段
/// - 54..=57 : 4 种操作模式（Standard/Pro/Float/SmartReminder）
/// - 58..=64 : 7 种操作习惯（点击延迟 / 搜索长度 / 选择速度 / 滚动距离 / 错误率 / 多次点击 / 长按）
pub const PREFERENCE_DIM: usize = 65;

pub const INTENT_DIMS: usize = 11;
pub const CATEGORY_DIMS: usize = 19;
pub const HOUR_DIMS: usize = 24;
pub const MODE_DIMS: usize = 4;
pub const HABIT_DIMS: usize = 7;

/// 11 类意图标签。
pub const INTENT_LABELS: &[&str] = &[
    "SEND", "CONSUME", "CONTACT", "TRAVEL", "BUY",
    "WORK", "SEARCH", "OPEN", "INSTALL", "HEALTH", "LEARN",
];

/// 19 类应用分类。
pub const CATEGORY_LABELS: &[&str] = &[
    "通讯", "视频", "音乐", "购物", "办公", "游戏", "浏览器", "工具",
    "社交", "学习", "健康", "旅行", "新闻", "阅读", "拍照", "支付",
    "系统", "生活", "其他",
];

// ─── 管理器 ─────────────────────────────────────────────────────────────────

/// PRO 模式管理器。
#[derive(Debug)]
pub struct ProManager<'a, S: Storage + ?Sized> {
    storage: &'a S,
}

impl<'a, S: Storage + ?Sized> ProManager<'a, S> {
    pub fn new(storage: &'a S) -> Self { Self { storage } }

    /// `getProState()`：读取 PRO 状态。
    pub fn get_state(&self) -> ProState {
        self.storage.read_json(StorageKeys::PRO, ProState::default())
    }

    /// `saveProState(state)`：保存 PRO 状态。
    pub fn save_state(&self, state: &ProState) {
        self.storage.write_json(StorageKeys::PRO, state);
    }

    /// `isProEnabled()`：PRO 是否启用。
    pub fn is_enabled(&self) -> bool {
        self.get_state().enabled
    }

    /// `setProEnabled(enabled)`：开关 PRO。
    pub fn set_enabled(&self, enabled: bool) -> bool {
        let mut s = self.get_state();
        s.enabled = enabled;
        self.save_state(&s);
        if enabled {
            // 触发快照刷新
            self.refresh_snapshot();
        }
        s.enabled
    }

    /// `getProSnapshot()`：生成 PRO 快照（不含 navigator 在 Rust 端不可用，留空）。
    pub fn get_snapshot(&self) -> ProSnapshot {
        let pro = self.get_state();
        let hour = get_hour();
        ProSnapshot {
            time: current_iso_time(),
            hour,
            language: "zh-CN".to_string(),
            online: true,
            memory: None,
            cores: None,
            connection: pro.signal.clone(),
            pro_enabled: pro.enabled,
            location: pro.location.clone(),
            battery: pro.battery.clone(),
            signal: pro.signal.clone(),
        }
    }

    /// `refreshProSnapshot()`：刷新快照（在 Rust 端只更新时间戳与 last_refresh）。
    pub fn refresh_snapshot(&self) -> ProState {
        let mut s = self.get_state();
        s.last_refresh = now_ts();
        self.save_state(&s);
        let _ = self.get_snapshot();
        s
    }

    /// `_getProContextBoost(query, app)`：PRO 上下文加权。
    ///
    /// 根据电量 / 信号 / 位置对 app 加分或减分。
    pub fn context_boost(&self, _query: &str, app: &AppItem) -> f64 {
        let pro = self.get_state();
        if !pro.enabled { return 0.0; }
        let mut boost = 0.0f64;
        let app_name = app.name.to_lowercase();
        let cat = app.cat.to_lowercase();
        let is_heavy_media = is_heavy_media(&app_name, &cat);
        let is_game = is_game(&app_name, &cat);

        // 电量
        if let Some(battery) = &pro.battery {
            if battery.granted {
                let level = battery.level;
                let charging = battery.charging;
                if level < 0.2 && !charging {
                    if is_heavy_media { boost -= 30.0; }
                    if is_game { boost -= 40.0; }
                }
            }
        }

        // 信号
        if let Some(signal) = &pro.signal {
            let et = signal.effective_type.to_lowercase();
            if et == "2g" || et == "slow-2g" || signal.rtt > 500 {
                if is_heavy_media { boost -= 25.0; }
            }
        }

        boost
    }

    /// `_getMicroContextBoost(query, app)`：微上下文加权。
    pub fn micro_context_boost(&self, query: &str, app: &AppItem) -> f64 {
        let mc: MicroContext = self.storage.read_json(StorageKeys::MICRO_CONTEXT, MicroContext::default());
        let mut boost = 0.0f64;
        let app_name = app.name.to_lowercase();
        let cat = app.cat.to_lowercase();
        let hour = get_hour();

        // 1. 手机使用情况权重
        let screen_min = 0u32; // Rust 端无 navigator，需要外部注入
        let switch_count = 0u32;
        let is_entertainment = is_heavy_media(&app_name, &cat) || is_game(&app_name, &cat);
        let is_productivity = is_productivity(&app_name, &cat);

        if screen_min > 120 {
            if is_entertainment { boost += 25.0; }
            if is_productivity { boost -= 10.0; }
        }
        if switch_count > 8 {
            if is_productivity { boost += 20.0; }
            if is_entertainment { boost -= 15.0; }
        }

        // 2. 时间权重（增强版时段感知）
        if hour < 6 {
            if app_name.contains("时钟") || app_name.contains("闹钟") || app_name.contains("睡眠") {
                boost += 35.0;
            }
            if app_name.contains("视频") || app_name.contains("游戏") {
                boost -= 20.0;
            }
        } else if hour >= 22 {
            if app_name.contains("阅读") || app_name.contains("书") || app_name.contains("新闻") {
                boost += 20.0;
            }
        } else if (7..9).contains(&hour) {
            if app_name.contains("新闻") || app_name.contains("地图") || app_name.contains("公交") {
                boost += 25.0;
            }
        }

        let _ = query; let _ = mc;
        boost
    }

    /// `getGlobalPreference()`：读取全局偏好（跨 query 的全局权重）。
    pub fn get_global_preference(&self) -> GlobalPreference {
        self.storage.read_json(StorageKeys::GLOBAL_PREF, GlobalPreference::default())
    }

    /// `saveGlobalPreference(map)`：保存全局偏好。
    pub fn save_global_preference(&self, pref: &GlobalPreference) {
        self.storage.write_json(StorageKeys::GLOBAL_PREF, pref);
    }

    /// `_bumpGlobalPreference(appName)`：全局偏好递增（被点击的 app 在所有查询中增加偏好值）。
    pub fn bump_global_preference(&self, app_name: &str) {
        if app_name.is_empty() { return; }
        let mut pref = self.get_global_preference();
        if let Some(item) = pref.app_weights.iter_mut().find(|(a, _)| a == app_name) {
            item.1 = (item.1 + 0.05).min(1.0);
        } else {
            pref.app_weights.push((app_name.to_string(), 0.55));
        }
        pref.last_ts = now_ts();
        self.save_global_preference(&pref);
    }

    /// 获取某 app 的全局偏好权重。
    pub fn get_app_global_weight(&self, app: &str) -> f64 {
        let pref = self.get_global_preference();
        pref.app_weights.iter()
            .find(|(a, _)| a == app)
            .map(|(_, w)| *w)
            .unwrap_or(0.5)
    }

    // ─── 65 维用户偏好向量 ──────────────────────────────────────────────────

    /// 读取用户偏好向量。
    pub fn get_user_preference(&self) -> UserPreference {
        let mut pref: UserPreference = self.storage.read_json(StorageKeys::PRO, UserPreference::default());
        if pref.vector.len() != PREFERENCE_DIM {
            pref.vector = vec![0.0; PREFERENCE_DIM];
        }
        pref
    }

    /// 保存用户偏好向量。
    pub fn save_user_preference(&self, pref: &UserPreference) {
        self.storage.write_json(StorageKeys::PRO, pref);
    }

    /// 更新偏好向量（基于一次观测）。
    pub fn update_preference(
        &self,
        intent: Option<&str>,
        category: Option<&str>,
        hour: Option<u32>,
        mode: Option<&str>,
        habit_deltas: &[f64],
    ) {
        let mut pref = self.get_user_preference();
        let vector = &mut pref.vector;

        if let Some(label) = intent {
            if let Some(idx) = INTENT_LABELS.iter().position(|&l| l == label) {
                vector[idx] = (vector[idx] + 0.05).min(1.0);
            }
        }
        if let Some(cat) = category {
            if let Some(idx) = CATEGORY_LABELS.iter().position(|&l| l == cat) {
                vector[INTENT_DIMS + idx] = (vector[INTENT_DIMS + idx] + 0.05).min(1.0);
            }
        }
        if let Some(h) = hour {
            let idx = INTENT_DIMS + CATEGORY_DIMS + (h as usize % HOUR_DIMS);
            vector[idx] = (vector[idx] + 0.05).min(1.0);
        }
        if let Some(m) = mode {
            let mode_idx = match m {
                "Standard" => 0,
                "Pro" => 1,
                "Float" => 2,
                "SmartReminder" => 3,
                _ => 0,
            };
            let idx = INTENT_DIMS + CATEGORY_DIMS + HOUR_DIMS + mode_idx;
            vector[idx] = (vector[idx] + 0.05).min(1.0);
        }
        // habit_deltas 直接覆盖 7 个习惯维度
        let habit_start = INTENT_DIMS + CATEGORY_DIMS + HOUR_DIMS + MODE_DIMS;
        for (i, &v) in habit_deltas.iter().enumerate() {
            if i >= HABIT_DIMS { break; }
            vector[habit_start + i] = v;
        }

        pref.samples = pref.samples.saturating_add(1);
        pref.last_ts = now_ts();
        self.save_user_preference(&pref);
    }

    /// 计算偏好向量与 app 元数据的余弦相似度（用于推荐排序）。
    pub fn cosine_similarity(&self, app: &AppItem) -> f64 {
        let pref = self.get_user_preference();
        let vector = &pref.vector;
        if vector.is_empty() { return 0.0; }

        // 构造 app 的 65 维 one-hot 向量
        let mut app_vec = vec![0.0; PREFERENCE_DIM];
        if let Some(idx) = CATEGORY_LABELS.iter().position(|&l| l == app.cat) {
            app_vec[INTENT_DIMS + idx] = 1.0;
        }
        let hour = get_hour() as usize;
        app_vec[INTENT_DIMS + CATEGORY_DIMS + (hour % HOUR_DIMS)] = 1.0;

        let dot: f64 = vector.iter().zip(app_vec.iter()).map(|(a, b)| a * b).sum();
        let mag_a: f64 = vector.iter().map(|v| v * v).sum::<f64>().sqrt();
        let mag_b: f64 = app_vec.iter().map(|v| v * v).sum::<f64>().sqrt();
        if mag_a == 0.0 || mag_b == 0.0 { return 0.0; }
        dot / (mag_a * mag_b)
    }

    // ─── 模式频次 ───────────────────────────────────────────────────────────

    /// 读取模式频次。
    pub fn get_mode_frequency(&self) -> ModeFrequency {
        self.storage.read_json(StorageKeys::MODE_FREQUENCY, ModeFrequency::default())
    }

    /// 记录一次模式使用。
    pub fn record_mode_use(&self, mode: &str) {
        let mut freq = self.get_mode_frequency();
        match mode {
            "Standard" => freq.standard += 1,
            "Pro" => freq.pro += 1,
            "Float" => freq.float += 1,
            "SmartReminder" => freq.smart_reminder += 1,
            _ => {}
        }
        self.storage.write_json(StorageKeys::MODE_FREQUENCY, &freq);
    }

    // ─── 悬浮窗状态 ─────────────────────────────────────────────────────────

    /// 读取悬浮窗状态。
    pub fn get_float_window_state(&self) -> crate::types::FloatWindowState {
        self.storage.read_json(StorageKeys::FLOAT_WINDOW, crate::types::FloatWindowState::default())
    }

    /// 保存悬浮窗状态。
    pub fn save_float_window_state(&self, state: &crate::types::FloatWindowState) {
        self.storage.write_json(StorageKeys::FLOAT_WINDOW, state);
    }
}

// ─── 辅助函数 ───────────────────────────────────────────────────────────────

fn is_heavy_media(app_name: &str, cat: &str) -> bool {
    let patterns = ["视频", "抖音", "b站", "youtube", "netflix", "音乐", "网易云", "qq音乐", "spotify"];
    patterns.iter().any(|p| app_name.contains(p)) || cat.contains("视频") || cat.contains("音乐")
}

fn is_game(app_name: &str, cat: &str) -> bool {
    let patterns = ["王者", "和平精英", "原神", "游戏", "steam"];
    patterns.iter().any(|p| app_name.contains(p)) || cat.contains("游戏")
}

fn is_productivity(app_name: &str, cat: &str) -> bool {
    let patterns = ["笔记", "文档", "wps", "office", "邮箱", "日历", "待办"];
    patterns.iter().any(|p| app_name.contains(p)) || cat.contains("工具") || cat.contains("效率")
}

#[cfg(feature = "std")]
fn current_iso_time() -> String {
    use chrono::Utc;
    Utc::now().to_rfc3339()
}

#[cfg(not(feature = "std"))]
fn current_iso_time() -> String { String::new() }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::MemoryStorage;

    #[test]
    fn test_pro_state_default() {
        let s = MemoryStorage::new();
        let mgr = ProManager::new(&s);
        assert!(!mgr.is_enabled());
    }

    #[test]
    fn test_enable_disable() {
        let s = MemoryStorage::new();
        let mgr = ProManager::new(&s);
        assert!(mgr.set_enabled(true));
        assert!(mgr.is_enabled());
        assert!(!mgr.set_enabled(false));
        assert!(!mgr.is_enabled());
    }

    #[test]
    fn test_bump_global_preference() {
        let s = MemoryStorage::new();
        let mgr = ProManager::new(&s);
        mgr.bump_global_preference("微信");
        assert!(mgr.get_app_global_weight("微信") > 0.5);
    }

    #[test]
    fn test_user_preference_dimensions() {
        let s = MemoryStorage::new();
        let mgr = ProManager::new(&s);
        let pref = mgr.get_user_preference();
        assert_eq!(pref.vector.len(), PREFERENCE_DIM);
    }

    #[test]
    fn test_update_preference() {
        let s = MemoryStorage::new();
        let mgr = ProManager::new(&s);
        mgr.update_preference(Some("SEND"), Some("通讯"), Some(14), Some("Standard"), &[0.5]);
        let pref = mgr.get_user_preference();
        assert!(pref.vector[0] > 0.0); // SEND 意图
        assert!(pref.vector[INTENT_DIMS] > 0.0); // 通讯 分类
        assert_eq!(pref.samples, 1);
    }

    #[test]
    fn test_record_mode_use() {
        let s = MemoryStorage::new();
        let mgr = ProManager::new(&s);
        mgr.record_mode_use("Standard");
        mgr.record_mode_use("Pro");
        mgr.record_mode_use("Standard");
        let freq = mgr.get_mode_frequency();
        assert_eq!(freq.standard, 2);
        assert_eq!(freq.pro, 1);
    }

    #[test]
    fn test_context_boost_disabled() {
        let s = MemoryStorage::new();
        let mgr = ProManager::new(&s);
        let app = AppItem { name: "微信".into(), cat: "通讯".into(), ..Default::default() };
        // PRO 未启用 → boost 应为 0
        assert_eq!(mgr.context_boost("test", &app), 0.0);
    }
}
