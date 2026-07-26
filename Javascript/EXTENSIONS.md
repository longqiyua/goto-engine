# GOTO Engine 第三方扩展指南

> 本文件说明如何扩展 GOTO Engine：添加应用、修改词库、覆盖算法、跨平台适配。

## 1. 扩展机制概述

引擎提供三种扩展模式：

| 模式 | 场景 | 方式 |
|------|------|------|
| **数据扩展** | 添加应用/分类/同义词 | 修改 `_appDataset` / `baseCatalog` / `intentSynonyms` |
| **算法扩展** | 自定义搜索逻辑 | 覆盖 `runSearchPipeline` / `fuzzySearch` |
| **平台扩展** | 跨平台存储/网络 | `GOTOEngineFacade.setAdapter(adapter)` |

## 2. 注册时机

所有扩展必须在引擎加载后执行：

```html
<!-- 1. 先加载语义模块（可选，须在引擎之前） -->
<script src="GOTO-Engine/semantic/semantic-loader.js" onerror="window.__semanticLoadFailed=true"></script>

<!-- 2. 再加载引擎（installGlobals 时检测 window.GOTOSemantic 是否存在） -->
<script src="GOTO-Engine/goto-engine.js"></script>

<!-- 3. 再写扩展脚本 -->
<script>
// 此时 window.GOTOEngine / window._appDataset / window.GOTOSemantic 已就绪
// 进行扩展...
</script>
```

> **语义模块加载顺序**：`semantic-loader.js` 必须在 `goto-engine.js` **之前**加载，确保引擎 `installGlobals()` 执行时 `window.GOTOSemantic` 已挂载。若顺序颠倒或文件缺失，引擎会静默跳过语义集成，不影响核心搜索。

## 3. 数据扩展

### 3.1 添加新应用到 _appDataset

```js
// 在 _appDataset 定义后追加（或用 push）
window._appDataset.push(
  {name:'我的应用',py:'wodeyingyong',abbr:'wdyy',en:'MyApp',icon:'🎯',cat:'工具',tags:['自定义','扩展']}
);
// 通知引擎重建索引
window.GOTOEngine.watchAppDataset(window._appDataset);
```

### 3.2 添加新分类到 catalog

```js
var catalog = window.GOTOEngine.loadCatalog();
catalog.myCategory = {
  label: '我的分类',
  apps: ['应用A','应用B'],
  keywords: ['关键词1','关键词2']
};
// 保存并重建索引
localStorage.setItem('goto_simint_catalog', JSON.stringify(catalog));
window.GOTOEngine.rebuildIndex();
```

### 3.3 添加意图同义词

```js
// 添加"支付"意图的新同义词
window.GOTOEngine.intentSynonyms.BUY.push('剁手', '买买买', '清空购物车');
```

## 4. 算法扩展

### 4.1 覆盖搜索管线（处理浏览器缓存）

> 参考 preview.html L17624-17682 的做法：用内联 script 覆盖 `runSearchPipeline`。

```js
if(window.GOTOEngine && typeof window.GOTOEngine.runSearchPipeline === 'function'){
  (function(){
    // 保存原始方法
    var _origPipeline = window.GOTOEngine.runSearchPipeline.bind(window.GOTOEngine);
    // 覆盖
    window.GOTOEngine.runSearchPipeline = function(query, apps){
      // 前置处理
      console.log('搜索:', query);
      // 调用原始方法
      var result = _origPipeline(query, apps);
      // 后置处理：过滤掉某些应用
      result.list = result.list.filter(function(app){
        return app.name !== '要过滤的应用';
      });
      return result;
    };
  })();
}
```

### 4.2 覆盖 fuzzySearch（自定义评分）

```js
var _origFuzzy = window.GOTOEngine.fuzzySearch.bind(window.GOTOEngine);
window.GOTOEngine.fuzzySearch = function(query, apps){
  var result = _origFuzzy(query, apps);
  // 自定义：给特定应用加分
  result.list.forEach(function(app){
    if(app.name === '常用应用'){
      app.score += 50;
    }
  });
  // 重新排序
  result.list.sort(function(a,b){ return (b.score||0) - (a.score||0); });
  return result;
};
```

### 4.3 注意事项

- **覆盖时必须 `.bind(window.GOTOEngine)`**：否则 `this` 指向错误。
- **JS 注释不可含 `</script>` 字符串**：否则 HTML 解析器会提前截断 script 块。如需在注释中提及，拆分到不同行：`</scr` + `ipt>`。
- **缓存问题**：浏览器可能缓存 goto-engine.js，覆盖法可绕过缓存（参考 preview.html 做法）。

## 5. 平台扩展

### 5.1 通过 Facade 设置 adapter

```js
// 自定义存储 adapter
var myAdapter = {
  storage: {
    getItem: function(key){ /* 从平台存储读取 */ },
    setItem: function(key, value){ /* 写入平台存储 */ },
    removeItem: function(key){ /* 删除 */ }
  },
  fetch: function(url){ /* 平台网络请求 */ }
};
window.GOTOEngineFacade.setAdapter(myAdapter);
```

