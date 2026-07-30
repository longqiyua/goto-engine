'use strict';

/**
 * GOTO Base Where Pattern Learning — WherePatternLearning Facade
 *
 * 封装 Where Phase 2 Pattern 存储的统一门面：
 *   - 读写 TimingPattern / AppTransitionPattern / GotoInternalPattern
 *   - 读写 ReminderPreference / ReminderFeedback
 *   - profileId 隔离
 *   - 初始化失败时 available=false，所有方法降级为 no-op
 *   - schemaVersion 兼容检测（不兼容时进入隔离 profile）
 *
 * 该 Facade 不依赖 PersonalLearning；HOST 在 Composition Root 注入到 BaseReaderAdapter / BaseWriterAdapter。
 */

const {
  WHERE_PATTERN_SCHEMA_VERSION,
  ReminderAction,
  ReminderPriority,
  buildWherePatternConfig,
  createTimingPattern,
  createAppTransitionPattern,
  createGotoInternalPattern,
  createReminderPreference,
  createReminderFeedback
} = require('./where-pattern-types.js');
const {
  InMemoryWherePatternStore
} = require('./where-pattern-store.js');

class WherePatternLearning {
  /**
   * @param {object} options
   *   - {object} [store] WherePatternStore 实现（不传则创建 InMemory）
   *   - {object} [config] 配置覆盖
   *   - {string} [profileId='default'] Profile ID
   *   - {function} [now] 自定义时间函数
   *   - {function} [idGen] 自定义 UUID 生成器
   */
  constructor({ store, config, profileId, now, idGen } = {}) {
    this._store = store || new InMemoryWherePatternStore(config);
    this._config = buildWherePatternConfig(config || {});
    this._profileId = profileId || 'default';
    this._now = now || (() => new Date().toISOString());
    this._idGen = idGen || (() => {
      try {
        if (typeof require === 'function') {
          const c = require('crypto');
          if (c && typeof c.randomUUID === 'function') return c.randomUUID();
        }
      } catch (_) {}
      return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    });
    this._available = false;
    this._supportedSchemaVersion = WHERE_PATTERN_SCHEMA_VERSION;
    // 隔离 profile：用于存放 schemaVersion 不兼容的数据
    this._quarantineProfileId = (this._profileId || 'default') + ':quarantine';
  }

  async init() {
    try {
      if (typeof this._store.init === 'function') {
        await this._store.init();
      }
      this._available = true;
    } catch (e) {
      this._available = false;
    }
  }

  get available() {
    return this._available;
  }

  get profileId() {
    return this._profileId;
  }

  // ====== TimingPattern ======

  async getTimingPattern(packageName) {
    if (!this._available) return null;
    try {
      const v = await this._store.getTimingPattern(packageName, this._profileId);
      return this._compat(v);
    } catch (e) { return null; }
  }

  async getAllTimingPatterns() {
    if (!this._available) return [];
    try {
      const list = await this._store.getAllTimingPatterns(this._profileId);
      return (list || []).filter(p => this._isCompatible(p));
    } catch (e) { return []; }
  }

  async upsertTimingPattern(pattern) {
    if (!this._available) return;
    try {
      await this._store.upsertTimingPattern(pattern, this._profileId);
    } catch (e) { /* 静默 */ }
  }

  async deleteTimingPattern(packageName) {
    if (!this._available) return false;
    try {
      return await this._store.deleteTimingPattern(packageName, this._profileId);
    } catch (e) { return false; }
  }

  // ====== AppTransitionPattern ======

  async getAppTransitionPattern(fromPackageName) {
    if (!this._available) return [];
    try {
      const list = await this._store.getAppTransitionPattern(fromPackageName, this._profileId);
      return (list || []).filter(p => this._isCompatible(p));
    } catch (e) { return []; }
  }

  async getAllAppTransitionPatterns() {
    if (!this._available) return [];
    try {
      const list = await this._store.getAllAppTransitionPatterns(this._profileId);
      return (list || []).filter(p => this._isCompatible(p));
    } catch (e) { return []; }
  }

  async upsertAppTransitionPattern(pattern) {
    if (!this._available) return;
    try {
      await this._store.upsertAppTransitionPattern(pattern, this._profileId);
    } catch (e) { /* 静默 */ }
  }

  async deleteAppTransitionPattern(fromPackageName, toPackageName) {
    if (!this._available) return false;
    try {
      return await this._store.deleteAppTransitionPattern(fromPackageName, toPackageName, this._profileId);
    } catch (e) { return false; }
  }

  // ====== GotoInternalPattern ======

  async getGotoInternalPatternsByQuery(normalizedQuery) {
    if (!this._available) return [];
    try {
      const list = await this._store.getGotoInternalPatternsByQuery(normalizedQuery, this._profileId);
      return (list || []).filter(p => this._isCompatible(p));
    } catch (e) { return []; }
  }

  async getAllGotoInternalPatterns() {
    if (!this._available) return [];
    try {
      const list = await this._store.getAllGotoInternalPatterns(this._profileId);
      return (list || []).filter(p => this._isCompatible(p));
    } catch (e) { return []; }
  }

