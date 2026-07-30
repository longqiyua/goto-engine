'use strict';

/*!
 * GOTO Engine · Layer 4 — 梳理层 (Personal Rerank) v1.0.0
 * ──────────────────────────────────────────────────────────────
 * Purpose: The fourth and final layer of the search pipeline.
 *          Stateless rerank that fuses Engine results with the
 *          five Base personal-layer schemas to produce the final
 *          ordering shown to the user.
 *
 * Design (per project principles):
 *   - Pure function: no IO, no mutation of inputs, returns new array.
 *   - Reuses Layer-3 rankCandidates from personal-ranker.js as base.
 *   - Adds five independent boosts (each clamped, sum-capped):
 *       1. heatmap        — current hour×weekday density
 *       2. hourly-ranking — smartRanking fused top candidates
 *       3. transition-matrix — foreground→app transition probability
 *       4. user-context   — geofence preference weight
 *       5. feedback-chain — recent click recency/frequency
 *   - Exact-match protection: an exact-match candidate stays at #1
 *     regardless of personal boosts (inherited from rankCandidates).
 *   - Degraded mode: if snapshot is null/degraded, returns the
 *     Engine result unchanged with matchedBy='engine-only'.
 *
 * License: GNU AGPL-3.0
 * ────────────────────────────────────────────────────────────── */

