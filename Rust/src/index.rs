//! 索引层（对应 `goto-engine.js` `createSearchIndex` / `buildSearchIndex` /
//! `rebuildIndex` / `buildTfidfIndex` / `buildTrieIndex`）。
//!
//! 包含四个子索引：
//!   1. **倒排索引**（`InvertedIndex`）：按首字母 / T9 / 前缀 / 单字建立倒排链。
//!   2. **元标签索引**（`MetaIndex`）：基于 catalog 关键词的语义倒排索引。
//!   3. **Trie 前缀树**（`TrieIndex`）：支持前缀匹配。
//!   4. **TF-IDF 索引**（`TfidfIndex`）：词项 → 文档倒排表 + IDF。

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use alloc::collections::{BTreeMap, BTreeSet};
use serde::{Deserialize, Serialize};

use crate::constants::{t9_digit, TFIDF_MAX_INDEX_SIZE};
use crate::nlp::pinyin_initial;
use crate::types::AppItem;
use crate::utils::{contains_chinese, is_chinese_char};

// ─── 倒排索引 ───────────────────────────────────────────────────────────────

/// 倒排索引（对应 JS `createSearchIndex()` 的返回值）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InvertedIndex {
    /// 首字母索引：`"wx" → ["微信"]`。
    #[serde(default)]
    pub by_initial: BTreeMap<String, Vec<String>>,
    /// T9 索引：`"99" → ["微信"]`。
    #[serde(default)]
    pub by_t9: BTreeMap<String, Vec<String>>,
    /// 前缀索引：`"微" → ["微信"]`。
    #[serde(default)]
    pub by_prefix: BTreeMap<String, Vec<String>>,
    /// 单字索引：`"信" → ["微信"]`。
    #[serde(default)]
    pub by_char: BTreeMap<String, Vec<String>>,
    /// appId 索引：`"微信" → app`（去重用）。
    #[serde(default)]
    pub by_app_id: BTreeSet<String>,
    /// 是否已构建。
    #[serde(default)]
    pub built: bool,
    /// 数据集指纹（用于检测数据集变化）。
    #[serde(default)]
    pub dataset_fingerprint: String,
}

impl InvertedIndex {
    /// 创建空索引（对应 JS `createSearchIndex()`）。
    pub fn new() -> Self {
        Self::default()
    }

    /// 构建索引（对应 JS `buildSearchIndex(apps)`）。
    pub fn build(&mut self, apps: &[AppItem]) {
        self.clear();
        for app in apps {
            self.by_app_id.insert(app.name.clone());
            self.index_app(app);
        }
        self.built = true;
        self.dataset_fingerprint = fingerprint(apps);
    }

    fn clear(&mut self) {
        self.by_initial.clear();
        self.by_t9.clear();
        self.by_prefix.clear();
        self.by_char.clear();
        self.by_app_id.clear();
        self.built = false;
    }

    fn index_app(&mut self, app: &AppItem) {
        // 1. 首字母索引（来自 abbr / 拼音首字母）
        if !app.abbr.is_empty() {
            self.by_initial
                .entry(app.abbr.to_lowercase())
                .or_default()
                .push(app.name.clone());
        }
        if !app.py.is_empty() {
            let initials: String = app
                .py
                .split_whitespace()
                .filter_map(|w| w.chars().next())
                .collect();
            if !initials.is_empty() {
                self.by_initial
                    .entry(initials.to_lowercase())
                    .or_default()
                    .push(app.name.clone());
            }
        }
        // 中文 → 拼音首字母
        let cn_initials: String = app
            .name
            .chars()
            .filter_map(|c| {
                if is_chinese_char(c) {
                    pinyin_initial(c)
                } else {
                    None
                }
            })
            .collect();
        if !cn_initials.is_empty() {
            self.by_initial
                .entry(cn_initials.to_lowercase())
                .or_default()
                .push(app.name.clone());
        }

        // 2. T9 索引（来自 abbr / 拼音首字母的 T9 编码）
        let t9_from_abbr: String = app
            .abbr
            .chars()
            .filter_map(|c| t9_digit(c))
            .collect();
        if !t9_from_abbr.is_empty() {
            self.by_t9.entry(t9_from_abbr).or_default().push(app.name.clone());
        }
        let t9_from_cn: String = app
            .name
            .chars()
            .filter_map(|c| {
                if is_chinese_char(c) {
                    pinyin_initial(c).and_then(|l| t9_digit(l))
                } else {
                    t9_digit(c)
                }
            })
            .collect();
        if !t9_from_cn.is_empty() {
            self.by_t9.entry(t9_from_cn).or_default().push(app.name.clone());
        }

        // 3. 前缀索引（name / py / en 的前 1..=4 个字符）
        for field in &[app.name.as_str(), app.py.as_str(), app.en.as_str()] {
            if field.is_empty() { continue; }
            let chars: Vec<char> = field.chars().collect();
            for len in 1..=4.min(chars.len()) {
                let prefix: String = chars[..len].iter().collect();
                self.by_prefix
                    .entry(prefix.to_lowercase())
                    .or_default()
                    .push(app.name.clone());
            }
        }

        // 4. 单字索引（name / en 的每个字符）
        for c in app.name.chars() {
            if c.is_whitespace() { continue; }
            let key = c.to_string();
            self.by_char.entry(key).or_default().push(app.name.clone());
        }
        for c in app.en.chars() {
            if c.is_whitespace() { continue; }
            let key = c.to_lowercase().to_string();
            self.by_char.entry(key).or_default().push(app.name.clone());
        }
    }

