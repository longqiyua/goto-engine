'use strict';

/**
 * GOTO Base Personal Learning — QueryNormalizer (语言无关接口)
 *
 * 纯函数模块：输入用户原始查询，输出归一化后的字符串与语言检测结果。
 * 不与 Engine / Base 知识库耦合，不产生 IO 副作用。
 *
 * 归一化规则：
 *   1. trim（去首尾空白）
 *   2. 不可见字符过滤（控制字符 U+0000~U+001F, U+007F~U+009F, BOM, 零宽字符等）
 *   3. 全角字符 → 半角（含 ASCII 字母/数字/标点，及全角空格 U+3000 → 半角空格）
 *   4. 大小写归一化（toLower，但保留中文/标点）
 *   5. 连续空白压缩为单个空格
 *
 * 不做：
 *   - 不做语义合并（"微信付款" 与 "微信聊天" 保持独立）
 *   - 不做拼音转换（pinyin 仅作为 detectLanguage 的判定结果，不改写字符）
 *   - 不做停用词过滤
 *
 * 接口对齐：Kotlin/Rust 实现应保持完全一致的字符串变换规则，便于跨语言事件比对。
 */

/** 全角字符 → 半角字符 的核心映射 */
function toHalfWidthChar(ch) {
  const code = ch.charCodeAt(0);
  // 全角空格 U+3000 → 半角空格 U+0020
  if (code === 0x3000) return ' ';
  // 全角 ASCII 字符 U+FF01~U+FF5E → 半角 U+0021~U+007E
  if (code >= 0xff01 && code <= 0xff5e) {
    return String.fromCharCode(code - 0xfee0);
  }
  return ch;
}

/**
 * 过滤不可见字符：
 *   - 控制字符 U+0000~U+001F（保留 \t \n \r 暂时，由空格压缩逻辑统一处理）
 *   - 控制字符 U+007F~U+009F
 *   - BOM U+FEFF
 *   - 零宽字符 U+200B / U+200C / U+200D / U+2060
 *   - 方向控制符 U+202A~U+202E、U+2066~U+2069
 */
function isInvisibleChar(code) {
  if (code <= 0x001f) return code !== 0x0009 && code !== 0x000a && code !== 0x000d;
  if (code >= 0x007f && code <= 0x009f) return true;
  if (code === 0xfeff) return true;
  if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0x2060) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  return false;
}

/**
 * 归一化用户查询。
 *
 * @param {string} rawQuery 原始查询
 * @returns {string} 归一化后查询（永远不为空字符串，若输入空则返回空字符串）
 */
function normalize(rawQuery) {
  if (typeof rawQuery !== 'string') return '';
  if (rawQuery.length === 0) return '';

  let out = '';
  for (let i = 0; i < rawQuery.length; i++) {
    const ch = rawQuery[i];
    const code = ch.charCodeAt(0);
    if (isInvisibleChar(code)) continue;
    out += toHalfWidthChar(ch);
  }

  // 大小写归一化（toLower）
  out = out.toLowerCase();

  // 连续空白压缩为单个空格
  out = out.replace(/\s+/g, ' ');

  // trim
  out = out.trim();

  return out;
}

// ====== 语言检测 ======

