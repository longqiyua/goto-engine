//! GOTO Engine · RAG 灰度过渡控制器（纯函数）
//!
//! 与 JS 版 `algorithms/rag/rag-transition.js` 和 Kotlin 版对齐
//!（V2.1 三语言同步）。
//!
//! 设计：
//!   - 纯函数：不操作文件系统，只管理状态对象
//!   - IO 由调用方处理（本控制器只负责状态计算）
//!   - 线性插值：[TRANSITION_DAYS] 天内从 0 → 1
//!   - 过渡中：common + personal 双路并存（按 blend weight 混合）
//!   - 过渡完成：切换到 personal 单路
//!
//! v2.1 新增

use alloc::string::String;
use alloc::string;
use alloc::vec;
use alloc::vec::Vec;

#[cfg(feature = "std")]
use std::time::{SystemTime, UNIX_EPOCH};

/// 过渡天数（线性插值 0→1 的跨度）
pub const TRANSITION_DAYS: u64 = 15;
const MS_PER_DAY: u64 = 24 * 60 * 60 * 1000;

/// 过渡状态对象
///
/// 由调用方持有，控制器只读取 / 返回新状态，不修改入参。
#[derive(Debug, Clone, Default)]
pub struct TransitionState {
    /// 过渡开始时间戳（ms）；0 = 未开始
    pub started_at: u64,
    /// 是否已最终化
    pub finalized: bool,
    /// 当前激活的路径列表
    pub active_paths: Vec<String>,
}

#[cfg(feature = "std")]
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(not(feature = "std"))]
fn now_millis() -> u64 {
    0
}

/// 线性插值 0→1，超过 [TRANSITION_DAYS] 后固定为 1
///
/// - `started_at`：过渡开始时间戳（ms）；0 表示未开始，返回 0
/// - `now`：当前时间戳（ms）
/// - 返回 [0.0, 1.0] 的混合权重
pub fn get_blend_weight(started_at: u64, now: u64) -> f64 {
    if started_at == 0 {
        return 0.0;
    }
    if now <= started_at {
        return 0.0;
    }
    let elapsed_days = (now - started_at) as f64 / MS_PER_DAY as f64;
    if elapsed_days >= TRANSITION_DAYS as f64 {
        return 1.0;
    }
    elapsed_days / TRANSITION_DAYS as f64
}

/// 开始过渡：初始化 / 重置状态
///
/// 返回新状态（浅拷贝入参后修改），不修改原 state。
pub fn start_transition(state: &TransitionState) -> TransitionState {
    let mut s = state.clone();
    s.started_at = now_millis();
    s.finalized = false;
    if s.active_paths.is_empty() {
        s.active_paths = vec![
            string::String::from("common"),
            string::String::from("personal"),
        ];
    }
    s
}

/// 最终化过渡：标记为已完成，切换到 personal 单路
///
/// 返回新状态（浅拷贝入参后修改），不修改原 state。
pub fn finalize_transition(state: &TransitionState) -> TransitionState {
    let mut s = state.clone();
    s.finalized = true;
    s.active_paths = vec![string::String::from("personal")];
    s
}

/// 是否处于过渡中（未最终化且权重 < 1）
pub fn is_transitioning(state: &TransitionState) -> bool {
    if state.finalized {
        return false;
    }
    if state.started_at == 0 {
        return false;
    }
    get_blend_weight(state.started_at, now_millis()) < 1.0
}

/// 获取当前激活的路径列表
///
/// - 未开始过渡：`["common"]`
/// - 过渡中：`state.active_paths` 或 `["common", "personal"]`
/// - 过渡完成（权重 ≥ 1）：`["personal"]`
/// - 已最终化：`["personal"]`
pub fn get_active_paths(state: &TransitionState) -> Vec<String> {
    if state.finalized {
        return vec![string::String::from("personal")];
    }
    if state.started_at == 0 {
        return vec![string::String::from("common")];
    }
    if get_blend_weight(state.started_at, now_millis()) >= 1.0 {
        return vec![string::String::from("personal")];
    }
    if !state.active_paths.is_empty() {
        return state.active_paths.clone();
    }
    vec![
        string::String::from("common"),
        string::String::from("personal"),
    ]
}