    /// 查询首字母命中。
    pub fn lookup_initial(&self, query: &str) -> &[String] {
        self.by_initial
            .get(&query.to_lowercase())
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    /// 查询 T9 命中。
    pub fn lookup_t9(&self, query: &str) -> &[String] {
        self.by_t9.get(query).map(|v| v.as_slice()).unwrap_or(&[])
    }

    /// 查询前缀命中。
    pub fn lookup_prefix(&self, query: &str) -> &[String] {
        self.by_prefix
            .get(&query.to_lowercase())
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    /// 查询单字命中。
    pub fn lookup_char(&self, query: &str) -> &[String] {
        self.by_char
            .get(query)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }
}

// ─── 元标签索引 ─────────────────────────────────────────────────────────────

/// 元标签索引（基于 catalog 关键词）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MetaIndex {
    /// 关键词 → app 列表。
    #[serde(default)]
    pub keyword_to_apps: BTreeMap<String, Vec<String>>,
    /// app → 关键词列表（反向索引）。
    #[serde(default)]
    pub app_to_keywords: BTreeMap<String, Vec<String>>,
    /// 是否已构建。
    #[serde(default)]
    pub built: bool,
}

impl MetaIndex {
    pub fn new() -> Self { Self::default() }

    /// 从 catalog 重建索引（对应 JS `rebuildIndex()`）。
    pub fn build(&mut self, apps: &[AppItem]) {
        self.keyword_to_apps.clear();
        self.app_to_keywords.clear();
        for app in apps {
            let mut kws: Vec<String> = Vec::new();
            if !app.cat.is_empty() { kws.push(app.cat.clone()); }
            for t in &app.tags { kws.push(t.clone()); }
            // 名称中文字符也作为关键词
            for c in app.name.chars() {
                if is_chinese_char(c) {
                    kws.push(c.to_string());
                }
            }
            kws = crate::utils::unique_strings_preserve_case(&kws);
            for k in &kws {
                self.keyword_to_apps
                    .entry(k.to_lowercase())
                    .or_default()
                    .push(app.name.clone());
            }
            self.app_to_keywords.insert(app.name.clone(), kws);
        }
        self.built = true;
    }

    /// 查询关键词命中。
    pub fn lookup(&self, keyword: &str) -> &[String] {
        self.keyword_to_apps
            .get(&keyword.to_lowercase())
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    /// 获取某 app 的所有关键词。
    pub fn app_keywords(&self, app: &str) -> &[String] {
        self.app_to_keywords
            .get(app)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }
}

// ─── Trie 前缀树 ───────────────────────────────────────────────────────────

/// Trie 节点（对应 JS `buildTrieIndex` 的实现）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TrieNode {
    /// 子节点。
    #[serde(default)]
    pub children: BTreeMap<char, TrieNode>,
    /// 该节点对应的 app 列表（叶子节点才有）。
    #[serde(default)]
    pub apps: Vec<String>,
    /// 是否为终止节点。
    #[serde(default)]
    pub is_end: bool,
}

/// Trie 前缀树索引。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TrieIndex {
    /// 根节点。
    pub root: TrieNode,
    #[serde(default)]
    pub built: bool,
}

