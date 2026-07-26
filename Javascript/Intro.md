# GOTO Engine 介绍

> GOTO Engine 是 GOTO 启动器的引擎母体。GUI（preview.html）只是它的一个壳。  
> 本文件说明引擎架构、各函数作用、跨平台接口与扩展点。

## 1. 项目定位

- **引擎母体**：`goto-engine.js` 是一个独立的、纯前端的搜索与意图识别引擎。
- **GUI 是壳**：`preview.html` 负责渲染与交互，所有搜索/学习/推荐逻辑都在引擎里。
- **跨平台**：引擎只依赖 `window`、`localStorage`、`Date`、`Map`/`Set`，可在浏览器、Electron、Android WebView、iOS WKWebView 中运行。未来跨平台只需替换存储 adapter（见 EXTENSIONS.md）。

## 2. 架构总览

```
┌─────────────────────────────────────────────────┐
│  preview.html (GUI 壳)                          │
│  ├─ <script src="GOTO-Engine/goto-engine.js">   │
│  ├─ 内联覆盖 runSearchPipeline (处理缓存)       │
│  └─ window.GOTOEngineFacade (统一 API 封装)     │
├─────────────────────────────────────────────────┤
│  goto-engine.js (IIFE)                          │
│  ├─ engine 对象 (所有方法)                      │
│  └─ engine.installGlobals()                     │
│     ├─ window.GOTOEngine = engine               │
│     └─ window._xxx = engine.xxx.bind(engine)    │
└─────────────────────────────────────────────────┘
```

引擎通过 IIFE 封装，内部定义 `engine` 对象，最后调用 `engine.installGlobals()` 把所有方法挂到 `window.GOTOEngine` 和 `window._xxx` 全局函数上。GUI 两套调用方式均可：
- `window.GOTOEngine.fuzzySearch(query, apps)` — 对象方法
- `window._fuzzySearch(query, apps)` — 全局函数（等价）

## 3. 核心模块说明

引擎按职责分为 12 个模块层：

### 3.1 存储层
| 函数 | 作用 |
|------|------|
| `readJSON(key, fallback)` | 从 localStorage 读 JSON，失败返回 fallback |
| `writeJSON(key, value)` | 写 JSON 到 localStorage，失败静默 |
| `STORAGE` (常量对象) | 所有 localStorage key 的集中定义：`simIntEnabled`/`catalog`/`memory`/`pending`/`stats`/`weights`/`chains`/`negative`/`blockFlags`/`selfHealing`/`pro`/`proSnapshot`/`floatWindow` |

### 3.2 索引层
| 函数 | 作用 |
|------|------|
| `createSearchIndex()` | 创建空倒排索引：byInitial/byT9/byPrefix/byChar/byAppId |
| `buildSearchIndex(apps)` | 遍历应用数据集构建倒排索引（首字母/T9/前缀/单字） |
| `rebuildIndex()` | 重建元标签索引（metaIndex），从 catalog 提取关键词倒排 |
| `loadCatalog()` | 加载分类词库（优先 localStorage，否则用 baseCatalog） |
| `watchAppDataset(apps)` | 监听数据集变化，重建搜索索引 |

### 3.3 搜索层（三阶优先级）
| 函数 | 作用 |
|------|------|
| `fuzzySearch(query, apps)` | **第一优先级**：模糊匹配（首字母/T9/前缀/包含），含 temporal/weight/context/pro/launchCount/installed boost |
| `metaSearch(query)` | **第二优先级**：元标签语义匹配（基于 catalog 关键词），独有结果追加末尾标"智能推荐" |
| `runSearchPipeline(query, apps)` | 搜索管线总入口：fuzzy 优先 + meta 补充 + 未知应用兜底，返回完整 SearchContext |
| `_getLaunchCountBoost(appName)` | 启动次数加权：每次 +2，封顶 80（第二优先级依据） |
| `_getInstalledBoost(appName)` | 已安装应用加权：+60（用户手机装的应用优先） |

### 3.4 意图层
| 函数 | 作用 |
|------|------|
| `extractTokens(query)` | 分词：提取动作词/意图/关系词/目标对象 |
| `intentSynonyms` (常量对象) | 意图同义词词典：SEND/CONSUME/CONTACT/TRAVEL/BUY/WORK 六类 |

### 3.5 学习层
| 函数 | 作用 |
|------|------|
| `recordSearch(query)` | 记录搜索行为（含 sanitize 过滤） |
| `recordSelection(query, appName)` | 记录用户选择（query→app 映射） |
| `recordUnknownApp(query, appName)` | 记录未知应用，进入待索引库 |
| `getMemory()` / `saveMemory(list)` | 读写个人记忆库（最近 220 条） |
| `getPendingIndex()` / `savePendingIndex(obj)` | 读写待索引库（低权重应用） |
| `getUnknownApps()` / `getUnknownAppSuggestions(query)` | 获取未知应用列表/建议 |

