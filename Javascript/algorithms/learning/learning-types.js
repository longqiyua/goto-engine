'use strict';

/**
 * GOTO Base Personal Learning — 数据类型与常量定义 (语言无关接口)
 *
 * 此模块定义 Personal Learning Overlay 的核心数据类型与默认配置。
 * 所有"工厂函数"返回深拷贝默认值，调用方负责填入业务字段。
 *
 * 接口对齐：Kotlin/Rust 实现应保持同名常量与字段顺序，便于跨语言事件序列化对齐。
 */

// ====== Schema 版本 ======
const LEARNING_SCHEMA_VERSION = '1.0.0';

// ====== AliasStatus 枚举 ======
const AliasStatus = Object.freeze({
  CANDIDATE: 'candidate',
  ACTIVE: 'active',
  SUPPRESSED: 'suppressed',
  DELETED: 'deleted'
});

// ====== SelectionSource 枚举 ======
const SelectionSource = Object.freeze({
  ENGINE_RESULT: 'engine-result',
  BASE_BOOST: 'base-boost',
  PERSONAL_BOOST: 'personal-boost',
  MANUAL_LAUNCH: 'manual-launch',
  EXTERNAL: 'external'
});

// ====== QueryLanguage 枚举 ======
const QueryLanguage = Object.freeze({
  ZH: 'zh',
  EN: 'en',
  PINYIN: 'pinyin',
  MIXED: 'mixed',
  UNKNOWN: 'unknown'
});

// ====== AliasSource 枚举 ======
const AliasSource = Object.freeze({
  USER_CLICK: 'user-click',
  USER_IMPORT: 'user-import',
  EXPLICIT_BIND: 'explicit-bind',
  AUTO_DETECTED: 'auto-detected'
});

// ====== PersonalAliasSource 别名（与 AliasSource 同义，便于引用） ======
const PersonalAliasSource = AliasSource;

// ====== 默认配置（与 learning-config.schema.json 的 default 对齐） ======
const DEFAULT_LEARNING_CONFIG = Object.freeze({
  maxPersonalBoost: 0.5,
  exactMatchProtection: true,
  candidateThreshold: 0.3,
  activeThreshold: 0.6,
  suppressionThreshold: -0.3,
  decayHalfLifeDays: 30,
  decayMinWeight: 0.05,
  firstClickIncrement: 0.15,
  repeatClickIncrement: 0.1,
  rank1ClickIncrement: 0.05,
  lowRankClickIncrement: 0.2,
  correctionDecrement: 0.15,
  shortQueryEvidenceFactor: 0.5,
  shortQueryMaxLength: 2,
  maxEventsKept: 10000,
  compactionIntervalEvents: 1000,
  aliasExpiresDays: 90,
  schemaVersion: LEARNING_SCHEMA_VERSION
});

/**
 * 合并用户配置与默认配置（浅合并，已冻结）。
 * @param {object} [override] 用户覆盖项
 * @returns {object} 合并后的配置（冻结）
 */
function buildConfig(override) {
  if (!override || typeof override !== 'object') {
    return Object.assign({}, DEFAULT_LEARNING_CONFIG);
  }
  const merged = Object.assign({}, DEFAULT_LEARNING_CONFIG, override);
  // 简单数值范围保护（不抛错，clamp 到合理范围）
  merged.maxPersonalBoost = clampNum(merged.maxPersonalBoost, 0, 2);
  merged.candidateThreshold = clampNum(merged.candidateThreshold, 0, 1);
  merged.activeThreshold = clampNum(merged.activeThreshold, 0, 1);
  merged.shortQueryMaxLength = Math.max(1, Math.floor(merged.shortQueryMaxLength) || 2);
  merged.maxEventsKept = Math.max(100, Math.floor(merged.maxEventsKept) || 10000);
  merged.compactionIntervalEvents = Math.max(10, Math.floor(merged.compactionIntervalEvents) || 1000);
  merged.aliasExpiresDays = Math.max(1, Math.floor(merged.aliasExpiresDays) || 90);
  return Object.freeze(merged);
}