impl TrieIndex {
    pub fn new() -> Self { Self::default() }

    /// 构建 Trie（对应 JS `buildTrieIndex(apps)`）。
    pub fn build(&mut self, apps: &[AppItem]) {
        self.root = TrieNode::default();
        for app in apps {
            for field in app.search_fields() {
                self.insert(field, &app.name);
            }
        }
        self.built = true;
    }

    fn insert(&mut self, word: &str, app: &str) {
        let mut node = &mut self.root;
        for c in word.to_lowercase().chars() {
            node = node.children.entry(c).or_default();
        }
        node.is_end = true;
        if !node.apps.iter().any(|a| a == app) {
            node.apps.push(app.to_string());
        }
    }

    /// 前缀查询：返回所有以 `prefix` 开头的 app。
    pub fn search_prefix(&self, prefix: &str) -> Vec<String> {
        let mut node = &self.root;
        for c in prefix.to_lowercase().chars() {
            match node.children.get(&c) {
                Some(n) => node = n,
                None => return Vec::new(),
            }
        }
        // 收集所有子树
        let mut result: Vec<String> = Vec::new();
        Self::collect(node, &mut result);
        result
    }

    fn collect(node: &TrieNode, out: &mut Vec<String>) {
        for app in &node.apps {
            if !out.iter().any(|a| a == app) {
                out.push(app.clone());
            }
        }
        for child in node.children.values() {
            Self::collect(child, out);
        }
    }
}

// ─── TF-IDF 索引 ───────────────────────────────────────────────────────────

/// TF-IDF 索引（对应 JS `buildTfidfIndex(apps)`）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TfidfIndex {
    /// 词项 → 倒排表：`[(app, tf), ...]`。
    #[serde(default)]
    pub postings: BTreeMap<String, Vec<(String, f64)>>,
    /// 文档总数。
    #[serde(default)]
    pub doc_count: usize,
    /// 每个 app 的文档长度（用于归一化）。
    #[serde(default)]
    pub doc_lengths: BTreeMap<String, usize>,
    /// 是否已构建。
    #[serde(default)]
    pub built: bool,
}

impl TfidfIndex {
    pub fn new() -> Self { Self::default() }

    /// 构建 TF-IDF 索引（对应 JS `buildTfidfIndex(apps)`）。
    pub fn build(&mut self, apps: &[AppItem]) {
        self.postings.clear();
        self.doc_lengths.clear();
        self.doc_count = apps.len();

        // 1. 统计 TF
        let mut doc_terms: BTreeMap<String, BTreeMap<String, u32>> = BTreeMap::new();
        for app in apps {
            let terms = tokenize_for_tfidf(app);
            self.doc_lengths.insert(app.name.clone(), terms.len());
            let mut term_counts: BTreeMap<String, u32> = BTreeMap::new();
            for t in &terms {
                *term_counts.entry(t.clone()).or_insert(0) += 1;
            }
            for (t, c) in &term_counts {
                let tf = (*c as f64) / (terms.len().max(1) as f64);
                self.postings
                    .entry(t.clone())
                    .or_default()
                    .push((app.name.clone(), tf));
            }
            doc_terms.insert(app.name.clone(), term_counts);
        }

        // 2. 计算 IDF 并更新 postings 中的权重
        let n = self.doc_count as f64;
        for (_term, postings) in self.postings.iter_mut() {
            let df = postings.len() as f64;
            let idf = ((n + 1.0) / (df + 1.0)).ln() + 1.0;
            for (_app, tf) in postings.iter_mut() {
                *tf *= idf;
            }
        }

        // 3. 限制索引大小（按 posting 长度降序保留前 N 个）
        if self.postings.len() > TFIDF_MAX_INDEX_SIZE {
            let mut entries: Vec<(String, Vec<(String, f64)>)> =
                self.postings.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            entries.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
            entries.truncate(TFIDF_MAX_INDEX_SIZE);
            self.postings = entries.into_iter().collect();
        }

        self.built = true;
    }

    /// 查询：返回 `[(app, score), ...]`，按 score 降序。
    pub fn search(&self, query: &str) -> Vec<(String, f64)> {
        let terms = tokenize_for_tfidf_str(query);
        let mut scores: BTreeMap<String, f64> = BTreeMap::new();
        for t in &terms {
            if let Some(postings) = self.postings.get(t) {
                for (app, weight) in postings {
                    *scores.entry(app.clone()).or_insert(0.0) += weight;
                }
            }
        }
        let mut result: Vec<(String, f64)> = scores.into_iter().collect();
        result.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(core::cmp::Ordering::Equal));
        result
    }
}

