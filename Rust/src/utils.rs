//! 通用工具函数（对应 `goto-engine.js` L89-139）。

use alloc::string::{String, ToString};
use alloc::vec::Vec;
use alloc::collections::BTreeSet;
use core::time::Duration;

/// 数值截断：`clamp(num, min, max)`。
#[inline]
pub fn clamp(num: f64, min: f64, max: f64) -> f64 {
    if num < min { min } else if num > max { max } else { num }
}

#[inline]
pub fn clamp_usize(num: usize, min: usize, max: usize) -> usize {
    if num < min { min } else if num > max { max } else { num }
}

/// 当前时间戳（毫秒，对应 JS `Date.now()`）。
#[cfg(feature = "std")]
pub fn now_ts() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(not(feature = "std"))]
pub fn now_ts() -> u64 {
    0
}

/// 当前小时（0-23）。
#[cfg(feature = "std")]
pub fn get_hour() -> u32 {
    use chrono::Local;
    Local::now().format("%H").to_string().parse::<u32>().unwrap_or(0)
}

#[cfg(not(feature = "std"))]
pub fn get_hour() -> u32 { 0 }

/// 时段分桶（morning/afternoon/evening/night）。
pub fn get_hour_bucket(hour: Option<u32>) -> &'static str {
    let h = hour.unwrap_or_else(get_hour);
    match h {
        6..=11 => "morning",
        12..=17 => "afternoon",
        18..=23 => "evening",
        _ => "night",
    }
}

/// 字符串数组小写去重（保留首次出现顺序）。
pub fn unique_strings(list: &[String]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::with_capacity(list.len());
    for s in list {
        let key = s.to_lowercase();
        if seen.insert(key) {
            out.push(s.clone());
        }
    }
    out
}

/// 字符串数组去重（保留首次出现顺序，不区分大小写但保留原大小写）。
pub fn unique_strings_preserve_case(list: &[String]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::with_capacity(list.len());
    for s in list {
        if seen.insert(s.clone()) {
            out.push(s.clone());
        }
    }
    out
}

/// `normalizeText`：trim 后返回字符串。
pub fn normalize_text(value: &str) -> String {
    value.trim().to_string()
}

/// `lowerText`：trim + 小写。
pub fn lower_text(value: &str) -> String {
    value.trim().to_lowercase()
}

/// 是否包含中文字符（CJK Unified Ideographs 范围）。
pub fn contains_chinese(s: &str) -> bool {
    s.chars().any(|c| (c as u32) >= 0x4E00 && (c as u32) <= 0x9FFF)
}

/// 是否包含字母或数字。
pub fn contains_alnum(s: &str) -> bool {
    s.chars().any(|c| c.is_alphanumeric())
}

/// 字符是否为中文。
pub fn is_chinese_char(c: char) -> bool {
    let cp = c as u32;
    cp >= 0x4E00 && cp <= 0x9FFF
}

/// 字符是否为拉丁字母。
pub fn is_latin_alpha(c: char) -> bool {
    c.is_ascii_alphabetic()
}

/// 字符是否为数字。
pub fn is_digit(c: char) -> bool {
    c.is_ascii_digit()
}

/// 判断字符串是否为纯数字。
pub fn is_all_digits(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
}

/// 判断字符串是否为纯字母（小写）。
pub fn is_all_lower_alpha(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase())
}

/// 字符频率（返回 (max_count, total_len)）。
pub fn char_freq_max(s: &str) -> (usize, usize) {
    if s.is_empty() {
        return (0, 0);
    }
    let mut counts: std::collections::HashMap<char, usize> = std::collections::HashMap::new();
    for c in s.chars() {
        *counts.entry(c).or_insert(0) += 1;
    }
    let max = *counts.values().max().unwrap_or(&0);
    (max, s.chars().count())
}

/// 字符串包含控制字符（U+0000-U+001F 或 U+007F-U+009F）。
pub fn contains_control_chars(s: &str) -> bool {
    s.chars().any(|c| {
        let cp = c as u32;
        cp < 0x20 || (0x7F..=0x9F).contains(&cp)
    })
}

/// 连续重复字符压缩为最多 3 个（对应 JS `_compressRepeated`）。
pub fn compress_repeated(s: &str, max_run: usize) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last = '\0';
    let mut run = 0usize;
    for c in s.chars() {
        if c == last {
            run += 1;
            if run < max_run {
                out.push(c);
            }
        } else {
            run = 0;
            out.push(c);
            last = c;
        }
    }
    out
}

