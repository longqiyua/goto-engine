# GOTO Engine — Rust 版本

> **声明：本目录是 GOTO Engine 仓库根目录 `README.md` 的副本**，内容与根目录 README 完全一致，仅在标题与开头补充本版本声明信息。如需查看最权威、最详细的三版本总览，请阅读根目录 [`../README.md`](../README.md)。
>
> **本目录为 GOTO Engine 的 Rust 实现（跨平台端口）**。是 `goto-engine.js` v3.2.0 的完整逻辑复制端口。算法逐行对齐 JS 版（常量、键名、数据结构、行为契约、Component API 五重对齐）。独立 crate，可被 Android JNI / Electron IPC / WASM 共用，下游可桥接 SharedPreferences/Room、localStorage/electron-store、IndexedDB、SQLite 等存储后端。多线程安全（`Arc<RwLock>`），no_std 友好（`spin` + `alloc`），117 个测试全部通过。License：GNU AGPL-3.0（详见 [LICENSE](LICENSE)）。

---

> **GOTO Engine 是 GOTO 搜索能力的算法运行时与对外 API 的权威入口**，专注于"本地优先 + 隐私安全"的智能搜索与意图引擎。独立于 GOTO 页面之外存在——GOTO 页面只是 Engine 的一个实现良好的客户端。本仓库包含三个语言实现：`Javascript/`（模拟智能母体）+ `Rust/`（跨平台端口）+ `Kotlin/`（Android 应用搜索引擎）。JS/Rust 双版本保持五重对齐（常量、键名、数据结构、行为契约、Component API）；Kotlin 版本聚焦 Android 应用搜索匹配，与 JS/Rust 互补而非完全对等。

## 版本信息

| 维度 | Javascript 版本 | Rust 版本 | Kotlin 版本 |
| --- | --- | --- | --- |
| 引擎版本 | v3.2.0 | v3.2.0 | v5.0（AppSearchEngine） |
| 组件 API 版本 | v1.0.0 | 1.0.0 | 1.0.0 |
| 插件 API 版本 | v1.0.0 | — | — |
| 运行环境 | 浏览器 / WebView / Node.js | Android JNI / Electron IPC / WASM / 嵌入式 | Android（原生） |
| License | GNU AGPL-3.0 | GNU AGPL-3.0 | GNU AGPL-3.0 |
| 并发模型 | 单线程事件循环 | `Arc<RwLock>` 多线程安全 | Kotlin 协程（`Dispatchers.IO`） |
| no_std 支持 | 不支持 | 支持（`spin` + `alloc`） | 不适用 |
| 测试 | 在主仓 `AppIndex/GOTO-Engine/` | 117 个测试全部通过 | 跟随主仓 |
| 存储 | 直接 `localStorage` | `Storage` trait（含 `MemoryStorage`） | SQLite + SharedPreferences |
| 插件宿主 | 有（`GOTOPlugin`） | 无 | 无 |
| 反馈通道 | 有（`GOTOFeedback`） | 无 | 无 |
| 模块数 | 18 模块 + 组件/插件/反馈 | 18 模块 + 组件 | 5 核心 + 数据/存储层 |
| 模拟智能 | 完整 18 模块 | 完整 18 模块 | 仅 SmartPredictionEngine |
| 应用搜索匹配 | 基础 | 基础 | 18 层匹配维度 + 键盘感知 |

### 版本历史补充

- **v3.3（规划中）**：微观上下文 Micro-Context（phoneUsage/location/clipboard/deviceInfo）已在 JS 版落地，Rust 版待对齐
- **v3.2.0（当前）**：JS/Rust 18 模块全部移植，五重对齐达成；Rust 版 117 测试通过
- **v1.0.0（组件 API）**：版本化 envelope、事件系统、错误码（`ENGINE_UNAVAILABLE` / `INVALID_QUERY` / `ENGINE_FAILURE`）
- **Kotlin v5.0**：AppSearchEngine 18 层匹配维度 + 并行协程；FuzzyMatchEngine v1.1 键盘感知编辑距离

---

## 一、介绍

