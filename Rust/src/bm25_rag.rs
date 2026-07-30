//! GOTO Engine · BM25 RAG Search — 基于 documentText 的自动语义检索
//!
//! 与 JS 版 `algorithms/rag/bm25-rag-search.js` 和 Kotlin 版
//! `Rerank/BM25RagSearch.kt` 对齐（v1.0.0，三语言同步）。
//!
//! 原理：对 RAG vectors 的 documentText 建倒排索引，查询时用 BM25 算法
//! 自动计算相似度，无需手写意图规则，无需神经网络模型。
//!
//! 分词策略：
//!   - 中文：unigram（单字）+ bigram（双字组合），兼顾精确与模糊
//!   - 英文：小写化按词
//!   - 数字：按串
//!
//! BM25 参数：k1 = 1.5（词频饱和），b = 0.75（文档长度归一化）
//!
//! 使用：
//! ```ignore
//! use goto_engine::bm25_rag::Bm25RagSearch;
//! let mut bm25 = Bm25RagSearch::new();
//! bm25.build(&[("com.app", "公园导航")]);
//! let results = bm25.search("公园", 10);
//! ```

use alloc::collections::{BTreeMap, BTreeSet};
use alloc::format;
use alloc::string::String;
use alloc::string::ToString;
use alloc::vec;
use alloc::vec::Vec;
use core::cmp::Ordering;

/// 版本号（与 JS `BM25RagSearch.version` / Kotlin `BM25RagSearch.VERSION` 对齐）
pub const VERSION: &str = "1.0.0";

/// 中文字符范围下界（CJK 统一汉字 \u4e00）
const CN_LO: u32 = 0x4e00;
/// 中文字符范围上界（CJK 统一汉字 \u9fa5）
const CN_HI: u32 = 0x9fa5;

/// 判断是否为 CJK 统一汉字（等价于 JS `/[\u4e00-\u9fa5]/`）
#[inline]
fn is_cjk(c: char) -> bool {
    let cp = c as u32;
    cp >= CN_LO && cp <= CN_HI
}

/// 判断是否为 ASCII 小写字母
#[inline]
fn is_ascii_lower(c: char) -> bool {
    c >= 'a' && c <= 'z'
}

/// 判断是否为 ASCII 数字
#[inline]
fn is_ascii_digit(c: char) -> bool {
    c >= '0' && c <= '9'
}

/// 分词：中文 unigram+bigram，英文按词小写，数字按串
///
/// 与 JS `tokenize` / Kotlin `BM25RagSearch.tokenize` 行为一致：
///   1. 英文词（先 toLowerCase，再匹配 `[a-z]+`）
///   2. 数字串（匹配 `[0-9]+`，基于原文）
///   3. 中文字符序列（匹配 `[\u4e00-\u9fa5]`）
///   4. 中文 unigram（每个字）
///   5. 中文 bigram（相邻两字组合）
///
/// 注意：中文 bigram 通过 `chars()` 收集为 `Vec<char>` 再组合，
/// 正确处理 UTF-8 字符边界。
pub fn tokenize(text: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    if text.is_empty() {
        return tokens;
    }

    // 英文词（小写化）：扫描原文，A-Z → a-z，连续 ASCII 字母收集
    // 等价于 JS `text.toLowerCase().match(/[a-z]+/g)`
    {
        let mut cur = String::new();
        let mut in_word = false;
        for c in text.chars() {
            // 仅 A-Z 需要转小写；其他字符不在 [a-z] 范围内，会被当作分隔符
            let lc = if c >= 'A' && c <= 'Z' {
                ((c as u8) + 32) as char
            } else {
                c
            };
            if is_ascii_lower(lc) {
                cur.push(lc);
                in_word = true;
            } else if in_word {
                tokens.push(cur.clone());
                cur.clear();
                in_word = false;
            }
        }
        if in_word {
            tokens.push(cur);
        }
    }

    // 数字串：匹配 [0-9]+
    {
        let mut cur = String::new();
        let mut in_num = false;
        for c in text.chars() {
            if is_ascii_digit(c) {
                cur.push(c);
                in_num = true;
            } else if in_num {
                tokens.push(cur.clone());
                cur.clear();
                in_num = false;
            }
        }
        if in_num {
            tokens.push(cur);
        }
    }

    // 中文字符序列（单字）
    let cn_chars: Vec<char> = text.chars().filter(|c| is_cjk(*c)).collect();
    // unigram：每个中文字
    for c in &cn_chars {
        tokens.push(c.to_string());
    }
    // bigram：相邻两字组合（捕获"公园""导航"等词级语义）
    if cn_chars.len() > 1 {
        for i in 0..cn_chars.len() - 1 {
            let mut s = String::with_capacity(cn_chars[i].len_utf8() + cn_chars[i + 1].len_utf8());
            s.push(cn_chars[i]);
            s.push(cn_chars[i + 1]);
            tokens.push(s);
        }
    }

    tokens
}

