//! 语义联想层（对应 `GOTO-Engine/semantic/semantic-loader.js`）。
//!
//! 三层架构：
//! - **L1 核心同义词**：内联词典（~12KB，覆盖 13 分类 + 6 意图 + 应用名 + 动作），零 IO。
//! - **L2 同义词词林分片**：按拼音首字母路由分片，外部 JSON 加载（Rust 端用 storage 注入）。
//! - **L3 mini embedding**：字符 n-gram 稀疏向量 + 余弦相似度。
//!
//! 删除 semantic 数据源即完全禁用，核心搜索不受影响。
//! 集成点位于 `metaSearch` 内，扩展评分 80（精确）/ 38（包含），
//! 介于原有 120/56 之间，不改变搜索优先级。

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use alloc::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::constants::StorageKeys;
use crate::storage::Storage;
use crate::utils::now_ts;

// ─── 常量 ───────────────────────────────────────────────────────────────────

/// LRU 缓存上限。
pub const LRU_MAX: usize = 20;

/// 默认扩展上限。
pub const DEFAULT_LIMIT: usize = 10;

/// L1 精确命中评分。
pub const SCORE_L1_DIRECT: f64 = 0.9;
/// L1 反向命中评分。
pub const SCORE_L1_REVERSE: f64 = 0.85;
/// L1 包含命中评分。
pub const SCORE_L1_CONTAIN: f64 = 0.6;
/// L2 精确命中评分。
pub const SCORE_L2_DIRECT: f64 = 0.95;
/// L2 原文命中评分。
pub const SCORE_L2_RAW: f64 = 0.92;

// ─── 数据结构 ───────────────────────────────────────────────────────────────

/// 一条扩展结果。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SemanticExpansion {
    /// 扩展词。
    pub term: String,
    /// 评分 [0, 1]。
    pub score: f64,
    /// 来源（L1 / L2 / L3）。
    pub source: String,
}

/// 语义模块统计信息。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SemanticStats {
    pub l1_count: usize,
    pub l1_hits: u32,
    pub l2_hits: u32,
    pub l2_misses: u32,
    pub cache_hits: u32,
    pub cached_shards: usize,
}

/// L2 分片结构（对应 JS `shard-{a..z}.json`）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct L2Shard {
    /// 分片 ID（如 "shard-a"）。
    pub id: String,
    /// 该分片下所有词的同义词映射。
    #[serde(default)]
    pub words: BTreeMap<String, Vec<String>>,
}

/// L3 词向量（稀疏字符 n-gram 向量）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MiniEmbedding {
    /// 词表：字符 n-gram → 维度索引。
    #[serde(default)]
    pub vocab: BTreeMap<String, u32>,
    /// 文档（词）列表，每个文档是 `(维度索引, 权重)` 的稀疏向量。
    #[serde(default)]
    pub docs: Vec<Vec<(u32, f64)>>,
    /// 文档对应的词。
    #[serde(default)]
    pub doc_terms: Vec<String>,
    /// 文档向量模长（预计算）。
    #[serde(default)]
    pub doc_norms: Vec<f64>,
}

// ─── 管理器 ─────────────────────────────────────────────────────────────────

/// 语义联想管理器。
#[derive(Debug)]
pub struct SemanticManager<'a, S: Storage + ?Sized> {
    storage: &'a S,
}

