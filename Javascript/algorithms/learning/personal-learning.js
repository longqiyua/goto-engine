'use strict';

/**
 * GOTO Base Personal Learning — PersonalLearning 主门面（Facade）
 *
 * 封装完整的个人学习闭环：记录查询 → 记录选择 → 更新亲和度 → 更新别名 →
 * 排序时应用 personalBoost。
 *
 * 关键设计：
 *   - 所有写入操作 try/catch，失败时只记日志不抛出
 *   - isEnabled()=false 时不记录任何 QueryEvent / SelectionEvent
 *   - recordSelection 异步执行权重更新，不阻塞调用方
 *   - 初始化失败时 available=false，所有方法降级为 no-op
 *   - 调用 runtime/shared/ 的纯算法函数，不重新实现
 *   - 默认 localOnly=true, telemetry=false, cloudSync=false
 */

const {
  buildConfig,
  createQueryEvent,
  createSelectionEvent,
  createPersonalAlias,
  createLocalAppStub,
  AliasStatus,
  AliasSource,
  SelectionSource
} = require('./learning-types.js');
const {
  normalize,
  detectLanguage
} = require('./query-normalizer.js');
const {
  updateAffinity,
  applyCorrection,
  updateAliasStatus,
  computePersonalBoost
} = require('./learning-algorithms.js');
const {
  rankCandidates: rankCandidatesImpl
} = require('./personal-ranker.js');

/**
 * 生成 UUID v4。
 */