GOTO Engine 是一款专注于"本地优先 + 隐私安全"的智能搜索与意图引擎。

**核心定位**：

- 可脱离 GOTO 页面单独加载的本地搜索组件
- 算法运行时与对外 API 的权威入口
- 全部搜索、索引、上下文、反馈默认在本地完成
- 不依赖云端，无外部依赖

**三版本关系**：

- `Javascript/` 是模拟智能母体，单文件 IIFE 封装，零依赖、零构建、即插即用，包含完整 18 模块（intent/learning/bayes/nlp/semantic/self_healing/association/weights/negative/context/maintenance/pro/filter 等）
- `Rust/` 是 JS 版的跨平台端口，模块化 crate，多线程安全，no_std 友好，与 JS 版五重对齐
- `Kotlin/` 是 Android 应用搜索引擎，聚焦应用搜索匹配（拼音/T9/键盘感知模糊匹配），含 SQLite 存储层与协程并发，与 JS/Rust 互补而非完全对等

---

## 二、设计

### 为何如此设计

**1. 引擎与页面解耦**

Engine 可独立运行，GOTO 页面只是一个客户端。这样设计的好处：
- Engine 可被任意宿主复用（WebView / Electron / Node.js / Android JNI / WASM）
- 页面故障不会拖垮引擎主链路
- 算法升级与 UI 升级解耦

**2. 多语言分工**

- JS 版作为模拟智能母体（快速迭代、浏览器即插即用，完整 18 模块）
- Rust 版作为高性能/跨平台端口（多线程、no_std、嵌入式，五重对齐 JS）
- Kotlin 版作为 Android 原生搜索引擎（直接扫描 PackageManager、协程并行、键盘感知匹配）

JS/Rust 五重对齐保证双版本可在不同宿主下产出一致结果；Kotlin 版聚焦 Android 应用搜索场景，与 JS/Rust 互补。

**3. 本地优先 + 隐私安全**

所有数据存储在本地（JS：`localStorage`；Rust：`Storage` trait 可桥接 SharedPreferences/Room、localStorage/electron-store、IndexedDB、SQLite；Kotlin：SQLite + SharedPreferences）。不上传任何用户数据。

**4. 三阶搜索管线（JS/Rust）**

`query()` → `sanitizeQuery()` 清洗 → `runSearch_pipeline()`（fuzzy → meta → tfidf+trie 三阶优先级）→ 重排（含 PRO/贝叶斯/语义 boost）→ 封装为 `EngineEnvelope` 返回。

**5. 18 层匹配维度（Kotlin 特色）**

`AppSearchEngine` v5 实现 18 层匹配维度 + 并行协程 + 提前终止 + 键盘误触容错 + 使用频率加权 + LRU 缓存；`FuzzyMatchEngine` v1.1 实现 QWERTY/T9 双布局键盘感知编辑距离。

**6. 读写分离**

`query()` 只读候选；只有明确调用 `record*` 函数才写入反馈。避免误触发污染学习记忆。

**7. 存储抽象（Rust 版特色）**

Rust 版 `Storage` trait（`get_string` / `set_string` / `remove_string` / `keys`），内置 `MemoryStorage`，支持 `EngineSnapshot::export/import`。下游可桥接任意存储后端。

**8. 自适应刷新调度（Kotlin 独有）**

`AdaptiveRefresh/SearchOrchestrator` + `TypingSpeedTracker` 实现"可丢弃搜索"调度：防抖 Debounce + 节流 Throttle + 基于打字速度的自适应延迟（t1/t2 公式）。JS 单线程不需此机制；Rust 由调用方处理。

**9. 关键常量**

- `WEIGHT_DECAY`：半衰期 30 天 / 下限 0.35
- `SIM_TRANSFER`：传递比例 0.2 / 前缀长度 2 / 重叠率 0.5
- `MAINTENANCE`：链边上限 500 / 每节点 20 / 记忆上限 220 条 / 90 天
- `BLOCK_FLAG_DEFAULT_DAYS=3`
- `BLOCK_FLAG_MAX_ENTRIES=200`

---

## 三、功能

### JS/Rust 版本（18 模块全部移植，双版本一一对应）