/// 文档条目：id、原文、分词、长度、词频表
#[derive(Debug, Clone)]
struct DocEntry {
    id: String,
    #[allow(dead_code)]
    text: String,
    #[allow(dead_code)]
    tokens: Vec<String>,
    len: usize,
    tf: BTreeMap<String, usize>,
}

/// 倒排索引条目：df + postings（docIdx → tf）
#[derive(Debug, Clone)]
struct InvertedEntry {
    df: usize,
    postings: Vec<(usize, usize)>,
}

/// BM25 倒排索引检索器
///
/// 与 JS `BM25RagSearch` / Kotlin `BM25RagSearch` 对齐。
pub struct Bm25RagSearch {
    k1: f64,
    b: f64,
    docs: Vec<DocEntry>,
    inverted: BTreeMap<String, InvertedEntry>,
    avgdl: f64,
    n: usize,
    built: bool,
}

impl Bm25RagSearch {
    /// 默认参数构造（k1=1.5, b=0.75）
    pub fn new() -> Self {
        Self::new_with_params(1.5, 0.75)
    }

    /// 自定义参数构造
    pub fn new_with_params(k1: f64, b: f64) -> Self {
        Self {
            k1,
            b,
            docs: Vec::new(),
            inverted: BTreeMap::new(),
            avgdl: 0.0,
            n: 0,
            built: false,
        }
    }

    /// 构建 BM25 索引
    ///
    /// `vectors` 每项为 `(id, documentText)` — 调用方负责从
    /// `RagVectorEntry` 转换（与 Kotlin 版 `build(List<Pair<String, String>>)` 对齐）。
    pub fn build(&mut self, vectors: &[(&str, &str)]) {
        self.docs.clear();
        self.inverted.clear();
        self.avgdl = 0.0;
        self.n = 0;
        self.built = false;

        if vectors.is_empty() {
            return;
        }

        let mut docs: Vec<DocEntry> = Vec::with_capacity(vectors.len());
        // token -> 出现该 token 的 docIdx 集合
        let mut doc_freq: BTreeMap<String, BTreeSet<usize>> = BTreeMap::new();
        let mut total_len: usize = 0;

        for (i, v) in vectors.iter().enumerate() {
            let id = if v.0.is_empty() {
                format!("doc_{}", i)
            } else {
                v.0.to_string()
            };
            let text = v.1;
            let tokens = tokenize(text);
            let mut tf: BTreeMap<String, usize> = BTreeMap::new();
            for t in &tokens {
                *tf.entry(t.clone()).or_insert(0) += 1;
                doc_freq
                    .entry(t.clone())
                    .or_insert_with(BTreeSet::new)
                    .insert(i);
            }
            let len = tokens.len();
            docs.push(DocEntry {
                id,
                text: text.to_string(),
                tokens,
                len,
                tf,
            });
            total_len += len;
        }

        self.n = docs.len();
        self.avgdl = if self.n > 0 {
            total_len as f64 / self.n as f64
        } else {
            0.0
        };

        // 构建倒排索引
        let mut inv: BTreeMap<String, InvertedEntry> = BTreeMap::new();
        for (token, idx_set) in doc_freq.iter() {
            let df = idx_set.len();
            let mut postings: Vec<(usize, usize)> = Vec::with_capacity(df);
            for &idx in idx_set {
                let tf = docs[idx].tf.get(token).copied().unwrap_or(0);
                postings.push((idx, tf));
            }
            inv.insert(token.clone(), InvertedEntry { df, postings });
        }

        self.docs = docs;
        self.inverted = inv;
        self.built = true;
    }

