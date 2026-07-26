/* GOTO Engine Feedback Channel v1.0.0
 * ──────────────────────────────────────────────────────────────
 * Purpose: A unified channel for plugins, the host shell, and
 *          end users to report issues, suggestions, selection
 *          corrections, and quality signals back to the engine
 *          and other registered plugins.
 *
 * Usage:
 *   // From a plugin (after GOTOPlugin is loaded):
 *   GOTOFeedback.send({
 *     type: 'correction',
 *     scope: 'search',
 *     query: 'wx',
 *     expected: '微信',
 *     actual: '微博',
 *     note: 'user tapped WeChat but WeiBo was ranked first'
 *   });
 *
 *   // Subscribe (plugins register onFeedback in manifest hooks):
 *   GOTOPlugin.register(manifest, {
 *     onFeedback: function(evt) { console.log(evt); }
 *   });
 *
 * Storage:
 *   - Local feedback buffer: ring buffer of last 200 events (localStorage key: goto_feedback_log)
 *   - Optional remote sink: GOTOFeedback.configure({ endpoint: 'https://...' })
 *   - Remote delivery is OFF by default; only enabled when endpoint is set
 *
 * License: GNU AGPL-3.0
 * ────────────────────────────────────────────────────────────── */
(function(root, factory) {
  var channel = factory(root || {});
  if (typeof module === 'object' && module.exports) module.exports = channel;
  if (root) root.GOTOFeedback = channel;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';

  var VERSION = '1.0.0';
  var BUFFER_KEY = 'goto_feedback_log';
  var BUFFER_MAX = 200;
  var BUFFER_DIRTY = false;       // marks unsaved changes
  var BUFFER_SAVE_THRESHOLD = 5;  // batch writes: only persist every Nth send
  var BUFFER_SAVE_TIMER_MS = 2000; // or after 2s of inactivity
  var bufferSaveTimer = null;
  var inMemoryBuffer = null;       // lazy-loaded cache of the local buffer
  var config = {
    endpoint: null,           // remote sink URL; null = local only
    flushIntervalMs: 0,       // 0 = no auto flush
    includeUserAgent: false,  // privacy: off by default
    anonymizeQuery: false     // hash query strings before logging
  };
  var pending = [];
  var flushTimer = null;

  /* ── Persistence (batched) ─────────────────────────────────── */
  // Instead of writing to localStorage on every send(), we keep an
  // in-memory copy and persist at most every BUFFER_SAVE_THRESHOLD
  // events or BUFFER_SAVE_TIMER_MS of inactivity. This removes the
  // synchronous localStorage write from the hot path.

  function loadBuffer() {
    if (inMemoryBuffer) return inMemoryBuffer;
    try {
      var raw = root.localStorage && root.localStorage.getItem(BUFFER_KEY);
      inMemoryBuffer = raw ? JSON.parse(raw) : [];
    } catch (_) { inMemoryBuffer = []; }
    return inMemoryBuffer;
  }

  function scheduleBufferSave() {
    if (bufferSaveTimer) return;
    bufferSaveTimer = setTimeout(function() {
      bufferSaveTimer = null;
      persistBuffer();
    }, BUFFER_SAVE_TIMER_MS);
  }

  function persistBuffer() {
    if (!inMemoryBuffer || !BUFFER_DIRTY) return;
    try {
      root.localStorage && root.localStorage.setItem(BUFFER_KEY, JSON.stringify(inMemoryBuffer));
      BUFFER_DIRTY = false;
    } catch (_) {}
  }

  /* ── Query anonymization ───────────────────────────────────── */
  function hash(str) {
    var h = 5381, i = str.length;
    while (i) h = (h * 33) ^ str.charCodeAt(--i);
    return 'q_' + (h >>> 0).toString(36);
  }

  function anonymize(evt) {
    if (!config.anonymizeQuery || !evt.query) return evt;
    var copy = Object.assign({}, evt);
    copy.query = hash(String(copy.query));
    if (copy.expected) copy.expected = hash(String(copy.expected));
    if (copy.actual) copy.actual = hash(String(copy.actual));
    return copy;
  }

  /* ── Public API ────────────────────────────────────────────── */

  function configure(opts) {
    if (!opts || typeof opts !== 'object') return config;
    Object.keys(opts).forEach(function(k) {
      if (k in config) config[k] = opts[k];
    });
    // Restart auto-flush if interval changed
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
    if (config.flushIntervalMs > 0 && config.endpoint) {
      flushTimer = setInterval(flush, config.flushIntervalMs);
    }
    return config;
  }

  function send(event) {
    if (!event || typeof event !== 'object') return false;
    var normalized = {
      id: 'fb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      ts: Date.now(),
      type: String(event.type || 'generic'),       // correction | suggestion | bug | quality | generic
      scope: String(event.scope || 'search'),       // search | render | context | plugin | engine
      plugin: event.plugin || null,                 // source plugin id (optional)
      query: event.query || null,
      expected: event.expected || null,
      actual: event.actual || null,
      note: String(event.note || '').slice(0, 500),
      severity: ['info', 'warn', 'error'].indexOf(event.severity) >= 0 ? event.severity : 'info',
      meta: event.meta || {}
    };
    if (config.includeUserAgent && root.navigator) {
      normalized.ua = root.navigator.userAgent;
    }
    normalized = anonymize(normalized);

    // 1. Push to in-memory ring buffer (no sync localStorage write here)
    var buf = loadBuffer();
    buf.push(normalized);
    if (buf.length > BUFFER_MAX) {
      // In-place trim to avoid allocating a new array on every overflow
      buf.splice(0, buf.length - BUFFER_MAX);
    }
    BUFFER_DIRTY = true;

    // Batch: persist every Nth event OR schedule a deferred save
    if (buf.length % BUFFER_SAVE_THRESHOLD === 0) {
      persistBuffer();
    } else {
      scheduleBufferSave();
    }

    // 2. Dispatch to plugin host (if loaded)
    if (root.GOTOPlugin && typeof root.GOTOPlugin.dispatchFeedback === 'function') {
      root.GOTOPlugin.dispatchFeedback(normalized);
    }

    // 3. Queue for remote sink if configured
    if (config.endpoint) pending.push(normalized);

    return normalized.id;
  }

  function list(filter) {
    var buf = loadBuffer();
    if (!filter) return buf.slice();
    return buf.filter(function(e) {
      return Object.keys(filter).every(function(k) { return e[k] === filter[k]; });
    });
  }

  function clear() {
    inMemoryBuffer = [];
    BUFFER_DIRTY = true;
    try {
      root.localStorage && root.localStorage.removeItem(BUFFER_KEY);
      BUFFER_DIRTY = false;
    } catch (_) {}
    if (bufferSaveTimer) { clearTimeout(bufferSaveTimer); bufferSaveTimer = null; }
    pending = [];
    return true;
  }

  function flush() {
    // Persist any buffered local events first
    persistBuffer();
    if (!config.endpoint || pending.length === 0) return Promise.resolve({ sent: 0 });
    var batch = pending.slice();
    pending = [];
    var body;
    try { body = JSON.stringify({ batch: batch, version: VERSION }); }
    catch (_) { return Promise.resolve({ sent: 0, error: 'serialize_failed' }); }

    if (root.fetch && typeof root.fetch === 'function') {
      return root.fetch(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body
      }).then(function(r) { return { sent: batch.length, status: r.status }; })
        .catch(function(e) {
          // Re-queue on failure
          pending = batch.concat(pending);
          return { sent: 0, error: String(e) };
        });
    }
    return Promise.resolve({ sent: 0, error: 'fetch_unavailable' });
  }

  function status() {
    return {
      version: VERSION,
      buffered: loadBuffer().length,
      pendingRemote: pending.length,
      endpoint: config.endpoint,
      localOnly: !config.endpoint
    };
  }

  return {
    version: VERSION,
    configure: configure,
    send: send,
    list: list,
    clear: clear,
    flush: flush,
    status: status
  };
});