1. **storage**（Rust）/ localStorage 直连（JS） — 存储抽象
2. **filter** — `sanitize_query`（7 条清洗规则）
3. **nlp** — Porter / BPE / Soundex / 拼音 / T9
4. **index** — 倒排 / 元标签 / Trie / TF-IDF
5. **intent** — `extract_tokens`
6. **search** — `fuzzy_search` / `meta_search` / `run_search_pipeline`
7. **learning** — `record_selection` 行为记忆
8. **weights** — 权重管理 + 30 天半衰期衰减
9. **negative** — `add_block_flag` / `remove_block_flag`
10. **self_healing** — 用户改选后自愈
11. **association** — 隐式 Markov 链（`ChainEdge`）
12. **stats** — 4 时段统计 / Top N
13. **context** — 上下文管理（最近 app / 时段）
14. **maintenance** — `_decay_all_stale_queries` 引擎自主维护
15. **bayes** — 贝叶斯意图过滤（P>0.6 注入 boost）
16. **pro** — 65 维用户偏好向量
17. **smart_reminder** — 智能提醒核心算法
18. **semantic** — L1/L2/L3 三层语义联想（可选模块）

附加：`engine`（主类）、`component`（封套）、`constants`、`utils`、`types`。JS 版另含 `plugin-api`（插件宿主）+ `feedback`（反馈通道）。

### Kotlin 版本（Android 应用搜索引擎，5 核心 + 数据/存储层）

1. **BasicSearch** — 应用索引 + 搜索 + 元标签 + 拼音
   - `AppIndexEngine`：扫描系统已安装应用，预计算拼音/首字母/T9/charSet
   - `AppSearchEngine`：18 层匹配维度 + 并行协程 + 提前终止 + LRU 缓存
   - `MetaTagEngine` + `MetaTagIndex`：MECE 分类 + 同义词簇语义索引
   - `PinyinConverter`：汉字转拼音（GB2312 紧凑数组 O(1) 查找）
   - `SearchService`：UI 与搜索层分离、异步优先、请求合并、取消支持
2. **FuzzyMatch** — 键盘感知模糊匹配
   - `FuzzyMatchEngine` v1.1：QWERTY 26 键 + T9 九宫格双布局，邻位误触成本分级，输入语言自动检测路由
3. **AdaptiveRefresh** — 自适应刷新调度（Kotlin 独有）
   - `SearchOrchestrator`：可丢弃搜索调度、防抖、节流
   - `TypingSpeedTracker`：双轨打字速度测量（中文 CPM + 英文 WPM）
4. **prediction** — 智能预测
   - `SmartPredictionEngine`：5 槽位软稳定机制（3 本时段高频 + 2 全天高频）
5. **Database** — SQLite 存储层
   - `AppDatabase` + `IndexDao` / `StatisticsDao` / `ConfigDao` + `Tables` + `JsonCodec`

附加：`IndexData` / `StatisticsData` / `ConfigurationData` / `TestData`（数据类）、`model`（SearchResult/SearchMode/AppInfo）、`utility/MatchTypeLabel`、`Personalization/KeyboardLayout`（键盘布局枚举）、`modules/`（FuzzyMatchModule + AdaptiveRefreshModule 自包含独立导出版本）

---

## 四、代码

### Javascript 版本（`Javascript/`）

| 文件 | 职责 |
|---|---|
| `goto-engine.js` | 算法运行时，IIFE 单文件，含 `engine` 对象 + `installGlobals()` |
| `goto-engine-component.js` | 独立组件 API（版本化 envelope，事件系统，错误码） |
| `component-api.d.ts` | 组件 API 类型契约（公开契约） |
| `interface.d.ts` | 引擎底层接口类型（v3.2.0） |
| `plugin-api.js` + `plugin-api.d.ts` | 插件宿主与类型 |
| `feedback.js` | 反馈通道（本地缓冲 200 条 + 可选远端） |
| `PLUGIN-GUIDE.md` / `EXTENSIONS.md` / `Intro.md` | 扩展文档 |
| `semantic/` | 可选语义扩展（loader + config + pinyin-index + 22 个首字母分片） |

