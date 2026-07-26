export type EngineDisplayFormat = 'json' | 'text' | 'compact';
export interface EngineQueryOptions { limit?: number; requestId?: string; context?: Record<string, unknown>; }
export interface EngineResultItem { rank:number; id:string; name:string; score:number; source:string; category:string; icon:unknown; raw:unknown; }
export interface EngineSuccessEnvelope { ok:true; apiVersion:string; request:{id:string;query:string;limit:number}; data:{items:EngineResultItem[];total:number;intent:{label:string;category:string};mode:string}; meta:{latencyMs:number;localOnly:true;timestamp:string}; }
export interface EngineErrorEnvelope { ok:false; apiVersion:string; request:{id:string;query:string}; error:{code:'ENGINE_UNAVAILABLE'|'INVALID_QUERY'|'ENGINE_FAILURE';message:string}; meta:{latencyMs:number;localOnly:true;timestamp:string}; }
export type EngineEnvelope = EngineSuccessEnvelope | EngineErrorEnvelope;
export interface GOTOEngineComponentInstance {
  readonly version:string;
  query(query:string,options?:EngineQueryOptions):EngineEnvelope;
  search(query:string):unknown;
  fuzzySearch(query:string):unknown[];
  recordSearch(query:string):void;
  recordSelection(query:string,appName:string):void;
  recordUnknownApp(query:string,appName?:string):void;
  setAppDataset(apps:unknown[]):number;
  getAppDataset():unknown[];
  setContext(context:Record<string,unknown>):void;
  clearContext():void;
  status():{apiVersion:string;ready:boolean;engineVersion:string;datasetSize:number;localOnly:true};
  format(result:EngineEnvelope,format?:EngineDisplayFormat):string;
  render(target:string|Element,result:EngineEnvelope,format?:EngineDisplayFormat):string;
  on(type:'query'|'error',listener:(payload:EngineEnvelope)=>void):()=>void;
  off(type:'query'|'error',listener:(payload:EngineEnvelope)=>void):void;
  raw():unknown;
}
export interface GOTOEngineComponentFactory { readonly version:string; create(options?:Record<string,unknown>):GOTOEngineComponentInstance; }
declare global { const GOTOEngineComponent:GOTOEngineComponentFactory; const GOTOEngineFacade:GOTOEngineComponentInstance; }