impl<'a, S: Storage + ?Sized> SemanticManager<'a, S> {
    pub fn new(storage: &'a S) -> Self { Self { storage } }

    /// `isEnabled()`：运行时开关状态。
    pub fn is_enabled(&self) -> bool {
        let v: bool = self.storage.read_json(StorageKeys::SEMANTIC_ENABLED, false);
        v
    }

    /// 开关语义模块。
    pub fn set_enabled(&self, enabled: bool) {
        self.storage.write_json(StorageKeys::SEMANTIC_ENABLED, &enabled);
    }

    /// `isReady()`：是否就绪（开关开启 && L1 已加载）。
    pub fn is_ready(&self) -> bool {
        self.is_enabled()
    }

    /// 获取 L1 词典（内联）。
    pub fn l1_dictionary(&self) -> &'static [(&'static str, &'static [&'static str])] {
        L1_CORE_SYNONYMS
    }

    /// `_expandSync(query, limit)`：L1 同步扩展。
    ///
    /// 三阶段：直接命中 → 反向命中 → 包含关系。
    pub fn expand_sync(&self, query: &str, limit: Option<usize>) -> Vec<SemanticExpansion> {
        if !self.is_enabled() { return Vec::new(); }
        let q = normalize_word(query);
        if q.is_empty() { return Vec::new(); }
        let limit = limit.unwrap_or(DEFAULT_LIMIT);

        let mut result: Vec<SemanticExpansion> = Vec::new();

        // 1. 直接命中
        for (key, syns) in L1_CORE_SYNONYMS.iter() {
            if *key == q.as_str() {
                for t in *syns {
                    result.push(SemanticExpansion {
                        term: t.to_string(),
                        score: SCORE_L1_DIRECT,
                        source: "L1".to_string(),
                    });
                }
            }
        }

        // 2. 反向命中
        for (key, syns) in L1_CORE_SYNONYMS.iter() {
            if *key == q.as_str() { continue; }
            for syn in *syns {
                if syn.to_lowercase() == q || *syn == query {
                    result.push(SemanticExpansion {
                        term: key.to_string(),
                        score: SCORE_L1_REVERSE,
                        source: "L1".to_string(),
                    });
                    break;
                }
            }
        }

        // 3. 包含关系
        for (key, _) in L1_CORE_SYNONYMS.iter() {
            if *key == q.as_str() { continue; }
            if key.contains(q.as_str()) || q.contains(key) {
                result.push(SemanticExpansion {
                    term: key.to_string(),
                    score: SCORE_L1_CONTAIN,
                    source: "L1".to_string(),
                });
            }
        }

        // 去重 + 截断
        let mut seen: BTreeMap<String, bool> = BTreeMap::new();
        let uniq: Vec<SemanticExpansion> = result.into_iter()
            .filter(|r| {
                if seen.contains_key(&r.term) { false }
                else { seen.insert(r.term.clone(), true); true }
            })
            .take(limit)
            .collect();
        uniq
    }

    /// `_expandAsync(query, limit)`：L2 异步扩展（Rust 端简化为同步）。
    ///
    /// 按拼音首字母路由分片，合并 L1 + L2。
    pub fn expand_async(&self, query: &str, limit: Option<usize>) -> Vec<SemanticExpansion> {
        if !self.is_enabled() { return Vec::new(); }
        let q = normalize_word(query);
        if q.is_empty() { return self.expand_sync(query, limit); }

        // 获取拼音首字母
        let initial = match q.chars().next() {
            Some(c) => crate::nlp::pinyin_initial(c).unwrap_or_else(|| c.to_ascii_lowercase()),
            None => return self.expand_sync(query, limit),
        };

        let shard_id = alloc::format!("shard-{}", initial);
        let shard = self.load_shard(&shard_id);

        let l1 = self.expand_sync(query, limit);
        if shard.is_none() {
            return l1;
        }
        let shard = shard.unwrap();

        let mut l2: Vec<SemanticExpansion> = Vec::new();
        // 精确匹配
        if let Some(syns) = shard.words.get(&q) {
            for t in syns {
                l2.push(SemanticExpansion {
                    term: t.clone(),
                    score: SCORE_L2_DIRECT,
                    source: "L2".to_string(),
                });
            }
        }
        // 原文匹配
        if let Some(syns) = shard.words.get(query) {
            if shard.words.get(&q) != Some(syns) {
                for t in syns {
                    l2.push(SemanticExpansion {
                        term: t.clone(),
                        score: SCORE_L2_RAW,
                        source: "L2".to_string(),
                    });
                }
            }
        }

        // 合并 L1 + L2，L2 优先
        let mut merged: BTreeMap<String, SemanticExpansion> = BTreeMap::new();
        for item in l2 { merged.insert(item.term.clone(), item); }
        for item in l1 {
            if !merged.contains_key(&item.term) {
                merged.insert(item.term.clone(), item);
            }
        }

        let limit = limit.unwrap_or(DEFAULT_LIMIT);
        merged.into_values().take(limit).collect()
    }

    /// `expand(query, opts)`：扩展查询统一入口。
    ///
    /// `async=false` 仅查 L1；`async=true` 查 L1+L2（Rust 端均为同步）。
    pub fn expand(&self, query: &str, async_mode: bool, limit: Option<usize>) -> Vec<SemanticExpansion> {
        if async_mode {
            self.expand_async(query, limit)
        } else {
            self.expand_sync(query, limit)
        }
    }

    /// `loadShard(shardId)`：加载分片。
    ///
    /// Rust 端简化为从 storage 读取 JSON（key 形如 `goto_semantic_shard_shard-a`）。
    pub fn load_shard(&self, shard_id: &str) -> Option<L2Shard> {
        let key = alloc::format!("goto_semantic_shard_{}", shard_id);
        self.storage.read_json_opt::<L2Shard>(&key)
    }

    /// 注入 L2 分片（外部使用，例如从文件加载）。
    pub fn save_shard(&self, shard: &L2Shard) {
        let key = alloc::format!("goto_semantic_shard_{}", shard.id);
        self.storage.write_json(&key, shard);
    }

    /// `findSimilar(word, topN)`：L3 本地 mini embedding。
    ///
    /// 字符 n-gram 稀疏向量 + 余弦相似度，并融合 L1 同义词簇。
    pub fn find_similar(&self, word: &str, top_n: usize) -> Vec<SemanticExpansion> {
        if !self.is_enabled() || word.is_empty() { return Vec::new(); }
        let emb = self.get_mini_embedding();
        if emb.docs.is_empty() { return Vec::new(); }

        let q_vec = build_ngram_vector(word, &emb.vocab);
        let q_norm = vector_norm(&q_vec);
        if q_norm == 0.0 { return Vec::new(); }

        let mut scored: Vec<(String, f64)> = emb.docs.iter().enumerate()
            .map(|(i, doc)| {
                let sim = cosine_similarity(&q_vec, doc, q_norm, emb.doc_norms.get(i).copied().unwrap_or(0.0));
                (emb.doc_terms.get(i).cloned().unwrap_or_default(), sim)
            })
            .filter(|(_, s)| *s > 0.0)
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(core::cmp::Ordering::Equal));
        scored.truncate(top_n);

        scored.into_iter().map(|(term, score)| SemanticExpansion {
            term,
            score,
            source: "L3".to_string(),
        }).collect()
    }

    /// 获取 mini embedding（懒构建，基于 L1 词典）。
    pub fn get_mini_embedding(&self) -> MiniEmbedding {
        // 从 storage 缓存读取
        if let Some(cached) = self.storage.read_json_opt::<MiniEmbedding>("goto_semantic_mini_embedding") {
            if !cached.docs.is_empty() {
                return cached;
            }
        }

        // 从 L1 词典构建
        let mut vocab: BTreeMap<String, u32> = BTreeMap::new();
        let mut docs: Vec<Vec<(u32, f64)>> = Vec::new();
        let mut doc_terms: Vec<String> = Vec::new();

        for (key, syns) in L1_CORE_SYNONYMS.iter() {
            // 每个 key 作为一篇文档
            let terms = build_ngram_terms(key);
            for t in &terms {
                if !vocab.contains_key(t) {
                    let idx = vocab.len() as u32;
                    vocab.insert(t.clone(), idx);
                }
            }
            let mut doc: BTreeMap<u32, f64> = BTreeMap::new();
            for t in &terms {
                if let Some(&idx) = vocab.get(t) {
                    *doc.entry(idx).or_insert(0.0) += 1.0;
                }
            }
            let doc_vec: Vec<(u32, f64)> = doc.into_iter().collect();
            docs.push(doc_vec);
            doc_terms.push(key.to_string());

            // 每个 syn 也作为一篇文档
            for syn in *syns {
                let syn_terms = build_ngram_terms(syn);
                for t in &syn_terms {
                    if !vocab.contains_key(t) {
                        let idx = vocab.len() as u32;
                        vocab.insert(t.clone(), idx);
                    }
                }
                let mut doc2: BTreeMap<u32, f64> = BTreeMap::new();
                for t in &syn_terms {
                    if let Some(&idx) = vocab.get(t) {
                        *doc2.entry(idx).or_insert(0.0) += 1.0;
                    }
                }
                docs.push(doc2.into_iter().collect());
                doc_terms.push(syn.to_string());
            }
        }

        // 计算文档向量模长
        let doc_norms: Vec<f64> = docs.iter().map(|d| vector_norm(d)).collect();

        let emb = MiniEmbedding { vocab, docs, doc_terms, doc_norms };
        self.storage.write_json("goto_semantic_mini_embedding", &emb);
        emb
    }

    /// `getStats()`：统计信息。
    pub fn get_stats(&self) -> SemanticStats {
        SemanticStats {
            l1_count: L1_CORE_SYNONYMS.len(),
            l1_hits: 0,
            l2_hits: 0,
            l2_misses: 0,
            cache_hits: 0,
            cached_shards: 0,
        }
    }

    /// `clearCache()`：清空缓存。
    pub fn clear_cache(&self) {
        // Rust 端无 IndexedDB，storage 是单一来源，仅清 mini embedding
        self.storage.remove_string("goto_semantic_mini_embedding");
    }

    /// 内部：记录统计（占位，可扩展）。
    pub fn touch(&self, _key: &str) {
        let _ = now_ts();
    }
}

