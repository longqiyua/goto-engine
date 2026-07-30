//! GOTO Engine · 月度 RAG 重建算法（纯函数）
//!
//! 与 Kotlin 版 `Rerank/RagRebuilder.kt` 和 JS 版
//! `algorithms/rag/rag-rebuilder.js` 对齐（V2.1 三语言同步）。
//!
//! 设计：
//!   - 纯函数：不读写 IO，不修改入参，返回新对象
//!   - [EmbedderPort] 由 app 层注入具体实现（base 小模型），Engine 不依赖具体模型
//!   - 向量维度 512（与公共 RAG 一致，bge-small-zh-v1.5）
//!   - 序列化方法 [serialize_vector_store] / [serialize_rag_index] 供
//!     Worker 和 Facade 共用
//!
//! v2.1 新增

use alloc::string::String;
use alloc::string;
use alloc::vec;
use alloc::vec::Vec;
use alloc::collections::BTreeMap;
use alloc::format;

use crate::rerank::PersonalSnapshot;

#[cfg(feature = "std")]
use std::time::{SystemTime, UNIX_EPOCH};

/// 向量维度（与公共 RAG 一致，bge-small-zh-v1.5）
pub const DIMENSION: usize = 512;

/// Embedder 端口接口 — 由 app 层注入具体实现（base 小模型）
///
/// 实现方应保证 [embed](EmbedderPort::embed) 不会 panic；
/// 若发生 panic 将向上传播（与 Kotlin/JS 的 catch→零向量不同，
/// Rust 倾向让调用方处理 embedder 故障）。
pub trait EmbedderPort {
    /// 将文本嵌入为 DIMENSION 维向量
    fn embed(&self, text: &str) -> Vec<f32>;
}

// ─── 数据结构（与 Kotlin 对齐） ──────────────────────────────

/// 应用信息（与 Kotlin `AppInfo` 对齐）
///
/// 独立于 [crate::types::AppItem]，因为 RAG 重建需要
/// `pinyin_array` / `is_system_app` 等字段，避免破坏现有类型。
#[derive(Debug, Clone, Default)]
pub struct RagAppInfo {
    /// 包名
    pub package_name: String,
    /// 应用显示名
    pub label: String,
    /// 完整拼音拼接（如 "weixin"）
    pub pinyin: String,
    /// 拼音首字母（如 "wx"）
    pub pinyin_initials: String,
    /// 逐字拼音数组（如 ["wei", "xin"]）
    pub pinyin_array: Vec<String>,
    /// 是否系统应用
    pub is_system_app: bool,
}

/// 元数据值（与 Kotlin `Map<String, Any>` 对齐）
#[derive(Debug, Clone)]
pub enum MetaValue {
    Str(String),
    Bool(bool),
    Num(f64),
}

impl MetaValue {
    /// 序列化为 JSON 值字符串
    fn to_json_value(&self) -> String {
        match self {
            MetaValue::Str(s) => json_str(s),
            MetaValue::Bool(b) => if *b { "true".into() } else { "false".into() },
            MetaValue::Num(n) => format!("{}", n),
        }
    }
}

/// 单条 RAG 向量条目（与 Kotlin `RagVectorEntry` 对齐）
#[derive(Debug, Clone)]
pub struct RagVectorEntry {
    pub id: usize,
    pub package_name: String,
    pub document_text: String,
    pub vector: Vec<f32>,
    pub intent_tags: Vec<String>,
    pub metadata: BTreeMap<String, MetaValue>,
}

/// RAG 索引结构（与 Kotlin `RagIndex` 对齐）
#[derive(Debug, Clone, Default)]
pub struct RagIndex {
    pub by_package: BTreeMap<String, usize>,
    pub by_category: BTreeMap<String, Vec<usize>>,
    pub by_intent_tag: BTreeMap<String, Vec<usize>>,
}

/// RAG 重建结果（与 Kotlin `RagBuildResult` 对齐）
#[derive(Debug, Clone)]
pub struct RagBuildResult {
    pub vectors: Vec<RagVectorEntry>,
    pub index: RagIndex,
}

// ─── JSON 字符串转义（no_std 友好，不依赖 serde_json） ─────

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    out.push_str(&json_escape(s));
    out.push('"');
    out
}

// ─── 个人层信号命中检测（与 Kotlin 内联逻辑对齐） ───────────

