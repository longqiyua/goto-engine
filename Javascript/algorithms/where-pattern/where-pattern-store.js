'use strict';

/**
 * GOTO Base Where Pattern — 存储接口（抽象定义）+ InMemory 实现
 *
 * 此模块定义 Where Phase 2 Pattern 存储的接口契约。
 * PersonalLearning 不依赖此模块；此模块仅服务于 Where 的 Pattern 持久化。
 *
 * 设计原则：
 *   1. 所有方法原子、幂等（重放安全）
 *   2. 异步方法返回 Promise
 *   3. profileId 用于多用户/多配置文件隔离
 *   4. schemaVersion 不兼容时由调用方决定迁移或隔离
 *
 * 与 LearningStore 的关系：
 *   - WherePatternStore 是 Personal Layer 的一个独立子模块
 *   - 实现可以共享同一个 IndexedDB（不同 Object Store）或独立存储
 *   - 删除 profile 时应同时清空 Pattern 数据
 */

const {
  WHERE_PATTERN_SCHEMA_VERSION,
  createTimingPattern,
  createAppTransitionPattern,
  createGotoInternalPattern,
  createReminderPreference,
  createReminderFeedback
} = require('./where-pattern-types.js');

/**
 * WherePatternStore 抽象接口。
 */
class WherePatternStore {
  async init() { throw new Error('NOT_IMPLEMENTED: init()'); }
  async close() { throw new Error('NOT_IMPLEMENTED: close()'); }

  // ====== TimingPattern ======
  async getTimingPattern(packageName) { throw new Error('NOT_IMPLEMENTED'); }
  async getAllTimingPatterns() { throw new Error('NOT_IMPLEMENTED'); }
  async upsertTimingPattern(pattern) { throw new Error('NOT_IMPLEMENTED'); }
  async deleteTimingPattern(packageName) { throw new Error('NOT_IMPLEMENTED'); }

  // ====== AppTransitionPattern ======
  async getAppTransitionPattern(fromPackageName) { throw new Error('NOT_IMPLEMENTED'); }
  async getAllAppTransitionPatterns() { throw new Error('NOT_IMPLEMENTED'); }
  async upsertAppTransitionPattern(pattern) { throw new Error('NOT_IMPLEMENTED'); }
  async deleteAppTransitionPattern(fromPackageName, toPackageName) { throw new Error('NOT_IMPLEMENTED'); }

  // ====== GotoInternalPattern ======
  async getGotoInternalPatternsByQuery(normalizedQuery) { throw new Error('NOT_IMPLEMENTED'); }
  async getAllGotoInternalPatterns() { throw new Error('NOT_IMPLEMENTED'); }
  async upsertGotoInternalPattern(pattern) { throw new Error('NOT_IMPLEMENTED'); }
  async deleteGotoInternalPattern(patternId) { throw new Error('NOT_IMPLEMENTED'); }

  // ====== ReminderPreference ======
  async getReminderPreference(ruleId) { throw new Error('NOT_IMPLEMENTED'); }
  async getAllReminderPreferences() { throw new Error('NOT_IMPLEMENTED'); }
  async upsertReminderPreference(pref) { throw new Error('NOT_IMPLEMENTED'); }
  async deleteReminderPreference(ruleId) { throw new Error('NOT_IMPLEMENTED'); }

  // ====== ReminderFeedback ======
  async recordReminderFeedback(feedback) { throw new Error('NOT_IMPLEMENTED'); }
  async getRecentReminderFeedback(filter) { throw new Error('NOT_IMPLEMENTED'); }
  async getAllReminderFeedback() { throw new Error('NOT_IMPLEMENTED'); }

  // ====== Profile 管理 ======
  async exportPatternProfile(profileId) { throw new Error('NOT_IMPLEMENTED'); }
  async importPatternProfile(data, profileId) { throw new Error('NOT_IMPLEMENTED'); }
  async resetPatternProfile(profileId) { throw new Error('NOT_IMPLEMENTED'); }

