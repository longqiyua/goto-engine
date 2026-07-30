//! L1 自适应刷新层（对应 Kotlin `AdaptiveRefresh/TypingSpeedTracker.kt` +
//! `AdaptiveRefresh/SearchOrchestrator.kt`，以及 JS `algorithms/adaptive-refresh.js`）。
//!
//! ## 核心职责
//!
//! 1. 【打字速度追踪】`TypingSpeedTracker`：记录按键间隔，输出 EMA 速度与
//!    防抖/节流时间。公式与 Kotlin 版完全一致：
//!    - 防抖 t1 = clamp(P_max × (1 + E), T_avg × 2, 400ms)
//!    - 节流 t2 = clamp(T_avg × (1 + √σ²/T_avg), 30ms, T_avg × 1.5)
//!    - 自适应延迟 = max(t1, t2)
//! 2. 【搜索编排】`SearchOrchestrator`：基于防抖（等用户停顿）+ 节流（保证最低
//!    刷新间隔）调度搜索。Kotlin 版用协程 + delay，Rust 版无运行时，故提供
//!    同步决策 API（`on_input` / `should_search`），由调用方轮询。
//!
//! ## 三语言一致性
//!
//! 与 Kotlin / JS 行为对齐：同样的间隔窗口（20）、同样的异常值过滤（10..5000ms）、
//! 同样的 clamp 边界与默认值。

use alloc::string::{String, ToString};
use alloc::vec::Vec;

// ─── 常量（与 Kotlin `TypingSpeedTracker` 对齐） ───────────────────────────

/// 间隔窗口大小（保留最近 N 次按键间隔）。
const INTERVAL_WINDOW_SIZE: usize = 20;
/// 异常间隔下限（毫秒）：低于此值视为误触，不计入统计。
const INTERVAL_MIN_MS: u64 = 10;
/// 异常间隔上限（毫秒）：高于此值视为停顿，不计入统计。
const INTERVAL_MAX_MS: u64 = 5000;
/// EMA 平滑系数（越大越偏向新样本）。
const EMA_ALPHA: f64 = 0.3;

// 防抖 / 节流边界（与 Kotlin 一致）
const DEBOUNCE_DEFAULT_MS: u64 = 200;
const DEBOUNCE_UPPER_MS: f64 = 400.0;
const THROTTLE_DEFAULT_MS: u64 = 100;
const THROTTLE_LOWER_MS: f64 = 30.0;
/// 采样不足 2 次时使用的默认延迟。
const FALLBACK_DELAY_MS: u64 = 200;

/// ═══════════════════════════════════════════════════════════════════════════
/// 打字速度追踪器
/// ═══════════════════════════════════════════════════════════════════════════
///
/// 同时维护：
/// - 按键间隔窗口（用于防抖/节流公式，对齐 Kotlin）
/// - EMA 打字速度（字符/秒，对齐任务签名）
#[derive(Debug, Clone)]
pub struct TypingSpeedTracker {
    /// 上次按键时间戳（毫秒）。
    last_input_time: Option<u64>,
    /// 最近 N 次按键间隔（毫秒）。
    intervals: Vec<u64>,
    /// EMA 打字速度（字符/秒）。
    ema_speed: f64,
    /// EMA 平滑系数。
    alpha: f64,
    /// 退格键次数（用于错误率 E）。
    backspace_count: u32,
    /// 总按键次数（用于错误率 E）。
    total_keystrokes: u32,
}

impl Default for TypingSpeedTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl TypingSpeedTracker {
    /// 创建追踪器（使用默认 EMA 系数 0.3）。
    pub fn new() -> Self {
        Self::with_alpha(EMA_ALPHA)
    }

    /// 创建追踪器并指定 EMA 平滑系数。
    pub fn with_alpha(alpha: f64) -> Self {
        Self {
            last_input_time: None,
            intervals: Vec::with_capacity(INTERVAL_WINDOW_SIZE),
            ema_speed: 0.0,
            alpha: alpha.clamp(0.0, 1.0),
            backspace_count: 0,
            total_keystrokes: 0,
        }
    }

