// GOTO Engine 统一 API 接口定义（跨平台）
// Version: 3.2.0
// 本文件为 TypeScript 声明文件，描述引擎与 Facade 的公开接口。

// ═══════════════════════════════════════════════
// 基础数据结构
// ═══════════════════════════════════════════════

/** 应用数据项 */
export interface AppItem {
  /** 应用名（中文或英文） */
  name: string;
  /** 拼音（全拼，小写） */
  py: string;
  /** 缩写（首字母缩写，如 wx/dd/zfb） */
  abbr: string;
  /** 英文名 */
  en: string;
  /** emoji 图标（当无 iconURI 时使用） */
  icon: string;
  /** 分类（社交/办公/娱乐/购物/出行/工具/系统/健康/游戏） */
  cat: string;
  /** 标签数组 */
  tags: string[];
  /** 品牌 SVG URI（由 GOTO.test.Icons 填充，可选） */
  iconURI?: string;
  /** 应用 ID（可选，缺省时用 name） */
  id?: string;
  /** 应用主题色（用于卡片背景，可选） */
  color?: string;
}

/** 搜索结果项 */
export interface SearchResult {
  name: string;
  score: number;
  source: 'fuzzy' | 'meta' | 'recommend' | 'unknown';
  appId?: string;
  id?: string;
  [key: string]: any;
}

/** 搜索上下文（runSearchPipeline 返回值） */
export interface SearchContext {
  query: string;
  list: SearchResult[];
  scores: Record<string, number>;
  hits: Record<string, string[]>;
  modeMap: Record<string, string>;
  mode: string;
  dt: number;
  intentLabel: string;
  intentCategory: string;
  latency?: number;
  info?: Record<string, any>;
}

/** 分类词库条目 */
export interface CatalogCategory {
  label: string;
  apps: string[];
  keywords: string[];
}

/** 分类词库 */
export type Catalog = Record<string, CatalogCategory>;

/** 意图同义词词典 */
export type IntentSynonyms = Record<string, string[]>;

// ═══════════════════════════════════════════════
// 引擎核心接口
// ═══════════════════════════════════════════════

/** GOTO Engine 核心接口 */
export interface GOTOEngineInterface {
  // — 搜索 —
  fuzzySearch(query: string, apps: AppItem[]): SearchContext;
  metaSearch(query: string): SearchContext;
  runSearchPipeline(query: string, apps: AppItem[]): SearchContext;

  // — 记录 —
  recordSearch(query: string): void;
  recordSelection(query: string, appName: string): void;
  recordUnknownApp(query: string, appName?: string): void;
  getUnknownApps(): any[];
  getUnknownAppSuggestions(query: string): SearchResult[];

  // — 索引 —
  rebuildIndex(): Record<string, string[]>;
  loadCatalog(): Catalog;
  buildSearchIndex(apps: AppItem[]): void;
  watchAppDataset(apps: AppItem[]): void;

  // — 过滤 —
  sanitizeQuery(query: string): string | null;

  // — 意图 —
  extractTokens(query: string): {
    query: string;
    lower: string;
    words: string[];
    actions: string[];
    intents: string[];
    relations: string[];
    target: string[];
  };

  // — 记忆 —
  getMemory(): any[];
  saveMemory(list: any[]): void;
  getPendingIndex(): Record<string, any>;
  savePendingIndex(obj: Record<string, any>): void;

  // — 权重 —
  getRuleWeights(): Record<string, Record<string, number>>;
  saveRuleWeights(weights: Record<string, Record<string, number>>): void;
  getRuleStats(): Record<string, any>;
  saveRuleStats(stats: Record<string, any>): void;

  // — 负面反馈 —
  getNegativeState(): Record<string, any>;
  saveNegativeState(state: Record<string, any>): void;
  addBlockFlag(query: string, appName: string, days?: number): boolean;
  removeBlockFlag(query: string, appName: string): boolean;
  isBlockFlagged(query: string, appName: string): boolean;
  clearExpiredBlockFlags(): Record<string, any>;
  getBlockFlagPreview(): any;

  // — 自愈 —
  applySelfHealing(query: string, newDefaultApp: string): any;
  getSelfHealingState(): Record<string, any>;
  saveSelfHealingState(state: Record<string, any>): void;

  // — 关联 —
  getChainStore(): { edges: Record<string, any>; lastAction: string };
  saveChainStore(store: { edges: Record<string, any>; lastAction: string }): void;
  getAssociationRecommendation(): any;
  getQuickBubbles(): any[];

  // — 统计 —
  getHourlyStats(): any;
  getFullTimeStats(): any;
  getCurrentHourStats(): any;

  // — Boost —
  _getLaunchCountBoost(appName: string): number;
  _getInstalledBoost(appName: string): number;

  // — 上下文 —
  setContext(ctx: any): void;
  clearContext(): void;
  getContext(): any;

  // — 安装全局 —
  installGlobals(): void;
}

// ═══════════════════════════════════════════════
// Facade 统一 API 接口
// ═══════════════════════════════════════════════

/** 搜索选项（预留） */
export interface SearchOptions {
  limit?: number;
  intent?: string;
  context?: any;
}

/** GOTOEngineFacade 统一 API */
export interface GOTOEngineFacadeInterface {
  /** 版本号 */
  version: string;