  // ====== 统计 ======
  async stats() { throw new Error('NOT_IMPLEMENTED'); }
}

/**
 * InMemoryWherePatternStore — 内存实现，用于测试与开发期参考。
 *
 * 提供：
 *   - profileId 隔离（数据存于 _profiles[profileId]）
 *   - 原子读写（单线程 JS 模型下天然原子）
 *   - 数据上限保护（maxPatternsKept / maxFeedbackKept）
 *   - schemaVersion 兼容检测（migrate / isolate）
 */
class InMemoryWherePatternStore extends WherePatternStore {
  constructor(config) {
    super();
    this._config = config || {};
    this._maxPatternsKept = (typeof this._config.maxPatternsKept === 'number' && this._config.maxPatternsKept > 0)
      ? this._config.maxPatternsKept : 1000;
    this._maxFeedbackKept = (typeof this._config.maxFeedbackKept === 'number' && this._config.maxFeedbackKept > 0)
      ? this._config.maxFeedbackKept : 5000;
    this._supportedSchemaVersion = WHERE_PATTERN_SCHEMA_VERSION;
    // profileId -> { timing, transition, gotoInternal, preferences, feedback }
    this._profiles = new Map();
    this._defaultProfileId = 'default';
    this._initialized = false;
  }

  async init() {
    if (!this._profiles.has(this._defaultProfileId)) {
      this._profiles.set(this._defaultProfileId, this._newProfile());
    }
    this._initialized = true;
  }

  async close() {
    this._initialized = false;
  }

  _newProfile() {
    return {
      timing: new Map(),           // packageName -> TimingPattern
      transition: new Map(),       // fromPackageName -> Array<AppTransitionPattern>
      gotoInternal: new Map(),     // normalizedQuery -> Array<GotoInternalPattern>
      preferences: new Map(),      // ruleId -> ReminderPreference
      feedback: []                 // Array<ReminderFeedback>
    };
  }

  _getProfile(profileId) {
    const pid = profileId || this._defaultProfileId;
    let p = this._profiles.get(pid);
    if (!p) {
      p = this._newProfile();
      this._profiles.set(pid, p);
    }
    return p;
  }

  // ====== TimingPattern ======

  async getTimingPattern(packageName, profileId) {
    const p = this._getProfile(profileId);
    const v = p.timing.get(packageName);
    return v ? deepClone(v) : null;
  }

  async getAllTimingPatterns(profileId) {
    const p = this._getProfile(profileId);
    return Array.from(p.timing.values()).map(deepClone);
  }

  async upsertTimingPattern(pattern, profileId) {
    if (!pattern || !pattern.packageName) throw new Error('upsertTimingPattern: invalid pattern');
    const p = this._getProfile(profileId);
    p.timing.set(pattern.packageName, deepClone(pattern));
    await this._maybeEvictPatterns(p);
  }

  async deleteTimingPattern(packageName, profileId) {
    const p = this._getProfile(profileId);
    return p.timing.delete(packageName);
  }

  // ====== AppTransitionPattern ======

  async getAppTransitionPattern(fromPackageName, profileId) {
    const p = this._getProfile(profileId);
    const arr = p.transition.get(fromPackageName) || [];
    return arr.map(deepClone);
  }

  async getAllAppTransitionPatterns(profileId) {
    const p = this._getProfile(profileId);
    const result = [];
    for (const arr of p.transition.values()) {
      for (const t of arr) result.push(deepClone(t));
    }
    return result;
  }

  async upsertAppTransitionPattern(pattern, profileId) {
    if (!pattern || !pattern.fromPackageName || !pattern.toPackageName) {
      throw new Error('upsertAppTransitionPattern: invalid pattern');
    }
    const p = this._getProfile(profileId);
    const key = pattern.fromPackageName;
    let arr = p.transition.get(key);
    if (!arr) {
      arr = [];
      p.transition.set(key, arr);
    }
    // 替换同 toPackageName 的项
    const idx = arr.findIndex(x => x.toPackageName === pattern.toPackageName);
    if (idx >= 0) arr[idx] = deepClone(pattern);
    else arr.push(deepClone(pattern));
    await this._maybeEvictPatterns(p);
  }