### Rust 版本（`Rust/`）

| 文件 | 职责 |
|---|---|
| `Cargo.toml` | 包配置（v3.2.0，edition 2021，AGPL-3.0-or-later） |
| `src/lib.rs` | 模块声明 + 公开导出 + `VERSION`/`API_VERSION` 常量 + `prelude` |
| `src/engine.rs` | `GotoEngine<S: Storage>` 主类（约 40+ pub 方法） |
| `src/component.rs` | `EngineComponent` 封套 + `QueryResponse` / `QueryOptions` / 事件系统 |
| `src/storage.rs` | `Storage` trait + `MemoryStorage` + `EngineSnapshot` |
| `src/filter.rs` | `sanitize_query` + `SanitizeResult` 枚举 |
| `src/{constants,utils,types,nlp,index,intent,search,learning,weights,negative,self_healing,association,stats,context,maintenance,bayes,pro,smart_reminder,semantic}.rs` | 18 模块实现 |
| `benches/search_bench.rs` | 基准测试 |

**Rust 依赖**：`serde`/`serde_json`、`regex`、`lru 0.12`、`once_cell 1.19`、`thiserror 1.0`、`chrono`、`spin 0.9`；dev：`pretty_assertions 1.4`。

### Kotlin 版本（`Kotlin/`）

| 目录/文件 | 职责 |
|---|---|
| `src/main/java/com/appindex/BasicSearch/` | 应用索引 + 搜索 + 元标签 + 拼音（6 文件） |
| `src/main/java/com/appindex/FuzzyMatch/FuzzyMatchEngine.kt` | 键盘感知模糊匹配 v1.1 |
| `src/main/java/com/appindex/AdaptiveRefresh/` | 自适应刷新调度（2 文件） |
| `src/main/java/com/appindex/prediction/SmartPredictionEngine.kt` | 智能预测 5 槽位 |
| `src/main/java/com/appindex/Database/` | SQLite 存储层（6 文件） |
| `src/main/java/com/appindex/IndexData/` | 索引数据结构 |
| `src/main/java/com/appindex/StatisticsData/` | 统计数据结构 + 使用统计管理器 |
| `src/main/java/com/appindex/ConfigurationData/` | 配置数据结构 |
| `src/main/java/com/appindex/TestData/` | 测试数据结构 |
| `src/main/java/com/appindex/model/` | SearchResult / SearchMode / AppInfo |
| `src/main/java/com/appindex/utility/MatchTypeLabel.kt` | 匹配类型标签工具 |
| `src/main/java/com/appindex/Personalization/KeyboardLayout.kt` | 键盘布局 + 输入语言枚举 |
| `src/main/java/com/appindex/component/` | **组件层封套**（与 JS/Rust 对齐）：`EngineComponent` + `GotoEngineFacade` + `DefaultEngineFacade` + `QueryResponse` + `QueryOptions` + `ErrorCode` + `EventBus` + `EventType` + `ComponentStatus` + `Versions` |
| `modules/FuzzyMatchModule/FuzzyMatchEngine.kt` | 自包含独立导出版本 |
| `modules/AdaptiveRefreshModule/AdaptiveRefresh.kt` | 自包含独立导出版本 |
| `app/build.gradle.kts` | 模块级 Gradle 构建配置（Android Library） |
| `build.gradle.kts` + `settings.gradle.kts` + `gradle.properties` | 项目级 Gradle 配置 |
| `app/src/main/AndroidManifest.xml` | Android Library 清单 |
| `LICENSE` | GNU AGPL-3.0 全文 |

**Kotlin 依赖**：`kotlinx.coroutines`（协程）、Android `SQLiteOpenHelper`、`SharedPreferences`、`PackageManager`、`androidx.core:core-ktx`、`org.json:json`。

---

## 五、调用

### 5.1 组件层（JS/Rust 推荐入口）

**Javascript**：

```javascript
const component = GOTOEngineComponent.create({ engine, dataset, storage });
const result = component.query(query, { limit, requestId, context });
// → EngineEnvelope { ok, data, requestId, latency, timestamp, localOnly }
component.setAppDataset(apps);
component.recordSearch(query);
component.recordSelection(query, appName);
component.setContext(ctx);
component.on(type, listener);
```

