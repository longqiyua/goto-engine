'use strict';

/**
 * GOTO Base Where Pattern — 数据类型与工厂函数（语言无关接口）
 *
 * 定义 Where Phase 2 所需的 Pattern 数据结构与默认配置。
 * 所有"工厂函数"返回深拷贝默认值，调用方负责填入业务字段。
 *
 * Schema 版本与 schema/usage/*.schema.json、schema/reminder/*.schema.json 对齐。
 * 字段必须与 schema 完全一致（additionalProperties=false）。
 */

// ====== Schema 版本 ======
const WHERE_PATTERN_SCHEMA_VERSION = '1.0.0';

// ====== ReminderAction 枚举 ======
const ReminderAction = Object.freeze({
  OPENED: 'opened',
  IGNORED: 'ignored',
  DISMISSED: 'dismissed',
  DISABLED_RULE: 'disabled_rule',
  SNOOZED: 'snoozed'
});

// ====== ReminderPriority 枚举 ======
const ReminderPriority = Object.freeze({
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
  CRITICAL: 'critical'
});

// ====== 默认配置 ======
const DEFAULT_WHERE_PATTERN_CONFIG = Object.freeze({
  minSampleCount: 3,            // 最小样本数
  minConfidence: 0.4,           // 最小置信度
  defaultTimeWindowMinutes: 30, // 默认时间窗口
  decayHalfLifeDays: 30,        // 衰减半衰期
  decayMinWeight: 0.05,         // 衰减下限
  outlierP90ThresholdMs: 600000, // 异常值 P90 阈值（10 分钟）
  maxFeedbackKept: 5000,        // 单 profile 最多保留反馈数
  maxPatternsKept: 1000,        // 单 profile 最多保留 pattern 数
  maxSampleThreshold: 10,       // confidence 饱和样本数（达到此值 sampleFactor=1.0）
  schemaVersion: WHERE_PATTERN_SCHEMA_VERSION
});

function buildWherePatternConfig(override) {
  if (!override || typeof override !== 'object') {
    return Object.assign({}, DEFAULT_WHERE_PATTERN_CONFIG);
  }
  const merged = Object.assign({}, DEFAULT_WHERE_PATTERN_CONFIG, override);
  merged.minSampleCount = Math.max(1, Math.floor(merged.minSampleCount) || 3);
  merged.minConfidence = clampNum(merged.minConfidence, 0, 1);
  merged.defaultTimeWindowMinutes = Math.max(1, Math.floor(merged.defaultTimeWindowMinutes) || 30);
  merged.decayHalfLifeDays = Math.max(1, Math.floor(merged.decayHalfLifeDays) || 30);
  merged.maxFeedbackKept = Math.max(100, Math.floor(merged.maxFeedbackKept) || 5000);
  merged.maxPatternsKept = Math.max(50, Math.floor(merged.maxPatternsKept) || 1000);
  merged.maxSampleThreshold = Math.max(1, Math.floor(merged.maxSampleThreshold) || 10);
  return Object.freeze(merged);
}