### 5.2 Electron 平台 adapter 示例

```js
// Electron 主进程存储（通过 IPC）
const { ipcRenderer } = require('electron');
window.GOTOEngineFacade.setAdapter({
  storage: {
    getItem: function(key){
      return ipcRenderer.sendSync('storage-get', key);
    },
    setItem: function(key, value){
      ipcRenderer.send('storage-set', key, value);
    },
    removeItem: function(key){
      ipcRenderer.send('storage-remove', key);
    }
  },
  fetch: function(url){
    return fetch(url);  // Electron 支持 fetch
  }
});
```

### 5.3 Android WebView adapter 示例

```js
// 通过 JSBridge 调用原生存储
window.GOTOEngineFacade.setAdapter({
  storage: {
    getItem: function(key){
      return AndroidBridge.getItem(key);  // 同步返回
    },
    setItem: function(key, value){
      AndroidBridge.setItem(key, value);
    },
    removeItem: function(key){
      AndroidBridge.removeItem(key);
    }
  },
  fetch: function(url){
    // 通过 JSBridge 异步请求
    return new Promise(function(resolve){
      AndroidBridge.fetchUrl(url, function(response){
        resolve(response);
      });
    });
  }
});
```

### 5.4 iOS WKWebView adapter 示例

```js
// 通过 postMessage 调用原生存储
window.GOTOEngineFacade.setAdapter({
  storage: {
    getItem: function(key){
      return prompt('GOTOStorage.getItem:' + key);
    },
    setItem: function(key, value){
      prompt('GOTOStorage.setItem:' + key + '=' + value);
    },
    removeItem: function(key){
      prompt('GOTOStorage.removeItem:' + key);
    }
  }
});
```

> **注意**：当前引擎内部仍直接调用 `localStorage`，Facade 的 adapter 仅影响 Facade 层方法。完整跨平台需要后续把引擎内部的 `localStorage` 调用替换为可注入的 storage。

## 6. 语义联想模块扩展

语义联想模块（`semantic/`）是可选模块，为搜索引擎提供同义词扩展和词向量相似度能力。模块采用三层架构（L1 核心同义词 / L2 同义词词林分片 / L3 词向量分片），按需异步加载，删除 `semantic/` 目录即完全禁用。

### 6.1 模块加载与降级

```html
<!-- semantic-loader.js 必须在 goto-engine.js 之前加载 -->
<script src="GOTO-Engine/semantic/semantic-loader.js" onerror="window.__semanticLoadFailed=true"></script>
<script src="GOTO-Engine/goto-engine.js"></script>
```

降级路径（任一环节失败都不影响核心搜索）：
1. `semantic-loader.js` 加载失败 → `window.GOTOSemantic` 不存在 → 引擎 installGlobals 跳过集成
2. `semantic-config.json` fetch 失败 → `isAvailable()` 返回 false，L1 仍可用（内联在 loader）
3. 单个分片 404 → `loadShard` 返回 null，`expand` 跳过 L2 仅返回 L1
4. IndexedDB 不可用 → 降级到仅内存 LRU cache
5. 运行时开关关闭 → `_expandSync` / `_expandAsync` 返回空数组

### 6.2 运行时控制

```js
// 启用/关闭语义联想（写入 localStorage 'goto_semantic_enabled'）
GOTOSemantic.setEnabled(true);
GOTOSemantic.setEnabled(false);

// 查询状态
GOTOSemantic.isEnabled();     // 开关是否开启
GOTOSemantic.isReady();       // 是否就绪（init 完成 && enabled）
GOTOSemantic.isAvailable();   // semantic/ 目录与 config 是否可用
```

### 6.3 同步扩展（L1，零阻塞）

```js
// L1 核心同义词表（220 条，覆盖 13 分类 + 6 意图），同步立即返回
var expansions = GOTOSemantic._expandSync('安静', 10);
// → [{term:'宁静', score:0.9, source:'L1'}, {term:'寂静', score:0.9, source:'L1'}, ...]
```

### 6.4 异步扩展（L1 + L2，按需加载分片）

```js
// L2 同义词词林按拼音首字母分片，IndexedDB 持久化 + 内存 LRU
GOTOSemantic._expandAsync('安静', 10).then(function(expansions){
  // expansions 包含 L1 + L2 合并结果，source 标注来源层
  console.log(expansions);
});
```

### 6.5 导入大规模语料

```bash
# 1. 下载哈工大同义词词林 cilin.txt
# 2. 转换为分片 JSON（按拼音首字母自动分片）
node AppIndex/GOTO-Engine/semantic/import-corpus.js \
  --input cilin.txt --type cilin --output synonyms/

# 3. 刷新 semantic-config.json 分片清单
node AppIndex/GOTO-Engine/semantic/import-corpus.js --refresh-config

# 4. （可选）导入 Chinese Word Vectors 作为 L3 词向量
node AppIndex/GOTO-Engine/semantic/import-corpus.js \
  --input sgns.zhihu.bigram --type cwv --output vectors/ --topn 50000 --dim 64
```