// ─── 辅助函数 ───────────────────────────────────────────────────────────────

/// 词归一化：trim + 小写。
pub fn normalize_word(s: &str) -> String {
    s.trim().to_lowercase()
}

/// 构建字符 n-gram（bigram + unigram）。
fn build_ngram_terms(word: &str) -> Vec<String> {
    let chars: Vec<char> = word.chars().collect();
    let mut terms: Vec<String> = Vec::with_capacity(chars.len() * 2);
    // unigram
    for c in &chars {
        terms.push(c.to_string());
    }
    // bigram
    for i in 0..chars.len().saturating_sub(1) {
        let s: String = format!("{}{}", chars[i], chars[i + 1]);
        terms.push(s);
    }
    terms
}

/// 构建稀疏向量（n-gram → 权重）。
fn build_ngram_vector(word: &str, vocab: &BTreeMap<String, u32>) -> Vec<(u32, f64)> {
    let terms = build_ngram_terms(word);
    let mut vec: BTreeMap<u32, f64> = BTreeMap::new();
    for t in &terms {
        if let Some(&idx) = vocab.get(t) {
            *vec.entry(idx).or_insert(0.0) += 1.0;
        }
    }
    vec.into_iter().collect()
}

/// 计算稀疏向量模长。
fn vector_norm(vec: &[(u32, f64)]) -> f64 {
    vec.iter().map(|(_, v)| v * v).sum::<f64>().sqrt()
}