    /// BM25 检索
    ///
    /// 返回按分数降序的 `(id, score)` 列表（取前 `top_k` 条）。
    /// 同分按 docIdx 升序（与 JS `for...in` 整数键升序 + 稳定排序对齐）。
    pub fn search(&self, query: &str, top_k: usize) -> Vec<(String, f64)> {
        if !self.built || query.is_empty() {
            return Vec::new();
        }
        let q_tokens = tokenize(query);
        if q_tokens.is_empty() {
            return Vec::new();
        }

        let mut scores: BTreeMap<usize, f64> = BTreeMap::new();
        let avgdl_safe = if self.avgdl > 0.0 { self.avgdl } else { 1.0 };

        // 去重查询 token（同一 token 只算一次）
        let mut seen: BTreeSet<String> = BTreeSet::new();
        for t in &q_tokens {
            if !seen.insert(t.clone()) {
                continue;
            }
            let entry = match self.inverted.get(t) {
                Some(e) => e,
                None => continue,
            };
            let df = entry.df;
            // IDF（BM25 变体，保证非负）
            let idf = (1.0 + (self.n as f64 - df as f64 + 0.5) / (df as f64 + 0.5)).ln();
            if idf <= 0.0 {
                continue;
            }
            for &(doc_idx, tf) in &entry.postings {
                let doc = &self.docs[doc_idx];
                let dl = doc.len as f64;
                // BM25 分数 = IDF * (tf * (k1+1)) / (tf + k1*(1-b+b*dl/avgdl))
                let denom = tf as f64 + self.k1 * (1.0 - self.b + self.b * dl / avgdl_safe);
                let s = idf * (tf as f64 * (self.k1 + 1.0)) / denom;
                *scores.entry(doc_idx).or_insert(0.0) += s;
            }
        }

        // 排序：score 降序，docIdx 升序
        let mut arr: Vec<(usize, f64)> = scores.into_iter().collect();
        arr.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(Ordering::Equal)
                .then(a.0.cmp(&b.0))
        });
        if top_k < arr.len() {
            arr.truncate(top_k);
        }
        arr.into_iter()
            .map(|(idx, sc)| (self.docs[idx].id.clone(), sc))
            .collect()
    }

    /// 索引是否已构建
    pub fn is_built(&self) -> bool {
        self.built
    }

    /// 文档总数
    pub fn size(&self) -> usize {
        self.n
    }
}

impl Default for Bm25RagSearch {
    fn default() -> Self {
        Self::new()
    }
}

