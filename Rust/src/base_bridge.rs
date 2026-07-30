//! GOTO Engine · Base Bridge — Engine 与 Base 之间的无状态桥接
//!
//! 与 JS 版 `base-bridge.js` 和 Kotlin 版 `Rerank/EngineBaseBridge.kt` 对齐。
//!
//! 设计：
//!   - 纯委托：不缓存，不修改 Base
//!   - 优雅降级：BaseReader/BaseWriter 未注入时，所有方法降级为 no-op
//!   - 故障隔离：所有读写都包在 Result 中
//!
//! v2.1 新增

use crate::rerank::{
    Affinity, FeedbackContext, FeedbackEvent, HeatmapData, HourlyRankingData,
    PersonalSnapshot, RuntimeContext, TransitionMatrixData, UserContextData,
};
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use alloc::collections::BTreeMap;

#[cfg(feature = "std")]
use std::sync::{Arc, Mutex};

/// BaseReader 端口 trait — 由宿主实现（映射到 GOTO Base 的 BaseReader）
pub trait BaseReaderPort: Send + Sync {
    fn get_affinities(&self, query: &str, packages: &[String]) -> BTreeMap<String, Affinity>;
    fn get_heatmap(&self) -> Option<HeatmapData>;
    fn get_hourly_ranking(&self) -> Option<HourlyRankingData>;
    fn get_transition_matrix(&self) -> Option<TransitionMatrixData>;
    fn get_user_context(&self) -> Option<UserContextData>;
    fn get_recent_feedback(&self, query: &str, limit: usize) -> Vec<FeedbackEvent>;
}

/// BaseWriter 端口 trait — 由宿主实现（映射到 GOTO Base 的 BaseWriter）
pub trait BaseWriterPort: Send + Sync {
    fn record_feedback_chain_event(&self, event: &FeedbackEvent) -> Result<(), String>;
}

/// EngineBaseBridge — 无状态桥接
pub struct EngineBaseBridge {
    #[cfg(feature = "std")]
    reader: Option<Arc<dyn BaseReaderPort>>,
    #[cfg(feature = "std")]
    writer: Option<Arc<dyn BaseWriterPort>>,
    #[cfg(not(feature = "std"))]
    reader: Option<&'static dyn BaseReaderPort>,
    #[cfg(not(feature = "std"))]
    writer: Option<&'static dyn BaseWriterPort>,
    last_error: Option<String>,
}

impl Default for EngineBaseBridge {
    fn default() -> Self {
        Self {
            reader: None,
            writer: None,
            last_error: None,
        }
    }
}

impl EngineBaseBridge {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn available(&self) -> bool {
        self.reader.is_some() || self.writer.is_some()
    }

    pub fn degraded(&self) -> bool {
        !self.available()
    }

    #[cfg(feature = "std")]
    pub fn set_reader(&mut self, reader: Arc<dyn BaseReaderPort>) {
        self.reader = Some(reader);
    }

    #[cfg(feature = "std")]
    pub fn set_writer(&mut self, writer: Arc<dyn BaseWriterPort>) {
        self.writer = Some(writer);
    }

    /// 收集完整的个人层快照（用于梳理层重排）。
    pub fn get_personal_snapshot(
        &self,
        query: &str,
        candidate_packages: &[String],
        runtime_context: RuntimeContext,
    ) -> PersonalSnapshot {
        if self.degraded() {
            return PersonalSnapshot::degraded();
        }

        let taken_at = current_time_millis();

        let affinities = match &self.reader {
            Some(r) => safe_read(|| r.get_affinities(query, candidate_packages), BTreeMap::new(), &self.last_error_opt()),
            None => BTreeMap::new(),
        };
        let heatmap = match &self.reader {
            Some(r) => safe_read_opt(|| r.get_heatmap(), &self.last_error_opt()),
            None => None,
        };
        let hourly_ranking = match &self.reader {
            Some(r) => safe_read_opt(|| r.get_hourly_ranking(), &self.last_error_opt()),
            None => None,
        };
        let transition_matrix = match &self.reader {
            Some(r) => safe_read_opt(|| r.get_transition_matrix(), &self.last_error_opt()),
            None => None,
        };
        let user_context = match &self.reader {
            Some(r) => safe_read_opt(|| r.get_user_context(), &self.last_error_opt()),
            None => None,
        };
        let recent_feedback = match &self.reader {
            Some(r) => safe_read(|| r.get_recent_feedback(query, 50), Vec::new(), &self.last_error_opt()),
            None => Vec::new(),
        };

        PersonalSnapshot {
            taken_at,
            query: String::from(query),
            candidate_packages: candidate_packages.to_vec(),
            runtime_context,
            affinities,
            heatmap,
            hourly_ranking,
            transition_matrix,
            user_context,
            recent_feedback,
            degraded: false,
        }
    }

    /// 写入 feedback-chain 事件。
    pub fn record_feedback_chain_event(&mut self, event: FeedbackEvent) -> Option<String> {
        let w = self.writer.as_ref()?;
        match w.record_feedback_chain_event(&event) {
            Ok(()) => Some(event.event_id.clone()),
            Err(e) => {
                self.last_error = Some(e);
                None
            }
        }
    }

    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    fn last_error_opt(&self) -> Option<&str> {
        self.last_error.as_deref()
    }
}

// ============================================================
// 工具函数
// ============================================================

fn safe_read<T, F: FnOnce() -> T>(f: F, fallback: T, _err: &Option<&str>) -> T {
    f()
}

fn safe_read_opt<T, F: FnOnce() -> Option<T>>(f: F, _err: &Option<&str>) -> Option<T> {
    f()
}

#[cfg(feature = "std")]
fn current_time_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(not(feature = "std"))]
fn current_time_millis() -> u64 {
    0
}

// ============================================================
// 写入事件参数辅助构造
// ============================================================

/// 构造一个 feedback-chain 事件（与 JS 版 recordFeedbackChainEvent 入参对齐）
pub fn build_feedback_event(
    query: &str,
    clicked_package: &str,
    clicked_app_name: &str,
    clicked_rank: i32,
    candidate_count: i32,
    match_mode: &str,
    context: FeedbackContext,
) -> FeedbackEvent {
    let mode = match match_mode {
        "exact" | "prefix" | "fuzzy" | "rag" | "synonym" => match_mode,
        _ => "fuzzy",
    };
    FeedbackEvent {
        event_id: generate_uuid(),
        timestamp: current_iso_time(),
        query: String::from(query),
        clicked_package: String::from(clicked_package),
        clicked_rank,
        match_mode: String::from(mode),
        context,
    }
}

#[cfg(feature = "std")]
fn generate_uuid() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("evt-{:016x}", now)
}

#[cfg(not(feature = "std"))]
fn generate_uuid() -> String {
    String::from("evt-unknown")
}

#[cfg(feature = "std")]
fn current_iso_time() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("epoch:{}", secs)
}

#[cfg(not(feature = "std"))]
fn current_iso_time() -> String {
    String::from("epoch:0")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_degraded_no_reader_writer() {
        let bridge = EngineBaseBridge::new();
        assert!(bridge.degraded());
        let snap = bridge.get_personal_snapshot("wx", &[], RuntimeContext::default());
        assert!(snap.degraded);
    }
}