/// RagTransitionController — 与 JS/Kotlin 对齐的控制器对象
///
/// 所有方法都是纯函数的包装，直接委托给模块级函数。
pub struct RagTransitionController;

impl RagTransitionController {
    /// 线性插值 0→1
    pub fn get_blend_weight(started_at: u64, now: u64) -> f64 {
        get_blend_weight(started_at, now)
    }

    /// 开始过渡
    pub fn start_transition(state: &TransitionState) -> TransitionState {
        start_transition(state)
    }

    /// 最终化过渡
    pub fn finalize_transition(state: &TransitionState) -> TransitionState {
        finalize_transition(state)
    }

    /// 是否处于过渡中
    pub fn is_transitioning(state: &TransitionState) -> bool {
        is_transitioning(state)
    }

    /// 获取当前激活的路径
    pub fn get_active_paths(state: &TransitionState) -> Vec<String> {
        get_active_paths(state)
    }
}

// ─── 单元测试 ───────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_blend_weight_not_started() {
        assert_eq!(get_blend_weight(0, 1000000), 0.0);
    }

    #[test]
    fn test_blend_weight_zero_elapsed() {
        let now = 1000000_u64;
        assert_eq!(get_blend_weight(now, now), 0.0);
    }

    #[test]
    fn test_blend_weight_midpoint() {
        // started_at=0 表示"未开始"，这里用非零起始时间
        let start = 1_000_000_u64;
        // 取过渡期一半的毫秒数（7.5 天），用乘法再除避免整数除法截断
        let half_period_ms = (MS_PER_DAY * TRANSITION_DAYS) / 2; // 7.5 days in ms
        let midpoint = start + half_period_ms;
        let w = get_blend_weight(start, midpoint);
        // 7.5 / 15 = 0.5
        assert!((w - 0.5).abs() < 0.001);
    }

    #[test]
    fn test_blend_weight_completed() {
        // started_at=0 表示"未开始"，这里用非零起始时间
        let start = 1_000_000_u64;
        let after = start + MS_PER_DAY * (TRANSITION_DAYS + 1); // 16 days after start
        assert_eq!(get_blend_weight(start, after), 1.0);
    }

    #[test]
    fn test_start_transition() {
        let state = TransitionState::default();
        let new_state = start_transition(&state);
        assert!(!new_state.finalized);
        assert!(new_state.started_at > 0);
        assert_eq!(new_state.active_paths, vec!["common", "personal"]);
    }

    #[test]
    fn test_finalize_transition() {
        let state = TransitionState {
            started_at: 1000,
            finalized: false,
            active_paths: vec!["common".into(), "personal".into()],
        };
        let final_state = finalize_transition(&state);
        assert!(final_state.finalized);
        assert_eq!(final_state.active_paths, vec!["personal"]);
        // 原状态不变
        assert!(!state.finalized);
    }

    #[test]
    fn test_is_transitioning_not_started() {
        let state = TransitionState::default();
        assert!(!is_transitioning(&state));
    }

    #[test]
    fn test_is_transitioning_finalized() {
        let state = TransitionState {
            started_at: 1000,
            finalized: true,
            active_paths: vec!["personal".into()],
        };
        assert!(!is_transitioning(&state));
    }

    #[test]
    fn test_is_transitioning_active() {
        let now = now_millis();
        let state = TransitionState {
            started_at: now, // 刚开始
            finalized: false,
            active_paths: vec!["common".into(), "personal".into()],
        };
        assert!(is_transitioning(&state));
    }

    #[test]
    fn test_get_active_paths_default() {
        let state = TransitionState::default();
        assert_eq!(get_active_paths(&state), vec!["common"]);
    }

    #[test]
    fn test_get_active_paths_finalized() {
        let state = TransitionState {
            started_at: 1000,
            finalized: true,
            active_paths: vec!["personal".into()],
        };
        assert_eq!(get_active_paths(&state), vec!["personal"]);
    }

    #[test]
    fn test_controller_wrapper() {
        let state = TransitionState::default();
        let new_state = RagTransitionController::start_transition(&state);
        assert!(RagTransitionController::is_transitioning(&new_state));
        assert_eq!(
            RagTransitionController::get_active_paths(&new_state),
            vec!["common", "personal"]
        );
        let w = RagTransitionController::get_blend_weight(new_state.started_at, new_state.started_at);
        assert_eq!(w, 0.0);
    }
}