**Rust**：

```rust
use goto_engine::{EngineComponent, QueryOptions};
let component = EngineComponent::new();
let resp: QueryResponse = component.query(q, QueryOptions::default())?;
component.set_app_dataset(apps);    // → usize
component.record_selection(q, app)?;
component.set_context(ctx);
component.on(type_, listener)?;     // → EventHandle
```

### 5.2 底层 Engine（JS/Rust）

**Javascript**（约 40+ 方法，详见 `interface.d.ts`）：

```javascript
GOTOEngine.fuzzySearch(query, apps);
GOTOEngine.metaSearch(query, apps);
GOTOEngine.runSearchPipeline(query, apps);
GOTOEngine.recordSelection(query, appName);
GOTOEngine.addBlockFlag(query, app, days);
GOTOEngine.applySelfHealing(query, newApp, candidates);
GOTOEngine.getAssociationRecommendation(app, topN);
GOTOEngine.maintain();
```

**Rust**：

```rust
use goto_engine::{GotoEngine, MemoryStorage};
let engine = GotoEngine::new();
engine.fuzzy_search(q, apps);
engine.run_search_pipeline(q, apps);  // → SearchContext
engine.record_selection(q, app)?;     // → MemoryRecord
engine.add_block_flag(q, app, days);
engine.apply_self_healing(q, new_app, candidates);
engine.get_association_recommendation(app, top_n);
engine.maintain();                    // → MaintenanceReport
```

### 5.3 Kotlin 版（组件层，与 JS/Rust 对齐）

```kotlin
import com.appindex.component.EngineComponent
import com.appindex.component.QueryOptions
import com.appindex.component.EventType

// 工厂创建（内部聚合 AppIndexEngine/AppSearchEngine/MetaTagEngine 等核心类）
val component = EngineComponent.create(context)

// 数据集管理
component.setAppDataset(apps)  // → Int（应用数）

// 查询（版本化响应，与 JS EngineEnvelope / Rust QueryResponse 对齐）
val response = component.query("微信", QueryOptions(limit = 10))
// → QueryResponse { ok, data, error, requestId, latencyMs, timestamp, localOnly }
if (response.ok) {
    response.data.forEach { println(it.appName) }
} else {
    println("错误: ${response.error?.code} - ${response.error?.message}")
}

// 兼容旧调用（直接返回结果列表）
val results = component.search("微信")

// 记录反馈
component.recordSearch("微信")
component.recordSelection("微信", "WeChat")
component.recordUnknownApp("wx", "WeChat")

// 上下文
component.setContext(mapOf("recentApp" to "WeChat"))
component.clearContext()

// 事件系统
val handle = component.on(EventType.AFTER_SEARCH) { payload ->
    println("搜索完成: latencyMs=${payload["latencyMs"]}")
}
component.off(EventType.AFTER_SEARCH, handle)

// 状态查询
val status = component.status()
// → ComponentStatus { version, apiVersion, ready, datasetSize, localOnly, eventTypes }

// 引擎自主维护
component.maintain()

// 销毁
component.destroy()
```

底层访问（高级场景，通过 `raw()` 获取 `GotoEngineFacade`）：

```kotlin
val facade = component.raw()  // GotoEngineFacade 实例
// facade.searchEngine() / facade.indexEngine() / facade.orchestrator()（DefaultEngineFacade 专有）
```

### 5.4 插件宿主（仅 JS 版）

```javascript
GOTOPlugin.register(plugin);
GOTOPlugin.list();
GOTOPlugin.query(query);
// Hook：beforeSearch / afterSearch / beforeRender / onFeedback / onError
```

### 5.5 反馈通道（仅 JS 版）

```javascript
GOTOFeedback.send(event);
GOTOFeedback.list();
GOTOFeedback.configure(opts);
```

### 5.6 Storage trait（仅 Rust 版）