    /// 记录一次按键输入。
    ///
    /// 计算 与上次按键的间隔，若在 `[10, 5000]` ms 区间内则计入窗口并
    /// 更新 EMA 速度（速度 = 1000 / interval_ms 字符/秒）。
    pub fn record_input(&mut self, timestamp_ms: u64) {
        if let Some(last) = self.last_input_time {
            let interval = timestamp_ms.saturating_sub(last);
            if interval >= INTERVAL_MIN_MS && interval <= INTERVAL_MAX_MS {
                // 更新 EMA 速度（字符/秒）
                let speed = 1000.0 / interval as f64;
                self.ema_speed = self.alpha * speed + (1.0 - self.alpha) * self.ema_speed;
                // 推入间隔窗口
                self.intervals.push(interval);
                if self.intervals.len() > INTERVAL_WINDOW_SIZE {
                    self.intervals.remove(0);
                }
            }
        }
        self.last_input_time = Some(timestamp_ms);
        self.total_keystrokes += 1;
    }

    /// 记录一次退格（计入总按键与退格计数，用于错误率）。
    pub fn record_backspace(&mut self, timestamp_ms: u64) {
        self.last_input_time = Some(timestamp_ms);
        self.backspace_count += 1;
        self.total_keystrokes += 1;
    }

    /// 当前 EMA 打字速度（字符/秒）。无样本时为 0.0。
    pub fn get_ema_speed(&self) -> f64 {
        self.ema_speed
    }

    /// 当前间隔窗口样本数。
    pub fn sample_count(&self) -> usize {
        self.intervals.len()
    }

    /// 错误率 E = backspace_count / total_keystrokes，clamp 到 [0, 1]。
    pub fn error_rate(&self) -> f64 {
        if self.total_keystrokes == 0 {
            0.0
        } else {
            (self.backspace_count as f64 / self.total_keystrokes as f64).clamp(0.0, 1.0)
        }
    }

    /// 计算防抖时间 t1（毫秒）。
    ///
    /// 公式（与 Kotlin 一致）：t1 = clamp(P_max × (1 + E), T_avg × 2, 400ms)
    /// 含义：用户停止输入后等待多久才开始搜索。快打字 → 短 debounce。
    pub fn get_debounce_ms(&self) -> u64 {
        if self.intervals.len() < 2 {
            return DEBOUNCE_DEFAULT_MS;
        }
        let t_avg = self.mean_interval();
        let p_max = self.min_interval();
        let e = self.error_rate();

        let t1 = p_max * (1.0 + e);
        let lower = t_avg * 2.0;
        let upper = DEBOUNCE_UPPER_MS;
        let clamped = t1.clamp(lower, upper);
        clamped.round() as u64
    }

    /// 计算节流时间 t2（毫秒）。
    ///
    /// 公式（与 Kotlin 一致）：t2 = clamp(T_avg × (1 + √σ²/T_avg), 30ms, T_avg × 1.5)
    /// 化简为：t2 = clamp(T_avg + √σ², 30ms, T_avg × 1.5)
    /// 含义：两次搜索之间的最小间隔（保证最低刷新间隔）。
    pub fn get_throttle_ms(&self) -> u64 {
        if self.intervals.len() < 2 {
            return THROTTLE_DEFAULT_MS;
        }
        let t_avg = self.mean_interval();
        let variance = self.variance(t_avg);
        let std_dev = variance.sqrt();

        let t2 = t_avg + std_dev;
        let lower = THROTTLE_LOWER_MS;
        let upper = t_avg * 1.5;
        let clamped = t2.clamp(lower, upper);
        clamped.round() as u64
    }

    /// 综合自适应延迟 = max(t1, t2)，同时满足防抖与节流。
    pub fn get_adaptive_delay(&self) -> u64 {
        let t1 = self.get_debounce_ms();
        let t2 = self.get_throttle_ms();
        t1.max(t2)
    }

    /// 重置所有统计（开始新会话）。
    pub fn reset(&mut self) {
        self.last_input_time = None;
        self.intervals.clear();
        self.ema_speed = 0.0;
        self.backspace_count = 0;
        self.total_keystrokes = 0;
    }

    // ─── 内部统计 ─────────────────────────────────────────────────────────

    fn mean_interval(&self) -> f64 {
        if self.intervals.is_empty() {
            return 0.0;
        }
        let sum: u64 = self.intervals.iter().sum();
        sum as f64 / self.intervals.len() as f64
    }

