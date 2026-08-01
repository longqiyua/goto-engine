# GOTO Engine — Rust 版本

> 🦀 Rust 版本（高性能 / 跨平台）
>
> 是 `goto-engine.js` v2.1.0 的完整逻辑复制端口，算法逐行对齐 JS 版（常量、键名、数据结构、行为契约、Component API 五重对齐）。
> 独立 crate，多线程安全（`Arc<RwLock>`），no_std 友好（`spin` + `alloc`），117 个测试全部通过。
> License：GNU AGPL-3.0（详见 [LICENSE](LICENSE)）。

## 版本

**V2.1 update**

- 搜索管线改为：`exact_search` → `prefix_search` → `fuzzy_search`
- `TrieIndex` 支持精确/前缀扩展召回，并暴露扩展接口
- 精确/前缀结果可按统计信息排序（不依赖模拟智能）

## 模块清单

| 文件 | 职责 |
|---|---|
| `src/engine.rs` | `GotoEngine<S: Storage>` 主类（约 40+ pub 方法） |
| `src/search.rs` | 搜索管线（`exact_search` / `prefix_search` / `fuzzy_search` / `meta_search` / `run_search_pipeline`） |
| `src/component.rs` | `EngineComponent` 封套 + `QueryResponse` / `QueryOptions` / 事件系统 |
| `src/index.rs` | 索引层：`InvertedIndex`（倒排）+ `MetaIndex`（元标签）+ `TfidfIndex`（TF-IDF）+ `TrieIndex`（Trie 树） |
| `src/nlp.rs` | 自然语言处理：拼音转换 + T9 编码 + Porter / BPE / Soundex |
| `src/utils.rs` | 工具函数：Jaccard 相似度 + 顺序恢复 + 间隔字母 + 缩写融合 |
| `src/types.rs` | 类型定义：`MatchType` 匹配类型枚举 |

附加模块（18 模块完整移植，与 JS 版一一对应）：

- `src/lib.rs` — 模块声明 + 公开导出 + `VERSION`/`API_VERSION` 常量 + `prelude`
- `src/storage.rs` — `Storage` trait + `MemoryStorage` + `EngineSnapshot`
- `src/filter.rs` — `sanitize_query` + `SanitizeResult` 枚举（7 条清洗规则）
- `src/constants.rs` — 关键常量（WEIGHT_DECAY / SIM_TRANSFER / MAINTENANCE 等）
- `src/intent.rs` — `extract_tokens`
- `src/learning.rs` — `record_selection` 行为记忆
- `src/weights.rs` — 权重管理 + 30 天半衰期衰减
- `src/negative.rs` — `add_block_flag` / `remove_block_flag`
- `src/self_healing.rs` — 用户改选后自愈
- `src/association.rs` — 隐式 Markov 链（`ChainEdge`）
- `src/stats.rs` — 4 时段统计 / Top N
- `src/context.rs` — 上下文管理（最近 app / 时段）
- `src/maintenance.rs` — `_decay_all_stale_queries` 引擎自主维护
- `src/bayes.rs` — 贝叶斯意图过滤（P>0.6 注入 boost）
- `src/pro.rs` — 65 维用户偏好向量
- `src/smart_reminder.rs` — 智能提醒核心算法
- `src/semantic.rs` — L1/L2/L3 三层语义联想（可选模块）

## 搜索管线：精确 → 前缀 → 模糊

```
run_search_pipeline(query, apps)
    ├── exact_search(query, apps)      # 完整 term 精确命中
    ├── prefix_search(query, apps)     # Trie 前缀树扩展召回
    └── fuzzy_search(query, apps)      # 模糊匹配兜底
```

- **精确匹配**：name / py / en / abbr 完全等于 query。
- **前缀索引**：基于 `TrieIndex` 返回所有以 query 开头的 App；节点维护 `ids`（前缀下全部 App）和 `terminals`（精确结尾 App）。
- **模糊匹配**：仅当前两级无结果时兜底。

### 统计型排序（不依赖模拟智能）

精确/前缀命中的结果会按以下统计信息排序，**无需开启模拟智能**：

- 启动次数
- 最近使用时间
- 是否已安装
- 时段偏好
- 模式频率

## Trie 前缀树扩展接口（隐藏入口）

```rust
engine.trie_index().insert(term, app_or_id)?;
engine.trie_index().remove(term, app_or_id)?;
engine.trie_index().exact_search(term);
engine.trie_index().prefix_search(prefix);
engine.trie_index().rebuild(&apps);
engine.trie_index().root();
```

Rust 版 `TrieIndex` 节点结构：

```rust
struct TrieNode {
    children: HashMap<char, TrieNode>,
    ids: HashSet<String>,      // 经过该前缀的全部 App ID
    terminals: HashSet<String>,// 恰好以该节点结尾的 App ID
}
```

## FeatureFlags 使用

通过 `SearchConfig` 结构体配置模块开关，三语言必须保持一致：

```rust
use goto_engine::SearchConfig;

let config = SearchConfig {
    fuzzy_match: true,       // 模糊匹配（Jaccard + 顺序恢复 + 缩写）
    index_tree: true,        // 索引树（英文单词树 + 中文汉字树 + 拼音树 + Trie 前缀树）
    adaptive_refresh: true,  // 自适应刷新（打字速度 + 防抖节流）
    sim_int: false,          // 模拟智能（微观上下文 + 时段加分）
    t9: false,               // T9 模式
    rag_fallback: false,     // RAG 兜底（最后调用，预留）
};
```

| Flag | 默认 | 作用 |
|---|---|---|
| `fuzzy_match` | `true` | 模糊匹配（Jaccard + 顺序恢复 + 缩写） |
| `index_tree` | `true` | 索引树（英文单词树 + 中文汉字树 + 拼音树 + Trie 前缀树） |
| `adaptive_refresh` | `true` | 自适应刷新（打字速度 + 防抖节流） |
| `sim_int` | `false` | 模拟智能（微观上下文 + 时段加分） |
| `t9` | `false` | T9 模式 |
| `rag_fallback` | `false` | RAG 兜底（最后调用，预留） |

## 匹配模式（MatchType）

Rust 版 `types.rs` 定义以下匹配模式，对应 MECE 匹配维度：

| MatchType | 分数 | 说明 |
|---|---|---|
| `Initial` | 1000 | 精确匹配（name/py/en/abbr 完全匹配） |
| `T9` | 700/500 | T9 模式独有 |
| `Prefix` | 800 | 前缀匹配（name/py/en/abbr 前缀匹配） |
| `Char` | 600 | 包含匹配（name/py/en/abbr 包含匹配） |
| `Disorder` | 50-400 | 模糊匹配（Jaccard + 顺序恢复 + 间隔字母 + 缩写融合） |
| `AdjacentSwap` | 50-400 | 相邻字符交换容错（高斯核键距） |
| `Meta` | 80 | 分类兜底（分类名包含） |
| `Tfidf` | — | TF-IDF 加权（重排阶段） |
| `Trie` | — | Trie 索引树命中（前缀/精确扩展召回） |

`Initial` / `Prefix` / `Char` / `Disorder` 互斥，取最高分；`Meta` 为低分兜底，不互斥。

## 组件层调用

```rust
use goto_engine::{EngineComponent, QueryOptions};

let component = EngineComponent::new();
let resp: QueryResponse = component.query(q, QueryOptions::default())?;
component.set_app_dataset(apps);    // → usize
component.record_selection(q, app)?;
```

## 相关文档

- 根目录 [`../README.md`](../README.md) — 三语言总览与架构
