/* GOTO Engine Plugin API v1.0.0
 * ──────────────────────────────────────────────────────────────
 * Purpose: A clean, versioned entry point for third-party plugins
 *          to register search providers, data sources, context
 *          enrichers, and UI hooks without touching engine internals.
 *
 * Load order:
 *   1. semantic/semantic-loader.js   (optional)
 *   2. goto-engine.js                (runtime)
 *   3. goto-engine-component.js      (stable component API)
 *   4. plugin-api.js                 (this file — plugin host)
 *   5. your-plugin.js                (calls GOTOPlugin.register(...))
 *
 * License: GNU AGPL-3.0
 * ────────────────────────────────────────────────────────────── */
(function(root, factory) {
  var host = factory(root || {});
  if (typeof module === 'object' && module.exports) module.exports = host;
  if (root) root.GOTOPlugin = host;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';

  var API_VERSION = '1.0.0';
  var plugins = Object.create(null);
  var listeners = {
    beforeSearch: [],
    afterSearch: [],
    beforeRender: [],
    onFeedback: [],
    onError: []
  };

  /* ── Cached component instance (avoid recreating per query) ── */
  var _cachedEngine = null;
  var _cachedDatasetRef = null;   // tracks dataset reference identity
  var _cachedDatasetLen = -1;     // tracks dataset length to detect changes

  function getEngineInstance() {
    if (!root.GOTOEngineComponent || typeof root.GOTOEngineComponent.create !== 'function') return null;
    var dataset = root._appDataset || [];
    var datasetLen = Array.isArray(dataset) ? dataset.length : 0;
    // Reuse cached instance if dataset identity OR length unchanged (cheap heuristic)
    if (_cachedEngine && (_cachedDatasetRef === dataset || _cachedDatasetLen === datasetLen)) {
      return _cachedEngine;
    }
    _cachedEngine = root.GOTOEngineComponent.create({
      engine: function() { return root.GOTOEngine; },
      dataset: function() { return root._appDataset || []; },
      storage: root.localStorage || null
    });
    _cachedDatasetRef = dataset;
    _cachedDatasetLen = datasetLen;
    return _cachedEngine;
  }

  function invalidateEngineCache() {
    _cachedEngine = null;
    _cachedDatasetRef = null;
    _cachedDatasetLen = -1;
  }

  /* ── Internal helpers ──────────────────────────────────────── */

  function emit(type, payload) {
    var list = listeners[type] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (_) {}
    }
  }

  function safeCall(fn, ctx) {
    try { return fn(ctx); } catch (e) {
      emit('onError', { phase: 'plugin-call', error: e, ctx: ctx });
      return undefined;
    }
  }

  function component() {
    return root.GOTOEngineComponent && typeof root.GOTOEngineComponent.create === 'function'
      ? root.GOTOEngineComponent
      : null;
  }

  /* ── PluginManifest ────────────────────────────────────────── */
  // {
  //   id:          'my-plugin',          // unique, alphanumeric + dash
  //   name:        'My Plugin',          // human-readable
  //   version:     '1.0.0',
  //   author:      'your-name',
  //   description: 'what it does',
  //   permissions: ['search.read', 'search.rerank', 'context.write', 'feedback.send']
  // }

  function validateManifest(m) {
    if (!m || typeof m !== 'object') return 'manifest must be an object';
    if (!/^[a-z0-9-]{2,64}$/i.test(m.id || '')) return 'manifest.id must be 2-64 alphanumeric/dash chars';
    if (typeof m.name !== 'string' || !m.name) return 'manifest.name required';
    if (!Array.isArray(m.permissions)) return 'manifest.permissions must be an array';
    return null;
  }

  /* ── PluginHooks ───────────────────────────────────────────── */
  // All hooks are optional. Each plugin supplies whichever it needs.
  //
  // beforeSearch(query, options)      → may return modified options
  // afterSearch(query, envelope)      → may return modified envelope
  // beforeRender(target, envelope)    → may return modified target selector
  // onFeedback(feedback)              → receives feedback events from feedback.js
  // onError(errorInfo)                → receives plugin/system errors

  /* ── Public API ────────────────────────────────────────────── */

  function register(manifest, hooks) {
    var err = validateManifest(manifest);
    if (err) { emit('onError', { phase: 'register', error: new Error(err), manifest: manifest }); return false; }
    if (plugins[manifest.id]) {
      emit('onError', { phase: 'register', error: new Error('Plugin already registered: ' + manifest.id), manifest: manifest });
      return false;
    }
    plugins[manifest.id] = { manifest: manifest, hooks: hooks || {} };
    // Wire hooks into listeners
    var h = hooks || {};
    if (typeof h.beforeSearch === 'function') listeners.beforeSearch.push({ id: manifest.id, fn: h.beforeSearch });
    if (typeof h.afterSearch === 'function') listeners.afterSearch.push({ id: manifest.id, fn: h.afterSearch });
    if (typeof h.beforeRender === 'function') listeners.beforeRender.push({ id: manifest.id, fn: h.beforeRender });
    if (typeof h.onFeedback === 'function') listeners.onFeedback.push({ id: manifest.id, fn: h.onFeedback });
    if (typeof h.onError === 'function') listeners.onError.push({ id: manifest.id, fn: h.onError });
    return true;
  }

  function unregister(pluginId) {
    var p = plugins[pluginId];
    if (!p) return false;
    delete plugins[pluginId];
    Object.keys(listeners).forEach(function(type) {
      listeners[type] = listeners[type].filter(function(entry) { return entry.id !== pluginId; });
    });
    return true;
  }

  function list() {
    return Object.keys(plugins).map(function(id) {
      var m = plugins[id].manifest;
      return { id: m.id, name: m.name, version: m.version, permissions: m.permissions };
    });
  }

  function get(pluginId) {
    var p = plugins[pluginId];
    return p ? { manifest: p.manifest, hooks: p.hooks } : null;
  }

  /* ── Search pipeline integration ───────────────────────────── */
  // Wraps GOTOEngineComponent.query() so plugins can observe/modify searches.
  // Hot path: skip hook loops entirely when no plugins registered.

  function query(queryStr, options) {
    options = options || {};
    var hasBefore = listeners.beforeSearch.length > 0;
    var hasAfter = listeners.afterSearch.length > 0;

    // beforeSearch: plugins may modify options
    if (hasBefore) {
      for (var i = 0; i < listeners.beforeSearch.length; i++) {
        var mod = safeCall(listeners.beforeSearch[i].fn, { query: queryStr, options: options });
        if (mod && typeof mod === 'object') options = Object.assign({}, options, mod);
      }
    }

    var engine = getEngineInstance();
    if (!engine) {
      var errEnv = {
        ok: false, apiVersion: API_VERSION,
        request: { query: queryStr },
        error: { code: 'COMPONENT_UNAVAILABLE', message: 'GOTOEngineComponent not loaded.' }
      };
      emit('onError', { phase: 'query', error: new Error('component unavailable'), query: queryStr });
      return errEnv;
    }
    var envelope = engine.query(queryStr, options);

    // afterSearch: plugins may modify envelope (must keep contract)
    if (hasAfter) {
      for (var j = 0; j < listeners.afterSearch.length; j++) {
        var alt = safeCall(listeners.afterSearch[j].fn, { query: queryStr, envelope: envelope });
        if (alt && alt.ok !== undefined) envelope = alt;
      }
    }
    return envelope;
  }

  function render(target, envelope, format) {
    // beforeRender: plugins may swap target selector
    if (listeners.beforeRender.length > 0) {
      for (var i = 0; i < listeners.beforeRender.length; i++) {
        var alt = safeCall(listeners.beforeRender[i].fn, { target: target, envelope: envelope });
        if (typeof alt === 'string') target = alt;
      }
    }
    var engine = getEngineInstance();
    if (!engine) return '';
    return engine.render(target, envelope, format);
  }

  /* ── Feedback bridge (used by feedback.js) ─────────────────── */
  function dispatchFeedback(feedback) {
    emit('onFeedback', feedback);
  }

  /* ── Status / introspection ────────────────────────────────── */
  function status() {
    return {
      apiVersion: API_VERSION,
      pluginCount: Object.keys(plugins).length,
      plugins: list(),
      componentReady: !!component(),
      engineReady: !!(root.GOTOEngine && typeof root.GOTOEngine.runSearchPipeline === 'function')
    };
  }

  return {
    version: API_VERSION,
    register: register,
    unregister: unregister,
    list: list,
    get: get,
    query: query,
    render: render,
    dispatchFeedback: dispatchFeedback,
    invalidateCache: invalidateEngineCache,
    status: status,
    _listeners: listeners
  };
});