// ─── 单元测试 ───────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tokenize_empty() {
        assert!(tokenize("").is_empty());
    }

    #[test]
    fn test_tokenize_english_lowercase() {
        let tokens = tokenize("Hello World 123");
        // 小写化英文词
        assert!(tokens.contains(&"hello".to_string()));
        assert!(tokens.contains(&"world".to_string()));
        // 数字串
        assert!(tokens.contains(&"123".to_string()));
    }

    #[test]
    fn test_tokenize_chinese_unigram_and_bigram() {
        let tokens = tokenize("公园");
        // unigram
        assert!(tokens.contains(&"公".to_string()));
        assert!(tokens.contains(&"园".to_string()));
        // bigram
        assert!(tokens.contains(&"公园".to_string()));
    }

    #[test]
    fn test_tokenize_chinese_bigram_utf8_boundary() {
        // 验证 UTF-8 字符边界：3 个中文字符应产生 2 个 bigram
        let tokens = tokenize("导航仪");
        assert!(tokens.contains(&"导航".to_string()));
        assert!(tokens.contains(&"航仪".to_string()));
        assert!(tokens.contains(&"导".to_string()));
        assert!(tokens.contains(&"航".to_string()));
        assert!(tokens.contains(&"仪".to_string()));
    }

    #[test]
    fn test_build_empty() {
        let mut bm25 = Bm25RagSearch::new();
        bm25.build(&[]);
        assert!(!bm25.is_built());
        assert_eq!(bm25.size(), 0);
    }

    #[test]
    fn test_build_and_size() {
        let mut bm25 = Bm25RagSearch::new();
        bm25.build(&[("com.a", "公园导航"), ("com.b", "音乐播放")]);
        assert!(bm25.is_built());
        assert_eq!(bm25.size(), 2);
    }

    #[test]
    fn test_search_basic() {
        let mut bm25 = Bm25RagSearch::new();
        bm25.build(&[
            ("com.a", "公园导航地图"),
            ("com.b", "音乐播放器"),
            ("com.c", "公园附近美食"),
        ]);
        let results = bm25.search("公园", 10);
        // 应命中 com.a 和 com.c
        assert!(results.len() >= 2);
        let ids: Vec<String> = results.iter().map(|(id, _)| id.clone()).collect();
        assert!(ids.contains(&"com.a".to_string()));
        assert!(ids.contains(&"com.c".to_string()));
        // com.b 不含"公园"，不应命中
        assert!(!ids.contains(&"com.b".to_string()));
    }

    #[test]
    fn test_search_top_k() {
        let mut bm25 = Bm25RagSearch::new();
        bm25.build(&[
            ("com.a", "公园"),
            ("com.b", "公园"),
            ("com.c", "公园"),
        ]);
        let results = bm25.search("公园", 2);
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn test_search_empty_query() {
        let mut bm25 = Bm25RagSearch::new();
        bm25.build(&[("com.a", "公园")]);
        assert!(bm25.search("", 10).is_empty());
    }

    #[test]
    fn test_search_not_built() {
        let bm25 = Bm25RagSearch::new();
        assert!(bm25.search("公园", 10).is_empty());
    }

    #[test]
    fn test_search_score_descending() {
        let mut bm25 = Bm25RagSearch::new();
        bm25.build(&[
            ("com.a", "公园 公园 公园"),
            ("com.b", "公园"),
        ]);
        let results = bm25.search("公园", 10);
        // tf 更高的文档分数应更高
        assert_eq!(results[0].0, "com.a");
        // 分数严格递减
        assert!(results[0].1 >= results[1].1);
    }

    #[test]
    fn test_custom_params() {
        let mut bm25 = Bm25RagSearch::new_with_params(2.0, 0.5);
        bm25.build(&[("com.a", "公园导航")]);
        assert!(bm25.is_built());
        let results = bm25.search("公园", 10);
        assert!(!results.is_empty());
    }

    #[test]
    fn test_version() {
        assert_eq!(VERSION, "1.0.0");
    }

    #[test]
    fn test_empty_id_fallback() {
        let mut bm25 = Bm25RagSearch::new();
        bm25.build(&[("", "公园")]);
        let results = bm25.search("公园", 10);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "doc_0");
    }

    #[test]
    fn test_default_impl() {
        let bm25 = Bm25RagSearch::default();
        assert!(!bm25.is_built());
        assert_eq!(bm25.size(), 0);
    }

    #[test]
    fn test_rebuild_resets_state() {
        let mut bm25 = Bm25RagSearch::new();
        bm25.build(&[("com.a", "公园"), ("com.b", "音乐")]);
        assert_eq!(bm25.size(), 2);
        // 重建为更小的集合
        bm25.build(&[("com.c", "导航")]);
        assert_eq!(bm25.size(), 1);
        let results = bm25.search("公园", 10);
        // 旧索引应被清除
        assert!(results.is_empty());
    }
}