/** 拼音特征表（覆盖常见拼音音节，用于判定纯拉丁字母 token 是否为拼音） */
const PINYIN_HINTS = new Set([
  // 单韵母
  'a', 'o', 'e', 'i', 'u', 'v',
  // 复韵母
  'ai', 'ei', 'ao', 'ou', 'an', 'en', 'ang', 'eng', 'er', 'ia', 'ie', 'iao', 'iu',
  'ian', 'in', 'iang', 'iong', 'ua', 'uo', 'uai', 'ui', 'uan', 'un', 'uang', 'ue', 've',
  // b
  'ba', 'bo', 'bai', 'bei', 'bao', 'ban', 'ben', 'bang', 'beng', 'bi', 'bie', 'biao', 'bian', 'bin', 'bing',
  // p
  'pa', 'po', 'pai', 'pei', 'pao', 'pou', 'pan', 'pen', 'pang', 'peng', 'pi', 'pie', 'piao', 'pian', 'pin', 'ping',
  // m
  'ma', 'mo', 'me', 'mai', 'mei', 'mao', 'mou', 'man', 'men', 'mang', 'meng', 'mi', 'mie', 'miao', 'miu', 'mian', 'min', 'ming',
  // f
  'fa', 'fo', 'fei', 'fao', 'fou', 'fan', 'fen', 'fang', 'feng',
  // d
  'da', 'de', 'dai', 'dei', 'dao', 'dou', 'dan', 'den', 'dang', 'deng', 'di', 'die', 'diao', 'diu', 'dian', 'ding', 'du', 'duo', 'dui', 'duan', 'dun', 'dong',
  // t
  'ta', 'te', 'tai', 'tao', 'tou', 'tan', 'tang', 'teng', 'ti', 'tie', 'tiao', 'tian', 'ting', 'tu', 'tuo', 'tui', 'tuan', 'tun', 'tong',
  // n
  'na', 'ne', 'nai', 'nei', 'nao', 'nou', 'nan', 'nen', 'nang', 'neng', 'ni', 'nie', 'niao', 'niu', 'nian', 'nin', 'niang', 'ning', 'nu', 'nuo', 'nuan', 'nong',
  // l
  'la', 'le', 'lai', 'lei', 'lao', 'lou', 'lan', 'lang', 'leng', 'li', 'lia', 'lie', 'liao', 'liu', 'lian', 'lin', 'liang', 'ling', 'lo', 'lu', 'luo', 'lua', 'lui', 'luan', 'lun', 'long',
  // g
  'ga', 'ge', 'gai', 'gei', 'gao', 'gou', 'gan', 'gen', 'gang', 'geng', 'gu', 'gua', 'guo', 'guai', 'gui', 'guan', 'gun', 'guang', 'gong',
  // k
  'ka', 'ke', 'kai', 'kao', 'kou', 'kan', 'ken', 'kang', 'keng', 'ku', 'kua', 'kuo', 'kuai', 'kui', 'kuan', 'kun', 'kuang', 'kong',
  // h
  'ha', 'he', 'hai', 'hei', 'hao', 'hou', 'han', 'hen', 'hang', 'heng', 'hu', 'hua', 'huo', 'huai', 'hui', 'huan', 'hun', 'huang', 'hong',
  // j
  'ji', 'jia', 'jie', 'jiao', 'jiu', 'jian', 'jin', 'jiang', 'jiong', 'jing', 'ju', 'jue', 'juan', 'jun',
  // q
  'qi', 'qia', 'qie', 'qiao', 'qiu', 'qian', 'qin', 'qiang', 'qiong', 'qing', 'qu', 'que', 'quan', 'qun',
  // x
  'xi', 'xia', 'xie', 'xiao', 'xiu', 'xian', 'xin', 'xiang', 'xiong', 'xing', 'xu', 'xue', 'xuan', 'xun',
  // zh
  'zha', 'zhe', 'zhai', 'zhao', 'zhou', 'zhan', 'zhen', 'zhang', 'zheng', 'zhi', 'zhua', 'zhuo', 'zhuai', 'zhui', 'zhuan', 'zhun', 'zhuang', 'zhong',
  // ch
  'cha', 'che', 'chai', 'chao', 'chou', 'chan', 'chen', 'chang', 'cheng', 'chi', 'chua', 'chuo', 'chuai', 'chui', 'chuan', 'chun', 'chuang', 'chong',
  // sh
  'sha', 'she', 'shai', 'shei', 'shao', 'shou', 'shan', 'shen', 'shang', 'sheng', 'shi', 'shua', 'shuo', 'shuai', 'shui', 'shuan', 'shun', 'shuang',
  // r
  'ran', 'ren', 'rang', 'reng', 'ri', 'rou', 'ru', 'rua', 'ruo', 'rui', 'ruan', 'run', 'rong',
  // z
  'za', 'ze', 'zai', 'zei', 'zao', 'zou', 'zan', 'zen', 'zang', 'zeng', 'zi', 'zong', 'zuan', 'zui', 'zun', 'zuo',
  // c
  'ca', 'ce', 'cai', 'cao', 'cou', 'can', 'cen', 'cang', 'ceng', 'ci', 'cong', 'cuan', 'cui', 'cun', 'cuo',
  // s
  'sa', 'se', 'sai', 'sao', 'sou', 'san', 'sen', 'sang', 'seng', 'si', 'song', 'suan', 'sui', 'sun', 'suo',
  // y
  'ya', 'yo', 'ye', 'yao', 'you', 'yan', 'yin', 'yang', 'ying', 'yong', 'yu', 'yue', 'yuan', 'yun', 'wei', 'wo'
]);