(function (root, factory) {
  var mod = factory(root || {});
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.PersonalRerank = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // Lazy-require personal-ranker so this file works both as CommonJS
  // (Kotlin/Rust port reference) and as a browser global when bundled
  // together with the rest of the engine.
  function loadRanker() {
    try {
      if (typeof require === 'function') {
        return require('../learning/personal-ranker.js');
      }
    } catch (_) {}
    if (root && root.personalRanker) return root.personalRanker;
    if (root && root.PersonalRanker) return root.PersonalRanker;
    return null;
  }

  var DEFAULT_CONFIG = Object.freeze({
    // Per-boost caps (each in [0,1]; sum of caps ≥ 1.0 prevents one source
    // from dominating but the final sum-caps below still clamps the total).
    heatmapBoostMax:      0.15,
    hourlyRankingBoostMax:0.20,
    transitionBoostMax:   0.15,
    geofenceBoostMax:     0.15,
    feedbackBoostMax:     0.20,
    // Total personalBoost cap (sum across all five sources).
    totalPersonalBoostMax:0.50,
    // Decay: how quickly recent feedback loses influence.
    feedbackHalfLifeEvents: 20,
    // Heatmap normalization: divide by this to convert launch count → [0,1]
    heatmapDensityBaseline: 5,
    // Transition threshold: ignore probabilities below this (noise floor).
    transitionNoiseFloor:  0.05
  });

  function buildConfig(override) {
    if (!override || typeof override !== 'object') return Object.assign({}, DEFAULT_CONFIG);
    return Object.freeze(Object.assign({}, DEFAULT_CONFIG, override));
  }

  function clampNum(v, lo, hi) {
    if (typeof v !== 'number' || isNaN(v)) return lo;
    return Math.max(lo, Math.min(hi, v));
  }

  function round4(v) {
    if (typeof v !== 'number' || isNaN(v)) return 0;
    return Math.round(v * 10000) / 10000;
  }

  /**
   * Map Engine result item → { packageName, name, score } for rankCandidates.
   * Engine items use either `id` or `name` as identifier; we normalise to
   * packageName-style keys for downstream merging.
   */
  function toRankerInput(engineResults) {
    if (!Array.isArray(engineResults)) return [];
    return engineResults.map(function (r) {
      if (!r) return null;
      var pkg = r.packageName || r.id || r.name || '';
      return {
        packageName: pkg,
        name: r.name || r.label || pkg,
        score: typeof r.score === 'number' ? r.score : 0
      };
    }).filter(Boolean);
  }

  /**
   * Convert snapshot.affinities (an object map) to a Map for rankCandidates.
   */
  function toAffinityMap(affinities) {
    var m = new Map();
    if (!affinities) return m;
    if (affinities instanceof Map) return affinities;
    Object.keys(affinities).forEach(function (k) {
      var v = affinities[k];
      if (v && typeof v === 'object') m.set(k, v);
    });
    return m;
  }

  // ============================================================
  // Boost 1 — Heatmap (current hour × weekday density)
  // ============================================================
  function heatmapBoost(packageName, snapshot, cfg) {
    if (!snapshot || !snapshot.heatmap || !Array.isArray(snapshot.heatmap.heatmap)) return 0;
    var ctx = snapshot.runtimeContext || {};
    var hour = typeof ctx.hour === 'number' ? ctx.hour : -1;
    var weekday = typeof ctx.weekday === 'number' ? ctx.weekday : -1;
    if (hour < 0 || weekday < 0) return 0;

    var cell = null;
    for (var i = 0; i < snapshot.heatmap.heatmap.length; i++) {
      var c = snapshot.heatmap.heatmap[i];
      if (c && c.hour === hour && c.weekday === weekday) { cell = c; break; }
    }
    if (!cell || !Array.isArray(cell.topApps)) return 0;

    var total = cell.launchCount || 0;
    if (total <= 0) return 0;
    var pkgCount = 0;
    for (var j = 0; j < cell.topApps.length; j++) {
      if (cell.topApps[j] && cell.topApps[j].packageName === packageName) {
        pkgCount = cell.topApps[j].count || 0;
        break;
      }
    }
    if (pkgCount <= 0) return 0;
    var density = pkgCount / Math.max(cfg.heatmapDensityBaseline, total);
    return clampNum(density, 0, 1) * cfg.heatmapBoostMax;
  }

  // ============================================================
  // Boost 2 — Hourly Ranking (smartRanking top candidates)
  // ============================================================
  function hourlyRankingBoost(packageName, snapshot, cfg) {
    if (!snapshot || !snapshot.hourlyRanking) return 0;
    var hr = snapshot.hourlyRanking;
    var ctx = snapshot.runtimeContext || {};
    var hour = typeof ctx.hour === 'number' ? ctx.hour : -1;
    if (hour < 0) return 0;

    // 1) Try the per-hour ranking first (most specific).
    var hourly = hr.hourlyRanking || {};
    var key = String(hour);
    var hourList = hourly[key];
    if (Array.isArray(hourList)) {
      for (var i = 0; i < hourList.length; i++) {
        var e = hourList[i];
        if (e && e.packageName === packageName) {
          var rec = e.recencyScore || 0;
          var cnt = e.count || 0;
          // Combine count (frequency) and recency (recencyScore already in [0,1]).
          var freq = clampNum(cnt / 10, 0, 1);
          return clampNum(freq * 0.5 + rec * 0.5, 0, 1) * cfg.hourlyRankingBoostMax;
        }
      }
    }

    // 2) Fall back to smartRanking topCandidates (fused global ranking).
    var smart = hr.smartRanking;
    if (smart && Array.isArray(smart.topCandidates)) {
      var top = smart.topCandidates;
      for (var k = 0; k < top.length; k++) {
        if (top[k] && top[k].packageName === packageName) {
          // score is unbounded in schema; normalise by position: rank 1 → full,
          // decaying linearly by index.
          var pos = k + 1;
          var posFactor = clampNum(1 - (pos - 1) / Math.max(1, top.length), 0, 1);
          var raw = typeof top[k].score === 'number' ? top[k].score : 0;
          // Normalize raw score assuming typical range [0, 10] (defensive).
          var norm = clampNum(raw / 10, 0, 1);
          return clampNum(posFactor * 0.6 + norm * 0.4, 0, 1) * cfg.hourlyRankingBoostMax;
        }
      }
    }
    return 0;
  }

  // ============================================================
  // Boost 3 — Transition Matrix (foreground → candidate)
  // ============================================================
  function transitionBoost(packageName, snapshot, cfg) {
    if (!snapshot || !snapshot.transitionMatrix) return 0;
    var tm = snapshot.transitionMatrix;
    var ctx = snapshot.runtimeContext || {};
    var from = ctx.foregroundPackage || '';
    if (!from) return 0;

    var transitions = tm.transitions || {};
    var list = transitions[from];
    if (!Array.isArray(list)) return 0;

    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t && t.toPackage === packageName) {
        var p = typeof t.probability === 'number' ? t.probability : 0;
        if (p < cfg.transitionNoiseFloor) return 0;
        // Recency: discount transitions older than 30 days.
        var lastOcc = t.lastOccurred ? Date.parse(t.lastOccurred) : NaN;
        var recFactor = 1;
        if (!isNaN(lastOcc)) {
          var daysSince = (Date.now() - lastOcc) / (24 * 60 * 60 * 1000);
          recFactor = clampNum(Math.pow(0.5, daysSince / 30), 0, 1);
        }
        return clampNum(p * recFactor, 0, 1) * cfg.transitionBoostMax;
      }
    }
    return 0;
  }

  // ============================================================
  // Boost 4 — User Context (geofence preference)
  // ============================================================
  function geofenceBoost(packageName, snapshot, cfg) {
    if (!snapshot || !snapshot.userContext) return 0;
    var uc = snapshot.userContext;
    var ctx = snapshot.runtimeContext || {};
    var geoId = ctx.geofenceId || '';
    if (!geoId) return 0;

    var prefs = uc.preferredApps;
    if (!Array.isArray(prefs)) return 0;
    for (var i = 0; i < prefs.length; i++) {
      var p = prefs[i];
      if (p && p.geofenceId === geoId && p.packageName === packageName) {
        return clampNum(p.weight || 0, 0, 1) * cfg.geofenceBoostMax;
      }
    }
    return 0;
  }

  // ============================================================
  // Boost 5 — Feedback Chain (recent clicks for this query)
  // ============================================================
  function feedbackBoost(packageName, query, snapshot, cfg) {
    if (!snapshot || !Array.isArray(snapshot.recentFeedback) || snapshot.recentFeedback.length === 0) return 0;
    var events = snapshot.recentFeedback;
    var halfLife = cfg.feedbackHalfLifeEvents || 20;

    var boost = 0;
    // events are assumed most-recent-first; iterate in that order so the
    // recency decay applies from the most recent backwards.
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (!e || e.clickedPackage !== packageName) continue;

      // Optional query match refinement: if event.query is non-empty and
      // does not match (case-insensitive) the current query, skip.
      if (query && e.query && String(e.query).toLowerCase() !== String(query).toLowerCase()) {
        continue;
      }

      // Recency decay: rank 0 → factor 1, decays by half every halfLife events.
      var factor = Math.pow(0.5, i / Math.max(1, halfLife));
      // Rank bonus: clicks at rank 0 (top) confirm strong intent; clicks at
      // rank -1 (manual launch) confirm intent even more strongly.
      var rankBonus = 1;
      if (typeof e.clickedRank === 'number') {
        if (e.clickedRank === -1) rankBonus = 1.2;       // manual launch
        else if (e.clickedRank === 0) rankBonus = 1.0;   // already on top
        else if (e.clickedRank > 0) rankBonus = 0.7;     // user had to scan
      }
      boost += factor * rankBonus;
    }
    // Saturating sum: diminishing returns past ~3 matching events.
    return clampNum(boost / 3, 0, 1) * cfg.feedbackBoostMax;
  }

  // ============================================================
  // Main entry
  // ============================================================

  /**
   * Apply Layer-4 rerank to Engine result.
   *
   * @param {string}   query             Normalized query string
   * @param {Array}    engineResults     Engine candidates [{id/name, score, ...}]
   * @param {object}   [snapshot]        Personal snapshot from EngineBaseBridge
   * @param {object}   [config]          Rerank config overrides
   * @returns {object} { list, scores, modeMap, explanation }
   *   - list: reranked array of original Engine items (re-ordered)
   *   - scores: { packageName → finalScore }
   *   - modeMap: { packageName → matchedBy / boost source labels }
   *   - explanation: { packageName → [reason strings] }
   */
  function rerankWithPersonalLayer(query, engineResults, snapshot, config) {
    var cfg = buildConfig(config || {});

    // Degraded: pass-through.
    if (!snapshot || snapshot.degraded || !Array.isArray(engineResults) || engineResults.length === 0) {
      return {
        list: (engineResults || []).slice(),
        scores: {},
        modeMap: {},
        explanation: {},
        degraded: true,
        applied: false
      };
    }

    // Step 1: base ranking via Layer-3 (personal-ranker.js) — uses affinities.
    var rankerInput = toRankerInput(engineResults);
    var affMap = toAffinityMap(snapshot.affinities);
    var ranker = loadRanker();
    var baseRanked;
    if (ranker && typeof ranker.rankCandidates === 'function') {
      try {
        baseRanked = ranker.rankCandidates(query, rankerInput, null, affMap, {});
      } catch (_) {
        baseRanked = null;
      }
    }
    // Fallback: if ranker is unavailable, build a trivial base list.
    if (!Array.isArray(baseRanked)) {
      baseRanked = rankerInput.map(function (r) {
        return {
          packageName: r.packageName,
          name: r.name,
          engineScore: r.score,
          baseScore: 0,
          personalScore: 0,
          finalScore: r.score,
          matchedBy: 'engine-only',
          explanation: ''
        };
      });
    }

    // Step 2: add the five personal-layer boosts.
    var q = String(query || '').toLowerCase();
    var enriched = baseRanked.map(function (c) {
      var pkg = c.packageName;
      var boosts = [];
      var total = 0;

      var b1 = heatmapBoost(pkg, snapshot, cfg);
      if (b1 > 0) { boosts.push('heatmap=' + round4(b1)); total += b1; }

      var b2 = hourlyRankingBoost(pkg, snapshot, cfg);
      if (b2 > 0) { boosts.push('hourly=' + round4(b2)); total += b2; }

      var b3 = transitionBoost(pkg, snapshot, cfg);
      if (b3 > 0) { boosts.push('transition=' + round4(b3)); total += b3; }

      var b4 = geofenceBoost(pkg, snapshot, cfg);
      if (b4 > 0) { boosts.push('geofence=' + round4(b4)); total += b4; }

      var b5 = feedbackBoost(pkg, q, snapshot, cfg);
      if (b5 > 0) { boosts.push('feedback=' + round4(b5)); total += b5; }

      // Cap total personal boost.
      var capped = clampNum(total, 0, cfg.totalPersonalBoostMax);

      return {
        packageName: pkg,
        name: c.name,
        engineScore: round4(c.engineScore || 0),
        baseScore: round4(c.baseScore || 0),
        personalScore: round4((c.personalScore || 0) + capped),
        finalScore: round4((c.finalScore || c.engineScore || 0) + capped),
        matchedBy: c.matchedBy || 'engine-only',
        boostSources: boosts,
        explanation: (c.explanation ? c.explanation + '; ' : '') + boosts.join('; ')
      };
    });

    // Step 3: stable sort by matchedBy priority then finalScore desc.
    // Exact-match stays at top; ties broken by finalScore; original order preserved otherwise.
    enriched.sort(function (a, b) {
      if (a.matchedBy === 'exact-match' && b.matchedBy !== 'exact-match') return -1;
      if (b.matchedBy === 'exact-match' && a.matchedBy !== 'exact-match') return 1;
      return (b.finalScore || 0) - (a.finalScore || 0);
    });

    // Step 4: map back to original Engine items, preserving their metadata.
    var byPkg = {};
    engineResults.forEach(function (r) {
      var pkg = r.packageName || r.id || r.name || '';
      if (pkg && !(pkg in byPkg)) byPkg[pkg] = r;
    });

    var list = [];
    var scores = {};
    var modeMap = {};
    var explanation = {};
    for (var i = 0; i < enriched.length; i++) {
      var e = enriched[i];
      var original = byPkg[e.packageName];
      if (!original) continue;
      list.push(original);
      scores[e.packageName] = e.finalScore;
      modeMap[e.packageName] = e.matchedBy === 'engine-only' && e.boostSources.length > 0
        ? '个人重排'
        : (e.matchedBy || 'engine-only');
      if (e.explanation) explanation[e.packageName] = e.explanation;
    }

    return {
      list: list,
      scores: scores,
      modeMap: modeMap,
      explanation: explanation,
      degraded: false,
      applied: true
    };
  }

  return {
    rerankWithPersonalLayer: rerankWithPersonalLayer,
    buildConfig: buildConfig,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    // Expose individual boosts for unit testing / Kotlin & Rust port reference.
    _boosts: {
      heatmap: heatmapBoost,
      hourlyRanking: hourlyRankingBoost,
      transition: transitionBoost,
      geofence: geofenceBoost,
      feedback: feedbackBoost
    }
  };
});
