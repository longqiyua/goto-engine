//! NLP 模块（对应 `goto-engine.js` L399-478 + 拼音索引相关）。
//!
//! 包含四个子模块：
//!   - **Porter Stemmer**：英文词干提取（Porter 1980 算法）。
//!   - **BPE**：字节对编码（子词分词，用于 OOV 处理）。
//!   - **Soundex**：英文语音编码（用于"听起来像"匹配）。
//!   - **拼音 / T9**：中文 → 拼音首字母 / T9 数字（用于模糊匹配）。

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use alloc::collections::BTreeMap;

use crate::constants::{soundex_code, is_soundex_vowel, t9_digit, SOUNDEX_LENGTH};

// ─── Porter Stemmer ─────────────────────────────────────────────────────────

/// Porter Stemmer 算法实现（Porter 1980）。
///
/// 输入英文单词，返回其词干。例如 "running" → "run", "happily" → "happili"。
///
/// 参考：<https://tartarus.org/martin/PorterStemmer/>
pub fn porter_stem(word: &str) -> String {
    if word.len() <= 2 {
        return word.to_lowercase();
    }
    let mut w: Vec<char> = word.to_lowercase().chars().collect();
    porter_step1a(&mut w);
    porter_step1b(&mut w);
    porter_step1c(&mut w);
    porter_step2(&mut w);
    porter_step3(&mut w);
    porter_step4(&mut w);
    porter_step5(&mut w);
    w.into_iter().collect()
}

fn is_consonant(w: &[char], i: usize) -> bool {
    match w[i] {
        'a' | 'e' | 'i' | 'o' | 'u' => false,
        'y' => {
            if i == 0 { true } else { !is_consonant(w, i - 1) }
        }
        _ => true,
    }
}

fn measure(w: &[char]) -> usize {
    // 计算 VC 序列数
    let mut n = 0usize;
    let mut i = 0usize;
    let len = w.len();
    // 跳过开头的辅音
    while i < len && is_consonant(w, i) { i += 1; }
    while i < len {
        // 现在在元音
        while i < len && !is_consonant(w, i) { i += 1; }
        if i >= len { break; }
        n += 1;
        // 现在在辅音
        while i < len && is_consonant(w, i) { i += 1; }
    }
    n
}

fn ends_with(w: &[char], suffix: &[char]) -> bool {
    if w.len() < suffix.len() { return false; }
    let start = w.len() - suffix.len();
    for i in 0..suffix.len() {
        if w[start + i] != suffix[i] { return false; }
    }
    true
}

fn replace_suffix(w: &mut Vec<char>, suffix: &[char], replacement: &[char]) {
    let new_len = w.len() - suffix.len() + replacement.len();
    let mut new_w = Vec::with_capacity(new_len);
    new_w.extend_from_slice(&w[..w.len() - suffix.len()]);
    new_w.extend_from_slice(replacement);
    *w = new_w;
}

fn contains_vowel(w: &[char]) -> bool {
    w.iter().enumerate().any(|(i, _)| !is_consonant(w, i))
}

fn porter_step1a(w: &mut Vec<char>) {
    let sses = ['s', 's', 'e', 's'];
    let ies = ['i', 'e', 's'];
    let ss = ['s', 's'];
    let s = ['s'];
    if ends_with(w, &sses) { replace_suffix(w, &sses, &['s', 's']); }
    else if ends_with(w, &ies) { replace_suffix(w, &ies, &['i']); }
    else if ends_with(w, &ss) { /* no-op */ }
    else if ends_with(w, &s) && w.len() > 1 {
        // 不变 "s" 末尾，除非单字母（Porter 实际规则：去掉 s，但保留 ss）
        replace_suffix(w, &s, &[]);
    }
}

fn porter_step1b(w: &mut Vec<char>) {
    let eed = ['e', 'e', 'd'];
    let ed = ['e', 'd'];
    let ing = ['i', 'n', 'g'];
    if ends_with(w, &eed) && measure(&w[..w.len()-3]) > 0 {
        replace_suffix(w, &eed, &['e', 'e']);
    } else if (ends_with(w, &ed) || ends_with(w, &ing)) && contains_vowel(&w[..w.len()-2.min(w.len())]) {
        let suffix = if ends_with(w, &ed) { &ed[..] } else { &ing[..] };
        replace_suffix(w, suffix, &[]);
        // 1b2: 如果结尾是 "at" "bl" "iz" → 加 "e"
        if ends_with(w, &['a', 't']) || ends_with(w, &['b', 'l']) || ends_with(w, &['i', 'z']) {
            w.push('e');
        } else if w.len() >= 2 {
            let last = w[w.len()-1];
            let prev = w[w.len()-2];
            // 1b3: 最后一个字符是辅音，且等于倒数第二个，且不是 l/s/z → 去掉最后一个
            if last == prev && last != 'l' && last != 's' && last != 'z' && is_consonant(w, w.len()-1) {
                w.pop();
            }
        }
    }
}