  async upsertGotoInternalPattern(pattern) {
    if (!this._available) return;
    try {
      await this._store.upsertGotoInternalPattern(pattern, this._profileId);
    } catch (e) { /* 静默 */ }
  }

  async deleteGotoInternalPattern(patternId) {
    if (!this._available) return false;
    try {
      return await this._store.deleteGotoInternalPattern(patternId, this._profileId);
    } catch (e) { return false; }
  }

  // ====== ReminderPreference ======

  async getReminderPreference(ruleId) {
    if (!this._available) return null;
    try {
      const v = await this._store.getReminderPreference(ruleId, this._profileId);
      return this._compat(v);
    } catch (e) { return null; }
  }

  async getAllReminderPreferences() {
    if (!this._available) return [];
    try {
      const list = await this._store.getAllReminderPreferences(this._profileId);
      return (list || []).filter(p => this._isCompatible(p));
    } catch (e) { return []; }
  }

  async upsertReminderPreference(pref) {
    if (!this._available) return;
    try {
      await this._store.upsertReminderPreference(pref, this._profileId);
    } catch (e) { /* 静默 */ }
  }

  async deleteReminderPreference(ruleId) {
    if (!this._available) return false;
    try {
      return await this._store.deleteReminderPreference(ruleId, this._profileId);
    } catch (e) { return false; }
  }

  // ====== ReminderFeedback ======

  async recordReminderFeedback(feedback) {
    if (!this._available) return;
    try {
      await this._store.recordReminderFeedback(feedback, this._profileId);
    } catch (e) { /* 静默 */ }
  }

  async getRecentReminderFeedback(filter) {
    if (!this._available) return [];
    try {
      const list = await this._store.getRecentReminderFeedback(filter, this._profileId);
      return (list || []).filter(p => this._isCompatible(p));
    } catch (e) { return []; }
  }

  async getAllReminderFeedback() {
    if (!this._available) return [];
    try {
      const list = await this._store.getAllReminderFeedback(this._profileId);
      return (list || []).filter(p => this._isCompatible(p));
    } catch (e) { return []; }
  }

  // ====== Profile 管理 ======

  async exportPatternProfile() {
    if (!this._available) {
      return {
        profileId: this._profileId,
        exportedAt: this._now(),
        timingPatterns: [],
        appTransitionPatterns: [],
        gotoInternalPatterns: [],
        reminderPreferences: [],
        reminderFeedback: [],
        schemaVersion: WHERE_PATTERN_SCHEMA_VERSION
      };
    }
    try {
      return await this._store.exportPatternProfile(this._profileId);
    } catch (e) {
      return {
        profileId: this._profileId,
        exportedAt: this._now(),
        timingPatterns: [],
        appTransitionPatterns: [],
        gotoInternalPatterns: [],
        reminderPreferences: [],
        reminderFeedback: [],
        schemaVersion: WHERE_PATTERN_SCHEMA_VERSION
      };
    }
  }

  async importPatternProfile(data) {
    if (!this._available || !data) return;
    try {
      await this._store.importPatternProfile(data, this._profileId);
    } catch (e) { /* 静默 */ }
  }

  async resetPatternProfile() {
    if (!this._available) return;
    try {
      await this._store.resetPatternProfile(this._profileId);
    } catch (e) { /* 静默 */ }
  }

  // ====== 统计 ======

  async getStats() {
    if (!this._available) {
      return {
        available: false,
        profileId: this._profileId,
        timingPatterns: 0,
        appTransitionPatterns: 0,
        gotoInternalPatterns: 0,
        reminderPreferences: 0,
        reminderFeedback: 0
      };
    }
    try {
      const s = await this._store.stats(this._profileId);
      return Object.assign({ available: true }, s);
    } catch (e) {
      return {
        available: true,
        profileId: this._profileId,
        timingPatterns: 0,
        appTransitionPatterns: 0,
        gotoInternalPatterns: 0,
        reminderPreferences: 0,
        reminderFeedback: 0
      };
    }
  }

  // ====== Schema 兼容性 ======

  /**
   * 检测数据 schemaVersion 是否兼容。
   * 兼容策略：1.x.x 互相兼容；2.x.x 及以上视为不兼容。
   */
  _isCompatible(data) {
    if (!data || !data.schemaVersion) return true; // 缺失视为兼容
    const v = String(data.schemaVersion);
    const m = /^(\d+)\./.exec(v);
    if (!m) return false;
    const major = parseInt(m[1], 10);
    return major === 1;
  }

  /**
   * 返回兼容的数据；不兼容返回 null 并记录到隔离 profile（仅在 init 后可用时）。
   */
  _compat(data) {
    if (data === null || data === undefined) return null;
    if (this._isCompatible(data)) return data;
    return null;
  }
}

module.exports = {
  WherePatternLearning,
  WHERE_PATTERN_SCHEMA_VERSION,
  ReminderAction,
  ReminderPriority,
  createTimingPattern,
  createAppTransitionPattern,
  createGotoInternalPattern,
  createReminderPreference,
  createReminderFeedback
};
