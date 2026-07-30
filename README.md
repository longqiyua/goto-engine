# GOTO Engine

> **V2.1** · GOTO 的搜索引擎层 — 无状态、只读、冻结。
>
> 负责搜索、匹配、纠错、排序、RAG 重建，不含任何用户数据。
>
> 三语言同步：JavaScript / Kotlin / Rust，相同算法契约与 FeatureFlags。

## 四层架构

GOTO Engine V2.1 采用四层架构（内部联动，对外统一）：

| 层 | 模块 | 职责 | 回馈方向 |
|---|---|---|---|
| L1 自适应刷新层 | AdaptiveRefresh | 打字速度测量、防抖节流 | → 回馈给 Engine（调整搜索时机） |
| L2 模糊匹配层 | FuzzyMatch + IndexTree | 精确/前缀/包含/模糊/T9 匹配 | → 核心搜索结果 |
| L3 模拟智能层 | SimInt / PersonalRanker | 微观上下文、时段加分、权重加分 | → Engine 访问 Base（增强排序） |
| L4 梳理层 | PersonalReranker | 融合 Base 个人层 5 schema 重排 | → Engine 无状态重排 |

```
用户输入
    │
    ▼
┌─────────────────────────────┐
│  L1 自适应刷新层              │
│  · 打字速度 EMA              │
│  · 防抖 t1 / 节流 t2         │
│  · 回馈给 Engine：何时触发    │
└────────────┬────────────────┘
             │
             ▼
┌─────────────────────────────┐
│  L2 模糊匹配层                │
│  · 精确 / 前缀 / 包含         │
│  · 模糊（Jaccard + 顺序恢复） │
│  · T9                        │
│  · IndexTree 索引树          │
│  · 高斯核键距容错             │
└────────────┬────────────────┘
             │
             ▼
┌─────────────────────────────┐
│  L3 模拟智能层（Engine → Base）│
│  · 微观上下文加分             │
│  · 时段加分                  │
│  · 权重加分                  │
│  · BM25 自动语义检索          │
└────────────┬────────────────┘
             │
             ▼
┌─────────────────────────────┐
│  L4 梳理层（PersonalReranker）│
│  · 读 Base 个人层 5 schema   │
│  · 融合 finalScore 重排       │
│  · 无状态纯函数               │
└─────────────────────────────┘
```

## V2.1 新增能力

### 1. 梳理层（PersonalReranker）

融合 Base 个人层 5 个 schema 进行无状态重排：

| Schema | 作用 |
|--------|------|
| `feedback-chain` | 用户点击事件（query→click） |
| `heatmap` | 24h×7d 时段启动热力图 |
| `hourly-ranking` | 时段智能排名（三层） |
| `transition-matrix` | 应用转移概率矩阵 |
| `user-context` | 地理围栏偏好 |

**无状态设计**：Engine 不存储学习状态，通过 `EngineBaseBridge` 实时读取 Base 个人层数据，调用 `PersonalReranker` 纯函数重排。Base 是唯一持久状态层。

### 2. 月度 RAG 自动重建

| 组件 | 职责 |
|------|------|
| `AppListStore` | 设备应用清单持久化（`filesDir/goto/apps/installed-apps.json`），增量 diff |
| `PackageReceiver` | 静态注册，监听 ADDED/REMOVED/CHANGED/REPLACED |
| `RagRebuilder` | 重建算法纯函数，512 维向量，注入 `EmbedderPort` |
| `RagTransitionController` | 15 天线性灰度过渡，超期删旧库 |
| `RagMonthlyWorker` | WorkManager 30 天周期，约束充电+空闲+网络 |

**数据流**：设备应用清单 + Base 个人层 snapshot → BGE-small 模型生成向量 → 写 `goto-base/shared/data/personal/rag/` 新库 → 时间线性权重灰度过渡 15 天 → 删旧库。

### 3. BM25 自动语义检索

运行时无需神经网络模型，基于 documentText 自动建 BM25 倒排索引：
- 中文 unigram + bigram 分词
- IDF 加权 + 文档长度归一化
- 毫秒级检索，零依赖

**示例**：搜索"公园" → BM25 自动匹配 documentText 含"公园/景点/导航"的地图类应用，无需手写意图规则。

## 模块开关（FeatureFlags）

三语言必须保持一致的模块开关：

| Flag | 默认 | 作用 |
|---|---|---|
| `fuzzyMatch` | `true` | 模糊匹配（Jaccard + 顺序恢复 + 缩写） |
| `indexTree` | `true` | 索引树（英文单词树 + 中文汉字树 + 拼音树） |
| `adaptiveRefresh` | `true` | 自适应刷新（打字速度 + 防抖节流） |
| `simInt` | `false` | 模拟智能（微观上下文 + 时段加分） |
| `t9` | `false` | T9 模式 |
| `ragFallback` | `false` | RAG 兜底（BM25 自动检索） |
| `personalRerank` | `true` | 梳理层（PersonalReranker） |
| `ragAutoRebuild` | `true` | 月度 RAG 自动重建 |
| `ragTransitionEnabled` | `true` | RAG 灰度过渡 |

## MECE 匹配维度

| 维度 | 分数 | 说明 |
|---|---|---|
| 精确匹配 | 1000 | name/py/en/abbr 完全匹配 |
| 前缀匹配 | 800 | name/py/en/abbr 前缀匹配 |
| 包含匹配 | 600 | name/py/en/abbr 包含匹配 |
| 模糊匹配 | 50-400 | Jaccard + 顺序恢复 + 间隔字母 + 缩写（融合） |
| T9 匹配 | 700/500 | T9 模式独有 |
| 分类兜底 | 80 | 分类名包含 |
| 标签兜底 | 50 | 标签包含 |