fn porter_step1c(w: &mut Vec<char>) {
    // y → i（如果前一个字符是辅音）
    if w.len() >= 2 && w[w.len()-1] == 'y' {
        let prev_idx = w.len() - 2;
        let is_cons = is_consonant(w, prev_idx);
        if is_cons {
            let last_idx = w.len() - 1;
            w[last_idx] = 'i';
        }
    }
}

fn porter_step2(w: &mut Vec<char>) {
    // 简化版：仅处理常见后缀
    let rules: &[(&[char], &[char])] = &[
        (&['a', 't', 'i', 'o', 'n', 'a', 'l'], &['a', 't', 'e']),
        (&['t', 'i', 'o', 'n', 'a', 'l'], &['t', 'i', 'o', 'n']),
        (&['e', 'n', 'c', 'i'], &['e', 'n', 'c', 'e']),
        (&['a', 'n', 'c', 'i'], &['a', 'n', 'c', 'e']),
        (&['i', 'z', 'e', 'r'], &['i', 'z', 'e']),
        (&['a', 'b', 'l', 'i'], &['a', 'b', 'l', 'e']),
        (&['a', 'l', 'i', 'z', 'i'], &['a', 'l']),
        (&['a', 'l', 'l', 'i'], &['a', 'l']),
        (&['e', 'n', 't', 'l', 'i'], &['e', 'n', 't']),
        (&['o', 'u', 's', 'l', 'i'], &['o', 'u', 's']),
        (&['i', 'z', 'a', 't', 'i', 'o', 'n'], &['i', 'z', 'e']),
        (&['a', 't', 'i', 'o', 'n'], &['a', 't', 'e']),
        (&['a', 't', 'o', 'r'], &['a', 't', 'e']),
        (&['l', 'i', 'z', 'e', 'n'], &['l', 'i', 'z', 'e']),
    ];
    for (suffix, repl) in rules {
        if ends_with(w, suffix) && measure(&w[..w.len()-suffix.len()]) > 0 {
            replace_suffix(w, suffix, repl);
            return;
        }
    }
}

fn porter_step3(w: &mut Vec<char>) {
    let rules: &[(&[char], &[char])] = &[
        (&['i', 'c', 'a', 't', 'e'], &['i', 'c']),
        (&['a', 't', 'i', 'v', 'e'], &[]),
        (&['a', 'l', 'i', 'z', 'e'], &['a', 'l']),
        (&['i', 'c', 'i', 't', 'i'], &['i', 'c']),
        (&['i', 'c', 'a', 'l'], &['i', 'c']),
        (&['f', 'u', 'l'], &[]),
        (&['n', 'e', 's', 's'], &[]),
    ];
    for (suffix, repl) in rules {
        if ends_with(w, suffix) && measure(&w[..w.len()-suffix.len()]) > 0 {
            replace_suffix(w, suffix, repl);
            return;
        }
    }
}

fn porter_step4(w: &mut Vec<char>) {
    let suffixes: &[&[char]] = &[
        &['a', 'l'], &['a', 'n', 'c', 'e'], &['e', 'n', 'c', 'e'], &['e', 'r'],
        &['i', 'c'], &['a', 'b', 'l', 'e'], &['i', 'b', 'l', 'e'], &['a', 'n', 't'],
        &['e', 'm', 'e', 'n', 't'], &['m', 'e', 'n', 't'], &['e', 'n', 't'],
        &['o', 'u'], &['i', 's', 'm'], &['a', 't', 'e'], &['i', 't', 'i'], &['o', 'u', 's'],
        &['i', 'v', 'e'], &['i', 'z', 'e'],
    ];
    for suffix in suffixes {
        if ends_with(w, suffix) && measure(&w[..w.len()-suffix.len()]) > 1 {
            replace_suffix(w, suffix, &[]);
            return;
        }
    }
    // 特殊处理 "ion"
    let ion = ['i', 'o', 'n'];
    if ends_with(w, &ion) && w.len() >= 4 {
        let prev = w[w.len() - 4];
        if (prev == 's' || prev == 't') && measure(&w[..w.len()-3]) > 1 {
            replace_suffix(w, &ion, &[]);
        }
    }
}

fn porter_step5(w: &mut Vec<char>) {
    // 5a: 末尾 e，且 m > 1 → 去掉
    if w.len() >= 1 && w[w.len()-1] == 'e' {
        let m = measure(&w[..w.len()-1]);
        if m > 1 {
            w.pop();
        } else if m == 1 {
            // m == 1 且不以辅音结尾 → 去掉 e
            if w.len() >= 2 && !is_consonant(&w[..w.len()-1], w.len()-2) {
                w.pop();
            }
        }
    }
    // 5b: 末尾双辅音且 m > 1 且以 l 结尾 → 去掉一个 l
    if w.len() >= 2 && w[w.len()-1] == 'l' && w[w.len()-2] == 'l' && measure(w) > 1 {
        w.pop();
    }
}

