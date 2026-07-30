'use strict';

/**
 * GOTO Base Personal Learning — QueryNormalizer 薄包装
 *
 * 在 runtime/shared/query-normalizer.js 之上添加 LRU 缓存，
 * 避免对同一查询反复执行归一化与语言检测（高频查询场景）。
 *
 * 设计：
 *   - LRU 容量 1000
 *   - 缓存命中直接返回，未命中走底层 normalize/detectLanguage
 *   - 共享缓存（normalize 与 detectLanguage 使用同一缓存项）
 */

const {
  normalize: _normalize,
  detectLanguage: _detectLanguage
} = require('./query-normalizer.js');

const DEFAULT_CACHE_SIZE = 1000;

/**
 * LRU 缓存（基于 Map 的插入顺序）。
 */
class LRUCache {
  constructor(maxSize) {
    this._maxSize = (typeof maxSize === 'number' && maxSize > 0) ? maxSize : DEFAULT_CACHE_SIZE;
    this._map = new Map();
  }

  get(key) {
    if (!this._map.has(key)) return undefined;
    // 移到最新位置
    const v = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, v);
    return v;
  }

  set(key, value) {
    if (this._map.has(key)) {
      this._map.delete(key);
    } else if (this._map.size >= this._maxSize) {
      // 删除最旧（第一个）
      const firstKey = this._map.keys().next().value;
      this._map.delete(firstKey);
    }
    this._map.set(key, value);
  }

  clear() {
    this._map.clear();
  }

  get size() {
    return this._map.size;
  }
}

class QueryNormalizerWrapper {
  constructor(options) {
    const opts = options || {};
    this._cache = new LRUCache(opts.cacheSize || DEFAULT_CACHE_SIZE);
  }

  /**
   * 归一化查询（带缓存）。
   * @param {string} rawQuery
   * @returns {string}
   */
  normalize(rawQuery) {
    if (typeof rawQuery !== 'string') return '';
    // 用原始字符串作为缓存 key（注意：原始字符串可能很长，但 LRU 会淘汰）
    const cacheKey = 'n:' + rawQuery;
    const cached = this._cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const result = _normalize(rawQuery);
    this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * 检测语言（带缓存）。注意：detectLanguage 输入应为归一化后的查询。
   * @param {string} normalizedQuery
   * @returns {'zh' | 'en' | 'pinyin' | 'mixed' | 'unknown'}
   */
  detectLanguage(normalizedQuery) {
    if (typeof normalizedQuery !== 'string' || normalizedQuery.length === 0) return 'unknown';
    const cacheKey = 'l:' + normalizedQuery;
    const cached = this._cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const result = _detectLanguage(normalizedQuery);
    this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * 一次性返回归一化结果与语言检测结果，减少缓存查询次数。
   * @param {string} rawQuery
   * @returns {{normalized: string, language: string}}
   */
  normalizeAndDetect(rawQuery) {
    if (typeof rawQuery !== 'string') return { normalized: '', language: 'unknown' };
    const normalized = this.normalize(rawQuery);
    const language = this.detectLanguage(normalized);
    return { normalized, language };
  }

  clearCache() {
    this._cache.clear();
  }

  get cacheSize() {
    return this._cache.size;
  }
}

module.exports = {
  QueryNormalizerWrapper,
  LRUCache
};
