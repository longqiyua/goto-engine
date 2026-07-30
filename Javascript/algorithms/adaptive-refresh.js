'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║         L1 自适应刷新层 / Adaptive Refresh — 打字速度追踪 + 搜索编排            ║
 * ║                                                                              ║
 * ║  对应 Kotlin `AdaptiveRefresh/TypingSpeedTracker.kt` +                        ║
 * ║  `AdaptiveRefresh/SearchOrchestrator.kt`，以及 Rust `adaptive_refresh.rs`。  ║
 * ║                                                                              ║
 * ║  核心特性（三语言一致）：                                                       ║
 * ║  1. 【按键间隔分析】T_avg 平均间隔 / P_max 最大速度（最小间隔）/ σ² 方差        ║
 * ║  2. 【错误率检测】退格键频率 → 错误率 E                                        ║
 * ║  3. 【EMA 打字速度】字符/秒，平滑系数 α=0.3                                    ║
 * ║  4. 【防抖计算】t1 = clamp(P_max × (1+E), T_avg × 2, 400ms)                  ║
 * ║  5. 【节流计算】t2 = clamp(T_avg × (1+√σ²/T_avg), 30ms, T_avg × 1.5)        ║
 * ║  6. 【自适应延迟】= max(t1, t2)                                               ║
 * ║                                                                              ║
 * ║  说明：本模块为独立模块，不修改 `goto-engine.js`，供未来集成使用。              ║
 * ║  通过 IIFE + UMD 暴露全局 `AdaptiveRefresh`（含 TypingSpeedTracker /          ║
 * ║  SearchOrchestrator 两个构造器）。                                            ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