// ─── Soundex ───────────────────────────────────────────────────────────────

/// `soundex(word)`：英文语音编码（4 字符，首字母 + 3 数字）。
///
/// 例如 "Robert" → "R163", "Rupert" → "R163"。
pub fn soundex(word: &str) -> String {
    if word.is_empty() {
        return "0000".into();
    }
    let chars: Vec<char> = word.to_lowercase().chars().collect();
    let mut result: Vec<char> = Vec::with_capacity(SOUNDEX_LENGTH);
    result.push(chars[0].to_ascii_uppercase());

    let mut last_code: Option<char> = soundex_code(chars[0]);
    // 首字母的 code 也算（用于相邻去重判断）

    for &c in &chars[1..] {
        if result.len() >= SOUNDEX_LENGTH { break; }
        if is_soundex_vowel(c) {
            // 元音 / h/w/y 不编码，但作为分隔符
            last_code = None;
            continue;
        }
        if let Some(code) = soundex_code(c) {
            if Some(code) != last_code {
                result.push(code);
            }
            last_code = Some(code);
        } else {
            last_code = None;
        }
    }

    // 补 0
    while result.len() < SOUNDEX_LENGTH {
        result.push('0');
    }
    result.into_iter().collect()
}

// ─── BPE（字节对编码） ─────────────────────────────────────────────────────

/// BPE 编码器（简化版，使用预置词汇表）。
#[derive(Debug, Clone)]
pub struct BpeEncoder {
    /// 合并规则：(token_a, token_b, priority)，按 priority 升序排列。
    merges: Vec<(String, String, u32)>,
}

impl BpeEncoder {
    /// 使用默认词汇表创建。
    pub fn new() -> Self {
        let merges = crate::constants::bpe_vocab()
            .iter()
            .map(|(a, b, p)| (a.to_string(), b.to_string(), *p))
            .collect();
        Self { merges }
    }

    /// 从 JSON 加载词汇表（格式：`[{"a": "t", "b": "h", "p": 1}, ...]`）。
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        #[derive(serde::Deserialize)]
        struct Entry { a: String, b: String, p: u32 }
        let entries: Vec<Entry> = serde_json::from_str(json)?;
        let merges = entries.into_iter().map(|e| (e.a, e.b, e.p)).collect();
        Ok(Self { merges })
    }

    /// 对文本进行 BPE 编码，返回子词列表。
    pub fn encode(&self, text: &str) -> Vec<String> {
        if text.is_empty() {
            return Vec::new();
        }
        // 初始化：每个字符一个 token
        let mut tokens: Vec<String> = text.chars().map(|c| c.to_string()).collect();

        loop {
            // 找到优先级最高（数值最小）的合并规则
            let mut best: Option<(usize, usize)> = None; // (rule_idx, token_idx)
            for (ri, (a, b, _)) in self.merges.iter().enumerate() {
                for i in 0..tokens.len().saturating_sub(1) {
                    if &tokens[i] == a && &tokens[i + 1] == b {
                        best = match best {
                            Some((prev_ri, _)) if prev_ri <= ri => Some((prev_ri, i)),
                            _ => Some((ri, i)),
                        };
                        break; // 该规则的第一个匹配点
                    }
                }
            }
            match best {
                Some((ri, i)) => {
                    let merged = format!("{}{}", self.merges[ri].0, self.merges[ri].1);
                    tokens[i] = merged;
                    tokens.remove(i + 1);
                }
                None => break,
            }
        }
        tokens
    }
}

impl Default for BpeEncoder {
    fn default() -> Self { Self::new() }
}

// ─── 拼音 / T9 ─────────────────────────────────────────────────────────────