### 6.6 自定义 L1 核心同义词

L1 核心同义词表内联在 `semantic-loader.js` 的 `L1_CORE_SYNONYMS` 常量中，扩展方式：

```js
// 在 semantic-loader.js 加载后、引擎加载前扩展
if (window.GOTOSemantic && window.GOTOSemantic.L1_CORE_SYNONYMS) {
  window.GOTOSemantic.L1_CORE_SYNONYMS['我的词'] = ['同义词1', '同义词2', '同义词3'];
}
```

### 6.7 集成点说明

引擎在 `metaSearch` 内的集成点（goto-engine.js L1040-1075）：
- 同步 L1：扩展词与 catalog 关键词匹配，精确命中 +80 分，包含命中 +38 分
- 异步 L2：不阻塞返回，结果通过 `_searchCacheClear()` + `renderHomeCards()` 触发 UI 重渲染
- 评分权重介于原有 metaSearch 的 120（精确）/ 56（包含）之间，不改变搜索优先级

详细 API 见 `interface.d.ts` 的 `SemanticAssociations` 接口。

## 7. 扩展最佳实践

1. **只扩展，不修改源码**：通过覆盖法扩展，保持 goto-engine.js 原始可更新。
2. **防御性编程**：覆盖前检查 `typeof window.GOTOEngine.xxx === 'function'`。
3. **保留原始方法**：用 `_orig = ...bind(...)` 保存，覆盖后仍可调用原始逻辑。
4. **测试**：扩展后运行 `run_all_tests.js` 确保未破坏现有功能。
5. **文档**：在扩展代码中注释说明扩展目的和影响范围。

## 7.1 v3.1 引擎自主维护扩展

引擎启动时自动调用 `maintain()`，第三方可通过修改 `MAINTENANCE` 常量调整阈值，或手动触发：

```js
// 手动触发完整维护（返回详细报告）
var report = window._maintain();
console.log(report);
// {
//   decayedQueries: 5,          // 本次衰减的过期查询数
//   totalQueriesChecked: 32,    // 扫描的总查询数
//   prunedChainEdges: 12,       // 剪掉的低权重/超限边
//   remainingChainEdges: 488,   // 剩余边数（≤500）
//   prunedMemoryRecords: 3,     // 剪掉的旧记忆
//   remainingMemory: 217,       // 剩余记忆（≤220）
//   ts: 1690000000000
// }

// 子步骤独立调用
window._decayAllStaleQueries();  // 全局时间衰减
window._pruneChainStore();       // 链式边修剪
window._pruneOldMemory();        // 旧记忆修剪

// 自定义维护策略（覆盖默认顺序）
var _origMaintain = window._maintain;
window._maintain = function(){
  console.log('[Custom] 维护开始');
  var result = _origMaintain();
  // 自定义后处理：例如清理陈旧的 _appDataset 引用
  if(typeof window._cleanupAppDataset === 'function'){
    window._cleanupAppDataset();
  }
  return result;
};
```

> **设计原则**：`MAINTENANCE` 常量（`CHAIN_MAX_EDGES=500` / `CHAIN_MAX_PER_NODE=20` / `CHAIN_MIN_WEIGHT=1` / `STALE_THRESHOLD_DAYS=1` / `MEMORY_MAX_AGE_DAYS=90`）是引擎默认策略，第三方可包装或修改但不应在生产环境随意降低阈值，避免过早丢弃用户学习成果。

## 8. 扩展点速查

| 扩展点 | 方法 | 示例 |
|--------|------|------|
| 添加应用 | `_appDataset.push(...)` + `watchAppDataset()` | 3.1 |
| 添加分类 | `loadCatalog()` → 修改 → `rebuildIndex()` | 3.2 |
| 添加同义词 | `intentSynonyms.XXX.push(...)` | 3.3 |
| 覆盖搜索管线 | `runSearchPipeline = function(...){...}` | 4.1 |
| 覆盖模糊搜索 | `fuzzySearch = function(...){...}` | 4.2 |
| 跨平台存储 | `GOTOEngineFacade.setAdapter({storage, fetch})` | 5.1 |
| 启用语义联想 | `GOTOSemantic.setEnabled(true)` | 6.2 |
| 同步扩展词 | `GOTOSemantic._expandSync(query, limit)` | 6.3 |
| 异步扩展词 | `GOTOSemantic._expandAsync(query, limit)` | 6.4 |
| 导入语料 | `node import-corpus.js --input ... --type cilin` | 6.5 |
| 扩展 L1 词典 | `GOTOSemantic.L1_CORE_SYNONYMS['词'] = [...]` | 6.6 |
| 手动维护引擎 | `_maintain()` | 7.1 |
| 自定义全局衰减 | `_decayAllStaleQueries()` | 7.1 |
| 修剪链式边 | `_pruneChainStore()` | 7.1 |
| 修剪旧记忆 | `_pruneOldMemory()` | 7.1 |