  async deleteAppTransitionPattern(fromPackageName, toPackageName, profileId) {
    const p = this._getProfile(profileId);
    const arr = p.transition.get(fromPackageName);
    if (!arr) return false;
    const idx = arr.findIndex(x => x.toPackageName === toPackageName);
    if (idx < 0) return false;
    arr.splice(idx, 1);
    if (arr.length === 0) p.transition.delete(fromPackageName);
    return true;
  }

  // ====== GotoInternalPattern ======

  async getGotoInternalPatternsByQuery(normalizedQuery, profileId) {
    const p = this._getProfile(profileId);
    const arr = p.gotoInternal.get(normalizedQuery) || [];
    return arr.map(deepClone);
  }

  async getAllGotoInternalPatterns(profileId) {
    const p = this._getProfile(profileId);
    const result = [];
    for (const arr of p.gotoInternal.values()) {
      for (const g of arr) result.push(deepClone(g));
    }
    return result;
  }

  async upsertGotoInternalPattern(pattern, profileId) {
    if (!pattern || !pattern.normalizedQuery || !pattern.targetPackageName) {
      throw new Error('upsertGotoInternalPattern: invalid pattern');
    }
    const p = this._getProfile(profileId);
    const key = pattern.normalizedQuery;
    let arr = p.gotoInternal.get(key);
    if (!arr) {
      arr = [];
      p.gotoInternal.set(key, arr);
    }
    const idx = arr.findIndex(x => x.targetPackageName === pattern.targetPackageName);
    if (idx >= 0) arr[idx] = deepClone(pattern);
    else arr.push(deepClone(pattern));
    await this._maybeEvictPatterns(p);
  }

  async deleteGotoInternalPattern(patternId, profileId) {
    const p = this._getProfile(profileId);
    let removed = false;
    for (const arr of p.gotoInternal.values()) {
      const idx = arr.findIndex(x => x.patternId === patternId);
      if (idx >= 0) {
        arr.splice(idx, 1);
        removed = true;
        break;
      }
    }
    // 清理空数组
    for (const [k, arr] of p.gotoInternal.entries()) {
      if (arr.length === 0) p.gotoInternal.delete(k);
    }
    return removed;
  }

  // ====== ReminderPreference ======

  async getReminderPreference(ruleId, profileId) {
    const p = this._getProfile(profileId);
    const v = p.preferences.get(ruleId);
    return v ? deepClone(v) : null;
  }

  async getAllReminderPreferences(profileId) {
    const p = this._getProfile(profileId);
    return Array.from(p.preferences.values()).map(deepClone);
  }

  async upsertReminderPreference(pref, profileId) {
    if (!pref || !pref.ruleId) throw new Error('upsertReminderPreference: invalid preference');
    const p = this._getProfile(profileId);
    p.preferences.set(pref.ruleId, deepClone(pref));
  }

  async deleteReminderPreference(ruleId, profileId) {
    const p = this._getProfile(profileId);
    return p.preferences.delete(ruleId);
  }

  // ====== ReminderFeedback ======

  async recordReminderFeedback(feedback, profileId) {
    if (!feedback || !feedback.feedbackId) throw new Error('recordReminderFeedback: invalid feedback');
    const p = this._getProfile(profileId);
    p.feedback.push(deepClone(feedback));
    // 上限保护
    if (p.feedback.length > this._maxFeedbackKept) {
      // 保留最新的 maxFeedbackKept 条（按 timestamp 排序）
      p.feedback.sort((a, b) => {
        const ta = Date.parse(a.timestamp || '');
        const tb = Date.parse(b.timestamp || '');
        return ta - tb;
      });
      p.feedback = p.feedback.slice(p.feedback.length - this._maxFeedbackKept);
    }
  }

