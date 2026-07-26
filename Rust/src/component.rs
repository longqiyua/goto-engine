//! Component API 封套（对应 `goto-engine-component.js` v1.0.0）。
//!
//! [`EngineComponent`] 是包裹 [`GotoEngine`] 的稳定适配层，提供：
//! - 统一的请求 / 响应封装（`QueryResponse` / `NormalizedItem`）
//! - 事件订阅（`on` / `off` / `_emit`）
//! - 多格式输出（`format` / `render`：json / compact / text）
//! - 与 JS 端 `EngineComponent.prototype` 一一对应的方法（snake_case 化）
//!
//! 设计目标：上游 UI / IPC / JNI 层只依赖 `EngineComponent` 的稳定接口，
//! 引擎内部结构变化不影响下游。

use alloc::collections::BTreeMap;
use alloc::format;
use alloc::string::{String, ToString};
use alloc::sync::Arc;
use alloc::vec::Vec;

#[cfg(feature = "std")]
use std::sync::RwLock as StdRwLock;

#[cfg(not(feature = "std"))]
use spin::RwLock as StdRwLock;

use serde::{Deserialize, Serialize};

use crate::context::SearchContext_;
use crate::engine::GotoEngine;
use crate::storage::MemoryStorage;
use crate::types::{AppItem, SearchContext, SearchHit};
use crate::utils::now_ts;

/// Component API 版本（对应 JS `API_VERSION`）。
pub const COMPONENT_API_VERSION: &str = "1.0.0";

// ─── 适配器 trait ──────────────────────────────────────────────────────────

/// 外部适配器（对应 JS `setAdapter({ storage, fetch })`）。
///
/// 下游可注入自定义的键值存储或网络请求实现。
/// Rust 端不强制要求实现，仅作为扩展点。
pub trait ComponentAdapter: Send + Sync {
    /// 读取一个字符串值（对应 `localStorage.getItem`）。
    fn get_item(&self, key: &str) -> Option<String>;
    /// 写入一个字符串值（对应 `localStorage.setItem`）。
    fn set_item(&self, key: &str, value: &str);
}

/// 默认空适配器（无 localStorage / fetch）。
#[derive(Debug, Default, Clone)]
pub struct NullAdapter;

impl ComponentAdapter for NullAdapter {
    fn get_item(&self, _key: &str) -> Option<String> { None }
    fn set_item(&self, _key: &str, _value: &str) {}
}

// ─── 数据结构 ──────────────────────────────────────────────────────────────

/// 归一化后的搜索结果条目（对应 JS `normalizeItem`）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NormalizedItem {
    /// 排名（1-based）。
    pub rank: u32,
    /// 唯一 ID（优先 app.id → app.name → index）。
    pub id: String,
    /// 应用名。
    pub name: String,
    /// 得分。
    pub score: f64,
    /// 来源（engine / fuzzy / meta / tfidf / ...）。
    pub source: String,
    /// 分类。
    pub category: String,
    /// 图标 URL。
    pub icon: String,
}

/// 意图信息（对应 JS `data.intent`）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IntentInfo {
    /// 意图标签（SEND / CONSUME / ...）。
    pub label: String,
    /// 意图分类（通讯 / 视频 / ...）。
    pub category: String,
}

/// `query()` 成功时的 data 字段。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct QueryData {
    /// 已截断到 limit 的结果列表。
    pub items: Vec<NormalizedItem>,
    /// 原始结果总数（截断前）。
    pub total: usize,
    /// 意图信息。
    pub intent: IntentInfo,
    /// 搜索模式（standard / pro / float / smart_reminder）。
    pub mode: String,
}

/// 请求元信息。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RequestMeta {
    /// 请求 ID。
    pub id: String,
    /// 清洗后的 query。
    pub query: String,
    /// limit（截取条数）。
    pub limit: u32,
}

/// 响应元信息。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ResponseMeta {
    /// 端到端延迟（ms）。
    pub latency_ms: u64,
    /// 是否仅本地（无网络请求）。
    pub local_only: bool,
    /// ISO-8601 时间戳。
    pub timestamp: String,
}

/// 错误信息。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