(function (root, factory) {
  // UMD：同时兼容 CommonJS / AMD / 浏览器全局
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.AdaptiveRefresh = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  // ─── 常量（与 Kotlin / Rust 对齐） ──────────────────────────────────────
  var INTERVAL_WINDOW_SIZE = 20;      // 间隔窗口大小
  var INTERVAL_MIN_MS = 10;           // 异常间隔下限
  var INTERVAL_MAX_MS = 5000;         // 异常间隔上限
  var EMA_ALPHA = 0.3;                // EMA 平滑系数
  var DEBOUNCE_DEFAULT_MS = 200;      // 采样不足时的默认防抖
  var DEBOUNCE_UPPER_MS = 400;        // 防抖上界
  var THROTTLE_DEFAULT_MS = 100;      // 采样不足时的默认节流
  var THROTTLE_LOWER_MS = 30;         // 节流下界
  var FALLBACK_DELAY_MS = 200;        // 编排器采样不足时的回退延迟

  // ─── 工具函数 ──────────────────────────────────────────────────────────
  function clamp(num, min, max) {
    return num < min ? min : (num > max ? max : num);
  }

  function nowTs() {
    return typeof Date !== 'undefined' && typeof Date.now === 'function'
      ? Date.now()
      : 0;
  }

  function mean(arr) {
    if (!arr || arr.length === 0) return 0;
    var sum = 0;
    for (var i = 0; i < arr.length; i++) sum += arr[i];
    return sum / arr.length;
  }

  function variance(arr, m) {
    if (!arr || arr.length < 2) return 0;
    var sumSq = 0;
    for (var i = 0; i < arr.length; i++) {
      var d = arr[i] - m;
      sumSq += d * d;
    }
    return sumSq / arr.length;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  打字速度追踪器 / TypingSpeedTracker
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * 打字速度追踪器。
   *
   * 同时维护按键间隔窗口（用于防抖/节流公式，对齐 Kotlin）与 EMA 打字速度
   * （字符/秒，对齐 Rust 任务签名）。
   *
   * @constructor
   * @param {object} [options] 可选配置
   * @param {number} [options.alpha=0.3] EMA 平滑系数
   */
  function TypingSpeedTracker(options) {
    options = options || {};
    this.alpha = typeof options.alpha === 'number' ? clamp(options.alpha, 0, 1) : EMA_ALPHA;
    this._intervals = [];           // 最近 N 次按键间隔（毫秒）
    this._lastInputTime = 0;        // 上次按键时间戳
    this._emaSpeed = 0;             // EMA 打字速度（字符/秒）
    this._backspaceCount = 0;       // 退格键次数
    this._totalKeystrokes = 0;      // 总按键次数
  }

  TypingSpeedTracker.prototype = {
    constructor: TypingSpeedTracker,

    /**
     * 记录一次按键输入。
     * @param {string} input 用户输入的字符串（兼容 Kotlin 签名，用于计数字符）
     * @param {boolean} [isBackspace=false] 是否为退格操作
     * @param {number} [timestampMs] 可选时间戳；缺省用 Date.now()
     */
    recordInput: function (input, isBackspace, timestampMs) {
      var now = typeof timestampMs === 'number' ? timestampMs : nowTs();
      // 退格：仅计入计数，不更新间隔窗口
      if (isBackspace) {
        this._backspaceCount++;
        this._totalKeystrokes++;
        this._lastInputTime = now;
        return;
      }
      // 记录按键间隔（异常值过滤：10..5000ms）
      if (this._lastInputTime > 0) {
        var interval = now - this._lastInputTime;
        if (interval >= INTERVAL_MIN_MS && interval <= INTERVAL_MAX_MS) {
          // 更新 EMA 速度（字符/秒）
          var speed = 1000 / interval;
          this._emaSpeed = this.alpha * speed + (1 - this.alpha) * this._emaSpeed;
          // 推入间隔窗口
          this._intervals.push(interval);
          if (this._intervals.length > INTERVAL_WINDOW_SIZE) {
            this._intervals.shift();
          }
        }
      }
      this._lastInputTime = now;
      this._totalKeystrokes++;
      // input 字符数统计（兼容 Kotlin，未来可用于中英文双轨速度）
      void input;
    },

    /** 当前 EMA 打字速度（字符/秒）。 */
    getEmaSpeed: function () {
      return this._emaSpeed;
    },

    /** 当前间隔窗口样本数。 */
    getSampleCount: function () {
      return this._intervals.length;
    },

    /** 错误率 E = backspaceCount / totalKeystrokes，clamp 到 [0,1]。 */
    getErrorRate: function () {
      if (this._totalKeystrokes === 0) return 0;
      return clamp(this._backspaceCount / this._totalKeystrokes, 0, 1);
    },

    /**
     * 计算防抖时间 t1（毫秒）。
     * 公式（与 Kotlin 一致）：t1 = clamp(P_max × (1 + E), T_avg × 2, 400ms)
     */
    calculateDebounceTime: function () {
      if (this._intervals.length < 2) return DEBOUNCE_DEFAULT_MS;
      var tAvg = mean(this._intervals);
      var pMax = Math.min.apply(null, this._intervals); // 最大速度对应最小间隔
      var e = this.getErrorRate();
      var t1 = pMax * (1 + e);
      return Math.round(clamp(t1, tAvg * 2, DEBOUNCE_UPPER_MS));
    },

    /**
     * 计算节流时间 t2（毫秒）。
     * 公式（与 Kotlin 一致）：t2 = clamp(T_avg × (1 + √σ²/T_avg), 30ms, T_avg × 1.5)
     * 化简为：t2 = clamp(T_avg + √σ², 30ms, T_avg × 1.5)
     */
    calculateThrottleTime: function () {
      if (this._intervals.length < 2) return THROTTLE_DEFAULT_MS;
      var tAvg = mean(this._intervals);
      var stdDev = Math.sqrt(variance(this._intervals, tAvg));
      var t2 = tAvg + stdDev;
      return Math.round(clamp(t2, THROTTLE_LOWER_MS, tAvg * 1.5));
    },

    /** 综合自适应延迟 = max(t1, t2)。 */
    calculateAdaptiveDelay: function () {
      return Math.max(this.calculateDebounceTime(), this.calculateThrottleTime());
    },

    /**
     * 获取所有计算参数的完整信息（对齐 Kotlin `getTimingStats()`）。
     */
    getTimingStats: function () {
      var intervals = this._intervals;
      if (intervals.length < 2) {
        return {
          tAvg: 0, tMin: 0, tMax: 0, variance: 0, stdDev: 0,
          errorRate: 0,
          debounceTime: DEBOUNCE_DEFAULT_MS,
          throttleTime: THROTTLE_DEFAULT_MS,
          adaptiveDelay: DEBOUNCE_DEFAULT_MS,
          sampleCount: intervals.length,
          backspaceCount: this._backspaceCount,
          totalKeystrokes: this._totalKeystrokes,
          emaSpeed: this._emaSpeed
        };
      }
      var tAvg = mean(intervals);
      var tMin = Math.min.apply(null, intervals);
      var tMax = Math.max.apply(null, intervals);
      var v = variance(intervals, tAvg);
      var stdDev = Math.sqrt(v);
      var e = this.getErrorRate();
      var t1 = this.calculateDebounceTime();
      var t2 = this.calculateThrottleTime();
      return {
        tAvg: tAvg,
        tMin: tMin,
        tMax: tMax,
        variance: v,
        stdDev: stdDev,
        errorRate: e,
        debounceTime: t1,
        throttleTime: t2,
        adaptiveDelay: Math.max(t1, t2),
        sampleCount: intervals.length,
        backspaceCount: this._backspaceCount,
        totalKeystrokes: this._totalKeystrokes,
        emaSpeed: this._emaSpeed
      };
    },

    /** 重置所有统计（开始新会话）。 */
    reset: function () {
      this._intervals = [];
      this._lastInputTime = 0;
      this._emaSpeed = 0;
      this._backspaceCount = 0;
      this._totalKeystrokes = 0;
    }
  };

  // ═══════════════════════════════════════════════════════════════════════
  //  搜索编排器 / SearchOrchestrator
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * 搜索编排器：基于 TypingSpeedTracker 的防抖 + 节流调度搜索。
   *
   * JS 版采用同步决策模型（对齐 Rust，无强运行时依赖）：
   * - `onInput(query, timestamp)`：记录输入并返回是否应立即搜索；
   * - `shouldSearch(timestamp)`：判断防抖 + 节流是否同时满足；
   * - `markSearched(timestamp)`：搜索执行后调用，更新节流基准。
   *
   * 另提供 `scheduleSearch(query, callback)` 基于 setTimeout 的便捷封装，
   * 模拟 Kotlin 协程版 submitSearch 的防抖行为（可丢弃旧搜索）。
   *
   * @constructor
   * @param {TypingSpeedTracker} [tracker] 可选，复用已有追踪器
   */
  function SearchOrchestrator(tracker) {
    this._tracker = tracker instanceof TypingSpeedTracker ? tracker : new TypingSpeedTracker();
    this._lastSearchTime = 0;       // 上次搜索时间戳
    this._pendingQuery = null;      // 待执行查询
    this._lastInputTime = 0;        // 最近输入时间戳（防抖起点）
    this._debounceTimer = null;     // setTimeout 句柄
  }

  SearchOrchestrator.prototype = {
    constructor: SearchOrchestrator,

    /** 访问内部追踪器。 */
    tracker: function () {
      return this._tracker;
    },

    /** 当前待执行的查询。 */
    pendingQuery: function () {
      return this._pendingQuery;
    },

    /**
     * 用户输入到来时调用。
     * @param {string} query 当前查询
     * @param {number} [timestampMs] 可选时间戳
     * @returns {boolean} 是否应立即搜索（空查询或首次输入）
     */
    onInput: function (query, timestampMs) {
      var now = typeof timestampMs === 'number' ? timestampMs : nowTs();
      this._tracker.recordInput(query, false, now);
      this._pendingQuery = query;
      this._lastInputTime = now;

      // 空查询直接执行（对齐 Kotlin `submitSearch` 中 query.isBlank 分支）
      if (!query) return true;
      // 首次输入立即执行（无上次搜索，无需节流）
      if (this._lastSearchTime === 0) return true;
      // 其余等待防抖 + 节流
      return false;
    },

    /**
     * 判断当前是否应执行搜索（防抖 + 节流同时满足）。
     * @param {number} [timestampMs] 可选时间戳
     * @returns {boolean}
     */
    shouldSearch: function (timestampMs) {
      if (this._pendingQuery === null) return false;
      if (this._lastInputTime === 0) return false;
      var now = typeof timestampMs === 'number' ? timestampMs : nowTs();

      var ready = this._tracker.getSampleCount() >= 2;
      var debounceMs = ready ? this._tracker.calculateDebounceTime() : FALLBACK_DELAY_MS;
      var debounceOk = (now - this._lastInputTime) >= debounceMs;

      var throttleOk = true;
      if (this._lastSearchTime > 0) {
        var throttleMs = ready ? this._tracker.calculateThrottleTime() : THROTTLE_DEFAULT_MS;
        throttleOk = (now - this._lastSearchTime) >= throttleMs;
      }
      return debounceOk && throttleOk;
    },

    /**
     * 搜索执行后调用，更新节流基准并清空待执行查询。
     * @param {number} [timestampMs] 可选时间戳
     */
    markSearched: function (timestampMs) {
      this._lastSearchTime = typeof timestampMs === 'number' ? timestampMs : nowTs();
      this._pendingQuery = null;
    },

    /**
     * 基于 setTimeout 的防抖搜索封装（模拟 Kotlin submitSearch 的可丢弃行为）。
     *
     * 每次调用会取消上一次未触发的防抖计时器，等价于“新输入丢弃旧搜索”。
     *
     * @param {string} query 当前查询
     * @param {function(string): void} callback 防抖到期后回调，参数为最终查询
     * @param {number} [timestampMs] 可选时间戳
     */
    scheduleSearch: function (query, callback, timestampMs) {
      var self = this;
      var now = typeof timestampMs === 'number' ? timestampMs : nowTs();
      // 记录输入（空查询立即执行）
      var immediate = this.onInput(query, now);
      // 取消旧防抖计时器（核心：新输入丢弃旧搜索）
      if (this._debounceTimer !== null) {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = null;
      }
      if (immediate) {
        this.markSearched(now);
        if (typeof callback === 'function') callback(query);
        return;
      }
      var ready = this._tracker.getSampleCount() >= 2;
      var delay = ready ? this._tracker.calculateAdaptiveDelay() : FALLBACK_DELAY_MS;
      this._debounceTimer = setTimeout(function () {
        self._debounceTimer = null;
        // 等待期间可能有新输入（已重置 _pendingQuery）；仅当查询未变时才执行
        if (self._pendingQuery === null) return;
        var fireTs = nowTs();
        // 节流检查
        var throttleMs = ready ? self._tracker.calculateThrottleTime() : THROTTLE_DEFAULT_MS;
        if (self._lastSearchTime > 0 && (fireTs - self._lastSearchTime) < throttleMs) {
          var remaining = throttleMs - (fireTs - self._lastSearchTime);
          self._debounceTimer = setTimeout(function () {
            self._debounceTimer = null;
            self.markSearched(fireTs + remaining);
            if (typeof callback === 'function') callback(self._pendingQuery || query);
          }, remaining);
          return;
        }
        self.markSearched(fireTs);
        if (typeof callback === 'function') callback(self._pendingQuery);
      }, delay);
    },

    /** 取消所有待处理搜索。 */
    cancel: function () {
      if (this._debounceTimer !== null) {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = null;
      }
      this._pendingQuery = null;
    },

    /** 重置编排器状态（保留追踪器统计）。 */
    reset: function () {
      this.cancel();
      this._lastSearchTime = 0;
      this._lastInputTime = 0;
    }
  };

  // ─── 导出 ──────────────────────────────────────────────────────────────
  return {
    TypingSpeedTracker: TypingSpeedTracker,
    SearchOrchestrator: SearchOrchestrator,
    // 常量一并导出，便于上层调试/对齐
    CONSTANTS: {
      INTERVAL_WINDOW_SIZE: INTERVAL_WINDOW_SIZE,
      INTERVAL_MIN_MS: INTERVAL_MIN_MS,
      INTERVAL_MAX_MS: INTERVAL_MAX_MS,
      EMA_ALPHA: EMA_ALPHA,
      DEBOUNCE_DEFAULT_MS: DEBOUNCE_DEFAULT_MS,
      DEBOUNCE_UPPER_MS: DEBOUNCE_UPPER_MS,
      THROTTLE_DEFAULT_MS: THROTTLE_DEFAULT_MS,
      THROTTLE_LOWER_MS: THROTTLE_LOWER_MS,
      FALLBACK_DELAY_MS: FALLBACK_DELAY_MS
    }
  };
}));