  async getRecentReminderFeedback(filter, profileId) {
    const p = this._getProfile(profileId);
    let list = p.feedback.slice();
    if (filter) {
      if (filter.ruleId) list = list.filter(f => f.ruleId === filter.ruleId);
      if (filter.candidateId) list = list.filter(f => f.candidateId === filter.candidateId);
      if (filter.action) list = list.filter(f => f.action === filter.action);
      if (filter.since) {
        const sinceMs = Date.parse(filter.since);
        if (!isNaN(sinceMs)) {
          list = list.filter(f => {
            const t = Date.parse(f.timestamp || '');
            return !isNaN(t) && t >= sinceMs;
          });
        }
      }
      if (typeof filter.limit === 'number' && filter.limit > 0) {
        list.sort((a, b) => {
          const ta = Date.parse(a.timestamp || '');
          const tb = Date.parse(b.timestamp || '');
          return tb - ta; // 降序，最新优先
        });
        list = list.slice(0, filter.limit);
      }
    }
    return list.map(deepClone);
  }

  async getAllReminderFeedback(profileId) {
    const p = this._getProfile(profileId);
    return p.feedback.slice().map(deepClone);
  }

  // ====== Profile 管理 ======

  async exportPatternProfile(profileId) {
    const pid = profileId || this._defaultProfileId;
    const p = this._profiles.get(pid);
    if (!p) {
      return {
        profileId: pid,
        exportedAt: new Date().toISOString(),
        timingPatterns: [],
        appTransitionPatterns: [],
        gotoInternalPatterns: [],
        reminderPreferences: [],
        reminderFeedback: [],
        schemaVersion: WHERE_PATTERN_SCHEMA_VERSION
      };
    }
    return {
      profileId: pid,
      exportedAt: new Date().toISOString(),
      timingPatterns: Array.from(p.timing.values()).map(deepClone),
      appTransitionPatterns: Array.from(p.transition.values()).flatMap(arr => arr.map(deepClone)),
      gotoInternalPatterns: Array.from(p.gotoInternal.values()).flatMap(arr => arr.map(deepClone)),
      reminderPreferences: Array.from(p.preferences.values()).map(deepClone),
      reminderFeedback: p.feedback.slice().map(deepClone),
      schemaVersion: WHERE_PATTERN_SCHEMA_VERSION
    };
  }

  async importPatternProfile(data, profileId) {
    if (!data) throw new Error('importPatternProfile: data is null');
    const pid = profileId || data.profileId || this._defaultProfileId;
    const p = this._newProfile();
    this._profiles.set(pid, p);

    if (Array.isArray(data.timingPatterns)) {
      for (const t of data.timingPatterns) {
        if (t && t.packageName) p.timing.set(t.packageName, deepClone(t));
      }
    }
    if (Array.isArray(data.appTransitionPatterns)) {
      for (const t of data.appTransitionPatterns) {
        if (!t || !t.fromPackageName || !t.toPackageName) continue;
        let arr = p.transition.get(t.fromPackageName);
        if (!arr) {
          arr = [];
          p.transition.set(t.fromPackageName, arr);
        }
        arr.push(deepClone(t));
      }
    }
    if (Array.isArray(data.gotoInternalPatterns)) {
      for (const g of data.gotoInternalPatterns) {
        if (!g || !g.normalizedQuery || !g.targetPackageName) continue;
        let arr = p.gotoInternal.get(g.normalizedQuery);
        if (!arr) {
          arr = [];
          p.gotoInternal.set(g.normalizedQuery, arr);
        }
        arr.push(deepClone(g));
      }
    }
    if (Array.isArray(data.reminderPreferences)) {
      for (const pref of data.reminderPreferences) {
        if (pref && pref.ruleId) p.preferences.set(pref.ruleId, deepClone(pref));
      }
    }
    if (Array.isArray(data.reminderFeedback)) {
      p.feedback = data.reminderFeedback.filter(f => f && f.feedbackId).map(deepClone);
    }
  }

  async resetPatternProfile(profileId) {
    const pid = profileId || this._defaultProfileId;
    this._profiles.set(pid, this._newProfile());
  }