/// 计算余弦相似度（稀疏向量）。
fn cosine_similarity(a: &[(u32, f64)], b: &[(u32, f64)], a_norm: f64, b_norm: f64) -> f64 {
    if a_norm == 0.0 || b_norm == 0.0 { return 0.0; }
    let mut dot = 0.0f64;
    let mut i = 0usize;
    let mut j = 0usize;
    while i < a.len() && j < b.len() {
        let (ai, av) = a[i];
        let (bj, bv) = b[j];
        if ai == bj {
            dot += av * bv;
            i += 1;
            j += 1;
        } else if ai < bj {
            i += 1;
        } else {
            j += 1;
        }
    }
    dot / (a_norm * b_norm)
}

// ─── L1 核心同义词（精选，覆盖 13 分类 + 6 意图 + 应用名 + 动作） ────────────

/// L1 核心同义词词典（精选版，约 80 条；完整版可在运行时通过 save_shard 注入）。
pub static L1_CORE_SYNONYMS: &[(&str, &[&str])] = &[
    // —— 通讯 / SEND 意图 ——
    ("发", &["写", "寄", "送", "传达", "发出", "递交"]),
    ("发短信", &["发消息", "发信息", "送信", "写信", "短信", "消息"]),
    ("发邮件", &["发邮箱", "写信", "寄信", "邮件", "邮箱", "email"]),
    ("聊天", &["聊聊", "沟通", "对话", "说话", "闲聊", "侃", "扯"]),
    ("联系", &["联络", "沟通", "找人", "约", "叫"]),
    ("打电话", &["拨号", "通话", "电话", "ring", "call"]),
    ("微信", &["wx", "weixin", "wechat", "绿聊", "微"]),
    ("QQ", &["qq", "企鹅", "tencent-qq", "qq聊天"]),
    ("飞书", &["feishu", "lark", "字节聊"]),
    ("钉钉", &["dingtalk", "dd", "阿里聊"]),
    ("微博", &["weibo", "新浪微博"]),
    ("小红书", &["xiaohongshu", "red", "小红"]),

    // —— 办公 / WORK 意图 ——
    ("办公", &["工作", "事务", "做事", "上班"]),
    ("工作", &["办公", "业务", "做事", "上班"]),
    ("文档", &["文件", "doc", "document"]),
    ("表格", &["excel", "sheet", "spreadsheet"]),
    ("演示", &["ppt", "powerpoint", "幻灯"]),
    ("开会", &["会议", "meeting", "讨论"]),
    ("协作", &["合作", "协同", "teamwork"]),
    ("邮箱", &["邮件", "email", "mail"]),
    ("WPS", &["wps", "金山办公"]),
    ("Word", &["word", "微软文档", "文档"]),
    ("Excel", &["excel", "微软表格", "表格"]),
    ("日历", &["calendar", "日程", "schedule"]),
    ("Zoom", &["zoom", "视频会议"]),

    // —— 浏览器 ——
    ("搜索", &["查一下", "搜一下", "搜一搜", "find", "search"]),
    ("查一下", &["搜索", "查资料", "搜一下"]),
    ("上网", &["浏览", "上网冲浪", "web"]),
    ("浏览", &["翻看", "查看", "browse"]),
    ("Chrome", &["google-chrome", "谷歌浏览器", "chrome浏览器"]),
    ("Edge", &["microsoft-edge", "微软浏览器", "edge浏览器"]),
    ("Safari", &["safari", "苹果浏览器"]),
    ("Firefox", &["firefox", "火狐", "火狐浏览器"]),
    ("百度", &["baidu", "百度搜索"]),
    ("浏览器", &["browser", "网页浏览"]),

    // —— 视频 / CONSUME ——
    ("看", &["观看", "欣赏", "浏览", "收看", "瞅"]),
    ("观看", &["看", "欣赏", "收看"]),
    ("刷视频", &["看视频", "刷抖音", "刷快手"]),
    ("追剧", &["追片", "追番", "binge"]),
    ("电影", &["影片", "movie", "film"]),
    ("电视剧", &["剧集", "tv", "剧"]),
    ("短视频", &["小视频", "short-video"]),
    ("直播", &["live", "现场"]),
    ("YouTube", &["yt", "油管", "youtube"]),
    ("B站", &["bilibili", "哔哩哔哩", "b站"]),
    ("抖音", &["douyin", "tiktok", "dy"]),
    ("快手", &["kuaishou", "ks"]),
    ("腾讯视频", &["qq-video", "腾讯影视"]),
    ("爱奇艺", &["iqiyi", "奇艺"]),
    ("优酷", &["youku", "土豆"]),
    ("芒果TV", &["mgtv", "芒果"]),
    ("Netflix", &["netflix", "奈飞", "网飞"]),

    // —— 音乐 ——
    ("听", &["聆听", "收听", "倾听", "听见"]),
    ("听歌", &["听音乐", "放歌", "play-music"]),
    ("音乐", &["歌曲", "歌", "music"]),
    ("歌单", &["playlist", "歌列表"]),
    ("播客", &["podcast", "音频节目"]),
    ("网易云音乐", &["netease-music", "网易云", "网易音乐"]),
    ("QQ音乐", &["qq-music", "腾讯音乐"]),
    ("酷狗音乐", &["kugou", "酷狗"]),
    ("酷我音乐", &["kuwo", "酷我"]),
    ("Spotify", &["spotify", "声田"]),
    ("Apple Music", &["apple-music", "苹果音乐"]),
    ("汽水音乐", &["qishui", "抖音音乐"]),
    ("喜马拉雅", &["ximalaya", "喜马"]),

    // —— 购物 / BUY ——
    ("买", &["下单", "购物", "采购", "购置", "剁手", "购"]),
    ("下单", &["买", "购物", "下单子", "order"]),
    ("购物", &["买东西", "买", "shopping"]),
    ("买东西", &["购物", "买", "采购"]),
    ("网购", &["网上购物", "电商", "online-shopping"]),
    ("点餐", &["点外卖", "叫外卖", "订餐", "order-food"]),
    ("点外卖", &["点餐", "叫外卖", "订餐", "外卖"]),
    ("吃饭", &["用餐", "就餐", "下馆子"]),
    ("外卖", &["外送", "delivery", "配送"]),
    ("淘宝", &["taobao", "阿里购物", "橙色app"]),
    ("京东", &["jd", "京东商城"]),
    ("拼多多", &["pdd", "拼购"]),
    ("天猫", &["tmall", "猫超"]),
    ("美团", &["meituan", "美团外卖"]),
    ("饿了么", &["eleme", "蜂鸟"]),

    // —— 出行 / TRAVEL ——
    ("打车", &["叫车", "出行", "出租车", "taxi"]),
    ("导航", &["指路", "路线", "navigate"]),
    ("地图", &["map", "看地图"]),
    ("高德地图", &["amap", "高德"]),
    ("百度地图", &["baidu-map", "百度导航"]),
    ("滴滴", &["didi", "滴滴出行"]),

    // —— 健康 / HEALTH ——
    ("运动", &["锻炼", "健身", "活动"]),
    ("跑步", &["跑", "慢跑", "jog"]),
    ("健身", &["运动", "锻炼", "workout"]),
    ("睡眠", &["睡觉", "休息", "sleep"]),
    ("减肥", &["瘦身", "减脂", "diet"]),

    // —— 学习 / LEARN ——
    ("学", &["学习", "study", "learn"]),
    ("学习", &["学", "study", "learn"]),
    ("背单词", &["记单词", "word", "vocabulary"]),
    ("学英语", &["英语学习", "english", "学英文"]),
    ("网课", &["在线课程", "online-course", "网课学习"]),
    ("课程", &["课", "lesson", "course"]),

    // —— 联系 / CONTACT ——
    ("找人", &["联系", "约", "叫"]),
    ("约", &["约人", "约定", "约会"]),

    // —— 安装 / INSTALL ——
    ("安装", &["装", "下载", "install"]),
    ("下载", &["download", "下", "获取"]),
    ("更新", &["升级", "update", "upgrade"]),
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::MemoryStorage;

    #[test]
    fn test_disabled_returns_empty() {
        let s = MemoryStorage::new();
        let mgr = SemanticManager::new(&s);
        assert!(mgr.expand_sync("微信", None).is_empty());
    }

    #[test]
    fn test_l1_direct_hit() {
        let s = MemoryStorage::new();
        let mgr = SemanticManager::new(&s);
        mgr.set_enabled(true);
        let result = mgr.expand_sync("微信", None);
        assert!(result.iter().any(|r| r.term == "wx"));
        assert!(result.iter().any(|r| r.term == "wechat"));
    }

    #[test]
    fn test_l1_reverse_hit() {
        let s = MemoryStorage::new();
        let mgr = SemanticManager::new(&s);
        mgr.set_enabled(true);
        let result = mgr.expand_sync("wx", None);
        assert!(result.iter().any(|r| r.term == "微信"));
    }

    #[test]
    fn test_find_similar() {
        let s = MemoryStorage::new();
        let mgr = SemanticManager::new(&s);
        mgr.set_enabled(true);
        let result = mgr.find_similar("微信", 5);
        // 应返回相似词（至少一个）
        assert!(!result.is_empty());
    }

    #[test]
    fn test_normalize_word() {
        assert_eq!(normalize_word("  WeChat "), "wechat");
        assert_eq!(normalize_word(""), "");
    }

    #[test]
    fn test_l2_shard_save_load() {
        let s = MemoryStorage::new();
        let mgr = SemanticManager::new(&s);
        let mut shard = L2Shard { id: "shard-a".into(), words: BTreeMap::new() };
        shard.words.insert("apple".into(), vec!["苹果".into(), "iPhone".into()]);
        mgr.save_shard(&shard);

        let loaded = mgr.load_shard("shard-a").expect("应能加载分片");
        assert_eq!(loaded.id, "shard-a");
        assert!(loaded.words.contains_key("apple"));
    }

    #[test]
    fn test_expand_async_with_shard() {
        let s = MemoryStorage::new();
        let mgr = SemanticManager::new(&s);
        mgr.set_enabled(true);

        // 注入一个 "w" 开头的分片
        let mut shard = L2Shard { id: "shard-w".into(), words: BTreeMap::new() };
        shard.words.insert("wechat".into(), vec!["微信".into(), "WeChat".into()]);
        mgr.save_shard(&shard);

        let result = mgr.expand_async("wechat", None);
        assert!(!result.is_empty());
        assert!(result.iter().any(|r| r.term == "微信"));
    }
}