/// 对 app 进行分词（用于 TF-IDF）。
fn tokenize_for_tfidf(app: &AppItem) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    // 名称按字符切分（中文一字一词）
    for c in app.name.chars() {
        if c.is_whitespace() { continue; }
        tokens.push(c.to_lowercase().to_string());
    }
    // 英文按空格切分
    for w in app.en.split_whitespace() {
        tokens.push(w.to_lowercase());
    }
    // 拼音按空格切分
    for w in app.py.split_whitespace() {
        tokens.push(w.to_lowercase());
    }
    // 标签
    for t in &app.tags {
        tokens.push(t.to_lowercase());
    }
    // 分类
    if !app.cat.is_empty() {
        tokens.push(app.cat.to_lowercase());
    }
    tokens
}

fn tokenize_for_tfidf_str(s: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    for c in s.chars() {
        if c.is_whitespace() { continue; }
        tokens.push(c.to_lowercase().to_string());
    }
    tokens
}

// ─── 数据集指纹 ─────────────────────────────────────────────────────────────

/// 计算数据集指纹（用于检测数据集变化）。
pub fn fingerprint(apps: &[AppItem]) -> String {
    // 简化实现：name + abbr + en 拼接后哈希
    let mut s = String::new();
    for app in apps {
        s.push_str(&app.name);
        s.push('|');
        s.push_str(&app.abbr);
        s.push('|');
        s.push_str(&app.en);
        s.push('|');
    }
    // FNV-1a 64-bit
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    alloc::format!("{:016x}", hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_apps() -> Vec<AppItem> {
        vec![
            AppItem {
                name: "微信".into(),
                py: "wei xin".into(),
                abbr: "wx".into(),
                en: "WeChat".into(),
                cat: "通讯".into(),
                tags: vec!["社交".into(), "即时通讯".into()],
                ..Default::default()
            },
            AppItem {
                name: "网易云音乐".into(),
                py: "wang yi yun yin le".into(),
                abbr: "wyy".into(),
                en: "NetEase Music".into(),
                cat: "音乐".into(),
                tags: vec!["音乐".into(), "音频".into()],
                ..Default::default()
            },
        ]
    }

    #[test]
    fn test_inverted_index_initial() {
        let apps = sample_apps();
        let mut idx = InvertedIndex::new();
        idx.build(&apps);
        let r = idx.lookup_initial("wx");
        assert!(r.contains(&"微信".to_string()));
        let r2 = idx.lookup_initial("wyy");
        assert!(r2.contains(&"网易云音乐".to_string()));
    }

    #[test]
    fn test_inverted_index_t9() {
        let apps = sample_apps();
        let mut idx = InvertedIndex::new();
        idx.build(&apps);
        // wx → 99
        let r = idx.lookup_t9("99");
        assert!(r.contains(&"微信".to_string()));
    }

    #[test]
    fn test_inverted_index_prefix() {
        let apps = sample_apps();
        let mut idx = InvertedIndex::new();
        idx.build(&apps);
        let r = idx.lookup_prefix("微");
        assert!(r.contains(&"微信".to_string()));
    }

    #[test]
    fn test_meta_index() {
        let apps = sample_apps();
        let mut idx = MetaIndex::new();
        idx.build(&apps);
        let r = idx.lookup("通讯");
        assert!(r.contains(&"微信".to_string()));
    }

    #[test]
    fn test_trie_index() {
        let apps = sample_apps();
        let mut idx = TrieIndex::new();
        idx.build(&apps);
        let r = idx.search_prefix("微");
        assert!(r.contains(&"微信".to_string()));
    }

    #[test]
    fn test_tfidf_index() {
        let apps = sample_apps();
        let mut idx = TfidfIndex::new();
        idx.build(&apps);
        let r = idx.search("微");
        assert!(!r.is_empty());
    }

    #[test]
    fn test_fingerprint_stable() {
        let apps = sample_apps();
        let f1 = fingerprint(&apps);
        let f2 = fingerprint(&apps);
        assert_eq!(f1, f2);
    }
}