/// heatmap 高频时段 top 应用命中
fn heatmap_hit(snapshot: &PersonalSnapshot, pkg: &str) -> bool {
    if let Some(hm) = &snapshot.heatmap {
        for cell in &hm.cells {
            for app in &cell.top_apps {
                if app.package_name == pkg {
                    return true;
                }
            }
        }
    }
    false
}

/// transition 高频目标应用命中
fn transition_hit(snapshot: &PersonalSnapshot, pkg: &str) -> bool {
    if let Some(tm) = &snapshot.transition_matrix {
        for edges in tm.transitions.values() {
            for e in edges {
                if e.to_package == pkg {
                    return true;
                }
            }
        }
    }
    false
}

/// feedback 最近点击命中
fn feedback_hit(snapshot: &PersonalSnapshot, pkg: &str) -> bool {
    for e in &snapshot.recent_feedback {
        if e.clicked_package == pkg {
            return true;
        }
    }
    false
}

/// affinity 偏好信号命中（currentWeight > 0）
fn affinity_hit(snapshot: &PersonalSnapshot, pkg: &str) -> bool {
    if let Some(aff) = snapshot.affinities.get(pkg) {
        return aff.current_weight > 0.0;
    }
    false
}

/// 生成意图标签：基于个人层信号（与 Kotlin `buildIntentTags` 对齐）
fn build_intent_tags(app: &RagAppInfo, snapshot: &PersonalSnapshot) -> Vec<String> {
    let mut tags = Vec::new();
    if snapshot.degraded {
        return tags;
    }
    let pkg = app.package_name.as_str();
    if pkg.is_empty() {
        return tags;
    }
    if heatmap_hit(snapshot, pkg) {
        tags.push(string::String::from("time_frequent"));
    }
    if transition_hit(snapshot, pkg) {
        tags.push(string::String::from("transition_target"));
    }
    if feedback_hit(snapshot, pkg) {
        tags.push(string::String::from("recent_click"));
    }
    if affinity_hit(snapshot, pkg) {
        tags.push(string::String::from("preferred"));
    }
    tags
}

// ─── 公开 API ───────────────────────────────────────────────

/// 为单个应用构建文档文本：appName + aliases(拼音) + 个人层 boost 信号
///
/// 个人层 boost 信号（若 snapshot 未降级）：
///   - heatmap 高频时段 top 应用 → "时段高频"
///   - transition 高频目标应用 → "跳转高频"
///   - feedback 最近点击 → "最近点击"
///   - affinity 偏好应用 → "偏好应用"
pub fn build_document_text(app: &RagAppInfo, snapshot: &PersonalSnapshot) -> String {
    let mut sb = String::with_capacity(128);
    sb.push_str(&app.label);

    // 别名：拼音 + 首字母 + 逐字拼音
    if !app.pinyin.is_empty() {
        sb.push(' ');
        sb.push_str(&app.pinyin);
    }
    if !app.pinyin_initials.is_empty() {
        sb.push(' ');
        sb.push_str(&app.pinyin_initials);
    }
    for p in &app.pinyin_array {
        if !p.is_empty() {
            sb.push(' ');
            sb.push_str(p);
        }
    }

    // 个人层 boost 信号
    if !snapshot.degraded {
        let pkg = app.package_name.as_str();
        if !pkg.is_empty() {
            if heatmap_hit(snapshot, pkg) {
                sb.push_str(" 时段高频");
            }
            if transition_hit(snapshot, pkg) {
                sb.push_str(" 跳转高频");
            }
            if feedback_hit(snapshot, pkg) {
                sb.push_str(" 最近点击");
            }
            if affinity_hit(snapshot, pkg) {
                sb.push_str(" 偏好应用");
            }
        }
    }

    sb
}