function clampNum(v, lo, hi) {
  if (typeof v !== 'number' || isNaN(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

// ====== 工厂函数 ======

/**
 * 创建一个空的 QueryEvent 对象，调用方填入业务字段。
 * @param {object} [init] 部分初始化字段
 * @returns {object}
 */
function createQueryEvent(init) {
  init = init || {};
  return {
    eventId: init.eventId || '',
    rawQuery: init.rawQuery || '',
    normalizedQuery: init.normalizedQuery || '',
    queryLanguage: init.queryLanguage || QueryLanguage.UNKNOWN,
    timestamp: init.timestamp || '',
    sessionId: init.sessionId || '',
    context: init.context || {},
    candidatePackageNames: Array.isArray(init.candidatePackageNames) ? init.candidatePackageNames.slice() : [],
    engineRanking: Array.isArray(init.engineRanking) ? init.engineRanking.slice() : [],
    baseRanking: Array.isArray(init.baseRanking) ? init.baseRanking.slice() : [],
    schemaVersion: init.schemaVersion || LEARNING_SCHEMA_VERSION
  };
}

/**
 * 创建一个空的 SelectionEvent 对象。
 */
function createSelectionEvent(init) {
  init = init || {};
  return {
    eventId: init.eventId || '',
    queryEventId: init.queryEventId || '',
    normalizedQuery: init.normalizedQuery || '',
    selectedPackageName: init.selectedPackageName || '',
    selectedRankBeforeLearning: typeof init.selectedRankBeforeLearning === 'number'
      ? init.selectedRankBeforeLearning : 0,
    selectedRankAfterLearning: typeof init.selectedRankAfterLearning === 'number'
      ? init.selectedRankAfterLearning : 0,
    timestamp: init.timestamp || '',
    sessionId: init.sessionId || '',
    selectionSource: init.selectionSource || SelectionSource.ENGINE_RESULT,
    context: init.context || {},
    dwellTimeMs: typeof init.dwellTimeMs === 'number' ? init.dwellTimeMs : undefined,
    schemaVersion: init.schemaVersion || LEARNING_SCHEMA_VERSION
  };
}

/**
 * 创建一个空的 QueryAppAffinity 对象。
 * @param {object} [init]
 * @param {string} [init.normalizedQuery]
 * @param {string} [init.packageName]
 * @param {string} [init.firstSeenAt]
 */
function createQueryAppAffinity(init) {
  init = init || {};
  const ts = init.firstSeenAt || '';
  return {
    normalizedQuery: init.normalizedQuery || '',
    packageName: init.packageName || '',
    selectionCount: 0,
    weightedSelectionCount: 0,
    correctionCount: 0,
    negativeCount: 0,
    firstSeenAt: ts,
    lastSeenAt: ts,
    confidence: 0,
    currentWeight: 0,
    decayVersion: 0,
    contextStats: {},
    lastConsecutiveCorrectionCount: 0,
    schemaVersion: init.schemaVersion || LEARNING_SCHEMA_VERSION
  };
}

/**
 * 创建一个空的 PersonalAlias 对象。
 */
function createPersonalAlias(init) {
  init = init || {};
  const ts = init.createdAt || '';
  return {
    alias: init.alias || '',
    packageName: init.packageName || '',
    source: init.source || AliasSource.USER_CLICK,
    confidence: 0,
    evidenceCount: 0,
    createdAt: ts,
    updatedAt: ts,
    expiresAt: init.expiresAt || null,
    status: init.status || AliasStatus.CANDIDATE,
    lastUsedAt: init.lastUsedAt || undefined,
    schemaVersion: init.schemaVersion || LEARNING_SCHEMA_VERSION
  };
}

/**
 * 创建一个 LocalAppStub 对象（用户本地未在 Base 全局知识库中的应用）。
 */
function createLocalAppStub(init) {
  init = init || {};
  const ts = init.installedAt || '';
  return {
    packageName: init.packageName || '',
    appName: init.appName || '',
    version: typeof init.version === 'string' ? init.version : null,
    iconRef: typeof init.iconRef === 'string' ? init.iconRef : null,
    installedAt: ts,
    updatedAt: init.updatedAt || ts,
    discoveredVia: init.discoveredVia || '',
    userAliases: Array.isArray(init.userAliases) ? init.userAliases.slice() : [],
    metadata: init.metadata || {},
    schemaVersion: init.schemaVersion || LEARNING_SCHEMA_VERSION
  };
}

module.exports = {
  LEARNING_SCHEMA_VERSION,
  AliasStatus,
  SelectionSource,
  QueryLanguage,
  AliasSource,
  PersonalAliasSource,
  DEFAULT_LEARNING_CONFIG,
  buildConfig,
  createQueryEvent,
  createSelectionEvent,
  createQueryAppAffinity,
  createPersonalAlias,
  createLocalAppStub
};
