'use strict';

/**
 * GOTO Engine — IndexTree 索引树模块
 *
 * 三种索引树 + 高斯核按键距离 + 快捷索引
 *
 * 树类型：
 * 1. 英文单词树 — 按字母建 Trie
 * 2. 中文拼音树 — 按拼音字母建 Trie
 * 3. 中文汉字树 — 按汉字建 Trie
 *
 * 高斯核按键距离：相邻按键距离近，按错也可低分命中（乘积关系）
 * 快捷索引：用户设置的快捷键节点优先级最高
 */

// === Trie 节点 ===
class TrieNode {
  constructor() {
    this.children = {};      // 子节点
    this.appIds = [];        // 该节点对应的应用 ID 列表
    this.isEnd = false;      // 是否单词结束
    this.priority = 0;       // 优先级（快捷索引 = 1000，普通 = 0）
    this.depth = 0;          // 深度
  }
}

// === IndexTree 主类 ===
class IndexTree {
  constructor() {
    this.englishTree = new TrieNode();    // 英文单词树
    this.pinyinTree = new TrieNode();     // 中文拼音树
    this.hanziTree = new TrieNode();      // 中文汉字树
    this.shortcutMap = new Map();         // 快捷索引：query → appId
    this._appDataset = [];
  }

  // 构建索引树
  build(apps) {
    this.englishTree = new TrieNode();
    this.pinyinTree = new TrieNode();
    this.hanziTree = new TrieNode();
    this._appDataset = apps || [];

    apps.forEach(app => {
      var name = (app.name || '').toLowerCase();
      var py = (app.py || '').toLowerCase();
      var en = (app.en || '').toLowerCase();
      var appId = app.id || app.name;

      // 英文单词树：按英文名的每个单词插入
      if (en) {
        en.split(/\s+/).forEach(word => {
          if (word.length > 0) this._insert(this.englishTree, word, appId);
        });
      }
      // 中文名如果是英文也加入英文树
      if (name && /^[a-z]+$/.test(name)) {
        this._insert(this.englishTree, name, appId);
      }

      // 拼音树：按拼音音节插入
      if (py) {
        py.split(/\s+/).forEach(syllable => {
          if (syllable.length > 0) this._insert(this.pinyinTree, syllable, appId);
        });
      }

      // 汉字树：按汉字逐字插入
      if (name) {
        this._insert(this.hanziTree, name, appId, true); // isHanzi=true
      }
    });
  }

