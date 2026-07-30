'use strict';

/*!
 * GOTO Engine · 月度 RAG 重建算法（纯函数）v1.0.0
 * ──────────────────────────────────────────────────────────────
 * Purpose: 月度 RAG 重建的算法部分。读应用清单 + Base 个人层
 *          snapshot → 生成向量库（vectors + index）。
 *
 * 与 Kotlin 版 `Rerank/RagRebuilder.kt` 和 Rust 版
 * `rag_rebuilder.rs` 对齐（V2.1 三语言同步）。
 *
 * Design (per project principles):
 *   - 纯函数：无 IO，不修改入参，返回新对象
 *   - EmbedderPort 由 app 层注入（base 小模型实现）
 *   - 向量维度 512（与公共 RAG 一致，bge-small-zh-v1.5）
 *   - rebuild 支持异步（embedder.embed 返回 Promise）和同步
 *     （embedder.embedSync 返回 number[]）两种路径
 *   - serializeVectorStore / serializeRagIndex 与 Kotlin 对齐格式
 *
 * License: GNU AGPL-3.0
 * ────────────────────────────────────────────────────────────── */

(function (root, factory) {
  var mod = factory(root || {});
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.RagRebuilder = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // ─── 常量（与 Kotlin / Rust 对齐） ──────────────────────────

  /** 向量维度（与公共 RAG 一致） */
  var DIMENSION = 512;
  var EMBEDDING_MODEL = 'bge-small-zh-v1.5';
  var VERSION = '1.0.0';
  var VECTOR_GENERATOR = 'personal-rag-rebuilder';

  // ─── 工具函数 ───────────────────────────────────────────────

  function isArr(v) { return Array.isArray(v); }

  function safeStr(v, def) {
    return typeof v === 'string' ? v : (def || '');
  }

  function safeNum(v, def) {
    return typeof v === 'number' && !isNaN(v) ? v : (def || 0);
  }

  function safeBool(v, def) {
    return typeof v === 'boolean' ? v : (def || false);
  }

  /** 提取 packageName（兼容 packageName / pkg 两种字段名） */
  function extractPkg(app) {
    if (!app) return '';
    return safeStr(app.packageName, safeStr(app.pkg, ''));
  }

  /** 提取 label（兼容 label / name 两种字段名） */
  function extractLabel(app) {
    if (!app) return '';
    return safeStr(app.label, safeStr(app.name, ''));
  }

  /** 生成零向量（维度 = DIMENSION） */
  function zeroVector() {
    var v = new Array(DIMENSION);
    for (var i = 0; i < DIMENSION; i++) v[i] = 0;
    return v;
  }

  /** 规范化向量到 DIMENSION 维（不足补零，超长截断） */
  function normalizeVector(vec) {
    if (!isArr(vec)) return zeroVector();
    var out = new Array(DIMENSION);
    for (var i = 0; i < DIMENSION; i++) {
      out[i] = i < vec.length ? safeNum(vec[i], 0) : 0;
    }
    return out;
  }

  // ─── 个人层信号命中检测（与 Kotlin buildDocumentText 内联逻辑对齐） ───

  /**
   * heatmap 高频时段 top 应用命中检测
   * 兼容 Kotlin 结构（heatmap.cells）和 JS personal-rerank 结构（heatmap.heatmap）
   */
  function heatmapHit(snapshot, pkg) {
    if (!snapshot || !snapshot.heatmap || !pkg) return false;
    var cells = snapshot.heatmap.cells;
    if (!isArr(cells)) {
      // 兼容 JS personal-rerank 风格：heatmap.heatmap[]
      cells = snapshot.heatmap.heatmap;
    }
    if (!isArr(cells)) return false;
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      if (!cell) continue;
      var topApps = cell.topApps;
      if (!isArr(topApps)) continue;
      for (var j = 0; j < topApps.length; j++) {
        if (topApps[j] && topApps[j].packageName === pkg) return true;
      }
    }
    return false;
  }

  /**
   * transition 高频目标应用命中检测
   * 兼容 Map 和普通对象两种 transitions 结构
   */
  function transitionHit(snapshot, pkg) {
    if (!snapshot || !snapshot.transitionMatrix || !pkg) return false;
    var transitions = snapshot.transitionMatrix.transitions;
    if (!transitions) return false;
    var edgesList;
    if (transitions instanceof Map) {
      edgesList = Array.from(transitions.values());
    } else {
      edgesList = [];
      var keys = Object.keys(transitions);
      for (var k = 0; k < keys.length; k++) {
        edgesList.push(transitions[keys[k]]);
      }
    }
    for (var i = 0; i < edgesList.length; i++) {
      var edges = edgesList[i];
      if (!isArr(edges)) continue;
      for (var j = 0; j < edges.length; j++) {
        if (edges[j] && edges[j].toPackage === pkg) return true;
      }
    }
    return false;
  }

  /** feedback 最近点击命中检测 */
  function feedbackHit(snapshot, pkg) {
    if (!snapshot || !isArr(snapshot.recentFeedback) || !pkg) return false;
    for (var i = 0; i < snapshot.recentFeedback.length; i++) {
      var e = snapshot.recentFeedback[i];
      if (e && e.clickedPackage === pkg) return true;
    }
    return false;
  }

  /** affinity 偏好信号命中检测（currentWeight > 0） */
  function affinityHit(snapshot, pkg) {
    if (!snapshot || !snapshot.affinities || !pkg) return false;
    var aff = null;
    if (snapshot.affinities instanceof Map) {
      aff = snapshot.affinities.get(pkg);
    } else {
      aff = snapshot.affinities[pkg];
    }
    return aff != null && safeNum(aff.currentWeight, 0) > 0;
  }

  // ─── 意图标签构建（与 Kotlin buildIntentTags 对齐） ─────────

  /**
   * 生成意图标签：基于个人层信号
   * @returns {string[]} 标签数组
   */
  function buildIntentTags(app, snapshot) {
    var tags = [];
    if (!snapshot || snapshot.degraded) return tags;
    var pkg = extractPkg(app);
    if (!pkg) return tags;
    if (heatmapHit(snapshot, pkg)) tags.push('time_frequent');
    if (transitionHit(snapshot, pkg)) tags.push('transition_target');
    if (feedbackHit(snapshot, pkg)) tags.push('recent_click');
    if (affinityHit(snapshot, pkg)) tags.push('preferred');
    return tags;
  }

  // ─── 核心纯函数 ─────────────────────────────────────────────

  /**
   * 为单个应用构建文档文本：appName + aliases(拼音) + 个人层 boost 信号
   *
   * 个人层 boost 信号（与 Kotlin 对齐）：
   *   - heatmap 高频时段 top 应用 → "时段高频"
   *   - transition 高频目标应用 → "跳转高频"
   *   - feedback 最近点击应用 → "最近点击"
   *   - affinity 偏好应用 → "偏好应用"
   *
   * @param {object} app       应用对象（label/name, packageName/pkg, pinyin,
   *                           pinyinInitials, pinyinArray, isSystemApp）
   * @param {object} snapshot  PersonalSnapshot（可为 null/undefined）
   * @returns {string} documentText
   */
  function buildDocumentText(app, snapshot) {
    if (!app) return '';
    var parts = [];
    parts.push(extractLabel(app));

    // 别名：拼音 + 首字母 + 逐字拼音
    var pinyin = safeStr(app.pinyin, '');
    if (pinyin) parts.push(pinyin);
    var initials = safeStr(app.pinyinInitials, '');
    if (initials) parts.push(initials);
    var pinyinArray = app.pinyinArray;
    if (isArr(pinyinArray)) {
      for (var i = 0; i < pinyinArray.length; i++) {
        var p = safeStr(pinyinArray[i], '');
        if (p) parts.push(p);
      }
    }

    // 个人层 boost 信号（若 snapshot 可用且未降级）
    if (snapshot && !snapshot.degraded) {
      var pkg = extractPkg(app);
      if (pkg) {
        if (heatmapHit(snapshot, pkg)) parts.push('时段高频');
        if (transitionHit(snapshot, pkg)) parts.push('跳转高频');
        if (feedbackHit(snapshot, pkg)) parts.push('最近点击');
        if (affinityHit(snapshot, pkg)) parts.push('偏好应用');
      }
    }

    return parts.join(' ');
  }

  /**
   * 构建单条向量条目（内部辅助，被 rebuildSync / rebuildAsync 共用）
   */
  function buildEntry(idx, app, snapshot, vector) {
    var pkg = extractPkg(app);
    var docText = buildDocumentText(app, snapshot);
    var intentTags = buildIntentTags(app, snapshot);
    var metadata = {
      packageName: pkg,
      appName: extractLabel(app),
      isSystemApp: safeBool(app.isSystemApp, false)
    };
    return {
      id: idx,
      packageName: pkg,
      documentText: docText,
      vector: vector,
      intentTags: intentTags,
      metadata: metadata
    };
  }

  /** 将单条 entry 的索引信息写入 index 映射 */
  function indexEntry(idx, app, snapshot, entry, byPackage, byCategory, byIntentTag) {
    var pkg = entry.packageName;
    byPackage[pkg] = idx;
    for (var k = 0; k < entry.intentTags.length; k++) {
      var tag = entry.intentTags[k];
      if (!byIntentTag[tag]) byIntentTag[tag] = [];
      byIntentTag[tag].push(idx);
    }
    // category：个人层无分类信息，按 system/user 简单归类（与 Kotlin 对齐）
    var category = safeBool(app.isSystemApp, false) ? '系统应用' : '用户应用';
    if (!byCategory[category]) byCategory[category] = [];
    byCategory[category].push(idx);
  }

  /**
   * 同步批量重建 RAG 向量库
   *
   * embedder 必须提供 embedSync(text) -> number[]
   *
   * @param {Array}  apps      应用清单
   * @param {object} snapshot  Base 个人层快照（可为 null）
   * @param {object} embedder  嵌入器（必须含 embedSync）
   * @returns {object} RagBuildResult { vectors, index }
   */
  function rebuildSync(apps, snapshot, embedder) {
    if (!isArr(apps)) apps = [];
    if (!snapshot) snapshot = { degraded: true };

    var vectors = [];
    var byPackage = {};
    var byCategory = {};
    var byIntentTag = {};

    for (var idx = 0; idx < apps.length; idx++) {
      var app = apps[idx];
      if (!app) continue;
      var docText = buildDocumentText(app, snapshot);
      var vector;
      try {
        vector = embedder && typeof embedder.embedSync === 'function'
          ? embedder.embedSync(docText)
          : zeroVector();
        vector = normalizeVector(vector);
      } catch (_) {
        vector = zeroVector();
      }
      var entry = buildEntry(idx, app, snapshot, vector);
      vectors.push(entry);
      indexEntry(idx, app, snapshot, entry, byPackage, byCategory, byIntentTag);
    }

    return {
      vectors: vectors,
      index: {
        byPackage: byPackage,
        byCategory: byCategory,
        byIntentTag: byIntentTag
      }
    };
  }

  /**
   * 异步批量重建 RAG 向量库（主入口，返回 Promise）
   *
   * embedder 接口（二选一）：
   *   - { embed(text) -> Promise<number[]> }  异步路径
   *   - { embedSync(text) -> number[] }       同步路径（自动走 rebuildSync）
   *
   * @param {Array}  apps      应用清单
   * @param {object} snapshot  Base 个人层快照
   * @param {object} embedder  嵌入器
   * @returns {Promise<object>} RagBuildResult
   */
  function rebuild(apps, snapshot, embedder) {
    if (!isArr(apps)) apps = [];
    if (!snapshot) snapshot = { degraded: true };

    // 同步 embedder：直接走 rebuildSync，包装为 Promise
    if (embedder && typeof embedder.embedSync === 'function' && typeof embedder.embed !== 'function') {
      try {
        return Promise.resolve(rebuildSync(apps, snapshot, embedder));
      } catch (e) {
        return Promise.reject(e);
      }
    }

    // 异步 embedder：逐条 embed，链式 Promise
    var vectors = [];
    var byPackage = {};
    var byCategory = {};
    var byIntentTag = {};

    function step(idx) {
      if (idx >= apps.length) {
        return Promise.resolve({
          vectors: vectors,
          index: {
            byPackage: byPackage,
            byCategory: byCategory,
            byIntentTag: byIntentTag
          }
        });
      }
      var app = apps[idx];
      if (!app) return step(idx + 1);

      var docText = buildDocumentText(app, snapshot);
      var embedPromise;
      try {
        if (embedder && typeof embedder.embed === 'function') {
          embedPromise = Promise.resolve(embedder.embed(docText));
        } else {
          embedPromise = Promise.resolve(zeroVector());
        }
      } catch (e) {
        embedPromise = Promise.resolve(zeroVector());
      }

      return embedPromise.then(function (rawVector) {
        var vector = normalizeVector(rawVector);
        var entry = buildEntry(idx, app, snapshot, vector);
        vectors.push(entry);
        indexEntry(idx, app, snapshot, entry, byPackage, byCategory, byIntentTag);
        return step(idx + 1);
      }).catch(function () {
        // embedding 失败：零向量兜底，继续处理下一个（与 Kotlin catch→zero 对齐）
        var entry = buildEntry(idx, app, snapshot, zeroVector());
        vectors.push(entry);
        indexEntry(idx, app, snapshot, entry, byPackage, byCategory, byIntentTag);
        return step(idx + 1);
      });
    }

    return step(0);
  }

  // ─── 序列化（与 Kotlin serializeVectorStore / serializeRagIndex 对齐） ───

  /**
   * 序列化 vector-store JSON（与公共 RAG vector-store.json 结构对齐）
   * @param {object} result  RagBuildResult
   * @returns {string} JSON 字符串
   */
  function serializeVectorStore(result) {
    var vectorsArr = [];
    var vecs = (result && isArr(result.vectors)) ? result.vectors : [];
    for (var i = 0; i < vecs.length; i++) {
      var v = vecs[i];
      var vecArr = isArr(v.vector) ? v.vector.slice() : [];
      var tags = isArr(v.intentTags) ? v.intentTags.slice() : [];
      var meta = (v.metadata && typeof v.metadata === 'object') ? v.metadata : {};
      vectorsArr.push({
        id: v.id,
        packageName: v.packageName,
        documentText: v.documentText,
        vector: vecArr,
        intentTags: tags,
        metadata: meta
      });
    }
    var root = {
      version: VERSION,
      embeddingModel: EMBEDDING_MODEL,
      dimension: DIMENSION,
      vectorGenerator: VECTOR_GENERATOR,
      updatedAt: Date.now(),
      vectors: vectorsArr
    };
    return JSON.stringify(root);
  }

  /** 将 index 中的映射对象序列化为普通对象（兼容 Map / plain object） */
  function serializeIdxMap(src) {
    var dst = {};
    if (!src) return dst;
    if (src instanceof Map) {
      src.forEach(function (v, k) {
        dst[k] = isArr(v) ? v.slice() : v;
      });
    } else {
      var keys = Object.keys(src);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        dst[k] = isArr(src[k]) ? src[k].slice() : src[k];
      }
    }
    return dst;
  }

  /**
   * 序列化 rag-index JSON（与公共 RAG rag-index.json 结构对齐）
   * @param {object} result  RagBuildResult
   * @returns {string} JSON 字符串
   */
  function serializeRagIndex(result) {
    var idx = (result && result.index) ? result.index : {};
    var byPkgOut = {};
    var bp = idx.byPackage || {};
    if (bp instanceof Map) {
      bp.forEach(function (v, k) { byPkgOut[k] = { idx: v }; });
    } else {
      var bpKeys = Object.keys(bp);
      for (var i = 0; i < bpKeys.length; i++) {
        byPkgOut[bpKeys[i]] = { idx: bp[bpKeys[i]] };
      }
    }

    var root = {
      version: VERSION,
      dimension: DIMENSION,
      updatedAt: Date.now(),
      totalVectors: (result && isArr(result.vectors)) ? result.vectors.length : 0,
      byPackage: byPkgOut,
      byCategory: serializeIdxMap(idx.byCategory),
      byIntentTag: serializeIdxMap(idx.byIntentTag)
    };
    return JSON.stringify(root);
  }

  // ─── 导出 ───────────────────────────────────────────────────

  return {
    // 常量
    DIMENSION: DIMENSION,
    EMBEDDING_MODEL: EMBEDDING_MODEL,
    // 核心纯函数
    buildDocumentText: buildDocumentText,
    rebuild: rebuild,                 // 异步入口（返回 Promise）
    rebuildSync: rebuildSync,         // 同步入口（embedder 需提供 embedSync）
    // 意图标签
    buildIntentTags: buildIntentTags,
    // 序列化
    serializeVectorStore: serializeVectorStore,
    serializeRagIndex: serializeRagIndex,
    // 内部函数暴露（供单元测试 / Kotlin & Rust port 参考）
    _internals: {
      heatmapHit: heatmapHit,
      transitionHit: transitionHit,
      feedbackHit: feedbackHit,
      affinityHit: affinityHit,
      zeroVector: zeroVector,
      normalizeVector: normalizeVector,
      extractPkg: extractPkg,
      extractLabel: extractLabel
    }
  };
});