  // — 搜索 API —
  search(query: string, options?: SearchOptions): SearchContext | null;
  fuzzySearch(query: string): SearchResult[];

  // — 记录 API（含自动 sanitize 过滤）—
  recordSearch(query: string): void;
  recordSelection(query: string, appName: string): void;
  recordUnknownApp(query: string, appName: string): void;

  // — 索引管理 —
  rebuildIndex(): void;
  setAppDataset(apps: AppItem[]): void;
  getAppDataset(): AppItem[];

  // — 模拟智能 —
  isSimIntEnabled(): boolean;
  enableSimInt(enabled: boolean): void;
  resetMemory(): void;
  getStats(): Record<string, any>;

  // — 上下文 —
  setContext(ctx: any): void;
  clearContext(): void;

  // — 跨平台 adapter —
  setAdapter(adapter: PlatformAdapter): void;
  getAdapter(): PlatformAdapter;

  // — 原始引擎引用 —
  raw(): GOTOEngineInterface | null;
}

// ═══════════════════════════════════════════════
// 跨平台 Adapter 接口
// ═══════════════════════════════════════════════

/** 平台适配器（用于跨平台存储/网络替换） */
export interface PlatformAdapter {
  /** 存储接口（localStorage 兼容） */
  storage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
  /** 网络请求（可选，用于未来在线图标/词库） */
  fetch?: (url: string) => Promise<any>;
}

// ═══════════════════════════════════════════════
// 全局声明
// ═══════════════════════════════════════════════

declare global {
  /** 引擎对象（由 goto-engine.js installGlobals 挂载） */
  const GOTOEngine: GOTOEngineInterface;

  /** 统一 API 封装（由 preview.html 挂载） */
  const GOTOEngineFacade: GOTOEngineFacadeInterface;

  /** 应用数据集 */
  const _appDataset: AppItem[];

  /** 元标签数据库 */
  const _metaTagDB: Catalog;

  /** 元标签索引 */
  const _metaTagIndex: Record<string, string[]>;

  /** 语义联想模块（由 semantic-loader.js 挂载，可选） */
  const GOTOSemantic: SemanticAssociations;

  /** 语义模块别名 */
  const _semantic: SemanticAssociations;
}

// ═══════════════════════════════════════════════
// 语义联想模块接口（可选模块，删除 semantic/ 目录即禁用）
// ═══════════════════════════════════════════════

/** 语义扩展结果项 */
export interface SemanticExpansion {
  /** 扩展词 */
  term: string;
  /** 相关度评分 0-1 */
  score: number;
  /** 来源层：L1（核心同义词）/ L2（同义词词林分片）/ L3（词向量） */
  source: 'L1' | 'L2' | 'L3';
}

/** 语义模块统计信息 */
export interface SemanticStats {
  /** 是否已初始化 */
  ready: boolean;
  /** L2/L3 是否可用（semantic-config.json 加载成功） */
  available: boolean;
  /** 运行时开关是否开启 */
  enabled: boolean;
  /** IndexedDB 是否可用 */
  dbAvailable: boolean;
  /** L1 内联同义词条数 */
  l1Count: number;
  /** 当前内存缓存的分片数 */
  cachedShards: number;
  /** L1 命中次数 */
  l1Hits: number;
  /** L2 命中次数 */
  l2Hits: number;
  /** L2 未命中次数 */
  l2Misses: number;
  /** 缓存命中次数（内存 + IndexedDB） */
  cacheHits: number;
  /** 缓存未命中次数 */
  cacheMisses: number;
  /** LRU 淘汰次数 */
  evictions: number;
  /** L2 同义词总词数（来自 config） */
  synonymsCount: number;
  /** L2 分片数 */
  synonymsShards: number;
  /** L3 词向量是否可用 */
  vectorsAvailable: boolean;
}

/** 语义联想模块（可选） */
export interface SemanticAssociations {
  /** 异步初始化（加载 config + IndexedDB） */
  init(): Promise<boolean>;
  /** 是否启用（运行时开关） */
  isEnabled(): boolean;
  /** 设置启用状态（写入 localStorage） */
  setEnabled(on: boolean): void;
  /** 是否已就绪（init 完成 + enabled） */
  isReady(): boolean;
  /** L2/L3 是否可用 */
  isAvailable(): boolean;
  /** 扩展查询（同步返回 L1，或异步返回 L1+L2） */
  expand(query: string, opts?: { async?: boolean; limit?: number }): SemanticExpansion[] | Promise<SemanticExpansion[]>;
  /** L1 同步扩展（零阻塞） */
  _expandSync(query: string, limit?: number): SemanticExpansion[];
  /** L2 异步扩展（按需加载分片） */
  _expandAsync(query: string, limit?: number): Promise<SemanticExpansion[]>;
  /** L3 词向量相似词（阶段 2 实现） */
  findSimilar(word: string, topN?: number): Promise<SemanticExpansion[]>;
  /** 加载分片（fetch → IndexedDB → 内存 LRU） */
  loadShard(shardId: string): Promise<any>;
  /** 获取统计信息 */
  getStats(): SemanticStats;
  /** 清除所有缓存（内存 + IndexedDB） */
  clearCache(): Promise<boolean>;
  /** L1 核心同义词词典（内联） */
  L1_CORE_SYNONYMS: Record<string, string[]>;
}
