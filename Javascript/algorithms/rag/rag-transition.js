'use strict';

/*!
 * GOTO Engine · RAG 灰度过渡控制器 v1.0.0
 * ──────────────────────────────────────────────────────────────
 * Purpose: 月度 RAG 重建后的灰度过渡控制。从公共 RAG 索引
 *          平滑切换到个人 RAG 索引，避免冷启动期间个人向量
 *          不足导致的体验回退。
 *
 * 与 Rust 版 `rag_transition.rs` 和 Kotlin 版对齐（V2.1 三语言同步）。
 *
 * Design (per project principles):
 *   - 纯函数：不操作文件系统，只管理状态对象
 *   - IO 由调用方处理（本控制器只负责状态计算）
 *   - 线性插值：TRANSITION_DAYS 天内从 0 → 1
 *   - 过渡中：common + personal 双路并存（按 blend weight 混合）
 *   - 过渡完成：切换到 personal 单路
 *
 * License: GNU AGPL-3.0
 * ────────────────────────────────────────────────────────────── */

(function (root, factory) {
  var mod = factory(root || {});
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.RagTransitionController = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // ─── 常量 ───────────────────────────────────────────────────

  /** 过渡天数（线性插值 0→1 的跨度） */
  var TRANSITION_DAYS = 15;
  var MS_PER_DAY = 24 * 60 * 60 * 1000;

  // ─── 工具函数 ───────────────────────────────────────────────

  function safeNum(v, def) {
    return typeof v === 'number' && !isNaN(v) ? v : (def || 0);
  }

  function isArr(v) { return Array.isArray(v); }

  function nowMs() { return Date.now(); }

  // ─── 核心纯函数 ─────────────────────────────────────────────

  /**
   * 线性插值 0→1，超过 TRANSITION_DAYS 后固定为 1
   *
   * @param {number} startedAt  过渡开始时间戳（ms）；0 表示未开始
   * @param {number} [now]      当前时间戳（ms）；省略则用 Date.now()
   * @returns {number} [0, 1] 混合权重
   */
  function getBlendWeight(startedAt, now) {
    var start = safeNum(startedAt, 0);
    var cur = safeNum(now, nowMs());
    if (start <= 0) return 0;
    if (cur <= start) return 0;
    var elapsedDays = (cur - start) / MS_PER_DAY;
    if (elapsedDays >= TRANSITION_DAYS) return 1;
    return elapsedDays / TRANSITION_DAYS;
  }

  /**
   * 开始过渡：初始化 / 重置状态对象
   *
   * @param {object} [state]  现有 state（可选，会被浅拷贝后修改）
   * @returns {object} 新 state
   *   - startedAt: 当前时间戳
   *   - finalized: false
   *   - activePaths: ['common', 'personal']
   */
  function startTransition(state) {
    var s = (state && typeof state === 'object') ? state : {};
    var out = {};
    // 浅拷贝现有字段
    var keys = Object.keys(s);
    for (var i = 0; i < keys.length; i++) out[keys[i]] = s[keys[i]];
    out.startedAt = nowMs();
    out.finalized = false;
    if (!isArr(out.activePaths) || out.activePaths.length === 0) {
      out.activePaths = ['common', 'personal'];
    }
    return out;
  }

  /**
   * 最终化过渡：标记为已完成，切换到 personal 单路
   *
   * @param {object} state  现有 state
   * @returns {object} 新 state（浅拷贝）
   */
  function finalizeTransition(state) {
    if (!state || typeof state !== 'object') return state;
    var out = {};
    var keys = Object.keys(state);
    for (var i = 0; i < keys.length; i++) out[keys[i]] = state[keys[i]];
    out.finalized = true;
    out.activePaths = ['personal'];
    return out;
  }

  /**
   * 是否处于过渡中（未最终化且权重 < 1）
   *
   * @param {object} state
   * @returns {boolean}
   */
  function isTransitioning(state) {
    if (!state || typeof state !== 'object') return false;
    if (state.finalized) return false;
    var startedAt = safeNum(state.startedAt, 0);
    if (startedAt <= 0) return false;
    return getBlendWeight(startedAt, nowMs()) < 1;
  }

  /**
   * 获取当前激活的路径列表
   *
   * - 未开始过渡：['common']
   * - 过渡中：state.activePaths 或 ['common', 'personal']
   * - 过渡完成（权重≥1）：['personal']
   * - 已最终化：['personal']
   *
   * @param {object} state
   * @returns {string[]} 路径名数组
   */
  function getActivePaths(state) {
    if (!state || typeof state !== 'object') return ['common'];
    if (state.finalized) return ['personal'];
    var startedAt = safeNum(state.startedAt, 0);
    if (startedAt <= 0) return ['common'];
    if (getBlendWeight(startedAt, nowMs()) >= 1) return ['personal'];
    if (isArr(state.activePaths) && state.activePaths.length > 0) {
      return state.activePaths.slice();
    }
    return ['common', 'personal'];
  }

  // ─── 导出 ───────────────────────────────────────────────────

  return {
    TRANSITION_DAYS: TRANSITION_DAYS,
    getBlendWeight: getBlendWeight,
    startTransition: startTransition,
    finalizeTransition: finalizeTransition,
    isTransitioning: isTransitioning,
    getActivePaths: getActivePaths
  };
});