    fn min_interval(&self) -> f64 {
        // P_max = 最大速度对应的最小间隔
        self.intervals.iter().min().copied().unwrap_or(0) as f64
    }

    fn variance(&self, mean: f64) -> f64 {
        if self.intervals.len() < 2 {
            return 0.0;
        }
        let n = self.intervals.len() as f64;
        let sum_sq: f64 = self.intervals
            .iter()
            .map(|&v| {
                let d = v as f64 - mean;
                d * d
            })
            .sum();
        sum_sq / n
    }
}

/// ═══════════════════════════════════════════════════════════════════════════
/// 搜索编排器
/// ═══════════════════════════════════════════════════════════════════════════
///
/// 基于 TypingSpeedTracker 的防抖 + 节流调度搜索。
///
/// Rust 版无异步运行时，故采用同步决策模型：
/// - `on_input`：记录输入并返回是否应立即搜索（空查询或首次输入）；
/// - `should_search`：调用方轮询，判断防抖 + 节流是否同时满足；
/// - `mark_searched`：搜索执行后调用，更新节流基准。
#[derive(Debug, Clone)]
pub struct SearchOrchestrator {
    /// 上一次搜索触发的时间戳（毫秒）。
    last_search_time: Option<u64>,
    /// 当前待执行的查询。
    pending_search: Option<String>,
    /// 最近一次输入的时间戳（作为防抖计时起点）。
    last_input_time: Option<u64>,
    /// 打字速度追踪器。
    tracker: TypingSpeedTracker,
}

impl Default for SearchOrchestrator {
    fn default() -> Self {
        Self::new()
    }
}

impl SearchOrchestrator {
    pub fn new() -> Self {
        Self {
            last_search_time: None,
            pending_search: None,
            last_input_time: None,
            tracker: TypingSpeedTracker::new(),
        }
    }

    /// 使用指定的速度追踪器构造。
    pub fn with_tracker(tracker: TypingSpeedTracker) -> Self {
        Self {
            last_search_time: None,
            pending_search: None,
            last_input_time: None,
            tracker,
        }
    }

    /// 访问内部追踪器（用于读取 EMA 速度等指标）。
    pub fn tracker(&self) -> &TypingSpeedTracker {
        &self.tracker
    }

    /// 可变访问内部追踪器（用于记录退格等）。
    pub fn tracker_mut(&mut self) -> &mut TypingSpeedTracker {
        &mut self.tracker
    }

    /// 当前待执行的查询。
    pub fn pending_query(&self) -> Option<&str> {
        self.pending_search.as_deref()
    }

    /// 用户输入到来时调用。
    ///
    /// - 记录输入到速度追踪器；
    /// - 更新待执行查询与防抖计时起点；
    /// - 返回是否应立即搜索（空查询直接执行；首次输入立即执行；其余等待防抖）。
    pub fn on_input(&mut self, query: &str, timestamp_ms: u64) -> bool {
        self.tracker.record_input(timestamp_ms);
        self.pending_search = Some(query.to_string());
        self.last_input_time = Some(timestamp_ms);

        // 空查询直接执行（对齐 Kotlin `submitSearch` 中 query.isBlank 分支）
        if query.is_empty() {
            return true;
        }
        // 首次输入立即执行（无上次搜索，无需节流）
        if self.last_search_time.is_none() {
            return true;
        }
        // 其余情况等待防抖 + 节流（由调用方轮询 should_search）
        false
    }

    /// 判断当前是否应执行搜索（防抖 + 节流同时满足）。
    ///
    /// - 防抖：距最近一次输入已过 `debounce_ms`；
    /// - 节流：距上次搜索已过 `throttle_ms`（无上次搜索视为满足）。
    pub fn should_search(&self, timestamp_ms: u64) -> bool {
        if self.pending_search.is_none() {
            return false;
        }
        let last_input = match self.last_input_time {
            Some(t) => t,
            None => return false,
        };

        // 采样不足时使用回退延迟，避免公式失真
        let debounce_ms = if self.tracker.sample_count() >= 2 {
            self.tracker.get_debounce_ms()
        } else {
            FALLBACK_DELAY_MS
        };
        let debounce_ok = timestamp_ms.saturating_sub(last_input) >= debounce_ms;

        let throttle_ok = match self.last_search_time {
            None => true,
            Some(t) => {
                let throttle_ms = if self.tracker.sample_count() >= 2 {
                    self.tracker.get_throttle_ms()
                } else {
                    THROTTLE_DEFAULT_MS
                };
                timestamp_ms.saturating_sub(t) >= throttle_ms
            }
        };

        debounce_ok && throttle_ok
    }