**MECE 原则**：精确/前缀/包含/模糊 互斥，取最高分。分类和标签为低分兜底，不互斥。

## IndexTree 索引树

| 树类型 | 构建方式 | 用途 |
|---|---|---|
| 英文单词树 | 按字母建 Trie（w→e→c→h） | 英文软件名前缀/子序列匹配 |
| 中文拼音树 | 按拼音字母建 Trie | 拼音前缀/子序列匹配 |
| 中文汉字树 | 按汉字建 Trie | 汉字前缀/子序列匹配 |
| 快捷索引 | 用户设置的快捷键 | 优先级最高，直接命中 |

**高斯核按键距离**：QWERTY 键盘相邻按键距离近，按错也可低分命中，乘积关系。

## RAG 调用策略

```
规则匹配（精确/前缀/包含/模糊/T9）→ 有结果 → 返回
                                       ↓ 无结果
                                   BM25 自动检索（documentText 倒排索引）
                                       ↓
                                   PersonalReranker 重排（融合 Base 个人层）
```

**离线自动索引**：RagRebuilder + RagMonthlyWorker 月度重建向量库。
**运行时自动检索**：BM25 基于 documentText 自动建索引+检索，无需手写规则。

## Engine 维护职责

Engine 启动时自动执行一次，运行时按需触发：

| 职责 | 触发时机 | 作用 |
|---|---|---|
| 全局衰减（decay） | 启动 + 用户点击 | 对 >1 天未访问的查询权重应用时间衰减 |
| 链式边修剪（prune chain） | 启动 | 清理权重 < 1 的边；每 from-key 最多 20 个 to-key |
| 旧记忆修剪（prune memory） | 启动 | 清理 > 90 天的记忆记录，按 220 条上限保险 |
| 过期屏蔽标记清理 | 启动 + 自愈时 | 清理已过期的 block flag（默认 3 天） |
| 自愈（self-healing） | 用户改选应用 | 降低其他候选权重，临时屏蔽原默认 app，提升新选 |
| 索引重建（rebuildIndex） | 启动 + 应用增删 | 重新拉取应用并构建搜索索引 |
| RAG 重建（rebuildRag） | 月度 WorkManager | 重建个人化 RAG 向量库 + 灰度过渡 |

## 多语言版本

| 语言 | 目录 | 版本号 | 场景 | 测试 |
|---|---|---|---|---|
| JavaScript | `Javascript/` | 2.1.0 | Web / Electron / GithubPages | node --check + 运行时加载 |
| Kotlin | `Kotlin/` | v2.1.0 | Android 原生（GOTO 应用嵌入） | Gradle compileDebugKotlin |
| Rust | `Rust/` | 2.1.0 | 高性能 / 跨平台 / no_std | cargo test（173 测试通过） |

三语言共用同一套算法契约和 FeatureFlags，模块开关必须一致。

### 三语言对齐项

- **四层架构**：L1 自适应刷新 / L2 模糊匹配 / L3 模拟智能 / L4 梳理层
- **Base 桥接**：`EngineBaseBridge`（6 读 1写，读取 5 schema + affinities）
- **RAG 重建**：`RagRebuilder`（512 维，`EmbedderPort` 注入）+ `RagTransitionController`（15 天灰度）
- **BM25 检索**：`BM25RagSearch`（中文 unigram+bigram，IDF 加权）
- **维护机制**：decay / prune chain / prune memory / clear block flags / self-healing

## 接口契约

### EngineBaseBridge（三语言对齐）

```
读（6）：getAffinities / getHeatmap / getHourlyRanking / getTransitionMatrix / getUserContext / getRecentFeedback
写（1）：recordFeedbackChainEvent
```

`getPersonalSnapshot()` 一次性并行收集 5 个 schema + affinities，故障隔离（`safeRead` try/catch，失败降级 `PersonalSnapshot.degraded()`）。

### EmbedderPort（RAG 重建注入接口）

```
embed(text: String): FloatArray  // 512 维向量
```

由 app 层注入具体模型实现（如 BGE-small ONNX），Engine 不依赖具体模型。

## 核心原则

- **无状态**：Engine 不持久化任何数据，所有数据在 Base
- **RAG 自动化**：离线月度重建 + 运行时 BM25 自动检索，无需手写规则
- **三语言同步**：JS / Kotlin / Rust 相同算法契约、FeatureFlags、接口（12 项功能全部对齐）
- **接口不变**：EngineBaseBridge 现有 6 读 1 写不动；Engine 对外 API 不变

## 目录结构

```
GOTO Engine/
├── Javascript/          # JS 版（Web / GithubPages）
│   ├── goto-engine.js   # 主引擎
│   ├── base-bridge.js   # Base 桥接
│   ├── algorithms/
│   │   ├── rerank/      # PersonalReranker
│   │   ├── rag/         # RagRebuilder + RagTransition + BM25RagSearch
│   │   └── semantic/    # SemanticSearch
│   └── model-runner/    # RAG 构建工具（BGE embedder）
├── Kotlin/              # Kotlin 版（Android 嵌入）
│   └── src/main/java/com/appindex/
│       ├── AppRegistry/ # AppListStore + PackageReceiver
│       ├── Rerank/      # PersonalReranker + EngineBaseBridge + RagRebuilder + RagTransition + RagMonthlyWorker
│       └── component/   # GotoEngineFacade
└── Rust/                # Rust 版（高性能 / no_std）
    └── src/
        ├── rag_rebuilder.rs
        ├── rag_transition.rs
        ├── base_bridge.rs
        └── maintenance.rs
```

## License

GNU AGPL-3.0（详见 [LICENSE](LICENSE)）。