/// 批量重建 RAG 向量库
///
/// 对每个 app 调用 [build_document_text] → `embedder.embed(text)`
/// 得到 512 维向量 → 组装 [RagBuildResult]。
///
/// 向量维度兜底：若 embedder 返回长度不等于 [DIMENSION]，
/// 不足补零、超长截断。
pub fn rebuild(
    apps: &[RagAppInfo],
    snapshot: &PersonalSnapshot,
    embedder: &dyn EmbedderPort,
) -> RagBuildResult {
    let mut vectors: Vec<RagVectorEntry> = Vec::with_capacity(apps.len());
    let mut by_package: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_intent_tag: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    let mut by_category: BTreeMap<String, Vec<usize>> = BTreeMap::new();

    for (idx, app) in apps.iter().enumerate() {
        let doc_text = build_document_text(app, snapshot);
        let raw = embedder.embed(&doc_text);
        let vector = normalize_dim(raw);

        let intent_tags = build_intent_tags(app, snapshot);
        let mut metadata: BTreeMap<String, MetaValue> = BTreeMap::new();
        metadata.insert(
            string::String::from("packageName"),
            MetaValue::Str(app.package_name.clone()),
        );
        metadata.insert(
            string::String::from("appName"),
            MetaValue::Str(app.label.clone()),
        );
        metadata.insert(
            string::String::from("isSystemApp"),
            MetaValue::Bool(app.is_system_app),
        );

        vectors.push(RagVectorEntry {
            id: idx,
            package_name: app.package_name.clone(),
            document_text: doc_text,
            vector,
            intent_tags: intent_tags.clone(),
            metadata,
        });

        by_package.insert(app.package_name.clone(), idx);
        for tag in &intent_tags {
            by_intent_tag
                .entry(tag.clone())
                .or_insert_with(Vec::new)
                .push(idx);
        }
        // category：个人层无分类信息，按 system/user 简单归类
        let category = if app.is_system_app { "系统应用" } else { "用户应用" };
        by_category
            .entry(string::String::from(category))
            .or_insert_with(Vec::new)
            .push(idx);
    }

    let index = RagIndex {
        by_package,
        by_category,
        by_intent_tag,
    };
    RagBuildResult { vectors, index }
}

/// 将向量规范化到 DIMENSION 维（不足补零，超长截断）
fn normalize_dim(mut v: Vec<f32>) -> Vec<f32> {
    if v.len() == DIMENSION {
        return v;
    }
    if v.len() < DIMENSION {
        v.resize(DIMENSION, 0.0);
        v
    } else {
        v.truncate(DIMENSION);
        v
    }
}

#[cfg(feature = "std")]
fn current_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(not(feature = "std"))]
fn current_millis() -> u64 {
    0
}

/// 序列化 vector-store JSON（与公共 RAG vector-store.json 结构对齐）
///
/// 格式与 Kotlin `serializeVectorStore` 一致：
/// ```json
/// { "version":"1.0.0", "embeddingModel":"bge-small-zh-v1.5",
///   "dimension":512, "vectorGenerator":"personal-rag-rebuilder",
///   "updatedAt":<ms>, "vectors":[ ... ] }
/// ```
pub fn serialize_vector_store(result: &RagBuildResult) -> String {
    let mut sb = String::with_capacity(256);
    sb.push('{');
    sb.push_str("\"version\":\"1.0.0\"");
    sb.push_str(",\"embeddingModel\":\"bge-small-zh-v1.5\"");
    sb.push_str(&format!(",\"dimension\":{}", DIMENSION));
    sb.push_str(",\"vectorGenerator\":\"personal-rag-rebuilder\"");
    sb.push_str(&format!(",\"updatedAt\":{}", current_millis()));
    sb.push_str(",\"vectors\":[");
    for (i, v) in result.vectors.iter().enumerate() {
        if i > 0 {
            sb.push(',');
        }
        sb.push_str(&format!(
            "{{\"id\":{},\"packageName\":{},\"documentText\":{},\"vector\":[",
            v.id,
            json_str(&v.package_name),
            json_str(&v.document_text)
        ));
        for (j, f) in v.vector.iter().enumerate() {
            if j > 0 {
                sb.push(',');
            }
            sb.push_str(&format!("{}", f));
        }
        sb.push(']');
        // intentTags
        sb.push_str(",\"intentTags\":[");
        for (j, t) in v.intent_tags.iter().enumerate() {
            if j > 0 {
                sb.push(',');
            }
            sb.push_str(&json_str(t));
        }
        sb.push(']');
        // metadata
        sb.push_str(",\"metadata\":{");
        for (j, (k, val)) in v.metadata.iter().enumerate() {
            if j > 0 {
                sb.push(',');
            }
            sb.push_str(&json_str(k));
            sb.push(':');
            sb.push_str(&val.to_json_value());
        }
        sb.push('}');
        sb.push('}');
    }
    sb.push(']');
    sb.push('}');
    sb
}