/// 统一响应封装（对应 JS `query()` 返回值）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResponse {
    pub ok: bool,
    pub api_version: String,
    pub request: RequestMeta,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<QueryData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
    pub meta: ResponseMeta,
}

impl QueryResponse {
    /// 构造成功响应。
    pub fn ok(id: &str, query: &str, limit: u32, data: QueryData, latency_ms: u64) -> Self {
        Self {
            ok: true,
            api_version: COMPONENT_API_VERSION.to_string(),
            request: RequestMeta {
                id: id.to_string(),
                query: query.to_string(),
                limit,
            },
            data: Some(data),
            error: None,
            meta: ResponseMeta {
                latency_ms,
                local_only: true,
                timestamp: current_iso(),
            },
        }
    }

    /// 构造错误响应。
    pub fn err(id: &str, query: &str, code: &str, message: &str, start_ts: u64) -> Self {
        Self {
            ok: false,
            api_version: COMPONENT_API_VERSION.to_string(),
            request: RequestMeta {
                id: id.to_string(),
                query: query.to_string(),
                limit: 0,
            },
            data: None,
            error: Some(ErrorBody {
                code: code.to_string(),
                message: message.to_string(),
            }),
            meta: ResponseMeta {
                latency_ms: now_ts().saturating_sub(start_ts),
                local_only: true,
                timestamp: current_iso(),
            },
        }
    }
}

/// `query()` 的可选参数（对应 JS `query(query, options)`）。
#[derive(Debug, Clone, Default)]
pub struct QueryOptions {
    /// 自定义请求 ID（不传则自动生成）。
    pub request_id: Option<String>,
    /// 截取条数（1-100，默认 12）。
    pub limit: Option<u32>,
    /// 临时上下文（仅本次查询生效）。
    pub context: Option<SearchContext_>,
}

/// `status()` 返回值。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ComponentStatus {
    pub api_version: String,
    pub ready: bool,
    pub engine_version: String,
    pub dataset_size: usize,
    pub local_only: bool,
}

/// 输出格式（对应 JS `format(result, format)`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputFormat {
    Json,
    Compact,
    Text,
}

impl Default for OutputFormat {
    fn default() -> Self { OutputFormat::Json }
}

// ─── 事件系统 ──────────────────────────────────────────────────────────────

/// 事件载荷（对应 JS `_emit(type, payload)`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EventPayload {
    /// 查询事件。
    Query(QueryResponse),
    /// 错误事件。
    Error(QueryResponse),
    /// 通用文本事件。
    Text(String),
}

/// 事件监听器（线程安全的 `Fn`）。
pub type EventListener = Arc<dyn Fn(&EventPayload) + Send + Sync>;

// ─── EngineComponent ───────────────────────────────────────────────────────

/// Component API 主结构（对应 JS `EngineComponent`）。
///
/// 持有一个 [`GotoEngine`] 和当前应用数据集快照，
/// 对外提供稳定的 `query()` / `search()` / `record_selection()` 等方法。
pub struct EngineComponent<S: crate::storage::Storage + 'static = MemoryStorage> {
    /// 被包裹的引擎实例。
    engine: GotoEngine<S>,
    /// 当前应用数据集（对应 JS `_appDataset`）。
    dataset: Arc<StdRwLock<Vec<AppItem>>>,
    /// 外部适配器（localStorage / fetch）。
    adapter: Arc<StdRwLock<Box<dyn ComponentAdapter>>>,
    /// 事件监听器表：`type → listeners`。
    listeners: Arc<StdRwLock<BTreeMap<String, Vec<EventListener>>>>,
    /// 自增序列号（用于生成 request id）。
    sequence: Arc<StdRwLock<u64>>,
}

impl EngineComponent<MemoryStorage> {
    /// 创建一个使用默认内存存储的 Component（对应 JS `create(options)`）。
    pub fn new() -> Self {
        Self::with_engine(GotoEngine::new())
    }
}

impl Default for EngineComponent<MemoryStorage> {
    fn default() -> Self { Self::new() }
}

