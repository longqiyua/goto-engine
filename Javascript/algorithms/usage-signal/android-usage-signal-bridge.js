'use strict';

/**
 * Android Usage Signal Bridge — 接收 Android UsageSignalProvider 传来的信号，
 * 写入 GOTO Base Personal Layer，并触发 Pattern Builder 生成/更新 Pattern。
 *
 * 职责：
 *   1. 接收 AppUsageSignal[] JSON
 *   2. 转换为 AppUsageAggregate（按会话聚合）
 *   3. 调用 Pattern Builder 生成/增量更新 TimingPattern / AppTransitionPattern
 *   4. 通过 WherePatternLearning 写入 Base
 *
 * 不职责：
 *   - 不直接调用 Android API
 *   - 不保存原始事件超过 TTL
 *   - 不影响 GOTO Engine
 *
 * 调用方式（由 Composition Root 注入）：
 *   const bridge = new AndroidUsageSignalBridge({
 *     wherePatternLearning,
 *     timingPatternBuilder,
 *     appTransitionPatternBuilder
 *   });
 *   const result = await bridge.ingestSignals(signalJsonArray);
 */

const {
  createAppUsageAggregate,
  APP_USAGE_AGGREGATE_SCHEMA_VERSION
} = require('../where-pattern/app-usage-aggregate-types.js');

class AndroidUsageSignalBridge {
  /**
   * @param {object} options
   *   - {object} wherePatternLearning WherePatternLearning Facade
   *   - {object} timingPatternBuilder TimingPatternBuilder
   *   - {object} appTransitionPatternBuilder AppTransitionPatternBuilder
   *   - {function} [now] 自定义时间函数
   *   - {number} [minSessionGapMs=60000] 会话间隔阈值（默认 60 秒视为新会话）
   */
  constructor({
    wherePatternLearning,
    timingPatternBuilder,
    appTransitionPatternBuilder,
    now,
    minSessionGapMs
  } = {}) {
    this._wpl = wherePatternLearning;
    this._tpb = timingPatternBuilder;
    this._atpb = appTransitionPatternBuilder;
    this._now = now || (() => new Date().toISOString());
    this._minSessionGapMs = typeof minSessionGapMs === 'number' ? minSessionGapMs : 60000;
  }

  /**
   * 摄取 Android 使用信号。
   * @param {string|Array} signalsJson AppUsageSignal[] JSON 字符串或数组
   * @returns {Promise<object>} {
   *   ingested, aggregates, timingPatternsBuilt, transitionPatternsBuilt,
   *   degraded, reason
   * }
   */
  async ingestSignals(signalsJson) {
    if (!this._wpl || !this._wpl.available) {
      return {
        ingested: 0,
        aggregates: 0,
        timingPatternsBuilt: 0,
        transitionPatternsBuilt: 0,
        degraded: true,
        reason: 'WherePatternLearning unavailable'
      };
    }

    let signals = [];
    try {
      if (typeof signalsJson === 'string') {
        signals = JSON.parse(signalsJson);
      } else if (Array.isArray(signalsJson)) {
        signals = signalsJson;
      }
    } catch (e) {
      return {
        ingested: 0,
        aggregates: 0,
        timingPatternsBuilt: 0,
        transitionPatternsBuilt: 0,
        degraded: true,
        reason: 'Invalid signals JSON: ' + e.message
      };
    }

    if (!Array.isArray(signals) || signals.length === 0) {
      return {
        ingested: 0,
        aggregates: 0,
        timingPatternsBuilt: 0,
        transitionPatternsBuilt: 0,
        degraded: false,
        reason: 'no signals'
      };
    }

    // 1. 将信号按应用分组成会话（AppUsageAggregate）
    const aggregates = this._buildAggregates(signals);

    // 2. 用 TimingPatternBuilder 构建时间模式
    let timingPatternsBuilt = 0;
    if (this._tpb) {
      // build() 接受 AppUsageAggregate[] 并返回 TimingPattern[]（按 packageName 分组）
      try {
        const patterns = this._tpb.build(aggregates);
        if (Array.isArray(patterns)) {
          for (const p of patterns) {
            if (p && p.packageName) {
              await this._wpl.upsertTimingPattern(p);
              timingPatternsBuilt++;
            }
          }
        }
      } catch (e) {
        // 单个应用失败不影响其他
      }
    }

    // 3. 用 AppTransitionPatternBuilder 构建转移模式
    // build() 接受完整 aggregates 列表，自行按时间排序并发现相邻会话间的转移对
    let transitionPatternsBuilt = 0;
    if (this._atpb) {
      try {
        const patterns = this._atpb.build(aggregates);
        if (Array.isArray(patterns)) {
          for (const p of patterns) {
            if (p && p.fromPackageName && p.toPackageName) {
              await this._wpl.upsertAppTransitionPattern(p);
              transitionPatternsBuilt++;
            }
          }
        }
      } catch (e) {
        // 转移构建失败不影响已有结果
      }
    }

    return {
      ingested: signals.length,
      aggregates: aggregates.length,
      timingPatternsBuilt,
      transitionPatternsBuilt,
      degraded: false,
      reason: 'ok'
    };
  }