function clampNum(v, lo, hi) {
  if (typeof v !== 'number' || isNaN(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function genId(prefix) {
  try {
    if (typeof require === 'function') {
      const c = require('crypto');
      if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    }
  } catch (_) {}
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ====== 工厂函数 ======

/**
 * 创建 TimingPattern。
 */
function createTimingPattern(init) {
  init = init || {};
  const ts = init.firstSeenAt || (init.lastSeenAt || '');
  return {
    patternId: init.patternId || ('timing:' + (init.packageName || '')),
    packageName: init.packageName || '',
    weekdays: Array.isArray(init.weekdays) ? init.weekdays.slice() : [true, true, true, true, true, false, false],
    typicalHour: typeof init.typicalHour === 'number' ? init.typicalHour : 0,
    typicalMinute: typeof init.typicalMinute === 'number' ? init.typicalMinute : 0,
    timeWindowMinutes: typeof init.timeWindowMinutes === 'number' ? init.timeWindowMinutes : 30,
    hourlyPattern: Array.isArray(init.hourlyPattern) ? init.hourlyPattern.slice() : undefined,
    sampleCount: typeof init.sampleCount === 'number' ? init.sampleCount : 0,
    confidence: typeof init.confidence === 'number' ? init.confidence : 0,
    firstSeenAt: ts,
    lastSeenAt: init.lastSeenAt || ts,
    decayVersion: typeof init.decayVersion === 'number' ? init.decayVersion : 0,
    enabled: init.enabled !== false,
    metadata: init.metadata || undefined,
    schemaVersion: init.schemaVersion || WHERE_PATTERN_SCHEMA_VERSION
  };
}

/**
 * 创建 AppTransitionPattern。
 */
function createAppTransitionPattern(init) {
  init = init || {};
  const ts = init.firstSeenAt || (init.lastSeenAt || '');
  const from = init.fromPackageName || '';
  const to = init.toPackageName || '';
  return {
    patternId: init.patternId || ('transition:' + from + '->' + to),
    fromPackageName: from,
    toPackageName: to,
    transitionCount: typeof init.transitionCount === 'number' ? init.transitionCount : 0,
    weightedTransitionCount: typeof init.weightedTransitionCount === 'number' ? init.weightedTransitionCount : 0,
    medianDelayMs: typeof init.medianDelayMs === 'number' ? init.medianDelayMs : 0,
    p90DelayMs: typeof init.p90DelayMs === 'number' ? init.p90DelayMs : undefined,
    confidence: typeof init.confidence === 'number' ? init.confidence : 0,
    firstSeenAt: ts,
    lastSeenAt: init.lastSeenAt || ts,
    decayVersion: typeof init.decayVersion === 'number' ? init.decayVersion : 0,
    enabled: init.enabled !== false,
    metadata: init.metadata || undefined,
    schemaVersion: init.schemaVersion || WHERE_PATTERN_SCHEMA_VERSION
  };
}

/**
 * 创建 GotoInternalPattern。
 */
function createGotoInternalPattern(init) {
  init = init || {};
  const ts = init.firstSeenAt || (init.lastSeenAt || '');
  const q = init.normalizedQuery || '';
  const pkg = init.targetPackageName || '';
  return {
    patternId: init.patternId || ('goto-internal:' + q + '@' + pkg),
    normalizedQuery: q,
    targetPackageName: pkg,
    weekdays: Array.isArray(init.weekdays) ? init.weekdays.slice() : [true, true, true, true, true, true, true],
    typicalHour: typeof init.typicalHour === 'number' ? init.typicalHour : 0,
    typicalMinute: typeof init.typicalMinute === 'number' ? init.typicalMinute : 0,
    timeWindowMinutes: typeof init.timeWindowMinutes === 'number' ? init.timeWindowMinutes : 30,
    sampleCount: typeof init.sampleCount === 'number' ? init.sampleCount : 0,
    confidence: typeof init.confidence === 'number' ? init.confidence : 0,
    firstSeenAt: ts,
    lastSeenAt: init.lastSeenAt || ts,
    decayVersion: typeof init.decayVersion === 'number' ? init.decayVersion : 0,
    enabled: init.enabled !== false,
    metadata: init.metadata || undefined,
    schemaVersion: init.schemaVersion || WHERE_PATTERN_SCHEMA_VERSION
  };
}

/**
 * 创建 ReminderPreference。
 */
function createReminderPreference(init) {
  init = init || {};
  const ts = init.updatedAt || (init.lastFeedbackAt || '');
  return {
    ruleId: init.ruleId || '',
    enabled: init.enabled !== false,
    priority: init.priority || ReminderPriority.NORMAL,
    quietHoursOverride: init.quietHoursOverride || undefined,
    cooldownOverride: typeof init.cooldownOverride === 'number' ? init.cooldownOverride : undefined,
    consecutiveIgnoreCount: typeof init.consecutiveIgnoreCount === 'number' ? init.consecutiveIgnoreCount : 0,
    openedCount: typeof init.openedCount === 'number' ? init.openedCount : 0,
    ignoredCount: typeof init.ignoredCount === 'number' ? init.ignoredCount : 0,
    dismissedCount: typeof init.dismissedCount === 'number' ? init.dismissedCount : 0,
    lastDeliveredAt: init.lastDeliveredAt || undefined,
    lastFeedbackAt: init.lastFeedbackAt || undefined,
    updatedAt: ts,
    metadata: init.metadata || undefined,
    schemaVersion: init.schemaVersion || WHERE_PATTERN_SCHEMA_VERSION
  };
}

/**
 * 创建 ReminderFeedback。
 */
function createReminderFeedback(init) {
  init = init || {};
  return {
    feedbackId: init.feedbackId || genId('fb'),
    ruleId: init.ruleId || '',
    candidateId: init.candidateId || '',
    receiptId: init.receiptId || undefined,
    packageName: init.packageName || undefined,
    action: init.action || ReminderAction.IGNORED,
    delayMs: typeof init.delayMs === 'number' ? init.delayMs : undefined,
    snoozeUntil: init.snoozeUntil || undefined,
    timestamp: init.timestamp || '',
    profileId: init.profileId || 'default',
    metadata: init.metadata || undefined,
    schemaVersion: init.schemaVersion || WHERE_PATTERN_SCHEMA_VERSION
  };
}

module.exports = {
  WHERE_PATTERN_SCHEMA_VERSION,
  ReminderAction,
  ReminderPriority,
  DEFAULT_WHERE_PATTERN_CONFIG,
  buildWherePatternConfig,
  genId,
  createTimingPattern,
  createAppTransitionPattern,
  createGotoInternalPattern,
  createReminderPreference,
  createReminderFeedback
};