### 3.6 权重层
| 函数 | 作用 |
|------|------|
| `getRuleWeights()` / `saveRuleWeights(weights)` | 读写个人权重（每个 query 对各 app 的偏好分） |
| `getRuleStats()` / `saveRuleStats(stats)` | 读写规则统计 |

### 3.7 负面层
| 函数 | 作用 |
|------|------|
| `getNegativeState()` / `saveNegativeState(state)` | 读写负面反馈 |
| `addBlockFlag(query, appName, days)` | 屏蔽某 query 的某 app（默认 3 天） |
| `removeBlockFlag(query, appName)` | 移除屏蔽 |
| `isBlockFlagged(query, appName)` | 查询是否被屏蔽 |
| `clearExpiredBlockFlags()` | 清理过期屏蔽标记 |

### 3.8 自愈层
| 函数 | 作用 |
|------|------|
| `applySelfHealing(query, newDefaultApp)` | 自愈：用户改选后降低其他候选权重并临时屏蔽 |
| `getSelfHealingState()` / `saveSelfHealingState(state)` | 读写自愈状态 |

### 3.9 关联层
| 函数 | 作用 |
|------|------|
| `getChainStore()` / `saveChainStore(store)` | 读写动作链（A→B 边权重） |
| `getAssociationRecommendation()` | 基于动作链推荐下一个应用 |

### 3.10 统计层
| 函数 | 作用 |
|------|------|
| `getHourlyStats()` | 获取四时段统计（上午/下午/晚上/凌晨） |
| `getFullTimeStats()` | 获取完整时间统计 |
| `getCurrentHourStats()` | 获取当前时段统计 |
| `getQuickBubbles()` | 获取快捷气泡推荐 |

### 3.11 过滤层
| 函数 | 作用 |
|------|------|
| `sanitizeQuery(query)` | 脏数据清洗：长度 2-40、必须含字母/数字/中文、纯数字过滤、重复率<60%、无控制字符、连续重复截断 |

### 3.12 上下文层
| 函数 | 作用 |
|------|------|
| `setContext(ctx)` / `clearContext()` | 设置/清除搜索上下文 |
| getContext() | 获取当前上下文 |

### 3.13 语义联想层（可选模块）
| 函数 | 作用 |
|------|------|
| `GOTOSemantic.init()` | 异步初始化：加载 semantic-config.json + pinyin-index.json + 打开 IndexedDB |
| `GOTOSemantic.isEnabled()` | 运行时开关状态（localStorage `goto_semantic_enabled`） |
| `GOTOSemantic.isReady()` | 是否就绪（init 完成 && 开关开启） |
| `GOTOSemantic.isAvailable()` | semantic/ 目录与 config 是否可用 |
| `GOTOSemantic.expand(query, opts)` | 扩展查询：opts.async=false 仅查 L1；opts.async=true 返回 Promise（L1+L2） |
| `GOTOSemantic._expandSync(query, limit)` | L1 同步扩展：220 条核心同义词词典（通讯/办公/浏览器/视频等 13 分类） |
| `GOTOSemantic._expandAsync(query, limit)` | L2 异步扩展：按拼音首字母路由分片，合并 L1+L2 |
| `GOTOSemantic.findSimilar(word, topN)` | L3 本地 mini embedding：字符 n-gram 稀疏向量 + 余弦相似度，并融合 L1 同义词簇 |
| `GOTOSemantic.loadShard(shardId)` | 加载分片：内存 LRU → IndexedDB → fetch（3 级查找） |
| `GOTOSemantic.getStats()` | 统计信息：l1Count / l1Hits / l2Hits / cacheHits / cachedShards 等 |
| `GOTOSemantic.clearCache()` | 清空内存 LRU + IndexedDB 缓存 |

> **可选模块**：删除 `semantic/` 目录即完全禁用，引擎 installGlobals 检测 `GOTOSemantic` 不存在时跳过集成。L1 核心同义词表内联在 loader 中（零 IO），L2 同义词词林按拼音首字母分片异步加载（IndexedDB 持久化 + 内存 LRU 20 片上限）。集成点位于 metaSearch 内，扩展评分 80（精确）/ 38（包含），介于原有 120/56 之间，不改变搜索优先级。

### 3.14 自主维护层（v3.1 新增）
| 函数 | 作用 |
|------|------|
| `maintain()` | 引擎自主维护入口：依次执行全局衰减 + 链式边修剪 + 旧记忆清理 + 过期 block flag 清理，返回统计报告 `{ decayedQueries, prunedChainEdges, prunedMemoryRecords, ... }` |
| `_decayAllStaleQueries()` | 全局时间衰减：对所有 > 1 天的查询权重复用 `_applyTimeDecayToQuery`，解决原算法仅在用户点击时才衰减的盲点 |
| `_pruneChainStore()` | 链式边修剪：清理权重 < 1 的边，每个 from-key 最多保留 20 个 to-key，全局总边数 ≤ 500，超出按权重降序截断 |
| `_pruneOldMemory()` | 旧记忆修剪：清理 > 90 天的记忆记录，并按 220 条上限双层保险 |