    /// 搜索执行后调用，更新节流基准并清空待执行查询。
    pub fn mark_searched(&mut self, timestamp_ms: u64) {
        self.last_search_time = Some(timestamp_ms);
        self.pending_search = None;
    }

    /// 取消所有待处理搜索。
    pub fn cancel(&mut self) {
        self.pending_search = None;
    }

    /// 重置编排器状态（保留追踪器统计）。
    pub fn reset(&mut self) {
        self.last_search_time = None;
        self.pending_search = None;
        self.last_input_time = None;
    }
}

// ─── 测试 ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tracker_initial_state() {
        let t = TypingSpeedTracker::new();
        assert_eq!(t.get_ema_speed(), 0.0);
        assert_eq!(t.sample_count(), 0);
        assert_eq!(t.get_debounce_ms(), DEBOUNCE_DEFAULT_MS);
        assert_eq!(t.get_throttle_ms(), THROTTLE_DEFAULT_MS);
    }

    #[test]
    fn test_record_input_updates_intervals_and_ema() {
        let mut t = TypingSpeedTracker::new();
        // 间隔 100ms → 速度 10 字符/秒
        t.record_input(1000);
        t.record_input(1100);
        assert_eq!(t.sample_count(), 1);
        assert!(t.get_ema_speed() > 0.0);
        // EMA = 0.3 * 10 + 0.7 * 0 = 3.0
        assert!((t.get_ema_speed() - 3.0).abs() < 1e-6);
    }

    #[test]
    fn test_record_input_filters_outliers() {
        let mut t = TypingSpeedTracker::new();
        t.record_input(1000);
        // 间隔 5ms < 10，过滤
        t.record_input(1005);
        assert_eq!(t.sample_count(), 0);
        // 间隔 6000ms > 5000，过滤
        t.record_input(7005);
        assert_eq!(t.sample_count(), 0);
    }

    #[test]
    fn test_debounce_throttle_bounds() {
        let mut t = TypingSpeedTracker::new();
        // 稳定 200ms 间隔
        let mut ts = 0u64;
        for _ in 0..10 {
            t.record_input(ts);
            ts += 200;
        }
        let d = t.get_debounce_ms();
        let th = t.get_throttle_ms();
        // t_avg=200 → debounce 下界 400；p_max=200,e=0 → t1=200，clamp(200,400,400)=400
        assert_eq!(d, 400);
        // t_avg=200,std=0 → t2=200，clamp(200,30,300)=200
        assert_eq!(th, 200);
        // adaptive = max(400,200)=400
        assert_eq!(t.get_adaptive_delay(), 400);
    }

    #[test]
    fn test_backspace_error_rate() {
        let mut t = TypingSpeedTracker::new();
        t.record_input(1000);
        t.record_input(1100);
        t.record_backspace(1200);
        assert!((t.error_rate() - 1.0 / 3.0).abs() < 1e-6);
    }

    #[test]
    fn test_orchestrator_first_input_searches_immediately() {
        let mut o = SearchOrchestrator::new();
        assert!(o.on_input("wx", 1000));
        assert_eq!(o.pending_query(), Some("wx"));
    }

    #[test]
    fn test_orchestrator_empty_query_searches_immediately() {
        let mut o = SearchOrchestrator::new();
        o.mark_searched(1000);
        assert!(o.on_input("", 2000));
    }

    #[test]
    fn test_orchestrator_debounce_throttle_gating() {
        let mut o = SearchOrchestrator::new();
        // 首次输入立即搜索
        assert!(o.on_input("a", 1000));
        o.mark_searched(1000);

        // 后续输入不应立即搜索
        assert!(!o.on_input("ab", 1050));
        // 50ms 后防抖未满足（debounce 默认 200ms）
        assert!(!o.should_search(1100));
    }

    #[test]
    fn test_orchestrator_mark_searched_clears_pending() {
        let mut o = SearchOrchestrator::new();
        o.on_input("wx", 1000);
        o.mark_searched(1000);
        assert!(o.pending_query().is_none());
    }
}