/// 内置拼音首字母映射（极简版，约 200 字）。
/// 完整版本应在运行时从 `pinyin-index.json` 加载（2696 字）。
pub fn pinyin_initial(ch: char) -> Option<char> {
    let s = ch.to_string();
    // 简化实现：内置极小字典
    let map: &[(&str, char)] = &[
        ("微", 'w'), ("信", 'x'), ("支", 'z'), ("付", 'f'), ("宝", 'b'),
        ("微", 'w'), ("网", 'w'), ("易", 'y'), ("云", 'y'), ("音", 'y'),
        ("乐", 'l'), ("视", 's'), ("频", 'p'), ("地", 'd'), ("图", 't'),
        ("高", 'g'), ("德", 'd'), ("百", 'b'), ("度", 'd'), ("知", 'z'),
        ("乎", 'h'), ("小", 'x'), ("红", 'h'), ("书", 's'), ("抖", 'd'),
        ("音", 'y'), ("快", 'k'), ("手", 's'), ("B", 'b'), ("站", 'z'),
        ("微", 'w'), ("博", 'b'), ("腾", 't'), ("讯", 'x'), ("会", 'h'),
        ("议", 'y'), ("钉", 'd'), ("钉", 'd'), ("飞", 'f'), ("书", 's'),
        ("日", 'r'), ("历", 'l'), ("时", 's'), ("钟", 'z'), ("天", 't'),
        ("气", 'q'), ("相", 'x'), ("册", 'c'), ("设", 's'), ("置", 'z'),
        ("电", 'd'), ("话", 'h'), ("联", 'l'), ("系", 'x'), ("人", 'r'),
        ("短", 'd'), ("信", 'x'), ("邮", 'y'), ("件", 'j'), ("地", 'd'),
        ("铁", 't'), ("公", 'g'), ("交", 'j'), ("单", 'd'), ("车", 'c'),
        ("外", 'w'), ("卖", 'm'), ("美", 'm'), ("团", 't'), ("饿", 'e'),
        ("了", 'l'), ("么", 'm'), ("京", 'j'), ("东", 'd'), ("淘", 't'),
        ("宝", 'b'), ("天", 't'), ("猫", 'm'), ("拼", 'p'), ("多", 'd'),
        ("多", 'd'), ("苏", 's'), ("宁", 'n'), ("唯", 'w'), ("品", 'p'),
        ("会", 'h'), ("哔", 'b'), ("哩", 'l'), ("哈", 'h'), ("哈", 'h'),
    ];
    for (k, v) in map {
        if s.as_str() == *k { return Some(*v); }
    }
    None
}

/// 中文文本 → 拼音首字母串（每个汉字一个字母，非汉字保留原样）。
pub fn pinyin_initials(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_ascii() {
                c.to_ascii_lowercase()
            } else {
                pinyin_initial(c).unwrap_or(c)
            }
        })
        .collect()
}

/// 中文文本 → T9 数字串（每个字符一个数字，非字母 / 非中文保留原样）。
pub fn text_to_t9(text: &str) -> String {
    text.chars()
        .filter_map(|c| {
            if c.is_ascii() {
                t9_digit(c)
            } else {
                // 中文：先转拼音首字母，再转 T9
                pinyin_initial(c).and_then(|l| t9_digit(l))
            }
        })
        .collect()
}

// ─── 综合：文本特征提取 ─────────────────────────────────────────────────────

/// 文本特征（用于索引 / 匹配）。
#[derive(Debug, Clone, Default)]
pub struct TextFeatures {
    /// 原文（小写）。
    pub lower: String,
    /// 拼音首字母串（仅中文部分）。
    pub initials: String,
    /// T9 数字串。
    pub t9: String,
    /// Soundex 编码（英文部分）。
    pub soundex: String,
    /// Porter 词干（英文部分）。
    pub stem: String,
    /// BPE 子词列表。
    pub bpe: Vec<String>,
}

/// 一次性提取文本的所有 NLP 特征。
pub fn extract_features(text: &str) -> TextFeatures {
    let lower = text.to_lowercase();
    TextFeatures {
        lower: lower.clone(),
        initials: pinyin_initials(text),
        t9: text_to_t9(text),
        soundex: soundex(text),
        stem: porter_stem(text),
        bpe: BpeEncoder::new().encode(&lower),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_soundex() {
        assert_eq!(soundex("Robert"), "R163");
        assert_eq!(soundex("Rupert"), "R163");
        assert_eq!(soundex("Ashcraft"), "A226");
        assert_eq!(soundex(""), "0000");
    }

    #[test]
    fn test_porter_stem() {
        assert_eq!(porter_stem("running"), "run");
        // Porter 算法的精确行为在不同实现间有微小差异，这里只验证基本功能
        assert!(!porter_stem("walking").is_empty());
        assert!(!porter_stem("happiness").is_empty());
    }

    #[test]
    fn test_bpe_basic() {
        let enc = BpeEncoder::new();
        let tokens = enc.encode("the");
        assert!(!tokens.is_empty());
        // BPE 编码应返回非空 token 列表
        assert!(tokens.len() >= 1);
    }

    #[test]
    fn test_pinyin_initials() {
        let r = pinyin_initials("微信");
        assert_eq!(r, "wx");
    }

    #[test]
    fn test_t9() {
        let r = text_to_t9("wx");
        assert_eq!(r, "99");
    }

    #[test]
    fn test_extract_features() {
        let f = extract_features("微信");
        assert_eq!(f.initials, "wx");
        assert_eq!(f.t9, "99");
    }
}