```rust
use goto_engine::{Storage, MemoryStorage, EngineSnapshot};
trait Storage: Send + Sync + Debug {
    fn get_string(&self, key: &str) -> Option<String>;
    fn set_string(&self, key: &str, value: &str);
    fn remove_string(&self, key: &str);
    fn keys(&self) -> Vec<String>;
}
let storage = MemoryStorage::new();
EngineSnapshot::export(&storage);
EngineSnapshot::import(&storage, snapshot);
```

---

## 六、边界

### 6.1 安全措施

- **本地优先**：搜索、索引、上下文、反馈默认全部本地完成
- **读写分离**：`query()` 只读候选；只有明确调用 `record*` 函数才写入反馈
- **重排约束**：高级模块只能重排已有可信候选，不能凭空制造无关应用
- **故障隔离**：页面、文档或主题故障不能阻断 Engine 主链路；semantic 缺失不影响引擎
- **错误结构化**：组件不抛可预期错误，返回失败包（`ENGINE_UNAVAILABLE` / `INVALID_QUERY` / `ENGINE_FAILURE`），仍含 requestId/latency/timestamp/localOnly
- **反馈缓冲**（JS）：默认本地缓冲 200 条，不开启远端上报
- **多线程安全**（Rust）：`Arc<RwLock>` 保护所有共享状态
- **存储可插拔**（Rust）：`Storage` trait 抽象，下游可扩展任意后端
- **no_std 友好**（Rust）：关闭 `std` feature 后进入 no_std 模式（`spin` + `alloc`）
- **测试覆盖**（Rust）：117 个测试全部通过，覆盖所有 18 模块核心算法
- **协程并发**（Kotlin）：`Dispatchers.IO` + `ConcurrentHashMap`/`CopyOnWriteArrayList`/`AtomicInteger` 线程安全
- **请求合并与取消**（Kotlin）：`SearchService` 异步优先、请求合并、取消支持、LRU 缓存

### 6.2 query 清洗 7 条规则（JS/Rust `sanitizeQuery` / `sanitize_query`）

1. trim 后非空
2. 长度 2-40
3. 必须含字母/数字/中文
4. 纯数字且非 T9 字符（2-9）拒绝
5. 重复字符率 ≤ 0.6
6. 不含控制字符
7. 连续重复截断为 3

### 6.3 组件契约

- JS：`component-api.d.ts` 是公开契约；`interface.d.ts` 描述底层运行时
- Rust：`EngineComponent` 与 JS 版 `GOTOEngineComponent` 行为对齐；`QueryResponse` 与 JS 版 `EngineEnvelope` 格式对齐
- Kotlin：`EngineComponent` 与 JS 版 `GOTOEngineComponent` / Rust 版 `EngineComponent` 行为对齐；`QueryResponse` 与 JS 版 `EngineEnvelope` / Rust 版 `QueryResponse` 格式对齐；`GotoEngineFacade` 接口定义引擎核心契约；`ErrorCode` 三版本错误码语义一致（`ENGINE_UNAVAILABLE` / `INVALID_QUERY` / `ENGINE_FAILURE`）；`EventType` 五种事件类型与 JS/Rust 字符串值一致（`beforeSearch` / `afterSearch` / `beforeRender` / `onFeedback` / `onError`）

### 6.4 feature flag（Rust 版）

- `std`（默认开）
- `semantic`（默认开）
- `wasm`（默认关）
- `strict`（默认关，JSON Schema 校验）

---

## 七、可能 BUG

### 7.1 已知边界情况

- **键名漂移风险**（JS）：v3.0/v3.2/v3.3 多次新增 STORAGE 键（globalPref/clickDelayEMA/modeFrequency/cycleTimestamps/microContext），跨版本升级时可能出现键名遗漏或读取旧值

- **sanitizeQuery 阈值细微不一致**（JS/Rust）：JS 版重复率检查 `> 0.6 && chars.length >= 4`，Rust 版 `>= 0.6 && total >= 3`（`Rust/src/filter.rs` L56）——阈值符号（`>` vs `>=`）和触发长度（4 vs 3）不同，可能导致同一 query 在两端清洗结果不同。这是文档承诺"逐行对齐"下的实际差异，**最值得注意**