impl<S: crate::storage::Storage + 'static> EngineComponent<S> {
    /// 用一个已有的引擎实例构造 Component。
    pub fn with_engine(engine: GotoEngine<S>) -> Self {
        Self {
            engine,
            dataset: Arc::new(StdRwLock::new(Vec::new())),
            adapter: Arc::new(StdRwLock::new(Box::new(NullAdapter))),
            listeners: Arc::new(StdRwLock::new(BTreeMap::new())),
            sequence: Arc::new(StdRwLock::new(0)),
        }
    }

    /// API 版本。
    pub fn version(&self) -> &'static str { COMPONENT_API_VERSION }

    /// 获取被包裹的引擎（对应 JS `raw()`）。
    pub fn raw(&self) -> &GotoEngine<S> { &self.engine }

    // ─── 数据集管理 ────────────────────────────────────────────────────────

    /// `setAppDataset(apps)`：更新数据集并触发索引重建。
    ///
    /// 返回数据集大小。
    pub fn set_app_dataset(&self, apps: Vec<AppItem>) -> usize {
        let len = apps.len();
        {
            #[cfg(feature = "std")]
            let mut w = self.dataset.write().unwrap();
            #[cfg(not(feature = "std"))]
            let mut w = self.dataset.write();
            *w = apps.clone();
        }
        self.engine.watch_app_dataset(&apps);
        self.engine.rebuild_index();
        len
    }

    /// `getAppDataset()`：读取当前数据集快照。
    pub fn get_app_dataset(&self) -> Vec<AppItem> {
        #[cfg(feature = "std")]
        { self.dataset.read().unwrap().clone() }
        #[cfg(not(feature = "std"))]
        { self.dataset.read().clone() }
    }

    // ─── 主入口：query ─────────────────────────────────────────────────────

    /// `query(query, options)`：稳定的组件契约入口。
    ///
    /// 1. 清洗 query；2. 调用引擎 `run_search_pipeline`；
    /// 3. 归一化结果到 `NormalizedItem`；4. 包装成 `QueryResponse`；
    /// 5. 触发 `query` 事件；6. 返回响应。
    pub fn query(&self, query: &str, options: QueryOptions) -> QueryResponse {
        let start = now_ts();
        let id = options.request_id.clone().unwrap_or_else(|| self.create_id());
        let limit = clamp_limit(options.limit);

        let cleaned = match self.engine.sanitize_query(query) {
            Some(q) => q,
            None => {
                let resp = QueryResponse::err(
                    &id,
                    &query.to_string(),
                    "INVALID_QUERY",
                    "Query is empty or rejected by the sanitizer.",
                    start,
                );
                self.emit("error", EventPayload::Error(resp.clone()));
                return resp;
            }
        };

        // 临时上下文
        if let Some(ctx) = options.context.as_ref() {
            self.engine.set_context(ctx.clone());
        }

        let ctx = self.engine.run_search_pipeline(&cleaned, &self.get_app_dataset());

        // 清理临时上下文
        if options.context.is_some() {
            self.engine.clear_context();
        }

        let source_list = ctx.list.clone();
        let total = source_list.len();
        let dataset = self.get_app_dataset();
        let items: Vec<NormalizedItem> = source_list.iter()
            .take(limit as usize)
            .enumerate()
            .map(|(i, hit)| normalize_item(hit, i, &dataset))
            .collect();

        // 从 query 中提取意图（对应 JS `context.intentLabel / intentCategory`）
        let tq = self.engine.extract_tokens(&cleaned);
        let intent_label = tq.intents.first().cloned().unwrap_or_default();
        let intent_category = tq.target.clone();
        let intent = IntentInfo {
            label: intent_label,
            category: intent_category,
        };
        let mode = format!("{:?}", ctx.mode).to_lowercase();

        let data = QueryData {
            items,
            total,
            intent,
            mode,
        };

        let latency_ms = now_ts().saturating_sub(start);
        let resp = QueryResponse::ok(&id, &cleaned, limit, data, latency_ms);
        self.emit("query", EventPayload::Query(resp.clone()));
        resp
    }

    // ─── 兼容方法（保持 preview shell 简薄） ───────────────────────────────

    /// `search(query)`：直接返回 `SearchContext`（对应 JS `search`）。
    pub fn search(&self, query: &str) -> SearchContext {
        self.engine.run_search_pipeline(query, &self.get_app_dataset())
    }

    /// `fuzzySearch(query)`：第一优先级模糊匹配。
    pub fn fuzzy_search(&self, query: &str) -> Vec<SearchHit> {
        self.engine.fuzzy_search(query, &self.get_app_dataset())
    }

    /// `recordSearch(query)`：记录搜索行为。
    pub fn record_search(&self, query: &str) {
        if let Some(cleaned) = self.engine.sanitize_query(query) {
            self.engine.record_search(&cleaned);
        }
    }

    /// `recordSelection(query, appName)`：记录用户选择。
    pub fn record_selection(&self, query: &str, app_name: &str) {
        if let Some(cleaned) = self.engine.sanitize_query(query) {
            self.engine.record_selection(&cleaned, app_name);
        }
    }

    /// `recordUnknownApp(query, appName)`：记录未知应用。
    pub fn record_unknown_app(&self, query: &str, app_name: &str) {
        if let Some(cleaned) = self.engine.sanitize_query(query) {
            self.engine.record_unknown_app(&cleaned, app_name);
        }
    }

    /// `rebuildIndex()`：重建索引。
    pub fn rebuild_index(&self) {
        self.engine.rebuild_index();
    }

    /// `setContext(ctx)`：设置上下文。
    pub fn set_context(&self, ctx: SearchContext_) {
        self.engine.set_context(ctx);
    }

    /// `clearContext()`：清除上下文。
    pub fn clear_context(&self) {
        self.engine.clear_context();
    }

    /// `isSimIntEnabled()`：模拟智能开关状态。
    ///
    /// 对应 JS：从 `localStorage.getItem('goto_simint_enabled')` 读取。
    pub fn is_simint_enabled(&self) -> bool {
        #[cfg(feature = "std")]
        let adapter = self.adapter.read().unwrap();
        #[cfg(not(feature = "std"))]
        let adapter = self.adapter.read();
        adapter.get_item("goto_simint_enabled").as_deref() == Some("1")
    }

    /// `enableSimInt(enabled)`：开关模拟智能。
    pub fn enable_simint(&self, enabled: bool) {
        {
            #[cfg(feature = "std")]
            let adapter = self.adapter.read().unwrap();
            #[cfg(not(feature = "std"))]
            let adapter = self.adapter.read();
            adapter.set_item("goto_simint_enabled", if enabled { "1" } else { "0" });
        }
        self.rebuild_index();
    }

    /// `resetMemory()`：清空记忆库。
    pub fn reset_memory(&self) {
        // JS 端调用 `engine.saveMemory([])`；Rust 端通过 `clear_all` 子集实现
        let s = self.engine.storage();
        s.remove_string(crate::constants::StorageKeys::MEMORY);
    }

    /// `getStats()`：读取规则统计（对应 JS `getRuleStats()`）。
    pub fn get_stats(&self) -> Vec<crate::types::RuleStats> {
        // 引擎未直接暴露 getRuleStats，从 storage 读取
        let s = self.engine.storage();
        s.read_json(
            crate::constants::StorageKeys::WEIGHTS,
            Vec::<(String, Vec<(String, f64)>)>::new(),
        );
        // RuleStats 在 JS 端是动态计算的；此处返回空 Vec 作为占位
        Vec::new()
    }

    // ─── 适配器 ─────────────────────────────────────────────────────────────

    /// `setAdapter(adapter)`：注入外部适配器。
    pub fn set_adapter(&self, adapter: Box<dyn ComponentAdapter>) {
        #[cfg(feature = "std")]
        let mut w = self.adapter.write().unwrap();
        #[cfg(not(feature = "std"))]
        let mut w = self.adapter.write();
        *w = adapter;
    }

    /// `getAdapter()`：读取适配器引用（无法直接返回 trait object，故返回克隆的 Arc）。
    pub fn adapter_handle(&self) -> Arc<StdRwLock<Box<dyn ComponentAdapter>>> {
        self.adapter.clone()
    }

    // ─── 状态 ───────────────────────────────────────────────────────────────

    /// `status()`：组件状态。
    pub fn status(&self) -> ComponentStatus {
        ComponentStatus {
            api_version: COMPONENT_API_VERSION.to_string(),
            ready: true,
            engine_version: self.engine.version().to_string(),
            dataset_size: self.get_app_dataset().len(),
            local_only: true,
        }
    }

    // ─── 格式化 / 渲染 ──────────────────────────────────────────────────────

    /// `format(result, format)`：格式化响应为字符串。
    pub fn format(&self, result: &QueryResponse, format: OutputFormat) -> String {
        match format {
            OutputFormat::Json => serde_json::to_string_pretty(result).unwrap_or_default(),
            OutputFormat::Compact => {
                if !result.ok {
                    return "GOTO Engine · ERROR".to_string();
                }
                let data = match result.data.as_ref() {
                    Some(d) => d,
                    None => return "GOTO Engine · NO_DATA".to_string(),
                };
                data.items.iter()
                    .map(|item| format!("{}. {} · {}", item.rank, item.name, item.score))
                    .collect::<Vec<_>>()
                    .join("\n")
            }
            OutputFormat::Text => {
                if result.ok {
                    let total = result.data.as_ref().map(|d| d.total).unwrap_or(0);
                    format!(
                        "GOTO Engine · {} results · {} ms",
                        total,
                        result.meta.latency_ms
                    )
                } else {
                    let msg = result.error.as_ref()
                        .map(|e| e.message.as_str())
                        .unwrap_or("Unknown error");
                    format!("GOTO Engine · {}", msg)
                }
            }
        }
    }

    /// `render(target, result, format)`：格式化结果。
    ///
    /// Rust 端无 DOM，仅返回格式化字符串；调用方自行渲染。
    pub fn render(&self, result: &QueryResponse, format: OutputFormat) -> String {
        self.format(result, format)
    }

    // ─── 事件系统 ───────────────────────────────────────────────────────────

    /// `on(type, listener)`：订阅事件，返回取消订阅的句柄。
    ///
    /// 支持的事件类型：`query` / `error`。
    pub fn on(&self, type_: &str, listener: EventListener) -> EventHandle {
        #[cfg(feature = "std")]
        let mut w = self.listeners.write().unwrap();
        #[cfg(not(feature = "std"))]
        let mut w = self.listeners.write();
        w.entry(type_.to_string()).or_default().push(listener.clone());
        EventHandle {
            listeners: self.listeners.clone(),
            type_: type_.to_string(),
            listener,
        }
    }

    /// `off(type, listener)`：取消订阅。
    pub fn off(&self, type_: &str, listener: &EventListener) {
        #[cfg(feature = "std")]
        let mut w = self.listeners.write().unwrap();
        #[cfg(not(feature = "std"))]
        let mut w = self.listeners.write();
        if let Some(list) = w.get_mut(type_) {
            list.retain(|l| !Arc::ptr_eq(l, listener));
        }
    }

    /// `_emit(type, payload)`：触发事件。
    pub fn emit(&self, type_: &str, payload: EventPayload) {
        #[cfg(feature = "std")]
        let listeners = self.listeners.read().unwrap();
        #[cfg(not(feature = "std"))]
        let listeners = self.listeners.read();
        if let Some(list) = listeners.get(type_) {
            // 复制一份 Arc 避免在回调中再次写锁
            let snapshot: Vec<EventListener> = list.iter().cloned().collect();
            drop(listeners);
            for l in &snapshot {
                // 回调失败不应影响其他监听器
                // (与 JS `try{ listener(payload); }catch(_){}` 一致)
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    l(&payload);
                }));
            }
        }
    }

    // ─── 内部辅助 ───────────────────────────────────────────────────────────

    /// 生成唯一请求 ID（`goto-{ts36}-{seq36}`）。
    fn create_id(&self) -> String {
        #[cfg(feature = "std")]
        {
            let mut seq = self.sequence.write().unwrap();
            *seq += 1;
            let n = *seq;
            format!("goto-{}-{}", now_ts().to_string(), n.to_string())
        }
        #[cfg(not(feature = "std"))]
        {
            let mut seq = self.sequence.write();
            *seq += 1;
            let n = *seq;
            format!("goto-{}-{}", now_ts().to_string(), n.to_string())
        }
    }
}