> **自动执行**：`installGlobals()` 启动时自动调用一次 `maintain()`，保证陈旧偏好不会无限累积。GUI 也可在"设置→重置记忆"或"重置设置"流程中手动调用 `window._maintain()` 触发。`MAINTENANCE` 常量对象集中管理阈值（`CHAIN_MAX_EDGES=500` / `CHAIN_MAX_PER_NODE=20` / `CHAIN_MIN_WEIGHT=1` / `STALE_THRESHOLD_DAYS=1` / `MEMORY_MAX_AGE_DAYS=90`）。

## 4. 公开 API 对照表

| window.GOTOEngine.xxx | window._xxx | 说明 |
|----------------------|-------------|------|
| `fuzzySearch(q, apps)` | `_fuzzySearch(q, apps)` | 模糊搜索 |
| `metaSearch(q)` | `_metaTagSearch(q)` | 元标签搜索 |
| `runSearchPipeline(q, apps)` | `runGotoEngineSearch(q, apps)` | 搜索管线 |
| `recordSearch(q)` | `_recordSimIntSearch(q)` | 记录搜索 |
| `recordSelection(q, app)` | `_recordSimIntSelection(q, app)` | 记录选择 |
| `recordUnknownApp(q, app)` | `_recordUnknownApp(q, app)` | 记录未知应用 |
| `rebuildIndex()` | — | 重建索引 |
| `sanitizeQuery(q)` | — | 脏数据过滤 |
| `setContext(ctx)` | `setContext(ctx)` | 设置上下文 |
| `applySelfHealing(q, app)` | `_applySelfHealing(q, app)` | 自愈 |
| `addBlockFlag(q, app, d)` | `_addBlockFlag(q, app, d)` | 添加屏蔽 |
| `isBlockFlagged(q, app)` | `_isBlockFlagged(q, app)` | 查询屏蔽 |
| `getHourlyStats()` | `_getHourlyStats()` | 时段统计 |
| `maintain()` | `_maintain()` | 引擎自主维护（全局衰减+链式边修剪+旧记忆清理） |
| `_decayAllStaleQueries()` | `_decayAllStaleQueries()` | 全局时间衰减（所有过期查询） |
| `_pruneChainStore()` | `_pruneChainStore()` | 链式边修剪 |
| `_pruneOldMemory()` | `_pruneOldMemory()` | 旧记忆修剪 |

> 完整列表见 `goto-engine.js` `installGlobals()` 方法。

## 5. 跨平台接口

引擎默认使用 `localStorage` 作为存储。跨平台时通过 `GOTOEngineFacade.setAdapter(adapter)` 替换：

```js
// Electron 平台
GOTOEngineFacade.setAdapter({
  storage: require('electron').remote.session.defaultSession.storage,
  fetch: require('node-fetch')
});

// Android WebView 平台
GOTOEngineFacade.setAdapter({
  storage: {
    getItem: function(k){ return AndroidBridge.getItem(k); },
    setItem: function(k,v){ AndroidBridge.setItem(k,v); },
    removeItem: function(k){ AndroidBridge.removeItem(k); }
  }
});
```

> 注意：当前引擎内部仍直接调用 `localStorage`，Facade 的 adapter 仅影响 Facade 层方法（如 `isSimIntEnabled`/`enableSimInt`）。完整跨平台需要后续重构引擎内部存储调用。

## 6. 版本与扩展点

- **当前版本**：3.2.0（含 L3 mini embedding 与 65 维用户偏好向量）
- **扩展方式**：见 `EXTENSIONS.md`
- **接口定义**：见 `interface.d.ts`
- **测试**：`run_all_tests.js` 运行所有测试

## 7. 文件结构

```
GOTO-Engine/
├─ goto-engine.js          # 引擎主体（v3.1，约 1900 行）
├─ Intro.md                # 本文件
├─ interface.d.ts          # TypeScript 接口定义
├─ EXTENSIONS.md           # 第三方扩展指南
├─ README.md               # 简要说明
├─ run_all_tests.js        # 测试入口
├─ test_association.js     # 关联推荐测试
├─ test_float_window.js    # 悬浮窗测试
├─ test_hourly_stats.js    # 时段统计测试
├─ test_pro.js             # PRO 模式测试
├─ test_self_healing.js    # 自愈测试
├─ test_synonyms_negative.js  # 同义词+负反馈测试
├─ test_semantic.js        # 语义联想模块测试
├─ semantic/               # 语义联想模块（可选，删除即禁用）
│  ├─ semantic-loader.js   # 加载器 + L1 核心同义词 + 公共 API
│  ├─ semantic-config.json # 分片清单
│  ├─ pinyin-index.json    # 汉字→拼音首字母映射（2696 字）
│  ├─ import-corpus.js     # Node 语料导入脚本
│  ├─ README.md            # 模块文档
│  ├─ synonyms/            # L2 同义词分片（shard-a.json ~ shard-z.json）
│  ├─ vectors/             # L3 词向量分片（可选）
│  └─ samples/             # 示例语料
```
