# GOTO Engine — Kotlin 版本

> 📱 Android 原生版本
>
> 聚焦 Android 原生应用搜索匹配场景：`AppSearchEngine` 实现 18 层匹配维度 + 并行协程；
> `FuzzyMatchEngine` 实现 QWERTY/T9 双布局键盘感知编辑距离；`AdaptiveRefresh` 提供可丢弃搜索调度。
> SQLite + SharedPreferences 双轨存储。License：GNU AGPL-3.0（详见 [LICENSE](LICENSE)）。

## 版本

**V2.1 update**

- 搜索管线改为：`exactSearch` → `prefixSearch` → `fuzzySearch`
- `IndexData` 中的 Trie 前缀树支持精确/前缀扩展召回，并暴露扩展接口
- 精确/前缀结果可按统计信息排序（不依赖模拟智能）

## 模块清单

| 模块 | 路径 | 职责 |
|---|---|---|
| `FuzzyMatchEngine` | `src/main/java/com/appindex/FuzzyMatch/FuzzyMatchEngine.kt` | 键盘感知模糊匹配 v1.1（QWERTY 26 键 + T9 九宫格双布局，邻位误触成本分级） |
| `AppSearchEngine` | `src/main/java/com/appindex/BasicSearch/AppSearchEngine.kt` | 18 层匹配维度 + 并行协程 + 提前终止 + LRU 缓存 |
| `MetaTagEngine` | `src/main/java/com/appindex/BasicSearch/MetaTagEngine.kt` | MECE 分类 + 同义词簇语义索引（配合 `MetaTagIndex`） |
| `PinyinConverter` | `src/main/java/com/appindex/BasicSearch/PinyinConverter.kt` | 汉字转拼音（GB2312 紧凑数组 O(1) 查找） |
| `AdaptiveRefresh` | `src/main/java/com/appindex/AdaptiveRefresh/` | 可丢弃搜索调度（`SearchOrchestrator` 防抖节流 + `TypingSpeedTracker` 双轨打字速度） |
| `IndexData`（IndexTree + Trie） | `src/main/java/com/appindex/IndexData/IndexData.kt` | 索引树数据结构（英文单词树 + 中文汉字树 + 拼音树 + Trie 前缀树） |
| `SmartPredictionEngine` | `src/main/java/com/appindex/prediction/SmartPredictionEngine.kt` | 智能预测 5 槽位软稳定机制（3 本时段高频 + 2 全天高频） |
| `ConfigurationData` | `src/main/java/com/appindex/ConfigurationData/ConfigurationData.kt` | 配置数据结构（含 `SearchConfig` 模块开关） |

附加模块：

- `BasicSearch/AppIndexEngine.kt` — 扫描系统已安装应用，预计算拼音/首字母/T9/charSet
- `BasicSearch/SearchService.kt` — UI 与搜索层分离、异步优先、请求合并、取消支持
- `Database/` — SQLite 存储层（`AppDatabase` + `IndexDao` / `StatisticsDao` / `ConfigDao` + `Tables` + `JsonCodec`）
- `StatisticsData/` — 统计数据结构 + 使用统计管理器
- `model/` — SearchResult / SearchMode / AppInfo
- `Personalization/KeyboardLayout.kt` — 键盘布局 + 输入语言枚举
- `component/` — 组件层封套（与 JS/Rust 对齐）：`EngineComponent` + `QueryResponse` + 事件系统 + 错误码
- `modules/` — `FuzzyMatchModule` + `AdaptiveRefreshModule`（自包含独立导出版本）

## 搜索管线：精确 → 前缀 → 模糊

```
runSearchPipeline(query, apps)
    ├── exactSearch(query, apps)      # 完整 term 精确命中
    ├── prefixSearch(query, apps)     # Trie 前缀树扩展召回
    └── fuzzySearch(query, apps)      # 模糊匹配兜底
```

- **精确匹配**：name / py / en / abbr 完全等于 query。
- **前缀索引**：基于 `IndexData` 中的 Trie 返回所有以 query 开头的 App；节点维护 `ids`（前缀下全部 App）和 `terminals`（精确结尾 App）。
- **模糊匹配**：仅当前两级无结果时兜底。

### 统计型排序（不依赖模拟智能）

精确/前缀命中的结果会按以下统计信息排序，**无需开启模拟智能**：

- 启动次数
- 最近使用时间
- 是否已安装
- 时段偏好
- 模式频率

## Trie 前缀树扩展接口（隐藏入口）

```kotlin
val trie = IndexData.getTrieIndex()
trie.insert(term, appOrId)
trie.remove(term, appOrId)
trie.exactSearch(term)
trie.prefixSearch(prefix)
trie.rebuild(apps)
trie.root
```

Kotlin 版 Trie 节点结构：

```kotlin
data class TrieNode(
    val children: MutableMap<Char, TrieNode> = mutableMapOf(),
    val ids: MutableSet<String> = mutableSetOf(),      // 经过该前缀的全部 App ID
    val terminals: MutableSet<String> = mutableSetOf() // 恰好以该节点结尾的 App ID
)
```

## FeatureFlags 使用

通过 `ConfigurationData.kt` 中的 `SearchConfig` 配置模块开关，三语言必须保持一致：

```kotlin
val config = SearchConfig(
    fuzzyMatch = true,        // 模糊匹配（Jaccard + 顺序恢复 + 缩写）
    indexTree = true,         // 索引树（英文单词树 + 中文汉字树 + 拼音树 + Trie 前缀树）
    adaptiveRefresh = true,   // 自适应刷新（打字速度 + 防抖节流）
    simInt = false,           // 模拟智能（微观上下文 + 时段加分）
    t9 = false,               // T9 模式
    ragFallback = false,      // RAG 兜底（最后调用，预留）
)
```

| Flag | 默认 | 作用 |
|---|---|---|
| `fuzzyMatch` | `true` | 模糊匹配（Jaccard + 顺序恢复 + 缩写） |
| `indexTree` | `true` | 索引树（英文单词树 + 中文汉字树 + 拼音树 + Trie 前缀树） |
| `adaptiveRefresh` | `true` | 自适应刷新（打字速度 + 防抖节流） |
| `simInt` | `false` | 模拟智能（微观上下文 + 时段加分） |
| `t9` | `false` | T9 模式 |
| `ragFallback` | `false` | RAG 兜底（最后调用，预留） |

## v3.2 增强

Kotlin 版在 v3.2 引入以下增强：

- **高斯核键距**：QWERTY 键盘相邻按键距离近，按错也可低分命中（乘积关系）。`FuzzyMatchEngine` 邻位误触成本分级，输入语言自动检测路由
- **ClickDelay EMA**：点击延迟指数移动平均，`TypingSpeedTracker` 双轨打字速度测量（中文 CPM + 英文 WPM），回馈给 Engine 调整搜索时机
- **犹豫补偿**：`AdaptiveRefresh/SearchOrchestrator` 实现可丢弃搜索调度，防抖 Debounce + 节流 Throttle + 基于打字速度的自适应延迟（t1/t2 公式），对用户犹豫输入进行补偿

## 组件层调用

```kotlin
import com.appindex.component.EngineComponent
import com.appindex.component.QueryOptions

val component = EngineComponent.create(context)
component.setAppDataset(apps)
val response = component.query("微信", QueryOptions(limit = 10))
// → QueryResponse { ok, data, error, requestId, latencyMs, timestamp, localOnly }
```

## 相关文档

- 根目录 [`../README.md`](../README.md) — 三语言总览与架构