  // 插入节点
  _insert(root, text, appId, isHanzi) {
    var node = root;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (!node.children[ch]) {
        node.children[ch] = new TrieNode();
        node.children[ch].depth = node.depth + 1;
      }
      node = node.children[ch];
    }
    node.isEnd = true;
    if (node.appIds.indexOf(appId) < 0) {
      node.appIds.push(appId);
    }
  }

  // 前缀搜索：返回匹配的 appId 列表
  searchPrefix(tree, prefix) {
    var node = tree;
    for (var i = 0; i < prefix.length; i++) {
      var ch = prefix[i];
      if (!node.children[ch]) return [];
      node = node.children[ch];
    }
    return this._collectAll(node);
  }

  // 收集子树所有 appId
  _collectAll(node) {
    var result = [];
    var seen = new Set();
    var queue = [node];
    while (queue.length > 0) {
      var cur = queue.shift();
      cur.appIds.forEach(id => {
        if (!seen.has(id)) { seen.add(id); result.push(id); }
      });
      Object.keys(cur.children).forEach(ch => {
        queue.push(cur.children[ch]);
      });
    }
    return result;
  }

  // 子序列搜索：query 的字符按顺序出现在树的路径中（不论间隔）
  searchSubsequence(tree, query) {
    var results = [];
    var seen = new Set();
    this._dfsSubsequence(tree, query, 0, results, seen);
    return results;
  }

  _dfsSubsequence(node, query, qi, results, seen) {
    if (qi >= query.length) {
      // 收集此节点下所有 appId
      this._collectAll(node).forEach(id => {
        if (!seen.has(id)) { seen.add(id); results.push(id); }
      });
      return;
    }
    var ch = query[qi];
    // 深度优先搜索：在所有子节点中找匹配字符
    Object.keys(node.children).forEach(childCh => {
      if (childCh === ch) {
        // 匹配当前字符，前进 query
        this._dfsSubsequence(node.children[childCh], query, qi + 1, results, seen);
      } else {
        // 不匹配，继续在子树中找（跳过当前树节点）
        this._dfsSubsequence(node.children[childCh], query, qi, results, seen);
      }
    });
  }

  // 快捷索引：设置/获取
  setShortcut(query, appId) {
    this.shortcutMap.set(query.toLowerCase(), appId);
  }

  getShortcut(query) {
    return this.shortcutMap.get(query.toLowerCase()) || null;
  }

  removeShortcut(query) {
    this.shortcutMap.delete(query.toLowerCase());
  }

  // 高斯核按键距离因子（乘积关系）
  // 相邻按键距离近 → 因子接近 1.0
  // 远离按键 → 因子较低
  gaussianKeyFactor(query) {
    if (!query || query.length < 2) return 1.0;
    var factor = 1.0;
    for (var i = 0; i < query.length - 1; i++) {
      var dist = this._qwertyDist(query[i], query[i + 1]);
      // 高斯核：exp(-dist² / 2σ²)，σ=1.5
      var sigma = 1.5;
      var gk = Math.exp(-(dist * dist) / (2 * sigma * sigma));
      factor *= gk;
    }
    return factor;
  }

  // QWERTY 键盘按键距离
  _qwertyDist(a, b) {
    var pos = this._qwertyPos(a);
    var pos2 = this._qwertyPos(b);
    if (!pos || !pos2) return 8;
    var dx = pos[0] - pos2[0];
    var dy = pos[1] - pos2[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  _qwertyPos(ch) {
    var rows = [
      'qwertyuiop',
      'asdfghjkl',
      'zxcvbnm'
    ];
    for (var r = 0; r < rows.length; r++) {
      var c = rows[r].indexOf(ch);
      if (c >= 0) return [c, r];
    }
    return null;
  }

  // 综合搜索：先查快捷索引，再查前缀，再查子序列
  search(query) {
    var q = (query || '').toLowerCase();
    if (!q) return { appIds: [], source: 'idle', shortcut: false };

    // 1. 快捷索引（最高优先级）
    var shortcut = this.getShortcut(q);
    if (shortcut) {
      return { appIds: [shortcut], source: 'shortcut', shortcut: true, priority: 1000 };
    }

    // 2. 英文前缀
    var enResults = this.searchPrefix(this.englishTree, q);
    if (enResults.length > 0) {
      return { appIds: enResults, source: 'english-prefix', shortcut: false };
    }

    // 3. 拼音前缀
    var pyResults = this.searchPrefix(this.pinyinTree, q);
    if (pyResults.length > 0) {
      return { appIds: pyResults, source: 'pinyin-prefix', shortcut: false };
    }

    // 4. 汉字前缀
    var hzResults = this.searchPrefix(this.hanziTree, q);
    if (hzResults.length > 0) {
      return { appIds: hzResults, source: 'hanzi-prefix', shortcut: false };
    }

    // 5. 英文子序列（顺序恢复）
    var enSubseq = this.searchSubsequence(this.englishTree, q);
    if (enSubseq.length > 0) {
      return { appIds: enSubseq, source: 'english-subsequence', shortcut: false };
    }

    // 6. 拼音子序列
    var pySubseq = this.searchSubsequence(this.pinyinTree, q);
    if (pySubseq.length > 0) {
      return { appIds: pySubseq, source: 'pinyin-subsequence', shortcut: false };
    }

    return { appIds: [], source: 'no-match', shortcut: false };
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { IndexTree, TrieNode };
}
if (typeof global !== 'undefined') {
  global.IndexTree = IndexTree;
  global.TrieNode = TrieNode;
}
