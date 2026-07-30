'use strict';

/*!
 * GOTO Engine · Base Bridge v1.0.0
 * ──────────────────────────────────────────────────────────────
 * Purpose: Stateless bridge between GOTO Engine and GOTO Base.
 *          Engine NEVER stores learning state locally; instead it
 *          reads/writes Base personal-layer schemas through this
 *          bridge. Base remains the single source of truth.
 *
 * Design:
 *   - Pure delegation: no Engine-side caching, no mutation of Base.
 *   - Graceful degradation: if BaseReader/BaseWriter/PersonalLearning
 *     are not injected, every method degrades to a no-op/null return.
 *   - Failure isolation: every read/write is wrapped in try/catch.
 *     Read failures return null/empty; write failures are silent.
 *   - Async-by-contract: all reads return Promises (Base may be IDB-backed).
 *
 * Personal-layer schemas consumed (read-only from Engine's perspective):
 *   - feedback-chain.schema.json     → recent click affinity (写入也走这里)
 *   - heatmap.schema.json            → time-of-day × weekday density
 *   - hourly-ranking.schema.json     → smartRanking fused candidates
 *   - transition-matrix.schema.json  → app→app transition probabilities
 *   - user-context.schema.json       → geofence preferences
 *
 * License: GNU AGPL-3.0
 * ────────────────────────────────────────────────────────────── */