/// 字符串相似度：Jaccard 系数（基于字符集）。
pub fn jaccard_chars(a: &str, b: &str) -> f64 {
    let sa: BTreeSet<char> = a.chars().collect();
    let sb: BTreeSet<char> = b.chars().collect();
    if sa.is_empty() && sb.is_empty() {
        return 1.0;
    }
    let inter = sa.intersection(&sb).count() as f64;
    let union = sa.union(&sb).count() as f64;
    if union == 0.0 { 0.0 } else { inter / union }
}

/// 共享字符数。
pub fn shared_char_count(a: &str, b: &str) -> usize {
    let sa: BTreeSet<char> = a.chars().collect();
    let sb: BTreeSet<char> = b.chars().collect();
    sa.intersection(&sb).count()
}

/// 最长公共子序列长度（LCS，经典 DP）。
pub fn lcs(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let (m, n) = (a.len(), b.len());
    if m == 0 || n == 0 { return 0; }
    let mut dp = vec![vec![0u32; n + 1]; m + 1];
    for i in 1..=m {
        for j in 1..=n {
            if a[i - 1] == b[j - 1] {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = dp[i - 1][j].max(dp[i][j - 1]);
            }
        }
    }
    dp[m][n] as usize
}

/// 邻位交换匹配：判断 query 交换相邻两个字符后是否为 target 的子串。
pub fn adjacent_swap_match(query: &str, target: &str) -> bool {
    let q: Vec<char> = query.chars().collect();
    if q.len() < 2 { return false; }
    let t: String = target.chars().collect();
    for i in 0..q.len() - 1 {
        let mut swapped = q.clone();
        swapped.swap(i, i + 1);
        let s: String = swapped.iter().collect();
        if t.contains(&s) {
            return true;
        }
    }
    false
}

/// 全名乱序匹配：query 所有字符是否都在 target 中出现（顺序无关）。
pub fn fullname_disorder_match(query: &str, target: &str) -> bool {
    let tq: BTreeSet<char> = query.chars().collect();
    let tt: BTreeSet<char> = target.chars().collect();
    tq.is_subset(&tt)
}

/// 高斯函数 `exp(-d² / (2σ²))`。
#[inline]
pub fn gaussian(d: f64, sigma: f64) -> f64 {
    (-d * d / (2.0 * sigma * sigma)).exp()
}

/// 数组按某个 key 排序（稳定排序，降序）。
pub fn sort_desc<T, K: Ord, F: FnMut(&T) -> K>(v: &mut [T], mut key: F) {
    v.sort_by(|a, b| key(b).cmp(&key(a)));
}

/// 生成随机 ID（基于时间戳 + 计数器）。
pub fn gen_id(counter: &mut u64) -> String {
    let ts = now_ts();
    let c = *counter;
    *counter += 1;
    alloc::format!("{}_{}", ts, c)
}

/// 解析整数字符串，失败返回默认值。
pub fn parse_usize(s: &str, default: usize) -> usize {
    s.parse::<usize>().unwrap_or(default)
}

pub fn parse_f64(s: &str, default: f64) -> f64 {
    s.parse::<f64>().unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clamp() {
        assert_eq!(clamp(5.0, 0.0, 10.0), 5.0);
        assert_eq!(clamp(-1.0, 0.0, 10.0), 0.0);
        assert_eq!(clamp(15.0, 0.0, 10.0), 10.0);
    }

    #[test]
    fn test_unique_strings() {
        let v = vec!["a".into(), "A".into(), "b".into(), "B".into()];
        assert_eq!(unique_strings(&v), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn test_lcs() {
        assert_eq!(lcs("abcde", "ace"), 3);
        assert_eq!(lcs("abc", "def"), 0);
    }

    #[test]
    fn test_jaccard() {
        assert!((jaccard_chars("abc", "bcd") - 0.5).abs() < 1e-9);
    }

    #[test]
    fn test_compress_repeated() {
        assert_eq!(compress_repeated("aaaaaa", 3), "aaa");
        assert_eq!(compress_repeated("aabbcc", 3), "aabbcc");
    }

    #[test]
    fn test_adjacent_swap_match() {
        assert!(adjacent_swap_match("ab", "ba"));
        assert!(!adjacent_swap_match("abc", "xyz"));
    }
}