/// 序列化 rag-index JSON（与公共 RAG rag-index.json 结构对齐）
///
/// 格式与 Kotlin `serializeRagIndex` 一致：
/// ```json
/// { "version":"1.0.0", "dimension":512, "updatedAt":<ms>,
///   "totalVectors":<n>, "byPackage":{<pkg>:{"idx":<i>},...},
///   "byCategory":{<cat>:[<i>,...],...}, "byIntentTag":{<tag>:[<i>,...],...} }
/// ```
pub fn serialize_rag_index(result: &RagBuildResult) -> String {
    let mut sb = String::with_capacity(256);
    sb.push('{');
    sb.push_str("\"version\":\"1.0.0\"");
    sb.push_str(&format!(",\"dimension\":{}", DIMENSION));
    sb.push_str(&format!(",\"updatedAt\":{}", current_millis()));
    sb.push_str(&format!(",\"totalVectors\":{}", result.vectors.len()));

    // byPackage
    sb.push_str(",\"byPackage\":{");
    for (i, (pkg, idx)) in result.index.by_package.iter().enumerate() {
        if i > 0 {
            sb.push(',');
        }
        sb.push_str(&json_str(pkg));
        sb.push_str(&format!(":{{\"idx\":{}}}", idx));
    }
    sb.push('}');

    // byCategory
    sb.push_str(",\"byCategory\":{");
    for (i, (cat, idxs)) in result.index.by_category.iter().enumerate() {
        if i > 0 {
            sb.push(',');
        }
        sb.push_str(&json_str(cat));
        sb.push(':');
        sb.push('[');
        for (j, x) in idxs.iter().enumerate() {
            if j > 0 {
                sb.push(',');
            }
            sb.push_str(&format!("{}", x));
        }
        sb.push(']');
    }
    sb.push('}');

    // byIntentTag
    sb.push_str(",\"byIntentTag\":{");
    for (i, (tag, idxs)) in result.index.by_intent_tag.iter().enumerate() {
        if i > 0 {
            sb.push(',');
        }
        sb.push_str(&json_str(tag));
        sb.push(':');
        sb.push('[');
        for (j, x) in idxs.iter().enumerate() {
            if j > 0 {
                sb.push(',');
            }
            sb.push_str(&format!("{}", x));
        }
        sb.push(']');
    }
    sb.push('}');

    sb.push('}');
    sb
}

