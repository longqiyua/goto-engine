//! GOTO Base — 语义向量检索（Rust 版）
//!
//! 与 JS 版 `algorithms/semantic/SemanticSearch.js` 和
//! Kotlin 版 `Rerank/SemanticSearch.kt` 行为对齐。
//!
//! MVP 实现：纯线性扫描 cosine 相似度。生产环境可替换为 hnswlib。
//!
//! 设计：
//!   - L2 归一化后存入 `BTreeMap<id, Vec<f64>>`，cosine 退化为点积
//!   - [`SemanticSearch::load`] 接受 `(id, vector)` 列表，避免耦合 JSON 解析
//!   - [`SemanticSearch::search`] 在无 `query_vector` 时返回空（MVP 无 embedding 模型）
//!
//! 注：使用 `BTreeMap` 而非 `HashMap`，以兼容 `no_std`（crate 默认 no_std 友好）。
//!
//! v2.1 新增

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use alloc::collections::BTreeMap;

/// 语义向量检索器
#[derive(Debug, Default)]
pub struct SemanticSearch {
    /// id -> L2 归一化后的向量
    vectors: BTreeMap<String, Vec<f64>>,
    /// 元信息（key -> value 字符串）
    meta: BTreeMap<String, String>,
    /// 是否已加载
    loaded: bool,
}

impl SemanticSearch {
    /// 构造空的检索器。
    pub fn new() -> Self {
        Self::default()
    }

    /// 加载向量列表（每个元素为 `(id, 原始向量)`）。
    ///
    /// 内部会对每个向量做 L2 归一化后存入。空 id / 空向量会被跳过；
    /// 重复 id 后者覆盖前者。
    pub fn load(&mut self, vectors: &[(String, Vec<f64>)]) {
        self.vectors.clear();
        for (id, vec) in vectors {
            if id.is_empty() || vec.is_empty() {
                continue;
            }
            self.vectors.insert(id.clone(), Self::normalize(vec));
        }
        self.loaded = true;
    }

    /// 设置元信息（与 JS `meta` 对齐，例如 model / dim）。
    pub fn set_meta(&mut self, key: &str, value: &str) {
        self.meta.insert(key.to_string(), value.to_string());
    }

    /// 用查询向量检索 top-K 最近邻。
    ///
    /// 返回 `(id, score)` 列表，按相似度降序。
    /// `k == 0` 时取默认 10（与 JS `k || 10` 一致）。
    pub fn search_by_vector(&self, query_vec: &[f64], k: usize) -> Vec<(String, f64)> {
        if !self.loaded {
            return Vec::new();
        }
        let q = Self::normalize(query_vec);
        let mut scored: Vec<(String, f64)> = self
            .vectors
            .iter()
            .map(|(id, vec)| (id.clone(), Self::cosine(&q, vec)))
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(core::cmp::Ordering::Equal));
        let limit = if k > 0 { k } else { 10 };
        scored.truncate(limit);
        scored
    }

    /// 用文本查询检索（MVP：依赖外部预计算的 `query_vector`）。
    ///
    /// `query_vector` 为 `None` 或空切片时返回空（避免错误匹配）。
    pub fn search(&self, query: &str, k: usize, query_vector: Option<&[f64]>) -> Vec<(String, f64)> {
        let _ = query; // MVP 阶段不使用，保留以对齐 JS 签名
        if let Some(qv) = query_vector {
            if !qv.is_empty() {
                return self.search_by_vector(qv, k);
            }
        }
        Vec::new()
    }

    /// 是否已加载。
    pub fn is_loaded(&self) -> bool {
        self.loaded
    }

    /// 已加载向量数。
    pub fn size(&self) -> usize {
        self.vectors.len()
    }

    /// 元信息。
    pub fn meta(&self) -> &BTreeMap<String, String> {
        &self.meta
    }

    // ─── 内部辅助 ──────────────────────────────────────────────────────────

    /// L2 归一化（零向量原样返回，与 JS 一致）。
    fn normalize(vec: &[f64]) -> Vec<f64> {
        let norm: f64 = vec.iter().map(|v| v * v).sum::<f64>().sqrt();
        if norm == 0.0 {
            return vec.to_vec();
        }
        vec.iter().map(|v| v / norm).collect()
    }

    /// 点积（向量已归一化时即 cosine）。长度不一致时取较短者，避免越界。
    fn cosine(a: &[f64], b: &[f64]) -> f64 {
        let n = a.len().min(b.len());
        let mut dot = 0.0f64;
        for i in 0..n {
            dot += a[i] * b[i];
        }
        dot
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_and_size() {
        let mut s = SemanticSearch::new();
        assert!(!s.is_loaded());
        s.load(&[
            ("com.a".into(), vec![1.0, 0.0, 0.0]),
            ("com.b".into(), vec![0.0, 1.0, 0.0]),
        ]);
        assert!(s.is_loaded());
        assert_eq!(s.size(), 2);
    }

    #[test]
    fn test_search_by_vector_topk() {
        let mut s = SemanticSearch::new();
        s.load(&[
            ("com.a".into(), vec![1.0, 0.0, 0.0]),
            ("com.b".into(), vec![0.0, 1.0, 0.0]),
            ("com.c".into(), vec![0.7071, 0.7071, 0.0]),
        ]);
        let result = s.search_by_vector(&[1.0, 0.0, 0.0], 2);
        assert_eq!(result.len(), 2);
        // 最相似：com.a（cosine=1.0）
        assert_eq!(result[0].0, "com.a");
        assert!((result[0].1 - 1.0).abs() < 1e-6);
        // 次相似：com.c（cosine≈0.7071）
        assert_eq!(result[1].0, "com.c");
    }

    #[test]
    fn test_search_without_query_vector_returns_empty() {
        let mut s = SemanticSearch::new();
        s.load(&[("com.a".into(), vec![1.0, 0.0])]);
        // 无 query_vector → 空结果
        assert!(s.search("任意文本", 5, None).is_empty());
    }

    #[test]
    fn test_search_with_query_vector() {
        let mut s = SemanticSearch::new();
        s.load(&[("com.a".into(), vec![1.0, 0.0])]);
        let result = s.search("ignored", 5, Some(&[1.0, 0.0]));
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].0, "com.a");
    }

    #[test]
    fn test_zero_vector_does_not_crash() {
        let mut s = SemanticSearch::new();
        s.load(&[("com.zero".into(), vec![0.0, 0.0, 0.0])]);
        assert_eq!(s.size(), 1);
        let result = s.search_by_vector(&[1.0, 0.0, 0.0], 5);
        // 零向量归一化后仍为零，点积为 0
        assert!((result[0].1 - 0.0).abs() < 1e-12);
    }

    #[test]
    fn test_default_k_when_zero() {
        let mut s = SemanticSearch::new();
        let data: Vec<(String, Vec<f64>)> = (0..15)
            .map(|i| {
                let mut v = vec![0.0; 16];
                v[i] = 1.0;
                (format!("com.{}", i), v)
            })
            .collect();
        s.load(&data);
        let mut q = vec![0.0; 16];
        q[0] = 1.0;
        // k=0 应回退到默认 10
        let result = s.search_by_vector(&q, 0);
        assert_eq!(result.len(), 10);
    }
}