  // ====== 统计 ======

  async stats(profileId) {
    if (profileId) {
      const p = this._profiles.get(profileId);
      if (!p) {
        return { profileId, timingPatterns: 0, appTransitionPatterns: 0, gotoInternalPatterns: 0, reminderPreferences: 0, reminderFeedback: 0 };
      }
      return {
        profileId,
        timingPatterns: p.timing.size,
        appTransitionPatterns: Array.from(p.transition.values()).reduce((s, a) => s + a.length, 0),
        gotoInternalPatterns: Array.from(p.gotoInternal.values()).reduce((s, a) => s + a.length, 0),
        reminderPreferences: p.preferences.size,
        reminderFeedback: p.feedback.length
      };
    }
    // 全部 profile 汇总
    let timingPatterns = 0, appTransitionPatterns = 0, gotoInternalPatterns = 0,
        reminderPreferences = 0, reminderFeedback = 0;
    for (const p of this._profiles.values()) {
      timingPatterns += p.timing.size;
      appTransitionPatterns += Array.from(p.transition.values()).reduce((s, a) => s + a.length, 0);
      gotoInternalPatterns += Array.from(p.gotoInternal.values()).reduce((s, a) => s + a.length, 0);
      reminderPreferences += p.preferences.size;
      reminderFeedback += p.feedback.length;
    }
    return {
      profileCount: this._profiles.size,
      timingPatterns,
      appTransitionPatterns,
      gotoInternalPatterns,
      reminderPreferences,
      reminderFeedback,
      schemaVersion: WHERE_PATTERN_SCHEMA_VERSION,
      initialized: this._initialized
    };
  }

  // ====== 内部辅助 ======

  async _maybeEvictPatterns(p) {
    const total = p.timing.size
      + Array.from(p.transition.values()).reduce((s, a) => s + a.length, 0)
      + Array.from(p.gotoInternal.values()).reduce((s, a) => s + a.length, 0);
    if (total <= this._maxPatternsKept) return;
    // LRU 策略：按 lastSeenAt 升序删除最旧
    const all = [];
    for (const t of p.timing.values()) all.push({ kind: 'timing', obj: t, ts: t.lastSeenAt || t.firstSeenAt || '' });
    for (const arr of p.transition.values()) {
      for (const t of arr) all.push({ kind: 'transition', obj: t, ts: t.lastSeenAt || t.firstSeenAt || '' });
    }
    for (const arr of p.gotoInternal.values()) {
      for (const t of arr) all.push({ kind: 'gotoInternal', obj: t, ts: t.lastSeenAt || t.firstSeenAt || '' });
    }
    all.sort((a, b) => Date.parse(a.ts || '') - Date.parse(b.ts || ''));
    const toRemove = all.slice(0, all.length - this._maxPatternsKept);
    for (const item of toRemove) {
      if (item.kind === 'timing') {
        p.timing.delete(item.obj.packageName);
      } else if (item.kind === 'transition') {
        const arr = p.transition.get(item.obj.fromPackageName);
        if (arr) {
          const idx = arr.findIndex(x => x.toPackageName === item.obj.toPackageName);
          if (idx >= 0) arr.splice(idx, 1);
          if (arr.length === 0) p.transition.delete(item.obj.fromPackageName);
        }
      } else if (item.kind === 'gotoInternal') {
        const arr = p.gotoInternal.get(item.obj.normalizedQuery);
        if (arr) {
          const idx = arr.findIndex(x => x.targetPackageName === item.obj.targetPackageName);
          if (idx >= 0) arr.splice(idx, 1);
          if (arr.length === 0) p.gotoInternal.delete(item.obj.normalizedQuery);
        }
      }
    }
  }
}

function deepClone(obj) {
  if (obj === null || obj === undefined) return obj;
  return JSON.parse(JSON.stringify(obj));
}

module.exports = {
  WherePatternStore,
  InMemoryWherePatternStore,
  WHERE_PATTERN_SCHEMA_VERSION
};
