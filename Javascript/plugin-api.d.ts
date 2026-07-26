// GOTO Engine Plugin API — TypeScript declarations
// Version: 1.0.0
// License: GNU AGPL-3.0

/** Plugin manifest describing identity and required permissions. */
export interface PluginManifest {
  /** Unique id, 2-64 alphanumeric/dash chars. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Semver version string. */
  version: string;
  /** Author or organization. */
  author?: string;
  /** Short description of what the plugin does. */
  description?: string;
  /** Permission scopes requested. */
  permissions: PluginPermission[];
}

export type PluginPermission =
  | 'search.read'        // observe queries and results
  | 'search.rerank'      // modify result envelope
  | 'search.options'     // modify query options
  | 'render.modify'      // swap render target
  | 'context.write'      // inject per-query context
  | 'feedback.send'      // dispatch feedback events
  | 'feedback.receive'   // subscribe to feedback events
  | 'engine.maintain';   // trigger maintenance routines

/** Optional hooks a plugin may implement. */
export interface PluginHooks {
  /** Called before each query; may return modified options. */
  beforeSearch?: (ctx: { query: string; options: QueryOptions }) => Partial<QueryOptions> | void;
  /** Called after each query; may return a modified envelope. */
  afterSearch?: (ctx: { query: string; envelope: EngineEnvelope }) => EngineEnvelope | void;
  /** Called before render; may return a new target selector. */
  beforeRender?: (ctx: { target: string | HTMLElement; envelope: EngineEnvelope }) => string | void;
  /** Called when a feedback event is dispatched. */
  onFeedback?: (feedback: FeedbackEvent) => void;
  /** Called when an error occurs in the host or another plugin. */
  onError?: (errorInfo: PluginErrorInfo) => void;
}

export interface QueryOptions {
  limit?: number;
  requestId?: string;
  context?: object;
}

export interface EngineEnvelope {
  ok: boolean;
  apiVersion: string;
  request: { id?: string; query: string; limit?: number };
  data?: {
    items: EngineResultItem[];
    total: number;
    intent: { label: string; category: string };
    mode: string;
  };
  error?: { code: string; message: string };
  meta: { latencyMs: number; localOnly: boolean; timestamp: string };
}

export interface EngineResultItem {
  rank: number;
  id: string;
  name: string;
  score: number;
  source: string;
  category: string;
  icon: string;
}

export interface FeedbackEvent {
  id: string;
  ts: number;
  type: 'correction' | 'suggestion' | 'bug' | 'quality' | 'generic';
  scope: 'search' | 'render' | 'context' | 'plugin' | 'engine';
  plugin?: string | null;
  query?: string | null;
  expected?: string | null;
  actual?: string | null;
  note: string;
  severity: 'info' | 'warn' | 'error';
  meta?: object;
}

export interface PluginErrorInfo {
  phase: 'register' | 'plugin-call' | 'query' | 'render' | 'feedback';
  error: Error;
  ctx?: any;
  manifest?: PluginManifest;
  query?: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  permissions: PluginPermission[];
}

export interface PluginStatus {
  apiVersion: string;
  pluginCount: number;
  plugins: PluginInfo[];
  componentReady: boolean;
  engineReady: boolean;
}

/** Plugin host public surface. */
export interface GOTOPluginHost {
  version: string;
  register(manifest: PluginManifest, hooks: PluginHooks): boolean;
  unregister(pluginId: string): boolean;
  list(): PluginInfo[];
  get(pluginId: string): { manifest: PluginManifest; hooks: PluginHooks } | null;
  query(query: string, options?: QueryOptions): EngineEnvelope;
  render(target: string | HTMLElement, envelope: EngineEnvelope, format?: 'json' | 'text' | 'compact'): string;
  dispatchFeedback(feedback: FeedbackEvent): void;
  status(): PluginStatus;
}

declare const GOTOPlugin: GOTOPluginHost;
export default GOTOPlugin;
