//! 意图层（对应 `goto-engine.js` `extractTokens` + `intentSynonyms`，L619-680 + L814-861）。
//!
//! 分词器从 query 中提取：
//!   - **action（动作词）**：发送 / 观看 / 联系 / 出行 / 购买 / 工作 / 搜索 / 打开 / 安装 / 健康 / 学习
//!   - **intent（意图分类）**：SEND / CONSUME / CONTACT / TRAVEL / BUY / WORK / SEARCH / OPEN / INSTALL / HEALTH / LEARN
//!   - **relations（关系词）**：给 / 和 / 跟 / 找 / ...
//!   - **target（目标对象）**：动作词之后的所有剩余 token

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use alloc::collections::BTreeMap;

use crate::constants::{intent_synonyms, RELATION_WORDS};

/// 一条 query 的结构化分词结果。
#[derive(Debug, Clone, Default)]
pub struct TokenizedQuery {
    /// 原始 query。
    pub raw: String,
    /// 提取的动作词（如 "发"、"看"、"打车"）。
    pub actions: Vec<String>,
    /// 意图分类标签（如 "SEND"、"CONSUME"）。
    pub intents: Vec<String>,
    /// 关系词（如 "给"、"和"、"跟"）。
    pub relations: Vec<String>,
    /// 目标对象（query 中去掉动作词和关系词后的剩余部分）。
    pub target: String,
    /// 所有 token（按出现顺序，用于索引）。
    pub tokens: Vec<String>,
}

/// `extractTokens(query)`：分词 + 意图识别。
///
/// 对应 JS `goto-engine.js` L814-861。
pub fn extract_tokens(query: &str) -> TokenizedQuery {
    let raw = query.to_string();
    let synonyms = intent_synonyms();
    let mut actions: Vec<String> = Vec::new();
    let mut intents: Vec<String> = Vec::new();
    let mut relations: Vec<String> = Vec::new();
    let mut remaining: Vec<String> = Vec::new();
    let mut all_tokens: Vec<String> = Vec::new();

    // 1. 关系词检测（最长匹配）
    let mut pos = 0usize;
    let chars: Vec<char> = query.chars().collect();
    let mut matched_relations: Vec<String> = Vec::new();

    while pos < chars.len() {
        let rest: String = chars[pos..].iter().collect();
        let mut matched = false;

        // 优先匹配 3 字关系词，再 2 字，再 1 字
        for len in [3, 2, 1] {
            if rest.chars().count() < len { continue; }
            let candidate: String = rest.chars().take(len).collect();
            if RELATION_WORDS.iter().any(|w| *w == candidate) {
                matched_relations.push(candidate.clone());
                all_tokens.push(candidate.clone());
                pos += len;
                matched = true;
                break;
            }
        }
        if matched { continue; }

        // 未匹配关系词，作为剩余字符
        let ch = chars[pos];
        remaining.push(ch.to_string());
        all_tokens.push(ch.to_string());
        pos += 1;
    }

    relations = matched_relations;

    // 2. 动作词 + 意图识别（在剩余字符中匹配同义词）
    let remaining_str: String = remaining.join("");
    for (intent_label, words) in &synonyms {
        for w in *words {
            if remaining_str.contains(w) {
                if !actions.contains(&w.to_string()) {
                    actions.push(w.to_string());
                }
                if !intents.contains(&intent_label.to_string()) {
                    intents.push(intent_label.to_string());
                }
            }
        }
    }

    // 3. target = 剩余字符中去掉已识别的动作词
    let mut target = remaining_str.clone();
    for a in &actions {
        target = target.replace(a, "");
    }
    target = target.trim().to_string();

    TokenizedQuery {
        raw,
        actions,
        intents,
        relations,
        target,
        tokens: all_tokens,
    }
}

/// 主意图（取第一个识别到的意图，若无返回 "UNKNOWN"）。
pub fn primary_intent(tq: &TokenizedQuery) -> &str {
    tq.intents.first().map(|s| s.as_str()).unwrap_or("UNKNOWN")
}

/// 是否包含某意图。
pub fn has_intent(tq: &TokenizedQuery, intent: &str) -> bool {
    tq.intents.iter().any(|i| i == intent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_send_intent() {
        let tq = extract_tokens("发微信给小明");
        assert!(tq.intents.contains(&"SEND".to_string()));
        assert!(tq.actions.iter().any(|a| a == "发"));
        assert!(tq.relations.iter().any(|r| r == "给"));
    }

    #[test]
    fn test_extract_consume_intent() {
        let tq = extract_tokens("看视频");
        assert!(tq.intents.contains(&"CONSUME".to_string()));
    }

    #[test]
    fn test_extract_search_intent() {
        let tq = extract_tokens("搜索附近的餐厅");
        assert!(tq.intents.contains(&"SEARCH".to_string()));
    }

    #[test]
    fn test_no_intent() {
        let tq = extract_tokens("xyz");
        assert!(tq.intents.is_empty());
        assert_eq!(primary_intent(&tq), "UNKNOWN");
    }
}
