# GOTO Engine — JavaScript 版本

> 🌐 JavaScript 版本（Web / Electron）
>
> 运行于浏览器 / WebView / Node.js，单文件 IIFE 封装，零依赖、零构建、即插即用。
> 是 GOTO Engine 的算法母体，包含完整 18 模块。License：GNU AGPL-3.0（详见 [LICENSE](LICENSE)）。

## 版本

**V2.1 update**

- 搜索管线改为：**精确匹配 → 前缀索引 → 模糊匹配**
- Trie 前缀树支持精确/前缀扩展召回，并暴露隐藏扩展接口
- 精确/前缀结果可按统计信息排序（不依赖模拟智能）

## 模块清单

| 文件 / 目录 | 职责 |
|---|---|
| `goto-engine.js` | 主引擎，算法运行时（IIFE 单文件，含 `engine` 对象 + `installGlobals()`） |
| `goto-engine-component.js` | 独立组件 API（版本化 envelope、事件系统、错误码） |
| `component-api.d.ts` | 组件 API 类型契约（公开契约） |
| `interface.d.ts` | 引擎底层接口类型（v2.1.0） |
| `plugin-api.js` + `plugin-api.d.ts` | 插件宿主与类型 |
| `feedback.js` | 反馈通道（本地缓冲 200 条 + 可选远端） |
| `semantic/` | 语义数据（loader + config + pinyin-index + 22 个首字母分片 + synonyms/ + samples/） |
| `algorithms/` | 算法模块（boost/ + learning/ + semantic/ + usage-signal/ + where-pattern/） |
| `model-runner/` | RAG 构建工具（bge-embedder + build-rag-from-seeds + build-seeds-bundle + expand-seed-data 等） |
| `dist/` | 浏览器打包（browser/：goto-engine.js + goto-engine-component.js + index.mjs） |
| `scripts/` | 构建脚本（build-browser-bundle.js） |
| `PLUGIN-GUIDE.md` / `EXTENSIONS.md` / `Intro.md` | 扩展文档 |

## 搜索管线：精确 → 前缀 → 模糊

```
runSearchPipeline(query, apps)
    ├── exactSearch(query, apps)      # 完整 term 精确命中
    ├── prefixSearch(query, apps)     # Trie 前缀树扩展召回
    └── fuzzySearch(query, apps)      # 模糊匹配兜底
```

- 精确匹配：name / py / en / abbr 完全等于 query。
- 前缀索引：基于 Trie 返回所有以 query 开头的 App。
- 模糊匹配：仅当前两级无结果时兜底。

### 统计型排序（不依赖模拟智能）

精确/前缀命中的结果会按以下统计信息排序，**无需开启模拟智能**：

- 启动次数
- 最近使用时间
- 是否已安装
- 时段偏好
- 模式频率

## Trie 前缀树扩展接口（隐藏入口）

```js
GOTOEngine.trieIndex.insert(term, appOrId)
GOTOEngine.trieIndex.remove(term, appOrId)
GOTOEngine.trieIndex.exactSearch(term)
GOTOEngine.trieIndex.prefixSearch(prefix)
GOTOEngine.trieIndex.rebuild()
GOTOEngine.trieIndex.getRoot()
```

全局快捷函数：

```js
_trieInsert(term, appOrId)
_trieRemove(term, appOrId)
_trieExactSearch(term)
_triePrefixSearch(prefix)
_trieRebuild()
_trieGetRoot()
_exactSearch(query, apps)
_prefixSearch(query, apps)
```

## FeatureFlags 使用

通过 `engine.setFeatureFlags()` 配置模块开关，三语言必须保持一致：

```javascript
// 开启模糊匹配 + 索引树 + 自适应刷新（默认开）
engine.setFeatureFlags({
  fuzzyMatch: true,
  indexTree: true,
  adaptiveRefresh: true,
});

// 开启模拟智能 / T9 / RAG 兜底（默认关）
engine.setFeatureFlags({
  simInt: true,
  t9: true,
  ragFallback: false, // 预留
});
```

| Flag | 默认 | 作用 |
|---|---|---|
| `fuzzyMatch` | `true` | 模糊匹配（Jaccard + 顺序恢复 + 缩写） |
| `indexTree` | `true` | 索引树（英文单词树 + 中文汉字树 + 拼音树 + Trie 前缀树） |
| `adaptiveRefresh` | `true` | 自适应刷新（打字速度 + 防抖节流） |
| `simInt` | `false` | 模拟智能（微观上下文 + 时段加分） |
| `t9` | `false` | T9 模式 |
| `ragFallback` | `false` | RAG 兜底（最后调用，预留） |

## 匹配模式（5 维度 MECE）

JS 版采用 5 维度 MECE 匹配，精确/前缀/包含/模糊 互斥，取最高分：

| 维度 | 分数 | 说明 |
|---|---|---|
| 精确匹配 | 1000 | name/py/en/abbr 完全匹配 |
| 前缀匹配 | 800 | name/py/en/abbr 前缀匹配 |
| 包含匹配 | 600 | name/py/en/abbr 包含匹配 |
| 模糊匹配 | 50-400 | Jaccard + 顺序恢复 + 间隔字母 + 缩写（融合） |
| T9 匹配 | 700/500 | T9 模式独有 |

分类兜底（80）与标签兜底（50）为低分兜底，不互斥。

## 组件层调用

```javascript
const component = GOTOEngineComponent.create({ engine, dataset, storage });
const result = component.query(query, { limit, requestId, context });
// → EngineEnvelope { ok, data, requestId, latency, timestamp, localOnly }
```

## 相关文档

- 根目录 [`../README.md`](../README.md) — 三语言总览与架构
- `Intro.md` — 引擎简介
- `EXTENSIONS.md` — 扩展机制
- `PLUGIN-GUIDE.md` — 插件开发指南
- `semantic/README.md` — 语义联想模块