// ─── 单元测试 ───────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rerank::{
        Affinity, FeedbackContext, FeedbackEvent, HeatmapApp, HeatmapCell, HeatmapData,
        PersonalSnapshot, RuntimeContext, TransitionEdge, TransitionMatrixData,
    };

    /// 测试用 embedder：返回固定向量（首元素=文本长度，其余=0）
    struct DummyEmbedder;
    impl EmbedderPort for DummyEmbedder {
        fn embed(&self, text: &str) -> Vec<f32> {
            let mut v = vec![0.0_f32; DIMENSION];
            v[0] = text.len() as f32;
            v
        }
    }

    fn make_app(pkg: &str, label: &str) -> RagAppInfo {
        RagAppInfo {
            package_name: pkg.into(),
            label: label.into(),
            pinyin: "test".into(),
            pinyin_initials: "t".into(),
            pinyin_array: vec!["te".into(), "st".into()],
            is_system_app: false,
        }
    }

    #[test]
    fn test_build_document_text_degraded() {
        let app = make_app("com.test.app", "测试");
        let snap = PersonalSnapshot::degraded();
        let text = build_document_text(&app, &snap);
        // 降级时不应有 boost 信号
        assert!(text.contains("测试"));
        assert!(!text.contains("时段高频"));
    }

    #[test]
    fn test_build_document_text_with_signals() {
        let app = make_app("com.test.app", "测试");

        // 构建带 heatmap 命中的 snapshot
        let snap = PersonalSnapshot {
            taken_at: 1,
            degraded: false,
            heatmap: Some(HeatmapData {
                cells: vec![HeatmapCell {
                    hour: 9,
                    weekday: 1,
                    launch_count: 10,
                    top_apps: vec![HeatmapApp {
                        package_name: "com.test.app".into(),
                        count: 5,
                    }],
                }],
                last_updated: None,
            }),
            recent_feedback: vec![FeedbackEvent {
                event_id: "e1".into(),
                timestamp: "2024-01-01".into(),
                query: "test".into(),
                clicked_package: "com.test.app".into(),
                clicked_rank: 0,
                match_mode: "fuzzy".into(),
                context: FeedbackContext::default(),
            }],
            affinities: {
                let mut m = BTreeMap::new();
                m.insert(
                    "com.test.app".into(),
                    Affinity {
                        package_name: "com.test.app".into(),
                        current_weight: 0.8,
                        confidence: 1.0,
                    },
                );
                m
            },
            ..Default::default()
        };

        let text = build_document_text(&app, &snap);
        assert!(text.contains("时段高频"));
        assert!(text.contains("最近点击"));
        assert!(text.contains("偏好应用"));
        // 无 transition 命中
        assert!(!text.contains("跳转高频"));
    }

    #[test]
    fn test_rebuild_basic() {
        let apps = vec![
            make_app("com.a", "应用A"),
            make_app("com.b", "应用B"),
        ];
        let snap = PersonalSnapshot::degraded();
        let result = rebuild(&apps, &snap, &DummyEmbedder);

        assert_eq!(result.vectors.len(), 2);
        assert_eq!(result.vectors[0].id, 0);
        assert_eq!(result.vectors[1].id, 1);
        assert_eq!(result.vectors[0].package_name, "com.a");
        assert_eq!(result.vectors[0].vector.len(), DIMENSION);
        assert_eq!(result.index.by_package.get("com.a"), Some(&0));
        assert_eq!(result.index.by_package.get("com.b"), Some(&1));
        // 降级 → 无 intent tags
        assert!(result.vectors[0].intent_tags.is_empty());
        // category：均为用户应用
        assert!(result.index.by_category.contains_key("用户应用"));
    }

    #[test]
    fn test_rebuild_intent_tags() {
        let app = make_app("com.test", "测试");
        let snap = PersonalSnapshot {
            degraded: false,
            heatmap: Some(HeatmapData {
                cells: vec![HeatmapCell {
                    hour: 9,
                    weekday: 1,
                    launch_count: 5,
                    top_apps: vec![HeatmapApp {
                        package_name: "com.test".into(),
                        count: 3,
                    }],
                }],
                last_updated: None,
            }),
            ..Default::default()
        };
        let result = rebuild(&[app], &snap, &DummyEmbedder);
        assert!(result.vectors[0].intent_tags.contains(&"time_frequent".into()));
        assert!(result.index.by_intent_tag.contains_key("time_frequent"));
    }

    #[test]
    fn test_serialize_vector_store() {
        let apps = vec![make_app("com.a", "A")];
        let snap = PersonalSnapshot::degraded();
        let result = rebuild(&apps, &snap, &DummyEmbedder);
        let json = serialize_vector_store(&result);
        assert!(json.contains("\"version\":\"1.0.0\""));
        assert!(json.contains("\"dimension\":512"));
        assert!(json.contains("\"embeddingModel\":\"bge-small-zh-v1.5\""));
        assert!(json.contains("\"packageName\":\"com.a\""));
    }

    #[test]
    fn test_serialize_rag_index() {
        let apps = vec![make_app("com.a", "A"), make_app("com.b", "B")];
        let snap = PersonalSnapshot::degraded();
        let result = rebuild(&apps, &snap, &DummyEmbedder);
        let json = serialize_rag_index(&result);
        assert!(json.contains("\"totalVectors\":2"));
        assert!(json.contains("\"byPackage\""));
        assert!(json.contains("\"idx\":0"));
        assert!(json.contains("\"byCategory\""));
    }

    #[test]
    fn test_normalize_dim() {
        // 短向量补零
        let v = normalize_dim(vec![1.0, 2.0]);
        assert_eq!(v.len(), DIMENSION);
        assert_eq!(v[0], 1.0);
        assert_eq!(v[1], 2.0);
        assert_eq!(v[2], 0.0);
        // 长向量截断
        let long = vec![1.0; DIMENSION + 10];
        let v2 = normalize_dim(long);
        assert_eq!(v2.len(), DIMENSION);
        // 正好 DIMENSION 维不变
        let exact = vec![0.5; DIMENSION];
        let v3 = normalize_dim(exact);
        assert_eq!(v3.len(), DIMENSION);
        assert_eq!(v3[0], 0.5);
    }

    #[test]
    fn test_transition_hit() {
        let app = make_app("com.target", "目标");
        let snap = PersonalSnapshot {
            degraded: false,
            transition_matrix: Some(TransitionMatrixData {
                transitions: {
                    let mut m = BTreeMap::new();
                    m.insert(
                        "com.source".into(),
                        vec![TransitionEdge {
                            to_package: "com.target".into(),
                            probability: 0.5,
                            last_occurred: None,
                        }],
                    );
                    m
                },
                last_updated: None,
            }),
            ..Default::default()
        };
        let text = build_document_text(&app, &snap);
        assert!(text.contains("跳转高频"));
    }

    // 让 unused import 警告不出现（RuntimeContext 用于 ..Default::default() 推导）
    #[test]
    fn _ensure_runtime_context_used() {
        let _ = RuntimeContext::default();
    }
}