function genId() {
  try {
    if (typeof require === 'function') {
      const c = require('crypto');
      if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    }
  } catch (e) {}
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

class PersonalLearning {
  /**
   * @param {object} options
   *   - {object} store LearningStore 实现（必须）
   *   - {object} [config] 学习配置覆盖
   *   - {string} [profileId='default'] Profile ID
   *   - {object} [hostContext] 宿主上下文
   *   - {function} [now] 自定义时间函数（测试用，返回 ISO 字符串）
   *   - {function} [idGen] 自定义 UUID 生成器（测试用）
   */
  constructor({ store, config, profileId, hostContext, now, idGen } = {}) {
    if (!store) {
      throw new Error('PersonalLearning: store is required');
    }
    this._store = store;
    this._config = buildConfig(config || {});
    this._profileId = profileId || 'default';
    this._hostContext = hostContext || null;
    this._now = now || (() => new Date().toISOString());
    this._idGen = idGen || genId;

    // 隐私默认值
    this._localOnly = true;
    this._telemetry = false;
    this._cloudSync = false;

    // 可用性标志
    this._available = false;
    // 学习开关（本地缓存，与 store 同步）
    this._enabled = true;

    // 最近 QueryEvent 缓存（eventId → QueryEvent）
    this._recentQueryEvents = new Map();
    this._maxRecentCache = 1000;

    // 待处理的学习更新 Promise 列表（用于测试等待）
    this._pendingUpdates = [];

    // 自上次 compact 以来累积的事件数
    this._eventsSinceCompact = 0;

    // 会话 ID
    this._sessionId = this._idGen();

    // Phase 3C: 写入串行化器——解决 fire-and-forget 同键竞争
    // 同一 (normalizedQuery, packageName) 的写入串行执行，不同键并行
    try {
      this._writeSerializer = new (require('../../../goto-base/runtimes/javascript/storage/write-serializer.js').WriteSerializer)();
    } catch (_) {
      this._writeSerializer = null;
    }
  }

  /**
   * 构造写入串行化 key。
   * @private
   */
  _serializeKey(normalizedQuery, packageName) {
    if (!normalizedQuery || !packageName) return '';
    return normalizedQuery + '|' + packageName;
  }

  /**
   * 初始化存储。失败时设置 available=false。
   */
  async init() {
    try {
      if (typeof this._store.init === 'function') {
        await this._store.init();
      }
      // 同步学习开关状态
      try {
        this._enabled = await this._store.isLearningEnabled();
      } catch (e) {
        this._enabled = true;
      }
      this._available = true;
    } catch (e) {
      this._available = false;
      this._enabled = false;
    }
  }

  /**
   * 是否可用（初始化成功）。
   */
  get available() {
    return this._available;
  }

  // ====== 学习开关 ======

  /**
   * 返回学习开关状态（同步，读本地缓存）。
   */
  isEnabled() {
    return this._enabled;
  }

  /**
   * 开/关学习（同步设置本地缓存，异步持久化）。
   */
  setEnabled(enabled) {
    this._enabled = !!enabled;
    if (this._available) {
      // fire-and-forget 持久化
      Promise.resolve()
        .then(() => this._store.setLearningEnabled(this._enabled))
        .catch(() => {});
    }
  }

  // ====== 记录查询 ======

  /**
   * 记录一次用户查询。
   * @param {object} params
   *   - {string} rawQuery 用户原始输入
   *   - {string} [sessionId] 会话 ID
   *   - {object} [context] 搜索上下文
   *   - {Array} [engineResults] Engine 候选
   *   - {Array} [baseResults] Base 候选
   * @returns {Promise<object|null>} QueryEvent；学习关闭/不可用/失败时返回 null
   */
  async recordQuery({ rawQuery, sessionId, context, engineResults, baseResults } = {}) {
    if (!this._available || !this._enabled) return null;

    try {
      const normalized = normalize(rawQuery || '');
      if (!normalized) return null;
      const language = detectLanguage(normalized);

      const engineRanking = this._buildRanking(engineResults);
      const baseRanking = this._buildRanking(baseResults);
      const candidatePackageNames = this._collectCandidates(engineResults, baseResults);

      const eventId = this._idGen();
      const queryEvent = createQueryEvent({
        eventId,
        rawQuery: rawQuery || '',
        normalizedQuery: normalized,
        queryLanguage: language,
        timestamp: this._now(),
        sessionId: sessionId || this._sessionId,
        context: context || {},
        candidatePackageNames,
        engineRanking,
        baseRanking
      });

      // 缓存最近的 QueryEvent（供 recordSelection 查询关联查询事件）
      this._cacheQueryEvent(queryEvent);

      // 持久化
      try {
        await this._store.recordQueryEvent(queryEvent);
      } catch (e) { /* 静默 */ }

      // 检查是否需要 compact
      this._eventsSinceCompact++;
      if (this._eventsSinceCompact >= this._config.compactionIntervalEvents) {
        this._eventsSinceCompact = 0;
        Promise.resolve().then(() => this._store.compact()).catch(() => {});
      }

      return queryEvent;
    } catch (e) {
      return null;
    }
  }

  /**
   * 记录一次用户选择。
   *
   * 权重更新异步执行，不阻塞调用方。调用方可通过 _waitForPendingUpdates() 等待。
   *
   * @param {object} params
   *   - {object} queryEvent 关联的 QueryEvent（由 recordQuery 返回）
   *   - {string} selectedPackageName 被选中的应用包名
   *   - {number} selectedRankBeforeLearning 学习前排名（1-based，0=未在候选中）
   *   - {number} selectedRankAfterLearning 学习后排名
   *   - {string} [selectionSource] SelectionSource 枚举值
   * @returns {Promise<object|null>} SelectionEvent；学习关闭/不可用/失败时返回 null
   */
  async recordSelection({ queryEvent, selectedPackageName, selectedRankBeforeLearning,
                          selectedRankAfterLearning, selectionSource } = {}) {
    if (!this._available || !this._enabled) return null;
    if (!queryEvent || !selectedPackageName) return null;

    try {
      const selectionEvent = createSelectionEvent({
        eventId: this._idGen(),
        queryEventId: queryEvent.eventId || '',
        normalizedQuery: queryEvent.normalizedQuery || '',
        selectedPackageName,
        selectedRankBeforeLearning: typeof selectedRankBeforeLearning === 'number'
          ? selectedRankBeforeLearning : 0,
        selectedRankAfterLearning: typeof selectedRankAfterLearning === 'number'
          ? selectedRankAfterLearning : 0,
        timestamp: this._now(),
        sessionId: queryEvent.sessionId || this._sessionId,
        selectionSource: selectionSource || SelectionSource.ENGINE_RESULT,
        context: queryEvent.context || {}
      });

      // 持久化 SelectionEvent
      try {
        await this._store.recordSelectionEvent(selectionEvent);
      } catch (e) { /* 静默 */ }

      // Phase 3C: 同一 (query, package) 的学习更新串行化，避免 read-modify-write 竞争
      const serializeKey = this._serializeKey(
        selectionEvent.normalizedQuery, selectionEvent.selectedPackageName);
      const updateFn = () => this._applyLearningUpdate(selectionEvent).catch(() => {});
      const updatePromise = this._writeSerializer
        ? this._writeSerializer.serialize(serializeKey, updateFn)
        : updateFn();
      this._trackPending(updatePromise);

      return selectionEvent;
    } catch (e) {
      return null;
    }
  }

  /**
   * 应用一次学习更新：
   *   1. 对同查询下的其他应用 affinity 应用 correction（用户改选 = 纠正信号）
   *   2. 对目标应用 affinity 应用 updateAffinity
   *   3. 重新评估 alias[query]：指向 currentWeight 最高的应用
   */
  async _applyLearningUpdate(selectionEvent) {
    try {
      const { normalizedQuery, selectedPackageName, timestamp } = selectionEvent;
      if (!normalizedQuery || !selectedPackageName) return;

      // 1. 获取此查询下的所有 affinity
      let allAffinities = [];
      try {
        allAffinities = await this._store.getAllAffinities(normalizedQuery);
      } catch (e) { allAffinities = []; }

      // 2. 检测连续纠正
      const isConsecutive = allAffinities.some(a =>
        a.packageName !== selectedPackageName &&
        (a.lastConsecutiveCorrectionCount || 0) > 0
      );

      // 3. 对其他应用应用 correction
      for (const aff of allAffinities) {
        if (aff.packageName !== selectedPackageName) {
          try {
            const corrected = applyCorrection(aff, selectionEvent, isConsecutive, this._config);
            await this._store.upsertAffinity(corrected);
          } catch (e) { /* 静默 */ }
        }
      }

      // 4. 对目标应用应用 updateAffinity
      let currentAffinity = null;
      try {
        currentAffinity = await this._store.getAffinity(normalizedQuery, selectedPackageName);
      } catch (e) { currentAffinity = null; }
      const updatedAffinity = updateAffinity(currentAffinity, selectionEvent, this._config);
      try {
        await this._store.upsertAffinity(updatedAffinity);
      } catch (e) { /* 静默 */ }

      // 5. 重新评估 alias
      await this._reevaluateAlias(normalizedQuery, selectionEvent);
    } catch (e) {
      // 静默：学习更新失败不影响调用方
    }
  }

  /**
   * 重新评估 alias[query]：
   *   - 找到该查询下 currentWeight 最高的应用
   *   - 若最高权重 <= 0：将现有 alias 标记为 SUPPRESSED
   *   - 若现有 alias 指向同一应用：更新 confidence / evidenceCount
   *   - 若现有 alias 指向不同应用或无现有 alias：创建新 candidate alias
   */
  async _reevaluateAlias(normalizedQuery, selectionEvent) {
    try {
      const allAffinities = await this._store.getAllAffinities(normalizedQuery);
      if (!allAffinities || allAffinities.length === 0) return;

      // 找最高 currentWeight
      let best = null;
      for (const aff of allAffinities) {
        if (!best || (aff.currentWeight || 0) > (best.currentWeight || 0)) {
          best = aff;
        }
      }

      const now = selectionEvent.timestamp;
      const existing = await this._store.getPersonalAlias(normalizedQuery);

      if (!best || (best.currentWeight || 0) <= 0) {
        // 没有正权重 affinity：抑制现有 alias
        if (existing && existing.status !== AliasStatus.SUPPRESSED &&
            existing.status !== AliasStatus.DELETED) {
          const updated = Object.assign({}, existing, {
            status: AliasStatus.SUPPRESSED,
            updatedAt: now
          });
          await this._store.upsertPersonalAlias(updated);
        }
        return;
      }

      if (existing && existing.packageName === best.packageName) {
        // 同一应用：更新 confidence 与 evidence
        const updated = Object.assign({}, existing, {
          confidence: best.confidence,
          currentWeight: best.currentWeight,
          evidenceCount: (existing.evidenceCount || 0) + 1,
          updatedAt: now,
          lastUsedAt: now
        });
        const final = updateAliasStatus(updated, this._config);
        await this._store.upsertPersonalAlias(final);
        return;
      }

      // 不同应用或无现有 alias：创建/替换为新应用的 candidate alias
      const newAlias = createPersonalAlias({
        alias: normalizedQuery,
        packageName: best.packageName,
        source: AliasSource.USER_CLICK,
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
        lastUsedAt: now
      });
      newAlias.confidence = best.confidence;
      newAlias.currentWeight = best.currentWeight;
      newAlias.evidenceCount = (existing && existing.packageName === best.packageName)
        ? (existing.evidenceCount || 0) + 1
        : 1;
      const final = updateAliasStatus(newAlias, this._config);
      await this._store.upsertPersonalAlias(final);
    } catch (e) {
      // 静默
    }
  }

  // ====== 排序与查询 ======

  /**
   * 获取指定查询下多个应用的 personalBoost 分数。
   * @param {string} query 原始或归一化查询
   * @param {string|Array<string>} packageNames 单个包名或包名数组
   * @returns {Promise<Map<string, number>>} packageName → boostScore
   */
  async getPersonalBoost(query, packageNames) {
    const result = new Map();
    if (!this._available) return result;

    try {
      const normalized = normalize(query || '');
      if (!normalized) return result;

      const packages = Array.isArray(packageNames) ? packageNames : [packageNames];
      if (!packages || packages.length === 0) return result;

      // 获取该查询下的所有 affinity（一次性读取，避免多次查库）
      let allAffinities = [];
      try {
        allAffinities = await this._store.getAllAffinities(normalized);
      } catch (e) { allAffinities = []; }

      const affMap = new Map();
      for (const a of allAffinities) {
        if (a && a.packageName) affMap.set(a.packageName, a);
      }

      for (const pkg of packages) {
        if (!pkg) continue;
        const aff = affMap.get(pkg);
        if (aff) {
          result.set(pkg, computePersonalBoost(aff, this._config));
        } else {
          result.set(pkg, 0);
        }
      }
    } catch (e) {
      // 静默：返回空 Map 或部分结果
    }
    return result;
  }

  /**
   * 获取该查询的 PersonalAlias 列表。
   * @param {string} query 原始或归一化查询
   * @returns {Promise<Array<object>>}
   */
  async getPersonalAliases(query) {
    if (!this._available) return [];
    try {
      const normalized = normalize(query || '');
      if (!normalized) return [];
      const all = await this._store.getAllPersonalAliases();
      return (all || []).filter(a => a && a.alias === normalized);
    } catch (e) {
      return [];
    }
  }

  /**
   * 对候选项应用个性化加权并产出最终排序。
   * @param {string} query 原始或归一化查询
   * @param {Array} engineResults Engine 候选
   * @param {Array} [baseResults] Base 候选
   * @returns {Promise<Array>} 排序后的候选列表
   */
  async rankCandidates(query, engineResults, baseResults) {
    if (!this._available) {
      // 降级：返回 engine 结果，不加 personalBoost
      return (engineResults || []).map(r => ({
        packageName: r.packageName,
        name: r.name,
        engineScore: typeof r.score === 'number' ? r.score : 0,
        baseScore: 0,
        personalScore: 0,
        finalScore: typeof r.score === 'number' ? r.score : 0,
        matchedBy: 'engine-only',
        explanation: 'degraded (unavailable)'
      }));
    }

    try {
      const normalized = normalize(query || '');
      let affinities = [];
      try {
        affinities = await this._store.getAllAffinities(normalized);
      } catch (e) { affinities = []; }

      const affMap = new Map();
      for (const a of (affinities || [])) {
        if (a && a.packageName) affMap.set(a.packageName, a);
      }
      return rankCandidatesImpl(normalized, engineResults, baseResults, affMap, this._config);
    } catch (e) {
      // 降级
      return (engineResults || []).map(r => ({
        packageName: r.packageName,
        name: r.name,
        engineScore: typeof r.score === 'number' ? r.score : 0,
        baseScore: 0,
        personalScore: 0,
        finalScore: typeof r.score === 'number' ? r.score : 0,
        matchedBy: 'engine-only',
        explanation: 'degraded (store error)'
      }));
    }
  }

  // ====== 导出 / 导入 / 重置 ======

  /**
   * 导出当前 profile 的所有数据。
   * @returns {Promise<object>}
   */
  async exportProfile() {
    if (!this._available) {
      return {
        profileId: this._profileId,
        exportedAt: this._now(),
        config: this._config,
        queryEvents: [],
        selectionEvents: [],
        affinities: [],
        aliases: [],
        stubs: []
      };
    }
    try {
      return await this._store.exportProfile(this._profileId);
    } catch (e) {
      return {
        profileId: this._profileId,
        exportedAt: this._now(),
        config: this._config,
        queryEvents: [],
        selectionEvents: [],
        affinities: [],
        aliases: [],
        stubs: []
      };
    }
  }

  /**
   * 导入数据。
   * @param {object} data PortableProfile 数据
   * @returns {Promise<void>}
   */
  async importProfile(data) {
    if (!this._available || !data) return;
    try {
      await this._store.importProfile(data, this._profileId);
    } catch (e) { /* 静默 */ }
  }

  /**
   * 清空当前 profile。
   * @returns {Promise<void>}
   */
  async resetProfile() {
    if (!this._available) return;
    try {
      await this._store.resetProfile(this._profileId);
    } catch (e) { /* 静默 */ }
    this._recentQueryEvents.clear();
    this._eventsSinceCompact = 0;
  }

  // ====== 压缩 ======

  /**
   * 手动触发压缩。
   * @returns {Promise<{compactedEvents: number, remainingEvents: number}>}
   */
  async compact() {
    if (!this._available) {
      return { compactedEvents: 0, remainingEvents: 0 };
    }
    try {
      return await this._store.compact();
    } catch (e) {
      return { compactedEvents: 0, remainingEvents: 0 };
    }
  }

  // ====== 统计 ======

  /**
   * 返回统计信息。
   * @returns {Promise<object>}
   */
  async getStats() {
    if (!this._available) {
      return {
        available: false,
        enabled: this._enabled,
        queryEvents: 0,
        selectionEvents: 0,
        affinities: 0,
        aliases: 0,
        stubs: 0,
        storageBytes: 0
      };
    }
    try {
      const s = await this._store.stats();
      return Object.assign({
        available: true,
        enabled: this._enabled,
        profileId: this._profileId
      }, s);
    } catch (e) {
      return {
        available: true,
        enabled: this._enabled,
        queryEvents: 0,
        selectionEvents: 0,
        affinities: 0,
        aliases: 0,
        stubs: 0,
        storageBytes: 0
      };
    }
  }

  // ====== LocalAppStub ======

  /**
   * 记录未知应用（本地应用存根）。
   * @param {object} params
   *   - {string} packageName
   *   - {string} appName
   *   - {string} [version]
   *   - {string} [iconRef]
   *   - {string} [discoveredVia]
   * @returns {Promise<object|null>}
   */
  async recordLocalAppStub({ packageName, appName, version, iconRef, discoveredVia } = {}) {
    if (!packageName || !appName) return null;
    try {
      const now = this._now();
      const stub = createLocalAppStub({
        packageName,
        appName,
        version: version !== undefined ? version : null,
        iconRef: iconRef !== undefined ? iconRef : null,
        installedAt: now,
        updatedAt: now,
        discoveredVia: discoveredVia || 'manual'
      });
      if (this._available) {
        try {
          await this._store.upsertLocalAppStub(stub);
        } catch (e) { /* 静默 */ }
      }
      return stub;
    } catch (e) {
      return null;
    }
  }

  /**
   * 返回本地应用存根列表。
   * @returns {Promise<Array<object>>}
   */
  async getLocalAppStubs() {
    if (!this._available) return [];
    try {
      // 优先使用 store 的 getAllLocalAppStubs 扩展方法
      if (typeof this._store.getAllLocalAppStubs === 'function') {
        return await this._store.getAllLocalAppStubs();
      }
      // 降级：通过 exportProfile 提取
      const exported = await this._store.exportProfile(this._profileId);
      return (exported && exported.stubs) || [];
    } catch (e) {
      return [];
    }
  }

  // ====== 测试辅助 ======

  /**
   * 等待所有待处理的学习更新完成（测试用）。
   */
  async _waitForPendingUpdates() {
    while (this._pendingUpdates.length > 0) {
      await Promise.all(this._pendingUpdates.slice());
    }
  }

  // ====== 内部辅助 ======

  _buildRanking(results) {
    if (!Array.isArray(results)) return [];
    return results.map((r, i) => {
      if (!r || !r.packageName) return null;
      return {
        packageName: r.packageName,
        score: typeof r.score === 'number' ? r.score : 0,
        rank: typeof r.rank === 'number' ? r.rank : (i + 1)
      };
    }).filter(Boolean);
  }

  _collectCandidates(engineResults, baseResults) {
    const set = new Set();
    if (Array.isArray(engineResults)) {
      for (const r of engineResults) {
        if (r && r.packageName) set.add(r.packageName);
      }
    }
    if (Array.isArray(baseResults)) {
      for (const r of baseResults) {
        if (r && r.packageName) set.add(r.packageName);
      }
    }
    return Array.from(set);
  }

  _cacheQueryEvent(event) {
    this._recentQueryEvents.set(event.eventId, event);
    if (this._recentQueryEvents.size > this._maxRecentCache) {
      const firstKey = this._recentQueryEvents.keys().next().value;
      this._recentQueryEvents.delete(firstKey);
    }
  }

  _trackPending(promise) {
    this._pendingUpdates.push(promise);
    const remove = () => {
      const i = this._pendingUpdates.indexOf(promise);
      if (i >= 0) this._pendingUpdates.splice(i, 1);
    };
    if (typeof promise.finally === 'function') {
      promise.finally(remove);
    } else {
      promise.then(remove, remove);
    }
  }
}

module.exports = { PersonalLearning, genId };