/**
 * 检测归一化后查询的主要语言/类型。
 *
 * 判定顺序：
 *   1. 全为空 → unknown
 *   2. 含中文 → zh（若混有拉丁字母则视为 mixed）
 *   3. 仅拉丁字母/数字：
 *      - 长度 1~6 且匹配常见拼音 → pinyin
 *      - 否则 en
 *   4. 含其他非拉丁非中文字符 → mixed
 *
 * @param {string} normalizedQuery 已归一化的查询
 * @returns {'zh' | 'en' | 'pinyin' | 'mixed' | 'unknown'} 语言标签
 */
function detectLanguage(normalizedQuery) {
  if (typeof normalizedQuery !== 'string' || normalizedQuery.length === 0) return 'unknown';

  let hasHan = false;
  let hasLatin = false;
  let hasOther = false;

  for (let i = 0; i < normalizedQuery.length; i++) {
    const code = normalizedQuery.charCodeAt(i);
    if (code === 0x0020) continue; // 空格分隔符
    // CJK Unified Ideographs (常用基础区 + 扩展 A)
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) {
      hasHan = true;
      continue;
    }
    // 基本拉丁字母
    if ((code >= 0x0061 && code <= 0x007a) || (code >= 0x0041 && code <= 0x005a)) {
      hasLatin = true;
      continue;
    }
    // 数字与 ASCII 标点
    if ((code >= 0x0030 && code <= 0x0039) || code === 0x002d || code === 0x002e || code === 0x005f) {
      continue;
    }
    hasOther = true;
  }

  if (hasHan && !hasLatin && !hasOther) return 'zh';
  if (hasHan && (hasLatin || hasOther)) return 'mixed';
  if (!hasHan && !hasLatin) return 'unknown';

  // 仅拉丁字母 / 数字
  if (hasOther) return 'mixed';
  // 尝试拼音判定（按 token 拆分）
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  if (tokens.length > 0 && tokens.every(t => t.length <= 6 && /^[a-z]+$/.test(t))) {
    const allPinyin = tokens.every(t => PINYIN_HINTS.has(t));
    if (allPinyin) return 'pinyin';
  }
  // 单 token 短拉丁串：可能是拼音（如 "wx" 不是拼音，但 "wei" 是）
  if (tokens.length === 1 && /^[a-z]+$/.test(tokens[0]) && PINYIN_HINTS.has(tokens[0])) {
    return 'pinyin';
  }
  return 'en';
}

/**
 * 判定是否为短查询。
 *
 * @param {string} normalizedQuery 已归一化的查询
 * @param {number} [shortQueryMaxLength=2] 短查询最大长度（含）
 * @returns {boolean}
 */
function isShortQuery(normalizedQuery, shortQueryMaxLength) {
  if (typeof normalizedQuery !== 'string' || normalizedQuery.length === 0) return false;
  const maxLen = (typeof shortQueryMaxLength === 'number' && shortQueryMaxLength > 0)
    ? shortQueryMaxLength
    : 2;
  // 短查询判定基于"非空白字符数"，避免 "a b c" 被误判为长查询
  const noSpaceLen = normalizedQuery.replace(/\s+/g, '').length;
  return noSpaceLen <= maxLen;
}

module.exports = {
  normalize,
  detectLanguage,
  isShortQuery,
  // 暴露内部纯函数便于单元测试
  toHalfWidthChar,
  isInvisibleChar
};