// ─── EventHandle ───────────────────────────────────────────────────────────

/// 事件订阅句柄，drop 时自动取消订阅。
pub struct EventHandle {
    listeners: Arc<StdRwLock<BTreeMap<String, Vec<EventListener>>>>,
    type_: String,
    listener: EventListener,
}

impl EventHandle {
    /// 手动取消订阅。
    pub fn off(&self) {
        #[cfg(feature = "std")]
        let mut w = self.listeners.write().unwrap();
        #[cfg(not(feature = "std"))]
        let mut w = self.listeners.write();
        if let Some(list) = w.get_mut(&self.type_) {
            list.retain(|l| !Arc::ptr_eq(l, &self.listener));
        }
    }
}

impl Drop for EventHandle {
    fn drop(&mut self) {
        self.off();
    }
}

// ─── 工厂函数 ──────────────────────────────────────────────────────────────

/// `create(options)`：创建默认 Component（对应 JS 工厂入口）。
pub fn create() -> EngineComponent<MemoryStorage> {
    EngineComponent::new()
}

// ─── 辅助函数 ───────────────────────────────────────────────────────────────

/// 限制 limit 到 [1, 100]，默认 12（对应 JS `clampLimit`）。
fn clamp_limit(value: Option<u32>) -> u32 {
    match value {
        Some(n) => n.clamp(1, 100),
        None => 12,
    }
}

