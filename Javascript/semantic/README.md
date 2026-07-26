# GOTO 语义联想模块（Semantic Associations）

GOTO Engine 的可选语义扩展模块，为搜索引擎提供同义词扩展和词向量相似度能力。

## 特性

- **三层架构**：L1 核心（内置）→ L2 同义词词林（分片）→ L3 词向量（分片）
- **按需加载**：L1 启动即用，L2/L3 按拼音首字母分片异步加载
- **本地缓存**：IndexedDB 持久化 + 内存 LRU（20 片上限）
- **可选模块**：删除整个 `semantic/` 目录即可完全禁用，核心搜索不受影响
- **运行时开关**：设置页"语义联想"开关，localStorage `goto_semantic_enabled`

## 文件结构

```
semantic/
├─ semantic-loader.js      # 加载器 + L1 核心同义词 + 公共 API
├─ semantic-config.json    # 分片清单（版本/词数/hash）
├─ pinyin-index.json       # 高频汉字 → 拼音首字母映射
├─ import-corpus.js        # Node 脚本：原始语料 → 分片 JSON
├─ synonyms/               # L2 同义词分片（shard-a.json ... shard-z.json）
├─ vectors/                # L3 词向量分片（可选）
└─ samples/                # 小规模示例语料
```

## 启用/禁用

### 运行时开关
设置页 → 进阶区域 → "语义联想"开关

### 文件级禁用
删除整个 `semantic/` 目录，或删除 `semantic-loader.js` 文件。引擎会自动降级到原有 metaSearch 逻辑。

## 数据来源（L2/L3）

- **L2 同义词**：哈工大同义词词林（扩充版）— 7.7 万词
- **L3 词向量**：Chinese Word Vectors（腾讯 AI Lab / sgns.zhihu.bigram）

## 生成大规模数据

```bash
# 1. 下载哈工大同义词词林原始文件 cilin.txt
# 2. 转换为分片
node AppIndex/GOTO-Engine/semantic/import-corpus.js --input cilin.txt --type cilin --output synonyms/

# 3. （可选）下载 Chinese Word Vectors，转换为 L3 分片
node AppIndex/GOTO-Engine/semantic/import-corpus.js --input sgns.zhihu.bigram --type cwv --output vectors/ --topn 50000 --dim 64

# 4. 刷新配置
node AppIndex/GOTO-Engine/semantic/import-corpus.js --refresh-config
```

## API

```js
// 全局对象：window.GOTOSemantic 或 window._semantic
GOTOSemantic.isEnabled()                    // 是否启用
GOTOSemantic.isReady()                      // 是否已初始化
GOTOSemantic.isAvailable()                  // semantic/ 目录是否存在
GOTOSemantic.expand('安静', {async:false})  // 同步：仅查 L1
GOTOSemantic.expand('安静', {async:true})   // 异步：L1 + L2
GOTOSemantic.findSimilar('安静', 5)         // 异步：L3 相似词
GOTOSemantic.getStats()                     // 统计信息
GOTOSemantic.clearCache()                   // 清除缓存
```

## 降级路径

1. `semantic/` 目录被删除 → `isAvailable()` 返回 false，L1 仍可用（内置在 loader）
2. `semantic-loader.js` 加载失败 → 引擎 installGlobals 检测 `GOTOSemantic` 不存在，跳过集成
3. 单个分片 404 → `loadShard` 返回 null，`expand` 跳过 L2，仅返回 L1
4. IndexedDB 不可用 → 降级到仅内存 cache
5. 任何