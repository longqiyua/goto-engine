/* GOTO Engine Component API v1.0.0 — independent adapter around the GOTO Engine runtime. */
(function(root,factory){
  var api=factory(root||{});
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.GOTOEngineComponent=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  var API_VERSION='1.0.0';
  var sequence=0;

  function clampLimit(value){var n=parseInt(value,10);return Number.isFinite(n)?Math.max(1,Math.min(100,n)):12;}
  function cleanQuery(engine,value){var raw=String(value==null?'':value);return engine&&typeof engine.sanitizeQuery==='function'?engine.sanitizeQuery(raw):raw.trim();}
  function asDataset(source){var value=typeof source==='function'?source():source;return Array.isArray(value)?value:[];}
  function asEngine(source){return typeof source==='function'?source():source;}
  function createId(){sequence+=1;return 'goto-'+Date.now().toString(36)+'-'+sequence.toString(36);}
  function normalizeItem(item,index){
    var app=item&&item.app?item.app:item||{};
    return {rank:index+1,id:String(app.id||item.id||app.name||item.name||index),name:String(app.name||item.name||''),score:Number(item.score||0),source:String(item.source||item.mode||'engine'),category:String(app.cat||app.category||item.category||''),icon:app.icon||item.icon||'',raw:item};
  }
  function errorEnvelope(id,query,code,message,start){return {ok:false,apiVersion:API_VERSION,request:{id:id,query:query},error:{code:code,message:message},meta:{latencyMs:Date.now()-start,localOnly:true,timestamp:new Date().toISOString()}};}

  function EngineComponent(options){
    options=options||{};
    this._engineSource=options.engine||function(){return root.GOTOEngine;};
    this._datasetSource=options.dataset||function(){return root._appDataset||[];};
    this._adapter={storage:options.storage||root.localStorage||null,fetch:options.fetch||root.fetch||null};
    this._listeners={};
    this.version=API_VERSION;
  }

  EngineComponent.prototype.query=function(query,options){
    options=options||{};var started=Date.now(),id=options.requestId||createId(),engine=asEngine(this._engineSource),cleaned=cleanQuery(engine,query);
    if(!engine||typeof engine.runSearchPipeline!=='function')return errorEnvelope(id,String(query||''),'ENGINE_UNAVAILABLE','GOTO Engine runtime is unavailable.',started);
    if(!cleaned)return errorEnvelope(id,String(query||''),'INVALID_QUERY','Query is empty or rejected by the sanitizer.',started);
    try{
      if(options.context&&typeof engine.setContext==='function')engine.setContext(options.context);
      var context=engine.runSearchPipeline(cleaned,asDataset(this._datasetSource))||{};
      var sourceList=Array.isArray(context.list)?context.list:(Array.isArray(context.results)?context.results:[]);
      var limit=clampLimit(options.limit),items=sourceList.slice(0,limit).map(normalizeItem);
      var result={ok:true,apiVersion:API_VERSION,request:{id:id,query:cleaned,limit:limit},data:{items:items,total:sourceList.length,intent:{label:context.intentLabel||'',category:context.intentCategory||''},mode:context.mode||'search'},meta:{latencyMs:Number(context.dt||context.latency||Date.now()-started),localOnly:true,timestamp:new Date().toISOString()}};
      this._emit('query',result);return result;
    }catch(error){var failed=errorEnvelope(id,cleaned,'ENGINE_FAILURE',error&&error.message?error.message:String(error),started);this._emit('error',failed);return failed;}
    finally{if(options.context&&engine&&typeof engine.clearContext==='function')engine.clearContext();}
  };

  /* Compatibility methods keep the preview shell thin while query() remains the stable component contract. */
  EngineComponent.prototype.search=function(query){var engine=asEngine(this._engineSource);return engine&&typeof engine.runSearchPipeline==='function'?engine.runSearchPipeline(query,asDataset(this._datasetSource)):null;};
  EngineComponent.prototype.fuzzySearch=function(query){var engine=asEngine(this._engineSource);return engine&&typeof engine.fuzzySearch==='function'?engine.fuzzySearch(query,asDataset(this._datasetSource)):[];};
  EngineComponent.prototype.recordSearch=function(query){var engine=asEngine(this._engineSource),cleaned=cleanQuery(engine,query);if(cleaned&&engine&&typeof engine.recordSearch==='function')engine.recordSearch(cleaned);};
  EngineComponent.prototype.recordSelection=function(query,appName){var engine=asEngine(this._engineSource),cleaned=cleanQuery(engine,query);if(cleaned&&engine&&typeof engine.recordSelection==='function')engine.recordSelection(cleaned,appName);};
  EngineComponent.prototype.recordUnknownApp=function(query,appName){var engine=asEngine(this._engineSource),cleaned=cleanQuery(engine,query);if(cleaned&&engine&&typeof engine.recordUnknownApp==='function')engine.recordUnknownApp(cleaned,appName);};
  EngineComponent.prototype.rebuildIndex=function(){var engine=asEngine(this._engineSource);if(engine&&typeof engine.rebuildIndex==='function')return engine.rebuildIndex();};
  EngineComponent.prototype.setAppDataset=function(apps){var list=Array.isArray(apps)?apps:[];this._datasetSource=list;var engine=asEngine(this._engineSource);if(engine&&typeof engine.watchAppDataset==='function')engine.watchAppDataset(list);this.rebuildIndex();return list.length;};
  EngineComponent.prototype.getAppDataset=function(){return asDataset(this._datasetSource);};
  EngineComponent.prototype.setContext=function(ctx){var engine=asEngine(this._engineSource);if(engine&&typeof engine.setContext==='function')engine.setContext(ctx||{});};
  EngineComponent.prototype.clearContext=function(){var engine=asEngine(this._engineSource);if(engine&&typeof engine.clearContext==='function')engine.clearContext();};
  EngineComponent.prototype.isSimIntEnabled=function(){try{return !!(this._adapter.storage&&this._adapter.storage.getItem('goto_simint_enabled')==='1');}catch(_){return false;}};
  EngineComponent.prototype.enableSimInt=function(enabled){try{if(this._adapter.storage)this._adapter.storage.setItem('goto_simint_enabled',enabled?'1':'0');}catch(_){}this.rebuildIndex();};
  EngineComponent.prototype.resetMemory=function(){var engine=asEngine(this._engineSource);if(engine&&typeof engine.saveMemory==='function')engine.saveMemory([]);};
  EngineComponent.prototype.getStats=function(){var engine=asEngine(this._engineSource);return engine&&typeof engine.getRuleStats==='function'?engine.getRuleStats():{};};
  EngineComponent.prototype.setAdapter=function(adapter){adapter=adapter||{};if(adapter.storage)this._adapter.storage=adapter.storage;if(adapter.fetch)this._adapter.fetch=adapter.fetch;return this;};
  EngineComponent.prototype.getAdapter=function(){return this._adapter;};
  EngineComponent.prototype.raw=function(){return asEngine(this._engineSource)||null;};
  EngineComponent.prototype.status=function(){var engine=this.raw();return {apiVersion:API_VERSION,ready:!!engine,engineVersion:engine&&(engine.version||engine.VERSION)||'unknown',datasetSize:this.getAppDataset().length,localOnly:true};};
  EngineComponent.prototype.format=function(result,format){format=format||'json';if(format==='compact'){if(!result||!result.ok)return 'GOTO Engine · ERROR';return result.data.items.map(function(item){return item.rank+'. '+item.name+' · '+item.score;}).join('\n');}if(format==='text'){return result&&result.ok?'GOTO Engine · '+result.data.total+' results · '+result.meta.latencyMs+' ms':'GOTO Engine · '+((result&&result.error&&result.error.message)||'Unknown error');}return JSON.stringify(result,null,2);};
  EngineComponent.prototype.render=function(target,result,format){var text=this.format(result,format||'json');if(typeof target==='string'&&root.document)target=root.document.querySelector(target);if(target){target.textContent=text;target.setAttribute('data-engine-state',result&&result.ok?'ready':'error');}return text;};
  EngineComponent.prototype.on=function(type,listener){if(typeof listener!=='function')return function(){};(this._listeners[type]||(this._listeners[type]=[])).push(listener);var self=this;return function(){self.off(type,listener);};};
  EngineComponent.prototype.off=function(type,listener){var list=this._listeners[type]||[];this._listeners[type]=list.filter(function(item){return item!==listener;});};
  EngineComponent.prototype._emit=function(type,payload){(this._listeners[type]||[]).slice().forEach(function(listener){try{listener(payload);}catch(_){}});};

  return {version:API_VERSION,EngineComponent:EngineComponent,create:function(options){return new EngineComponent(options);}};
});