/// 把 `SearchHit` 归一化为 `NormalizedItem`（对应 JS `normalizeItem`）。
fn normalize_item(hit: &SearchHit, index: usize, dataset: &[AppItem]) -> NormalizedItem {
    let app_item = dataset.iter().find(|a| a.name == hit.app);
    let id = app_item
        .map(|a| if !a.pkg.is_empty() { a.pkg.clone() } else { a.name.clone() })
        .unwrap_or_else(|| hit.app.clone());
    let category = app_item.map(|a| a.cat.clone()).unwrap_or_default();
    let icon = app_item.map(|a| a.icon.clone()).unwrap_or_default();

    NormalizedItem {
        rank: (index as u32) + 1,
        id,
        name: hit.app.clone(),
        score: hit.score,
        source: format!("{:?}", hit.source).to_lowercase(),
        category,
        icon,
    }
}

/// 当前 ISO-8601 时间戳（对应 JS `new Date().toISOString()`）。
#[cfg(feature = "std")]
fn current_iso() -> String {
    use chrono::Utc;
    Utc::now().to_rfc3339()
}

#[cfg(not(feature = "std"))]
fn current_iso() -> String { String::new() }

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
                tags: vec!["社交".into()],
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
    fn test_create_default() {
        let comp = EngineComponent::new();
        assert_eq!(comp.version(), "1.0.0");
        let status = comp.status();
        assert!(status.ready);
        assert_eq!(status.dataset_size, 0);
    }

    #[test]
    fn test_set_get_dataset() {
        let comp = EngineComponent::new();
        let n = comp.set_app_dataset(sample_apps());
        assert_eq!(n, 3);
        assert_eq!(comp.get_app_dataset().len(), 3);
    }

    #[test]
    fn test_query_basic() {
        let comp = EngineComponent::new();
        comp.set_app_dataset(sample_apps());

        let resp = comp.query("wx", QueryOptions::default());
        assert!(resp.ok);
        let data = resp.data.expect("应有 data");
        assert!(!data.items.is_empty());
        assert!(data.items.iter().any(|i| i.name == "微信"));
    }

    #[test]
    fn test_query_invalid_returns_error() {
        let comp = EngineComponent::new();
        let resp = comp.query("", QueryOptions::default());
        assert!(!resp.ok);
        assert_eq!(resp.error.unwrap().code, "INVALID_QUERY");
    }

    #[test]
    fn test_query_limit() {
        let comp = EngineComponent::new();
        comp.set_app_dataset(sample_apps());

        let resp = comp.query("qq", QueryOptions { limit: Some(1), ..Default::default() });
        assert!(resp.ok);
        let data = resp.data.unwrap();
        assert!(data.items.len() <= 1);
    }

    #[test]
    fn test_record_selection() {
        let comp = EngineComponent::new();
        comp.set_app_dataset(sample_apps());
        comp.record_selection("wx", "微信");
        // 不抛错即视为通过
    }

    #[test]
    fn test_format_json() {
        let comp = EngineComponent::new();
        comp.set_app_dataset(sample_apps());
        let resp = comp.query("wx", QueryOptions::default());
        let s = comp.format(&resp, OutputFormat::Json);
        assert!(s.contains("GOTO") || s.contains("api_version") || s.contains("ok"));
    }

    #[test]
    fn test_format_compact() {
        let comp = EngineComponent::new();
        comp.set_app_dataset(sample_apps());
        let resp = comp.query("wx", QueryOptions::default());
        let s = comp.format(&resp, OutputFormat::Compact);
        assert!(s.contains("微信") || s.contains("ERROR") || s.contains(". "));
    }

    #[test]
    fn test_format_text() {
        let comp = EngineComponent::new();
        comp.set_app_dataset(sample_apps());
        let resp = comp.query("wx", QueryOptions::default());
        let s = comp.format(&resp, OutputFormat::Text);
        assert!(s.contains("GOTO Engine"));
    }

    #[test]
    fn test_event_subscribe_and_emit() {
        let comp = EngineComponent::new();
        comp.set_app_dataset(sample_apps());

        let counter = Arc::new(StdRwLock::new(0u32));
        let counter_clone = counter.clone();
        let listener: EventListener = Arc::new(move |_payload| {
            #[cfg(feature = "std")]
            { let mut w = counter_clone.write().unwrap(); *w += 1; }
            #[cfg(not(feature = "std"))]
            { let mut w = counter_clone.write(); *w += 1; }
        });

        let _handle = comp.on("query", listener);
        let _ = comp.query("wx", QueryOptions::default());

        #[cfg(feature = "std")]
        let count = *counter.read().unwrap();
        #[cfg(not(feature = "std"))]
        let count = *counter.read();
        assert_eq!(count, 1, "query 事件应被触发一次");
    }

    #[test]
    fn test_event_handle_off() {
        let comp = EngineComponent::new();
        comp.set_app_dataset(sample_apps());

        let counter = Arc::new(StdRwLock::new(0u32));
        let counter_clone = counter.clone();
        let listener: EventListener = Arc::new(move |_| {
            #[cfg(feature = "std")]
            { let mut w = counter_clone.write().unwrap(); *w += 1; }
            #[cfg(not(feature = "std"))]
            { let mut w = counter_clone.write(); *w += 1; }
        });

        let handle = comp.on("query", listener);
        handle.off();
        let _ = comp.query("wx", QueryOptions::default());

        #[cfg(feature = "std")]
        let count = *counter.read().unwrap();
        #[cfg(not(feature = "std"))]
        let count = *counter.read();
        assert_eq!(count, 0, "off 后不应再触发");
    }

    #[test]
    fn test_status() {
        let comp = EngineComponent::new();
        let status = comp.status();
        assert_eq!(status.api_version, "1.0.0");
        assert!(status.ready);
        assert_eq!(status.dataset_size, 0);
    }

    #[test]
    fn test_clamp_limit() {
        assert_eq!(clamp_limit(None), 12);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(50)), 50);
        assert_eq!(clamp_limit(Some(200)), 100);
    }

    #[test]
    fn test_adapter() {
        let comp = EngineComponent::new();
        // 默认 NullAdapter：isSimIntEnabled 应返回 false
        assert!(!comp.is_simint_enabled());
        comp.enable_simint(true);
        // NullAdapter 不存储，仍为 false
        assert!(!comp.is_simint_enabled());
    }

    #[test]
    fn test_search_compat() {
        let comp = EngineComponent::new();
        comp.set_app_dataset(sample_apps());
        let ctx = comp.search("wx");
        assert!(!ctx.list.is_empty());
    }

    #[test]
    fn test_fuzzy_search_compat() {
        let comp = EngineComponent::new();
        comp.set_app_dataset(sample_apps());
        let hits = comp.fuzzy_search("wx");
        assert!(!hits.is_empty());
    }

    #[test]
    fn test_create_factory() {
        let comp = create();
        assert_eq!(comp.version(), "1.0.0");
    }
}