(function (root, factory) {
  var mod = factory(root || {});
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.EngineBaseBridge = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = '1.0.0';

  /**
   * Generate a UUID v4 (used for feedback-chain eventId).
   * Mirrors personal-learning.js genId() — kept local to avoid coupling.
   */
  function genId() {
    try {
      if (typeof require === 'function') {
        var c = require('crypto');
        if (c && typeof c.randomUUID === 'function') return c.randomUUID();
      }
    } catch (_) {}
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function nowIso() {
    return new Date().toISOString();
  }

  /**
   * EngineBaseBridge
   *
   * @param {object} opts
   *   - {object} [baseReader]      BaseReader port impl (read APIs)
   *   - {object} [baseWriter]      BaseWriter port impl (write APIs)
   *   - {object} [personalLearning] PersonalLearning facade (affinities/aliases)
   *   - {object} [personalStore]   PersonalStore direct access (for 5 schemas if reader lacks them)
   *   - {function} [now]           Custom clock (testing)
   *   - {function} [idGen]         Custom UUID generator (testing)
   */
  function EngineBaseBridge(opts) {
    opts = opts || {};
    this._reader = opts.baseReader || null;
    this._writer = opts.baseWriter || null;
    this._pl = opts.personalLearning || null;
    this._pstore = opts.personalStore || null;
    this._now = opts.now || nowIso;
    this._idGen = opts.idGen || genId;
    this._lastError = null;
  }

  EngineBaseBridge.prototype.VERSION = VERSION;

  Object.defineProperty(EngineBaseBridge.prototype, 'available', {
    get: function () {
      return !!(this._reader || this._writer || this._pl || this._pstore);
    }
  });

  Object.defineProperty(EngineBaseBridge.prototype, 'degraded', {
    get: function () {
      return !this.available;
    }
  });

  // ============================================================
  // READS — Personal-layer snapshot
  // ============================================================

  /**
   * Collect a complete personal-layer snapshot for rerank.
   * All five schemas + affinities for the candidate packages.
   *
   * @param {string} query             normalized query (may be '')
   * @param {string[]} candidatePackages  packages in Engine result
   * @param {object} [runtimeContext]   { hour, weekday, geofenceId, foregroundPackage }
   * @returns {Promise<object>} snapshot
   */
  EngineBaseBridge.prototype.getPersonalSnapshot = function (query, candidatePackages, runtimeContext) {
    var self = this;
    var ctx = runtimeContext || {};
    var now = this._now();
    var packages = Array.isArray(candidatePackages) ? candidatePackages.slice() : [];

    // Degraded: return empty snapshot, rerank layer will no-op.
    if (!this.available) {
      return Promise.resolve(self._emptySnapshot(now));
    }

    // Parallel reads — each method isolates its own errors.
    var tasks = [
      this._readAffinities(query, packages),
      this._readHeatmap(),
      this._readHourlyRanking(),
      this._readTransitionMatrix(),
      this._readUserContext(),
      this._readRecentFeedback(query, 50)
    ];

    return Promise.all(tasks).then(function (results) {
      var snapshot = {
        version: VERSION,
        takenAt: now,
        query: query || '',
        candidatePackages: packages,
        runtimeContext: {
          hour: typeof ctx.hour === 'number' ? ctx.hour : new Date().getHours(),
          weekday: typeof ctx.weekday === 'number' ? ctx.weekday : new Date().getDay(),
          geofenceId: ctx.geofenceId || '',
          foregroundPackage: ctx.foregroundPackage || ''
        },
        affinities: results[0] || {},      // Map-like { packageName: affinity }
        heatmap: results[1] || null,
        hourlyRanking: results[2] || null,
        transitionMatrix: results[3] || null,
        userContext: results[4] || null,
        recentFeedback: results[5] || []   // most recent first
      };
      return snapshot;
    }).catch(function (e) {
      self._lastError = e && e.message ? e.message : String(e);
      return self._emptySnapshot(now);
    });
  };

  EngineBaseBridge.prototype._emptySnapshot = function (now) {
    return {
      version: VERSION,
      takenAt: now,
      query: '',
      candidatePackages: [],
      runtimeContext: { hour: 0, weekday: 0, geofenceId: '', foregroundPackage: '' },
      affinities: {},
      heatmap: null,
      hourlyRanking: null,
      transitionMatrix: null,
      userContext: null,
      recentFeedback: [],
      degraded: true
    };
  };

  // ---- affinities (via PersonalLearning facade) ----
  EngineBaseBridge.prototype._readAffinities = function (query, packages) {
    var self = this;
    if (!this._pl || !packages.length) return Promise.resolve({});
    try {
      return Promise.resolve(this._pl.getPersonalBoost(query || '', packages)).then(function (boostMap) {
        // boostMap is Map<packageName, number>; expand to a minimal affinity-ish record
        var out = {};
        if (boostMap && typeof boostMap.forEach === 'function') {
          boostMap.forEach(function (v, k) {
            out[k] = { packageName: k, currentWeight: typeof v === 'number' ? v : 0, confidence: 1 };
          });
        }
        return out;
      }).catch(function () { return {}; });
    } catch (_) { return Promise.resolve({}); }
  };

  // ---- heatmap ----
  EngineBaseBridge.prototype._readHeatmap = function () {
    if (this._pstore && typeof this._pstore.getHeatmap === 'function') {
      try { return Promise.resolve(this._pstore.getHeatmap()); } catch (_) {}
    }
    if (this._reader && typeof this._reader.getHeatmap === 'function') {
      try { return Promise.resolve(this._reader.getHeatmap()); } catch (_) {}
    }
    return Promise.resolve(null);
  };

  // ---- hourly-ranking ----
  EngineBaseBridge.prototype._readHourlyRanking = function () {
    if (this._pstore && typeof this._pstore.getHourlyRanking === 'function') {
      try { return Promise.resolve(this._pstore.getHourlyRanking()); } catch (_) {}
    }
    if (this._reader && typeof this._reader.getHourlyRanking === 'function') {
      try { return Promise.resolve(this._reader.getHourlyRanking()); } catch (_) {}
    }
    return Promise.resolve(null);
  };

  // ---- transition-matrix ----
  EngineBaseBridge.prototype._readTransitionMatrix = function () {
    if (this._pstore && typeof this._pstore.getTransitionMatrix === 'function') {
      try { return Promise.resolve(this._pstore.getTransitionMatrix()); } catch (_) {}
    }
    if (this._reader && typeof this._reader.getTransitionMatrix === 'function') {
      try { return Promise.resolve(this._reader.getTransitionMatrix()); } catch (_) {}
    }
    return Promise.resolve(null);
  };

  // ---- user-context ----
  EngineBaseBridge.prototype._readUserContext = function () {
    if (this._pstore && typeof this._pstore.getUserContext === 'function') {
      try { return Promise.resolve(this._pstore.getUserContext()); } catch (_) {}
    }
    if (this._reader && typeof this._reader.getUserContext === 'function') {
      try { return Promise.resolve(this._reader.getUserContext()); } catch (_) {}
    }
    return Promise.resolve(null);
  };

  // ---- recent feedback-chain events ----
  EngineBaseBridge.prototype._readRecentFeedback = function (query, limit) {
    if (this._pstore && typeof this._pstore.getRecentFeedback === 'function') {
      try { return Promise.resolve(this._pstore.getRecentFeedback({ query: query, limit: limit })); } catch (_) {}
    }
    if (this._reader && typeof this._reader.getRecentFeedback === 'function') {
      try { return Promise.resolve(this._reader.getRecentFeedback({ query: query, limit: limit })); } catch (_) {}
    }
    return Promise.resolve([]);
  };

  // ============================================================
  // WRITES — Feedback chain
  // ============================================================

  /**
   * Append a feedback-chain event when the user clicks an app.
   * Mirrors feedback-chain.schema.json structure exactly.
   *
   * @param {object} evt
   *   - {string} query                raw query (may be '')
   *   - {string} normalizedQuery      normalized (lowercase, trimmed)
   *   - {string} clickedPackage       package name (required)
   *   - {string} [clickedAppName]     display name (optional, for offline analysis)
   *   - {number} clickedRank          0-based; -1 if not in candidates (manual)
   *   - {number} candidateCount       total candidates returned
   *   - {string} matchMode            'exact' | 'prefix' | 'fuzzy' | 'rag' | 'synonym'
   *   - {object} [context]            { hour, weekday, geofenceId, foregroundPackage }
   * @returns {Promise<string|null>} eventId or null on failure
   */
  EngineBaseBridge.prototype.recordFeedbackChainEvent = function (evt) {
    var self = this;
    if (!evt || !evt.clickedPackage) return Promise.resolve(null);
    if (!this._writer && !this._pstore) return Promise.resolve(null);

    var record = {
      eventId: evt.eventId || this._idGen(),
      timestamp: evt.timestamp || this._now(),
      query: String(evt.query || ''),
      normalizedQuery: String(evt.normalizedQuery || '').toLowerCase(),
      clickedPackage: String(evt.clickedPackage),
      clickedAppName: evt.clickedAppName || '',
      clickedRank: typeof evt.clickedRank === 'number' ? evt.clickedRank : -1,
      candidateCount: typeof evt.candidateCount === 'number' ? evt.candidateCount : 0,
      matchMode: ['exact','prefix','fuzzy','rag','synonym'].indexOf(evt.matchMode) >= 0
        ? evt.matchMode
        : 'fuzzy',
      context: this._normalizeContext(evt.context)
    };

    // Path A: dedicated writer API
    if (this._writer && typeof this._writer.recordFeedbackChainEvent === 'function') {
      try {
        return Promise.resolve(this._writer.recordFeedbackChainEvent(record)).then(function () {
          return record.eventId;
        }).catch(function (e) {
          self._lastError = e && e.message ? e.message : String(e);
          return null;
        });
      } catch (e) {
        self._lastError = e && e.message ? e.message : String(e);
        return Promise.resolve(null);
      }
    }

    // Path B: personal store direct
    if (this._pstore && typeof this._pstore.appendFeedbackEvent === 'function') {
      try {
        return Promise.resolve(this._pstore.appendFeedbackEvent(record)).then(function () {
          return record.eventId;
        }).catch(function (e) {
          self._lastError = e && e.message ? e.message : String(e);
          return null;
        });
      } catch (e) {
        self._lastError = e && e.message ? e.message : String(e);
        return Promise.resolve(null);
      }
    }

    // Path C: writer adapter-style fallback (recordContextOutcome)
    if (this._writer && typeof this._writer.recordContextOutcome === 'function') {
      try {
        return Promise.resolve(this._writer.recordContextOutcome({
          candidateId: 'feedback:' + record.clickedPackage,
          action: 'opened',
          packageName: record.clickedPackage,
          timestamp: record.timestamp,
          context: record.context,
          metadata: {
            query: record.query,
            normalizedQuery: record.normalizedQuery,
            clickedRank: record.clickedRank,
            candidateCount: record.candidateCount,
            matchMode: record.matchMode
          }
        })).then(function () { return record.eventId; }).catch(function (e) {
          self._lastError = e && e.message ? e.message : String(e);
          return null;
        });
      } catch (e) {
        self._lastError = e && e.message ? e.message : String(e);
        return Promise.resolve(null);
      }
    }

    return Promise.resolve(null);
  };

  EngineBaseBridge.prototype._normalizeContext = function (ctx) {
    ctx = ctx || {};
    var hour = typeof ctx.hour === 'number' ? ctx.hour : new Date().getHours();
    var weekday = typeof ctx.weekday === 'number' ? ctx.weekday : new Date().getDay();
    return {
      hour: hour,
      weekday: weekday,
      geofenceId: ctx.geofenceId || '',
      foregroundPackage: ctx.foregroundPackage || ''
    };
  };

  // ============================================================
  // Diagnostics
  // ============================================================

  EngineBaseBridge.prototype.status = function () {
    return {
      version: VERSION,
      available: this.available,
      degraded: this.degraded,
      hasReader: !!this._reader,
      hasWriter: !!this._writer,
      hasPersonalLearning: !!this._pl,
      hasPersonalStore: !!this._pstore,
      lastError: this._lastError || null
    };
  };

  /**
   * Update bridge components at runtime (e.g., late Base init).
   */
  EngineBaseBridge.prototype.configure = function (opts) {
    opts = opts || {};
    if ('baseReader' in opts) this._reader = opts.baseReader;
    if ('baseWriter' in opts) this._writer = opts.baseWriter;
    if ('personalLearning' in opts) this._pl = opts.personalLearning;
    if ('personalStore' in opts) this._pstore = opts.personalStore;
    if (typeof opts.now === 'function') this._now = opts.now;
    if (typeof opts.idGen === 'function') this._idGen = opts.idGen;
    return this;
  };

  return EngineBaseBridge;
});