- **JS 版"纯数字且非 T9 字符拒绝"规则在 Rust 版未见对应分支**：`Rust/src/filter.rs` 注释提到"纯数字（且长度 ≤ 6）直接拒绝"，但实现中未见对 T9 字符 2-9 的放行逻辑，与 JS 版 `/^[2-9]+$/` 放行规则可能不一致

- **lastSearchContext 全局污染**（JS）：`lastSearchContext` 来自 `global._lastSearchContext`，多实例或多次调用可能跨上下文污染

- **installGlobals 命名空间膨胀**（JS）：约 50+ 全局别名挂到 `window`，与第三方脚本冲突风险高

- **no_std 自旋锁竞争**（Rust）：`spin::rwlock` 在高并发下可能忙等浪费 CPU，不适合高频写场景

- **包声明与物理目录不一致**（Kotlin）：`TypingSpeedTracker.kt` 物理位于 `AdaptiveRefresh/` 但 `package` 声明为 `com.appindex.Personalization`，复制时需保留此包声明或修正目录结构

- **隐藏跨目录依赖**（Kotlin）：`FuzzyMatchEngine` 依赖 `Personalization/KeyboardLayout.kt`（纯枚举），复制时必须一并包含

### 7.2 静默失败 / 精度风险

- **try/catch 静默失败**（JS）：启动时 `maintain()`、semantic 初始化均用 try/catch 吞错，部分模块可能静默失效而无日志

- **Micro-Context 字段缺失**（JS）：`getMicroContext` 强制补默认字段，但 `updateMicroContext` 用 `Object.keys(partial.*)` 遍历，若 partial 字段为 undefined 不会写入，可能出现部分更新不一致

- **Storage trait 实现责任**（Rust）：trait 要求 `Send + Sync + Debug`，下游错误实现（如忽略 `set_string` 失败）会导致数据丢失而无引擎层报错

- **跨版本浮点精度差异**：JS `number` 与 Rust `f64` 在权重衰减、贝叶斯概率计算上理论一致，但 `WEIGHT_DECAY_MIN_FLOOR=0.35` 等常量在两端浮点比较可能产生边界差异

- **模拟智能模块缺失**（Kotlin）：Kotlin 版未实现 JS/Rust 的 13 个模块（intent/learning/bayes/nlp/semantic/self_healing/association/weights/negative/context/maintenance/pro/filter），跨版本功能不对等

### 7.3 易出错场景

- **跨查询相似权重传递**（JS/Rust）：`SIM_TRANSFER.PREFIX_LEN=2` 对 2 字符前缀的短查询可能误判为相似，导致权重错误传递
- **测试套件不在分发副本中**（JS）：README 注明测试在 `AppIndex/GOTO-Engine/`，分发副本无测试，存在版本漂移风险
- **"严格对齐"是文档承诺**（JS/Rust）：117 个测试覆盖核心算法，但跨语言等价测试（同一输入两端输出完全一致）未见明确说明，可能存在字符串处理/排序稳定性边界差异
- **`panic = "abort"`**（Rust）：release 模式下任何 panic 直接终止进程，无 unwind，单次错误可能拖垮整个宿主进程（适合独立核心，但嵌入到其他进程时需注意）
- **License 统一**：三个版本均采用 GNU AGPL-3.0，确保开源传染性一致
- **会员/付费功能内嵌**（Kotlin）：`SearchMode.FUZZY_ENGINE` 标注"付费功能，默认关闭"；`MatchType` 中有"FUZZY_ENGINE_*（付费）"维度；`UsageStatisticsManager` 注释标"会员功能"

---

## 相关文档

- `Javascript/Intro.md` — 引擎简介
- `Javascript/EXTENSIONS.md` — 扩展机制
- `Javascript/PLUGIN-GUIDE.md` — 插件开发指南
- `Javascript/semantic/README.md` — 语义联想模块
- `Javascript/README.md` — Javascript 版本副本（含声明信息）
- `Rust/README.md` — Rust 版本副本（含声明信息）
- `Kotlin/README.md` — Kotlin 版本副本（含声明信息）
