'use strict';

/**
 * GOTO Engine — Browser Module Entry (dist/browser/index.mjs)
 *
 * 自包含的统一浏览器模块协议 entry。
 * 不修改 Engine 算法，仅作为统一浏览器协议的薄包装。
 *
 * 在浏览器中：
 *   - goto-engine.js 通过 <script> 标签加载，挂载到 window.GOTOEngine
 *   - 此 entry 包装 EngineComponent API
 *
 * 在 Node.js 中：
 *   - goto-engine.js 依赖 window/localStorage，无法直接运行
 *   - init() 会返回 unavailable（预期行为）
 *   - 消费者可注入 mock engine 进行测试
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = __filename.substring(0, __filename.lastIndexOf('/'));
const require = createRequire(import.meta.url);

let _component = null;
let _initialized = false;
let _destroyed = false;

// 尝试加载 EngineComponent（UMD 模块，兼容 Node.js 和浏览器）
let engineComponent = null;
try {
  engineComponent = require('./goto-engine-component.js');
} catch (e) {
  // 在某些环境中可能无法直接 require（如纯浏览器 ES module 模式）
  // 此时依赖 init() 时注入的 engine
}

export const moduleManifest = {
  id: 'engine',
  version: '2.1.0',
  schemaVersion: '1.0.0',
  capabilities: [
    'search',
    'fuzzy-match',
    'meta-tag-search',
    'association',
    'self-healing',
    'stats',
    'intent-detection',
    'block-flags',
    'sim-int',
    'float-window'
  ],
  description: 'GOTO Engine — Core search & association runtime (required)',
  degradedBehavior: '搜索不可用，其他页面仍渲染'
};

export async function init(context) {
  if (_initialized) {
    return { id: 'engine', status: 'already-initialized' };
  }
  if (_destroyed) {
    return { id: 'engine', status: 'destroyed' };
  }
  const ctx = context || {};
  try {
    // 获取引擎实例：
    //   1. 优先使用注入的 engine
    //   2. 其次使用全局 GOTOEngine（浏览器中通过 script 标签加载）
    //   3. 最后为 null（Node.js 中无法运行）
    let engine = ctx.engine || null;
    if (!engine && typeof globalThis !== 'undefined' && globalThis.GOTOEngine) {
      engine = function() { return globalThis.GOTOEngine; };
    }

    if (engineComponent && engineComponent.EngineComponent) {
      _component = new engineComponent.EngineComponent({
        engine: typeof engine === 'function' ? engine : function() { return engine; },
        dataset: ctx.dataset || function() { return []; },
        storage: ctx.storage || null,
        fetch: ctx.fetch || null
      });
      _initialized = true;
      return { id: 'engine', status: 'available', component: _component };
    } else if (engine) {
      // 无 EngineComponent 时，直接暴露 engine
      _component = engine;
      _initialized = true;
      return { id: 'engine', status: 'available', component: engine };
    } else {
      // Node.js 中无 window/localStorage，引擎不可用
      _initialized = false;
      return { id: 'engine', status: 'unavailable', error: 'GOTOEngine not found (requires browser environment or injected engine)' };
    }
  } catch (e) {
    _initialized = false;
    return { id: 'engine', status: 'unavailable', error: e.message };
  }
}

export async function healthCheck() {
  if (_destroyed) {
    return { id: 'engine', status: 'destroyed', available: false };
  }
  if (!_initialized || !_component) {
    return { id: 'engine', status: 'not-initialized', available: false };
  }
  try {
    return {
      id: 'engine',
      status: 'available',
      available: true,
      version: moduleManifest.version,
      hasComponent: !!_component
    };
  } catch (e) {
    return { id: 'engine', status: 'degraded', available: false, error: e.message };
  }
}

export async function destroy() {
  if (_destroyed) return { id: 'engine', status: 'already-destroyed' };
  try {
    if (_component && typeof _component.destroy === 'function') {
      _component.destroy();
    }
  } catch (_) {}
  _component = null;
  _initialized = false;
  _destroyed = true;
  return { id: 'engine', status: 'destroyed' };
}

export const EngineComponent = engineComponent ? (engineComponent.EngineComponent || engineComponent) : null;
export const API_VERSION = (engineComponent && engineComponent.API_VERSION) ? engineComponent.API_VERSION : '1.0.0';

export default {
  moduleManifest,
  init,
  healthCheck,
  destroy
};