  /**
   * 将信号序列按应用 + 时间间隔分组成会话（AppUsageAggregate）。
   */
  _buildAggregates(signals) {
    const aggregates = [];
    const sessionsByPackage = new Map(); // packageName -> current session

    for (const sig of signals) {
      if (!sig || !sig.packageName || typeof sig.timestamp !== 'number') continue;

      const packageName = sig.packageName;
      const ts = sig.timestamp;
      const eventType = sig.eventType || '';

      let session = sessionsByPackage.get(packageName);

      if (eventType === 'foreground') {
        // 开始新会话
        if (session && session.endedAt) {
          // 之前的会话已结束，提交
          aggregates.push(this._finalizeAggregate(session));
        }
        session = {
          packageName,
          sessionId: 'sess-' + ts + '-' + packageName,
          startedAt: new Date(ts).toISOString(),
          startedAtMs: ts,
          endedAt: null,
          endedAtMs: null,
          durationMs: 0,
          previousPackageName: sig.previousPackageName || null,
          transitionDelayMs: undefined
        };
        sessionsByPackage.set(packageName, session);
      } else if (eventType === 'background') {
        if (session && !session.endedAt) {
          session.endedAt = new Date(ts).toISOString();
          session.endedAtMs = ts;
          session.durationMs = ts - session.startedAtMs;

          // 计算转移延时（从 previousPackageName 切换到此应用的时间）
          if (session.previousPackageName) {
            session.transitionDelayMs = Math.max(0, session.startedAtMs - ts);
          }
        }
      }
    }

    // 提交未结束的会话
    for (const session of sessionsByPackage.values()) {
      if (session && !session.endedAt) {
        aggregates.push(this._finalizeAggregate(session));
      }
    }

    return aggregates;
  }

  _finalizeAggregate(session) {
    return createAppUsageAggregate({
      packageName: session.packageName,
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      endedAt: session.endedAt || session.startedAt,
      durationMs: session.durationMs || 0,
      previousPackageName: session.previousPackageName,
      transitionDelayMs: session.transitionDelayMs
    });
  }

  /**
   * 按 packageName 分组。
   */
  _groupByPackage(aggregates) {
    const map = new Map();
    for (const a of aggregates) {
      if (!map.has(a.packageName)) map.set(a.packageName, []);
      map.get(a.packageName).push(a);
    }
    return map;
  }

  /**
   * 构建转移序列（fromPackage → toPackage）。
   */
  _buildTransitions(aggregates) {
    const byFrom = new Map();
    for (const a of aggregates) {
      if (!a.previousPackageName) continue;
      const key = a.previousPackageName;
      if (!byFrom.has(key)) byFrom.set(key, []);
      byFrom.get(key).push(a);
    }

    const out = [];
    for (const [fromPkg, sessions] of byFrom.entries()) {
      // 按 toPackage 再分组
      const byTo = new Map();
      for (const s of sessions) {
        if (!byTo.has(s.packageName)) byTo.set(s.packageName, []);
        byTo.get(s.packageName).push(s);
      }
      for (const [toPkg, toSessions] of byTo.entries()) {
        out.push({
          fromPackageName: fromPkg,
          toPackageName: toPkg,
          sessions: toSessions
        });
      }
    }
    return out;
  }
}

module.exports = { AndroidUsageSignalBridge };
