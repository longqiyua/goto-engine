/*!
 * GOTO Engine · Copyright (C) 2025-2026 GOTO Contributors
 * Licensed under GNU AGPL-3.0 — https://github.com/longqiyua/goto
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
(function(global){
  'use strict';

  var STORAGE = {
    simIntEnabled: 'goto_simint_enabled',
    catalog: 'goto_simint_catalog',
    memory: 'goto_simint_user_memory',
    pending: 'goto_simint_pending_index',
    stats: 'goto_simint_stats',
    weights: 'goto_engine_rule_weights',
    weightsTs: 'goto_engine_rule_weights_ts',
    chains: 'goto_engine_action_chains',
    negative: 'goto_engine_negative_feedback',
    blockFlags: 'goto_engine_block_flags',
    selfHealing: 'goto_engine_self_healing',
    pro: 'goto_engine_pro',
    proSnapshot: 'goto_engine_pro_snapshot',
    floatWindow: 'goto_engine_float_window',
    // v3.0 新增：跨查询全局偏好 + 相似查询关联
    globalPref: 'goto_engine_global_preference',
    // v3.2 新增：点击延迟 EMA（用于置信度调节）
    clickDelayEMA: 'goto_engine_click_delay_ema',
    // v3.3 新增：模糊匹配模式频率统计（多周期统计 → 权重调整）
    modeFrequency: 'goto_engine_mode_frequency',
    // v3.3 新增：搜索周期时间戳（用于误操作检测）
    cycleTimestamps: 'goto_engine_cycle_timestamps',
    // v3.3 新增：微观上下文 Micro-Context（增强模拟智能核心）
    microContext: 'goto_engine_micro_context'
  };

  // v3.0 负反馈时间衰减参数
  var WEIGHT_DECAY = {
    HALF_LIFE_DAYS: 30,   // 半衰期：30 天权重衰减 50%
    MIN_FLOOR: 0.35       // 衰减下限：避免权重完全消失（保留一些历史）
  };

  // v3.0 相似查询权重传递参数
  var SIM_TRANSFER = {
    RATIO: 0.2,           // 相似查询传递比例
    PREFIX_LEN: 2,        // 视为相似的前缀长度
    MIN_OVERLAP: 0.5      // 字符重叠率阈值
  };

  // v3.1 引擎自主维护参数
  var MAINTENANCE = {
    CHAIN_MAX_EDGES: 500,      // 链式边总数上限（超出按权重剪掉）
    CHAIN_MAX_PER_NODE: 20,    // 每个 fromKey 最多保留的 toKey 数
    CHAIN_MIN_WEIGHT: 1,       // 边权重下限（低于此值清理）
    STALE_THRESHOLD_DAYS: 1,   // 全局衰减的过期阈值
    MEMORY_MAX_AGE_DAYS: 90,   // 记忆记录最长保留天数
    MEMORY_MAX_RECORDS: 220    // 记忆最大条数（与 saveMemory 默认一致）
  };

  var BLOCK_FLAG_DEFAULT_DAYS = 3;
  var BLOCK_FLAG_MAX_ENTRIES = 200;
  var DAY_MS = 86400000;

  var T9_MAP = {
    '2':'abc','3':'def','4':'ghi','5':'jkl',
    '6':'mno','7':'pqrs','8':'tuv','9':'wxyz'
  };

  function clamp(num, min, max){
    return Math.min(max, Math.max(min, num));
  }

  function nowTs(){
    return Date.now();
  }

  function readJSON(key, fallback){
    try{
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    }catch(_){
      return fallback;
    }
  }

  function writeJSON(key, value){
    try{ localStorage.setItem(key, JSON.stringify(value)); }catch(_){}
  }

  function uniqueStrings(list){
    var seen = new Set();
    return (list || []).filter(function(item){
      var key = (item || '').toLowerCase();
      if(!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function normalizeText(value){
    return (value || '').toString().trim();
  }

  function lowerText(value){
    return normalizeText(value).toLowerCase();
  }

  function getHour(){
    return new Date().getHours();
  }

  function createSearchIndex(){
    return {
      byInitial: new Map(),
      byT9: new Map(),
      byPrefix: new Map(),
      byChar: new Map(),
      byAppId: new Map(),
      trie: _createTrieNode(),
      built: false,
      buildTime: 0
    };
  }

  // ═══ 前缀树（Trie）索引 — 精确匹配的延伸：可快速取到某前缀下的全部 App ═══
  function _createTrieNode(){
    return { children: new Map(), ids: new Set(), terminals: new Set() };
  }
  function _trieInsert(trie, str, id){
    var node = trie;
    for(var i = 0; i < str.length; i++){
      var ch = str[i];
      var next = node.children.get(ch);
      if(!next){
        next = _createTrieNode();
        node.children.set(ch, next);
      }
      node = next;
      node.ids.add(id);
    }
    node.terminals.add(id);
  }
  function _trieExactIds(trie, str){
    var node = trie;
    for(var i = 0; i < str.length; i++){
      node = node.children.get(str[i]);
      if(!node) return null;
    }
    return node.terminals;
  }
  function _triePrefixIds(trie, prefix){
    var node = trie;
    for(var i = 0; i < prefix.length; i++){
      node = node.children.get(prefix[i]);
      if(!node) return null;
    }
    // ids 沿途已聚合所有经过该前缀的 App，直接返回即可
    return node.ids;
  }
  function _trieNodeContainsId(node, id){
    if(node.terminals.has(id)) return true;
    for(var iter = node.children.values(), step = iter.next(); !step.done; step = iter.next()){
      if(_trieNodeContainsId(step.value, id)) return true;
    }
    return false;
  }
  function _trieRemove(trie, str, id){
    function remove(node, depth){
      if(depth === str.length){
        var had = node.terminals.has(id);
        node.terminals.delete(id);
        node.ids.delete(id);
        return had;
      }
      var ch = str[depth];
      var child = node.children.get(ch);
      if(!child) return false;
      var childShouldDelete = remove(child, depth + 1);
      if(childShouldDelete){
        node.children.delete(ch);
      }
      if(!_trieNodeContainsId(node, id)) node.ids.delete(id);
      return node.children.size === 0 && node.terminals.size === 0 && node.ids.size === 0;
    }
    return remove(trie, 0);
  }

  // v4.0: 第四层（梳理层）依赖 — 延迟加载，缺失时静默降级
  var _rerankModule = null;
  function _loadRerankModule(){
    if(_rerankModule) return _rerankModule;
    try{
      if(typeof require === 'function'){
        _rerankModule = require('./algorithms/rerank/personal-rerank.js');
      }
    }catch(_){
      _rerankModule = null;
    }
    if(!_rerankModule && global.PersonalRerank){
      _rerankModule = global.PersonalRerank;
    }
    return _rerankModule;
  }
  // v4.0: Base 桥接（无状态），由宿主通过 setBaseBridge 注入
  var _baseBridge = null;

  var engine = {
    version: '2.1.0',
    storage: STORAGE,
    searchIndex: createSearchIndex(),
    context: null,
    catalog: null,
    metaIndex: {},
    semantic: null,
    lastSearchContext: global._lastSearchContext || { query:'', list:[], info:{}, latency:0, intentLabel:'待识别' },
    lastRecordId: null,
    datasetVersion: '',
    // v4.0: 梳理层缓存 — 异步刷新，同步消费（保证搜索零延迟）
    _personalSnapshot: null,
    _personalSnapshotTs: 0,
    _personalSnapshotTTL: 30000,  // 30s 内复用快照，避免每次搜索都打 Base
    _personalRerankEnabled: true,
    // v3.3: Engine FeatureFlags — 统一模块开关，三语言必须一致
    _featureFlags: {
      fuzzyMatch: true,      // 模糊匹配
      indexTree: true,       // 索引树（预留，当前用 searchIndex）
      adaptiveRefresh: true, // 自适应刷新
      simInt: false,         // 模拟智能（默认关闭）
      t9: false,             // T9 模式
      ragFallback: false     // RAG 兜底（默认关闭，最后调用）
    },
    setFeatureFlags: function(flags){
      if (flags && typeof flags === 'object') {
        Object.keys(flags).forEach(function(k) {
          if (k in engine._featureFlags) {
            engine._featureFlags[k] = !!flags[k];
          }
        });
      }
      // 同步 simInt 到 localStorage
      if ('simInt' in (flags || {})) {
        try {
          if (flags.simInt) {
            localStorage.setItem('goto_simint_enabled', '1');
          } else {
            localStorage.removeItem('goto_simint_enabled');
          }
        } catch(_) {}
      }
    },
    isSimIntEnabled: function(){
      // 优先读 FeatureFlags
      if (engine._featureFlags && engine._featureFlags.simInt === true) return true;
      // 兼容旧版 localStorage
      try{ return localStorage.getItem(STORAGE.simIntEnabled) === '1'; }
      catch(_){ return false; }
    },
    // v3.3: 增强模拟智能检测 — 微观上下文仅在此模式下启用
    isEnhancedSimIntEnabled: function(){
      try{
        return this.isSimIntEnabled() && localStorage.getItem('goto_enhanced_simint') === '1';
      }catch(_){ return false; }
    },
    // v3.3: 微观上下文 Micro-Context — 联合推荐权重
    getMicroContext: function(){
      var def = {
        phoneUsage: { granted: false, screenOnMinutes: 0, lastAppPackage: '', appSwitchCount: 0 },
        location: { granted: false, lat: 0, lng: 0, mode: 'normal' },
        clipboard: { granted: false, content: '', detectedType: 'text' },
        deviceInfo: { model: '', sdk: 0, screenHeight: 0, screenWidth: 0 }
      };
      try{
        var s = readJSON(STORAGE.microContext, def);
        if(!s) return def;
        // 确保所有字段存在
        s.phoneUsage = s.phoneUsage || def.phoneUsage;
        s.location = s.location || def.location;
        s.clipboard = s.clipboard || def.clipboard;
        s.deviceInfo = s.deviceInfo || def.deviceInfo;
        return s;
      }catch(_){ return def; }
    },
    saveMicroContext: function(state){
      try{ writeJSON(STORAGE.microContext, state || {}); }catch(_){}
    },
    updateMicroContext: function(partial){
      try{
        var s = this.getMicroContext();
        if(partial.phoneUsage) Object.keys(partial.phoneUsage).forEach(function(k){ s.phoneUsage[k] = partial.phoneUsage[k]; });
        if(partial.location) Object.keys(partial.location).forEach(function(k){ s.location[k] = partial.location[k]; });
        if(partial.clipboard) Object.keys(partial.clipboard).forEach(function(k){ s.clipboard[k] = partial.clipboard[k]; });
        if(partial.deviceInfo) Object.keys(partial.deviceInfo).forEach(function(k){ s.deviceInfo[k] = partial.deviceInfo[k]; });
        this.saveMicroContext(s);
        return s;
      }catch(_){ return this.getMicroContext(); }
    },
    // v3.3: 自动 Mock 微观上下文（无需 UI 权限开关，增强模拟智能启用时自动注入）
    // Web 端注入演示数据；Kotlin 端映射到真实系统权限请求
    autoMockMicroContext: function(){
      if(!this.isEnhancedSimIntEnabled()) return null;
      try{
        var mc = this.getMicroContext();
        var hour = getHour();
        var now = Date.now();

        // 1. 设备信息（一次性写入）
        if(!mc.deviceInfo.model){
          mc.deviceInfo = {
            model: 'GOTO-Preview-Device',
            sdk: 33,
            screenHeight: 2400,
            screenWidth: 1080
          };
        }

        // 2. 手机使用情况（每次调用刷新，模拟动态数据）
        var lastUpdate = mc._lastMockUpdate || 0;
        if(now - lastUpdate > 60000){  // 每分钟刷新一次
          var screenMin = mc.phoneUsage.screenOnMinutes || 0;
          var switchCount = mc.phoneUsage.appSwitchCount || 0;
          // 模拟屏幕使用时间随时间增长
          mc.phoneUsage = {
            granted: true,
            screenOnMinutes: screenMin + Math.floor(Math.random() * 3) + 1,
            lastAppPackage: 'com.appindex.goto',
            appSwitchCount: switchCount + (Math.random() > 0.7 ? 1 : 0)
          };
          mc._lastMockUpdate = now;
        }

        // 3. 位置（光感模式联动）
        if(!mc.location.granted){
          mc.location = {
            granted: true,
            lat: 22.5431,
            lng: 114.0579,
            mode: (typeof document !== 'undefined' && document.body && document.body.classList.contains('light-sense')) ? 'light_sense' : 'normal'
          };
        }else{
          // 同步光感模式状态
          var isLightSense = (typeof document !== 'undefined' && document.body && document.body.classList.contains('light-sense'));
          mc.location.mode = isLightSense ? 'light_sense' : 'normal';
        }

        // 4. 剪贴板识别增强（模拟检测）
        if(!mc.clipboard.granted || now - (mc._lastClipCheck || 0) > 30000){
          var clipSamples = [
            { content: 'YT1234567890', detectedType: 'tracking' },
            { content: 'https://github.com/longqiyua/goto', detectedType: 'url' },
            { content: '13800138000', detectedType: 'phone' },
            { content: '', detectedType: 'text' }
          ];
          var clipIdx = Math.floor(Math.random() * clipSamples.length);
          mc.clipboard = {
            granted: true,
            content: clipSamples[clipIdx].content,
            detectedType: clipSamples[clipIdx].detectedType
          };
          mc._lastClipCheck = now;
        }

        this.saveMicroContext(mc);
        return mc;
      }catch(_){ return this.getMicroContext(); }
    },
    intentSynonyms: {
      // ===== 原有 6 个意图 =====
      SEND: ['写','发','寄','送','留言','传','传送','通知','告之','发短信','发邮件','发邮箱','发消息','发信息','发微信','转发','回复'],
      CONSUME: ['看','听','读','欣赏','刷','播放','追','阅读','瞧瞧','围观','翻翻','收听','观看','瞅瞅','瞄一眼','追剧','刷剧','视频','看片','看点'],
      CONTACT: ['聊天','沟通','联系','找人','聊聊','回消息','私聊','群聊','唠嗑','搭话','吼一声','打招呼','问个事','发短信','打电话'],
      TRAVEL: ['打车','导航','定位','查定位','出发','出行','去一趟','路线','查一下','走','查公交','查路线','查地铁','开车','坐车','查票'],
      BUY: ['买','下单','点','点餐','吃饭','购物','买东西','点外卖','剁手','拼单','买买买','抢','收快递','拿外卖','付款','结账','付款码','做饭','下馆子','点个'],
      WORK: ['办公','工作','文档','表格','开会','协作','汇报','发邮箱','写代码','做材料','写方案','写ppt','做ppt','做表','做汇报','干活','加班'],
      // ===== 新增 5 个意图（v3.0 扩展） =====
      SEARCH: ['搜','查','找','搜索','查一下','搜一下','搜一搜','查资料','找资料','查信息','上网查','百度一下','谷歌','检索','问下','问问','搜个','找下','度娘','搜下','查个','上网','问个'],
      OPEN: ['打开','启动','进入','开','开一下','运行','调出','唤起','开app','打开app','启动app','开应用','进','拉起','切到','跳到','启动一下','调起','起'],
      INSTALL: ['装','安装','下载','装个','下个','下个app','装个app','安装app','装软件','下软件','添加','更新','升级','重装','装上','重新下载','装一个','重下','下个新'],
      HEALTH: ['运动','跑步','健身','喝水','睡眠','锻炼','减肥','塑形','瑜伽','冥想','心跳','步数','称重','打卡','记步','跑步打卡','走路','散步','慢跑','晨跑','夜跑','锻炼身体','健身打卡'],
      LEARN: ['学','学习','背单词','记单词','背书','上课','学英语','练听力','练口语','看教程','看课','学一下','读点书','研究','背题','练题','做题','刷题','练一下','背古诗','看网课','学日语','教程','课','课程','网课'],
    },
    baseCatalog: function(){
      return {
        communication: {
          label: '通讯',
          apps: ['微信','QQ','TIM','飞书','企业微信','钉钉','Telegram','WhatsApp','Messenger','Discord','Line','Skype','Teams','短信','电话','通讯录','微博','小红书'],
          keywords: ['聊天','沟通','找人','聊聊','联系','联系人','发消息','回消息','消息','社交','私聊','群聊','对话','说话','发短信','短信','打电话','电话','约人','找谁','联系谁','发什么','给谁','和谁说','找同事','找朋友','消息回复','回个信']
        },
        office: {
          label: '办公',
          apps: ['邮箱','Outlook','Gmail','WPS','Word','Excel','PowerPoint','Notion','腾讯文档','石墨文档','语雀','备忘录','日历','Zoom','Teams','飞书','钉钉','企业微信'],
          keywords: ['办公','工作','文档','表格','演示','写文档','开会','会议','发邮箱','邮件','邮箱','日程','任务','安排','汇报','做表','做ppt','写材料','写方案','找同事','协作','发邮件']
        },
        browser: {
          label: '浏览器',
          apps: ['Chrome','Google','Edge','Safari','Firefox','QQ浏览器','UC浏览器','百度','搜狗','浏览器'],
          keywords: ['搜索','查一下','上网','打开网页','浏览','网页','网站','查资料','搜一下','搜一搜','网页搜索','浏览器']
        },
        video: {
          label: '视频',
          apps: ['YouTube','B站','抖音','快手','腾讯视频','爱奇艺','优酷','芒果TV','Netflix'],
          keywords: ['视频','刷视频','看视频','欣赏电影','追剧','电影','电视剧','短视频','直播','看片','看点什么']
        },
        music: {
          label: '音乐',
          apps: ['网易云音乐','QQ音乐','酷狗音乐','酷我音乐','Spotify','Apple Music','汽水音乐','喜马拉雅'],
          keywords: ['音乐','听歌','听点歌','播放','歌单','播客','听书','听音乐','歌曲','电台']
        },
        shopping: {
          label: '购物',
          apps: ['淘宝','京东','拼多多','天猫','闲鱼','得物','美团','饿了么','大众点评'],
          keywords: ['购物','买东西','下单','网购','电商','外卖','点餐','买点东西','下馆子','吃饭','点外卖']
        },
        finance: {
          label: '支付金融',
          apps: ['支付宝','微信','云闪付','招商银行','建设银行','工商银行','中国银行','农业银行'],
          keywords: ['支付','付款','转账','收款','收钱','付款码','银行','钱包','理财','还钱','记账']
        },
        maps: {
          label: '地图出行',
          apps: ['高德地图','百度地图','腾讯地图','滴滴出行','12306','携程','去哪儿','飞猪','哈啰出行'],
          keywords: ['地图','导航','打车','出行','路线','坐车','开车','去哪','订票','火车票','飞机票','旅行','查定位']
        },
        photo: {
          label: '拍照影像',
          apps: ['相机','照片','美图秀秀','醒图','Lightroom','剪映','必剪','Snapseed'],
          keywords: ['拍照','拍个照','照片','修图','美颜','剪辑','拍视频','修照片','滤镜','做图']
        },
        reading: {
          label: '阅读资讯',
          apps: ['微信读书','Kindle','今日头条','知乎','豆瓣','起点读书','百度'],
          keywords: ['阅读','看书','看新闻','资讯','小说','头条','文章','读点东西','看内容']
        },
        games: {
          label: '游戏',
          apps: ['Steam','TapTap','王者荣耀','和平精英','原神','英雄联盟','Epic'],
          keywords: ['游戏','打游戏','开黑','玩会儿','玩一下','上号','开一把']
        },
        dev: {
          label: '开发',
          apps: ['VS Code','Visual Studio','GitHub Desktop','Postman','Docker','Cursor','Trae','终端'],
          keywords: ['开发','写代码','编程','调试','终端','控制台','接口测试','提交代码','github']
        },
        system: {
          label: '系统工具',
          apps: ['设置','文件管理','时钟','天气','计算器','GOTO','应用商店','电话','短信'],
          keywords: ['设置','系统','工具','文件','清理','时钟','天气','算一下','计算','系统工具']
        },
        // ===== 新增 7 个分类（v3.0 扩展） =====
        input: {
          label: '输入法',
          apps: ['搜狗输入法','百度输入法','讯飞输入法','微信键盘','QQ输入法','微软拼音','Google拼音','手心输入法'],
          keywords: ['输入法','键盘','打字','语音输入','手写输入','拼音','五笔']
        },
        smart_home: {
          label: '智能家居',
          apps: ['米家','天猫精灵','小度','华为智慧生活','HomeKit','Aqara','涂鸦智能','小爱音箱'],
          keywords: ['智能家居','智能家电','控制家电','开灯','关灯','扫地机器人','音箱','小爱','小度','家电']
        },
        cloud_drive: {
          label: '网盘云盘',
          apps: ['百度网盘','阿里云盘','OneDrive','Google Drive','腾讯微云','坚果云','Dropbox','iCloud'],
          keywords: ['网盘','云盘','云存储','同步文件','备份','上传文件','下载文件','存文件','云盘文件']
        },
        translation: {
          label: '翻译',
          apps: ['网易有道词典','Google翻译','DeepL','百度翻译','微软翻译','彩云小译','腾讯翻译君','欧路词典'],
          keywords: ['翻译','译','中英','英中','查单词','背单词','词典','字典','划词翻译','拍照翻译','实时翻译','同声传译']
        },
        education: {
          label: '教育学习',
          apps: ['作业帮','猿题库','得到','极客时间','网易云课堂','中国大学MOOC','B站学习','腾讯课堂'],
          keywords: ['学习','课程','上课','听网课','做题','背单词','看课','看教程','研究','练题','刷题','网课','学英语']
        },
        health: {
          label: '健康运动',
          apps: ['Keep','咕咚','华为运动健康','小米运动','Fitbit','Strava','薄荷健康','悦跑圈'],
          keywords: ['运动','跑步','健身','锻炼','减肥','瑜伽','冥想','心率','步数','称重','打卡','塑形','跑步打卡','晨跑','夜跑']
        },
        delivery: {
          label: '跑腿快递',
          apps: ['闪送','达达','顺丰速运','菜鸟裹裹','京东快递','美团跑腿','UU跑腿','丰巢'],
          keywords: ['快递','跑腿','同城','寄快递','取快递','查快递','物流','取件','寄件','送货上门']
        }
      };
    },
    loadCatalog: function(){
      var stored = readJSON(STORAGE.catalog, null);
      this.catalog = stored && typeof stored === 'object' ? stored : this.baseCatalog();
      return this.catalog;
    },
    rebuildIndex: function(){
      var catalog = this.loadCatalog();
      var metaIndex = {};
      Object.keys(catalog).forEach(function(catKey){
        var entry = catalog[catKey] || {};
        uniqueStrings([].concat(entry.apps || [], entry.keywords || [], [entry.label || ''])).forEach(function(term){
          var key = lowerText(term);
          if(!key) return;
          if(!metaIndex[key]) metaIndex[key] = [];
          if(metaIndex[key].indexOf(catKey) < 0) metaIndex[key].push(catKey);
        });
      });
      this.metaIndex = metaIndex;
      global._metaTagDB = catalog;
      global._metaTagIndex = metaIndex;
      writeJSON(STORAGE.catalog, catalog);
      return metaIndex;
    },
    sanitizeQuery: function(query){
      var q = normalizeText(query);
      if(!q) return null;
      if(q.length < 2 || q.length > 40) return null;
      if(!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(q)) return null;
      if(/^\d+$/.test(q) && !/^[2-9]+$/.test(q)) return null;
      var chars = q.split('');
      var freq = {};
      chars.forEach(function(c){ freq[c] = (freq[c] || 0) + 1; });
      var maxFreq = 0;
      Object.keys(freq).forEach(function(k){ if(freq[k] > maxFreq) maxFreq = freq[k]; });
      if(maxFreq / chars.length > 0.6 && chars.length >= 4) return null;
      if(/[\x00-\x1f\x7f]/.test(q)) return null;
      q = q.replace(/(.)\1{7,}/g, '$1$1$1');
      return q;
    },
    extractTokens: function(query){
      var normalized = normalizeText(query);
      var lower = normalized.toLowerCase();
      var relationPool = ['给','和','跟','找','发给','联系','约','叫'];
      var actions = [];
      var intents = [];
      Object.keys(this.intentSynonyms).forEach(function(intentKey){
        var words = engine.intentSynonyms[intentKey] || [];
        var matched = words.some(function(word){ return normalized.indexOf(word) >= 0; });
        if(matched){
          intents.push(intentKey);
          words.forEach(function(word){
            if(normalized.indexOf(word) >= 0 && actions.indexOf(word) < 0) actions.push(word);
          });
        }
      });
      var relations = relationPool.filter(function(item){ return normalized.indexOf(item) >= 0; });
      var target = [];
      var relationMatch = normalized.match(/(?:给|和|跟|找|发给|联系|约|叫)([^，。,.]{1,12})/);
      if(relationMatch && relationMatch[1]) target.push(relationMatch[1].trim());
      return {
        query: normalized,
        lower: lower,
        words: normalized.split(/[\s,，。.、/]+/).filter(Boolean),
        actions: actions,
        intents: intents,
        relations: relations,
        target: target
      };
    },
    getMemory: function(){
      return readJSON(STORAGE.memory, []) || [];
    },
    saveMemory: function(list){
      writeJSON(STORAGE.memory, (list || []).slice(-220));
    },
    getPendingIndex: function(){
      return readJSON(STORAGE.pending, {}) || {};
    },
    savePendingIndex: function(obj){
      writeJSON(STORAGE.pending, obj || {});
    },
    getRuleStats: function(){
      return readJSON(STORAGE.stats, {}) || {};
    },
    saveRuleStats: function(stats){
      writeJSON(STORAGE.stats, stats || {});
    },
    getRuleWeights: function(){
      return readJSON(STORAGE.weights, {}) || {};
    },
    saveRuleWeights: function(weights){
      writeJSON(STORAGE.weights, weights || {});
    },
    // v3.0: 权重时间戳（每个查询最后更新时间，用于时间衰减）
    getRuleWeightsTs: function(){
      return readJSON(STORAGE.weightsTs, {}) || {};
    },
    saveRuleWeightsTs: function(map){
      writeJSON(STORAGE.weightsTs, map || {});
    },
    // v3.0: 跨查询全局偏好（用户对某个 app 的总体偏好，跨所有查询共享）
    getGlobalPreference: function(){
      return readJSON(STORAGE.globalPref, {}) || {};
    },
    saveGlobalPreference: function(map){
      writeJSON(STORAGE.globalPref, map || {});
    },
    getChainStore: function(){
      return readJSON(STORAGE.chains, { edges:{}, lastAction:'' }) || { edges:{}, lastAction:'' };
    },
    saveChainStore: function(store){
      writeJSON(STORAGE.chains, store || { edges:{}, lastAction:'' });
    },
    getNegativeState: function(){
      return readJSON(STORAGE.negative, {}) || {};
    },
    saveNegativeState: function(state){
      writeJSON(STORAGE.negative, state || {});
    },
    getBlockFlags: function(){
      return readJSON(STORAGE.blockFlags, {}) || {};
    },
    saveBlockFlags: function(flags){
      writeJSON(STORAGE.blockFlags, flags || {});
    },
    clearExpiredBlockFlags: function(){
      var flags = this.getBlockFlags();
      var now = nowTs();
      var changed = false;
      Object.keys(flags).forEach(function(queryKey){
        var apps = flags[queryKey] || {};
        Object.keys(apps).forEach(function(appName){
          if(apps[appName] && apps[appName].expire && apps[appName].expire <= now){
            delete apps[appName];
            changed = true;
          }
        });
        if(Object.keys(apps).length === 0){
          delete flags[queryKey];
          changed = true;
        }else{
          flags[queryKey] = apps;
        }
      });
      if(changed) this.saveBlockFlags(flags);
      return flags;
    },
    isBlockFlagged: function(query, appName){
      if(!query || !appName) return false;
      var flags = this.clearExpiredBlockFlags();
      var queryKey = lowerText(query);
      var entry = (flags[queryKey] || {})[appName];
      return !!entry;
    },
    addBlockFlag: function(query, appName, days){
      if(!query || !appName) return false;
      var d = typeof days === 'number' && days > 0 ? days : BLOCK_FLAG_DEFAULT_DAYS;
      var flags = this.getBlockFlags();
      var queryKey = lowerText(query);
      if(!flags[queryKey]) flags[queryKey] = {};
      flags[queryKey][appName] = {
        expire: nowTs() + d * DAY_MS,
        setAt: nowTs(),
        days: d
      };
      var total = Object.keys(flags).reduce(function(sum, key){
        return sum + Object.keys(flags[key] || {}).length;
      }, 0);
      if(total > BLOCK_FLAG_MAX_ENTRIES){
        var flat = [];
        Object.keys(flags).forEach(function(qk){
          Object.keys(flags[qk] || {}).forEach(function(an){
            flat.push({ qk:qk, an:an, setAt:(flags[qk][an].setAt||0) });
          });
        });
        flat.sort(function(a,b){ return a.setAt - b.setAt; });
        var remove = flat.length - BLOCK_FLAG_MAX_ENTRIES;
        for(var i=0;i<remove;i++){
          delete flags[flat[i].qk][flat[i].an];
          if(Object.keys(flags[flat[i].qk]).length === 0) delete flags[flat[i].qk];
        }
      }
      this.saveBlockFlags(flags);
      return true;
    },
    removeBlockFlag: function(query, appName){
      if(!query || !appName) return false;
      var flags = this.getBlockFlags();
      var queryKey = lowerText(query);
      if(flags[queryKey] && flags[queryKey][appName]){
        delete flags[queryKey][appName];
        if(Object.keys(flags[queryKey]).length === 0) delete flags[queryKey];
        this.saveBlockFlags(flags);
        return true;
      }
      return false;
    },
    getSelfHealingState: function(){
      return readJSON(STORAGE.selfHealing, {}) || {};
    },
    saveSelfHealingState: function(state){
      writeJSON(STORAGE.selfHealing, state || {});
    },
    applySelfHealing: function(query, newDefaultApp){
      var q = normalizeText(query);
      if(!q || !newDefaultApp) return null;
      var queryKey = lowerText(q);
      var weights = this.getRuleWeights();
      if(!weights[queryKey]) weights[queryKey] = {};
      var candidates = (global._lastSearchContext && global._lastSearchContext.list) || [];
      var blockedApps = [];
      // P0-2 修复：自愈不能屏蔽与 query 文本强匹配的 app（如精确/前缀命中）
      // 否则会出现 "搜 taobao 误点 WPS → 淘宝被屏蔽 3 天" 的灾难
      var queryLower = queryKey;
      var isExactOrPrefixMatch = function(app){
        if(!app) return false;
        var name = String(app.name || '');
        var py = String(app.py || '');
        var abbr = String(app.abbr || '');
        var en = String(app.en || '');
        var nameLower = name.toLowerCase();
        var enLower = en.toLowerCase();
        // 精确命中
        if(nameLower === queryLower || py === queryLower || abbr === queryLower || enLower === queryLower) return true;
        // 前缀命中（query 是 app 标识符的前缀）
        if(py.indexOf(queryLower) === 0 || abbr.indexOf(queryLower) === 0 || enLower.indexOf(queryLower) === 0) return true;
        // 中文名称包含 query（且 query 长度 ≥ 2）
        if(queryLower.length >= 2 && nameLower.indexOf(queryLower) >= 0) return true;
        return false;
      };
      candidates.slice(0, 6).forEach(function(app){
        var name = app && app.name;
        if(!name || name === newDefaultApp) return;
        // 跳过与 query 强匹配的 app：仅减权，不加 blockFlag
        if(isExactOrPrefixMatch(app)){
          weights[queryKey][name] = clamp((typeof weights[queryKey][name] === 'number' ? weights[queryKey][name] : 0.5) * 0.85, 0, 1);
          return;
        }
        // 非匹配 app：才执行 blockFlag（用户主动跳过它们选了 newDefaultApp）
        weights[queryKey][name] = clamp((typeof weights[queryKey][name] === 'number' ? weights[queryKey][name] : 0.5) * 0.5, 0, 1);
        engine.addBlockFlag(q, name, BLOCK_FLAG_DEFAULT_DAYS);
        blockedApps.push(name);
      });
      weights[queryKey][newDefaultApp] = clamp((typeof weights[queryKey][newDefaultApp] === 'number' ? weights[queryKey][newDefaultApp] : 0.6) + 0.3, 0, 1);
      this.saveRuleWeights(weights);
      var healing = this.getSelfHealingState();
      if(!healing[queryKey]) healing[queryKey] = [];
      healing[queryKey].unshift({
        defaultApp: newDefaultApp,
        blockedApps: blockedApps,
        timestamp: nowTs()
      });
      healing[queryKey] = healing[queryKey].slice(0, 10);
      this.saveSelfHealingState(healing);
      try{
        if(typeof global._searchCacheClear === 'function') global._searchCacheClear();
        if(typeof global.renderHomeCards === 'function') global.renderHomeCards();
      }catch(_){}
      return { defaultApp: newDefaultApp, blockedApps: blockedApps };
    },
    getBlockFlagPreview: function(query){
      var flags = this.clearExpiredBlockFlags();
      var queryKey = lowerText(query || '');
      var apps = flags[queryKey] || {};
      return Object.keys(apps).map(function(name){
        return {
          app: name,
          expire: apps[name].expire,
          remainDays: Math.max(0, Math.ceil((apps[name].expire - nowTs()) / DAY_MS))
        };
      });
    },
    setContext: function(previousAppPackage, extra){
      this.context = {
        previousAppPackage: normalizeText(previousAppPackage),
        extra: extra || {},
        startedAt: nowTs()
      };
      try{
        if(typeof global._searchCacheClear === 'function') global._searchCacheClear();
        if(typeof global.renderHomeCards === 'function') global.renderHomeCards();
      }catch(_){}
      return this.context;
    },
    getContext: function(){
      return this.context ? Object.assign({}, this.context) : null;
    },
    clearContext: function(){
      this.context = null;
      try{
        if(typeof global._searchCacheClear === 'function') global._searchCacheClear();
        if(typeof global.renderHomeCards === 'function') global.renderHomeCards();
      }catch(_){}
    },
    getProState: function(){
      var def = { enabled:false, location:null, battery:null, signal:null, lastRefresh:0 };
      var s = readJSON(STORAGE.pro, null);
      if(!s || typeof s !== 'object') return def;
      if(typeof s.enabled !== 'boolean') s.enabled = false;
      return s;
    },
    getFloatWindowState: function(){
      var def = {
        enabled: false,
        singleClick: 'search',
        doubleClick: 'meta',
        position: 'top-center',
        autoMorph: true,
        lastX: null,
        lastY: null,
        morphMessage: '',
        morphExpire: 0
      };
      var s = readJSON(STORAGE.floatWindow, null);
      if(!s || typeof s !== 'object') return def;
      if(typeof s.enabled !== 'boolean') s.enabled = false;
      if(typeof s.singleClick !== 'string') s.singleClick = def.singleClick;
      if(typeof s.doubleClick !== 'string') s.doubleClick = def.doubleClick;
      if(typeof s.position !== 'string') s.position = def.position;
      if(['top-left','top-center','top-right'].indexOf(s.position) < 0) s.position = def.position;
      if(typeof s.autoMorph !== 'boolean') s.autoMorph = def.autoMorph;
      return s;
    },
    saveFloatWindowState: function(state){
      writeJSON(STORAGE.floatWindow, state || {});
    },
    isFloatWindowEnabled: function(){
      return !!this.getFloatWindowState().enabled;
    },
    setFloatWindowEnabled: function(enabled){
      var s = this.getFloatWindowState();
      s.enabled = !!enabled;
      this.saveFloatWindowState(s);
      return s;
    },
    updateFloatWindowConfig: function(patch){
      var s = this.getFloatWindowState();
      if(!patch || typeof patch !== 'object') return s;
      if(typeof patch.singleClick === 'string') s.singleClick = patch.singleClick;
      if(typeof patch.doubleClick === 'string') s.doubleClick = patch.doubleClick;
      if(typeof patch.position === 'string' && ['top-left','top-center','top-right'].indexOf(patch.position) >= 0){
        s.position = patch.position;
      }
      if(typeof patch.autoMorph === 'boolean') s.autoMorph = patch.autoMorph;
      if(typeof patch.lastX === 'number') s.lastX = patch.lastX;
      if(typeof patch.lastY === 'number') s.lastY = patch.lastY;
      this.saveFloatWindowState(s);
      return s;
    },
    triggerFloatWindowMorph: function(message, ttlMs){
      var s = this.getFloatWindowState();
      s.morphMessage = String(message || '').slice(0, 80);
      s.morphExpire = nowTs() + (typeof ttlMs === 'number' && ttlMs > 0 ? ttlMs : 8000);
      this.saveFloatWindowState(s);
      return s;
    },
    clearFloatWindowMorph: function(){
      var s = this.getFloatWindowState();
      if(s.morphMessage || s.morphExpire){
        s.morphMessage = '';
        s.morphExpire = 0;
        this.saveFloatWindowState(s);
      }
      return s;
    },
    isFloatWindowMorphActive: function(){
      var s = this.getFloatWindowState();
      if(!s.morphMessage) return false;
      if(s.morphExpire && s.morphExpire <= nowTs()){
        return false;
      }
      return true;
    },
    saveProState: function(state){
      writeJSON(STORAGE.pro, state || {});
    },
    isProEnabled: function(){
      return !!this.getProState().enabled;
    },
    setProEnabled: function(enabled){
      var s = this.getProState();
      s.enabled = !!enabled;
      this.saveProState(s);
      try{
        if(enabled) this.refreshProSnapshot();
        if(typeof global._searchCacheClear === 'function') global._searchCacheClear();
      }catch(_){}
      return s.enabled;
    },
    getProSnapshot: function(){
      var pro = this.getProState();
      var snapshot = {
        time: new Date().toISOString(),
        hour: getHour(),
        language: navigator.language || 'zh-CN',
        online: typeof navigator.onLine === 'boolean' ? navigator.onLine : true,
        memory: (navigator.deviceMemory || null),
        cores: (navigator.hardwareConcurrency || null),
        connection: navigator.connection ? {
          effectiveType: navigator.connection.effectiveType || '',
          downlink: navigator.connection.downlink || null,
          rtt: navigator.connection.rtt || null
        } : null,
        proEnabled: !!pro.enabled,
        location: pro.location || null,
        battery: pro.battery || null,
        signal: pro.signal || (navigator.connection ? {
          effectiveType: navigator.connection.effectiveType || '',
          downlink: navigator.connection.downlink || null,
          rtt: navigator.connection.rtt || null,
          updated: nowTs()
        } : null)
      };
      writeJSON(STORAGE.proSnapshot, snapshot);
      return snapshot;
    },
    refreshProSnapshot: function(){
      var s = this.getProState();
      var self = this;
      s.lastRefresh = nowTs();
      try{
        if(navigator.connection){
          s.signal = {
            effectiveType: navigator.connection.effectiveType || '',
            downlink: navigator.connection.downlink || null,
            rtt: navigator.connection.rtt || null,
            updated: nowTs()
          };
        }
      }catch(_){}
      try{
        if(navigator.getBattery){
          var p = navigator.getBattery();
          if(p && typeof p.then === 'function'){
            p.then(function(b){
              s.battery = {
                level: b.level,
                charging: b.charging,
                granted: true,
                updated: nowTs()
              };
              self.saveProState(s);
            }).catch(function(){});
          }
        }
      }catch(_){}
      try{
        if(navigator.geolocation && s.enabled){
          navigator.geolocation.getCurrentPosition(
            function(pos){
              s.location = {
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                accuracy: pos.coords.accuracy,
                granted: true,
                grantedAt: nowTs()
              };
              self.saveProState(s);
            },
            function(){
              if(!s.location || !s.location.granted){
                s.location = { granted:false, grantedAt: nowTs() };
                self.saveProState(s);
              }
            },
            { timeout: 5000, maximumAge: 600000 }
          );
        }
      }catch(_){}
      this.saveProState(s);
      this.getProSnapshot();
      return s;
    },
    _getProContextBoost: function(query, app){
      var pro = this.getProState();
      if(!pro.enabled) return 0;
      var boost = 0;
      var appName = lowerText(app.name || '');
      var cat = lowerText(app.cat || '');
      var isHeavyMedia = /视频|抖音|b站|youtube|netflix|音乐|网易云|qq音乐|spotify/.test(appName) || cat.indexOf('视频')>=0 || cat.indexOf('音乐')>=0;
      var isGame = /王者|和平精英|原神|游戏|steam/.test(appName) || cat.indexOf('游戏')>=0;
      if(pro.battery && pro.battery.granted){
        var level = pro.battery.level;
        var charging = pro.battery.charging;
        if(typeof level === 'number' && level < 0.2 && !charging){
          if(isHeavyMedia) boost -= 30;
          if(isGame) boost -= 40;
        }
      }
      if(pro.signal && pro.signal.effectiveType){
        var et = lowerText(pro.signal.effectiveType);
        if(et === '2g' || et === 'slow-2g' || (pro.signal.rtt && pro.signal.rtt > 500)){
          if(isHeavyMedia) boost -= 25;
        }
      }
      return boost;
    },
    // v3.3: 微观上下文 Micro-Context — 增强模拟智能的绝对核心
    // 联合：设备信息 + 地点(光感) + 时间 + 手机使用情况 + 用户统计 + 剪贴板
    _getMicroContextBoost: function(query, app){
      if(!this.isEnhancedSimIntEnabled()) return 0;
      var mc = this.getMicroContext();
      var boost = 0;
      var appName = lowerText(app.name || '');
      var cat = lowerText(app.cat || '');
      var hour = getHour();

      // 1. 手机使用情况权重
      if(mc.phoneUsage && mc.phoneUsage.granted){
        var screenMin = mc.phoneUsage.screenOnMinutes || 0;
        var switchCount = mc.phoneUsage.appSwitchCount || 0;
        var isEntertainment = /视频|抖音|b站|youtube|音乐|游戏|王者/.test(appName) || cat.indexOf('视频')>=0 || cat.indexOf('游戏')>=0 || cat.indexOf('音乐')>=0;
        var isProductivity = /笔记|文档|wps|office|邮箱|日历|待办/.test(appName) || cat.indexOf('工具')>=0 || cat.indexOf('效率')>=0;
        // 长时间使用屏幕(>120min) → 深度使用模式，推荐娱乐/沉浸应用
        if(screenMin > 120){
          if(isEntertainment) boost += 25;
          if(isProductivity) boost -= 10;
        }
        // 频繁切换应用(>8次) → 快速任务模式，推荐工具/效率应用
        if(switchCount > 8){
          if(isProductivity) boost += 20;
          if(isEntertainment) boost -= 15;
        }
      }

      // 2. 地点权重（光感模式）
      if(mc.location && mc.location.granted){
        var locMode = mc.location.mode || 'normal';
        if(locMode === 'light_sense'){
          var isNavigation = /地图|导航|高德|百度/.test(appName);
          var isMusic = /音乐|网易云|qq音乐|spotify/.test(appName);
          // 光感模式下可能正在移动 → 推荐导航和音乐
          if(isNavigation) boost += 30;
          if(isMusic) boost += 15;
        }
      }

      // 3. 时间权重（增强版时段感知）
      if(hour < 6){
        // 深夜 → 推荐放松/睡眠类
        if(/时钟|闹钟|睡眠|白噪音|冥想/.test(appName)) boost += 35;
        if(/视频|游戏/.test(appName)) boost -= 20;
      }else if(hour >= 22){
        // 晚间 → 推荐阅读/放松
        if(/阅读|书|新闻/.test(appName)) boost += 20;
      }else if(hour >= 7 && hour < 9){
        // 早高峰 → 推荐新闻/通勤
        if(/新闻|地图|公交|地铁/.test(appName)) boost += 25;
      }

      // 4. 剪贴板识别增强
      if(mc.clipboard && mc.clipboard.granted){
        var clipContent = mc.clipboard.content || '';
        var clipType = mc.clipboard.detectedType || 'text';
        if(clipType === 'tracking' && /菜鸟|快递|物流/.test(appName)){
          boost += 40;
        }else if(clipType === 'url' && /浏览器|chrome|edge/.test(appName)){
          boost += 35;
        }else if(clipType === 'phone' && /电话|拨号|通讯录/.test(appName)){
          boost += 35;
        }
      }

      // 5. 设备信息权重
      if(mc.deviceInfo && mc.deviceInfo.model){
        var sdk = mc.deviceInfo.sdk || 0;
        var isHeavyApp = /王者|原神|和平精英|3d/.test(appName);
        // 低端设备(sdk<24) → 压制重型应用
        if(sdk > 0 && sdk < 24 && isHeavyApp){
          boost -= 20;
        }
      }

      // 6. 用户统计联合权重（结合已有统计增强）
      try{
        var stats = this.getRuleStats();
        var queryKey = lowerText(query);
        var statItem = ((stats[queryKey] || {}).apps || {})[app.name];
        if(statItem){
          // 该应用在此查询下的历史选择频率高 → 增强推荐
          var totalSel = statItem.total || 0;
          if(totalSel >= 3) boost += Math.min(30, totalSel * 8);
        }
      }catch(_){}

      return boost;
    },
    refreshSimIntPanel: function(){
      try{
        var catalog = this.catalog || this.loadCatalog();
        var catalogCount = Object.keys(catalog || {}).reduce(function(total, key){
          return total + (((catalog[key] || {}).apps || []).length);
        }, 0);
        var catalogEl = document.getElementById('simIntCatalogCount');
        var memoryEl = document.getElementById('simIntMemoryCount');
        var pendingEl = document.getElementById('simIntPendingCount');
        if(catalogEl) catalogEl.textContent = String(catalogCount);
        if(memoryEl) memoryEl.textContent = String(this.getMemory().length);
        if(pendingEl) pendingEl.textContent = String(Object.keys(this.getPendingIndex()).length);
      }catch(_){}
    },
    _toT9String: function(text){
      var out = '';
      lowerText(text).split('').forEach(function(ch){
        Object.keys(T9_MAP).some(function(key){
          if(T9_MAP[key].indexOf(ch) >= 0){
            out += key;
            return true;
          }
          return false;
        });
      });
      return out;
    },
    _qwertyPos: function(ch){
      var rows = ['qwertyuiop','asdfghjkl','zxcvbnm'];
      var c = lowerText(ch);
      for(var r=0;r<rows.length;r++){
        var idx = rows[r].indexOf(c);
        if(idx >= 0) return { r:r, c:idx };
      }
      return null;
    },
    _qwertyDist: function(a, b){
      if(a === b) return 0;
      var pa = this._qwertyPos(a);
      var pb = this._qwertyPos(b);
      if(!pa || !pb) return 8;
      // v3.3: QWERTY 行交错补偿 — 模拟真实键盘物理布局
      // row 0 (qwertyuiop) 偏移 0；row 1 (asdfghjkl) 偏移 0.5；row 2 (zxcvbnm) 偏移 1.25
      var rowStagger = [0, 0.5, 1.25];
      var dr = Math.abs(pa.r - pb.r);
      var realDc = Math.abs((pa.c + rowStagger[pa.r]) - (pb.c + rowStagger[pb.r]));
      // 行间移动成本更高（手指跨行切换），保留 1.6 权重
      // 对角线方向叠加额外惩罚（手指伸展更费力）
      var diagPenalty = (dr > 0 && realDc > 0) ? 0.15 : 0;
      return Math.sqrt(dr * dr * 1.6 + realDc * realDc) + diagPenalty;
    },
    // v3.2: 高斯核键距因子 — 距离 0 → 1.0，距离越大因子越小（乘法惩罚而非减法）
    _gaussianKeyFactor: function(query, target){
      if(!query || !target) return 1.0;
      var ql = query.toLowerCase();
      var tl = target.toLowerCase();
      var len = Math.min(ql.length, tl.length, 3);
      if(len === 0) return 1.0;
      var sigma = 2.0;
      var sum = 0, count = 0;
      for(var i=0; i<len; i++){
        var a = ql[i], b = tl[i];
        if(a && b){
          var dist = this._qwertyDist(a, b);
          sum += Math.exp(-dist * dist / (2 * sigma * sigma));
          count++;
        }
      }
      return count > 0 ? sum / count : 1.0;
    },
    _charSetOf: function(app){
      if(app._engineCharSet) return app._engineCharSet;
      var set = new Set();
      [app.name || '', app.py || '', app.en || '', app.abbr || ''].forEach(function(source){
        (source + '').toLowerCase().split('').forEach(function(ch){
          if(ch) set.add(ch);
        });
      });
      app._engineCharSet = set;
      return set;
    },
    _jaccard: function(setA, setB){
      if(!setA.size || !setB.size) return 0;
      var inter = 0;
      setA.forEach(function(value){
        if(setB.has(value)) inter += 1;
      });
      return inter / (setA.size + setB.size - inter);
    },
    // v3.3: 顺序恢复 — query 字符按顺序出现在 target 中（子序列匹配带评分）
    // 基础分 200，连续匹配加分（+30×consecutive），间隔字母惩罚（-3×gap，上限 20）
    _subsequenceScore: function(query, target){
      if(!query || !target) return 0;
      var qi = 0, score = 0, consecutive = 0, lastPos = -1;
      for (var ti = 0; ti < target.length && qi < query.length; ti++) {
        if (target[ti] === query[qi]) {
          if (ti === lastPos + 1) {
            consecutive++;
            score += 30 * consecutive;
          } else {
            consecutive = 0;
            score += 15;
            if (lastPos >= 0) {
              var gap = ti - lastPos - 1;
              score -= Math.min(gap * 3, 20);
            }
          }
          lastPos = ti;
          qi++;
        }
      }
      return qi === query.length ? Math.max(50, score) : 0;
    },
    // v3.3: 子序列判定 — query 是否为 target 的子序列（仅返回布尔，不评分）
    _isSubsequence: function(query, target){
      if(!query || !target) return false;
      var qi = 0;
      for (var ti = 0; ti < target.length && qi < query.length; ti++) {
        if (target[ti] === query[qi]) qi++;
      }
      return qi === query.length;
    },
    buildSearchIndex: function(apps){
      var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      this.searchIndex = createSearchIndex();
      var idx = this.searchIndex;
      (apps || []).forEach(function(app){
        var id = app.id || app.name;
        idx.byAppId.set(id, app);
        var py = lowerText(app.py);
        var abbr = lowerText(app.abbr);
        // 拼音首字母索引：优先用 abbr 字段（数据中已显式提供如 wx/dd/zfb），
        // 否则尝试从 py 按音节首字母提取（仅在 py 含空格分隔时有效），
        // 最后回退为 py 的每个字符（旧行为，保留兼容性）
        var ini = '';
        if(abbr){
          ini = abbr;
        }else if(py && py.indexOf(' ') >= 0){
          ini = py.split(' ').map(function(s){ return s[0] || ''; }).join('');
        }else if(py){
          ini = py;
        }
        if(ini){
          for(var i=1;i<=Math.min(ini.length, 4);i++){
            var k = ini.substring(0, i);
            if(!idx.byInitial.has(k)) idx.byInitial.set(k, []);
            if(idx.byInitial.get(k).indexOf(id) < 0) idx.byInitial.get(k).push(id);
          }
        }
        // 全拼前缀索引（独立于首字母索引，覆盖 1-6 字符前缀）
        if(py){
          for(i=1;i<=Math.min(py.length, 6);i++){
            k = py.substring(0, i);
            if(!idx.byPrefix.has(k)) idx.byPrefix.set(k, []);
            if(idx.byPrefix.get(k).indexOf(id) < 0) idx.byPrefix.get(k).push(id);
          }
        }
        var t9 = engine._toT9String((app.name || '') + py + (app.en || ''));
        if(t9){
          for(i=1;i<=Math.min(t9.length, 4);i++){
            k = t9.substring(0, i);
            if(!idx.byT9.has(k)) idx.byT9.set(k, []);
            if(idx.byT9.get(k).indexOf(id) < 0) idx.byT9.get(k).push(id);
          }
        }
        // P0-5 / P2-7 修复：name 统一 lowercase，byPrefix 推入前先去重
        [lowerText(app.name), py, lowerText(app.en), lowerText(app.abbr)].forEach(function(source){
          if(source.length >= 2){
            for(var size=2;size<=Math.min(source.length, 3);size++){
              var prefix = source.substring(0, size);
              if(!idx.byPrefix.has(prefix)) idx.byPrefix.set(prefix, []);
              if(idx.byPrefix.get(prefix).indexOf(id) < 0) idx.byPrefix.get(prefix).push(id);
            }
          }
        });
        var seen = new Set();
        lowerText((app.name || '') + py + (app.en || '')).split('').forEach(function(ch){
          if(!ch || seen.has(ch)) return;
          seen.add(ch);
          if(!idx.byChar.has(ch)) idx.byChar.set(ch, []);
          idx.byChar.get(ch).push(id);
        });
        // 前缀树索引：把各维度文本逐字插入，沿途记录 App ID，支持前缀扩展召回
        [lowerText(app.name), py, lowerText(app.en), lowerText(app.abbr), ini, t9].forEach(function(source){
          if(source && source.length > 0) _trieInsert(idx.trie, source, id);
        });
      });
      idx.built = true;
      idx.buildTime = Math.round((((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0) * 100) / 100;
      global._gotoEngineSearchIndex = idx;
      return idx;
    },
    watchAppDataset: function(apps){
      var list = apps || global._appDataset || [];
      var version = String(list.length) + '::' + list.slice(0, 3).map(function(app){ return app && app.id || app && app.name || ''; }).join('|');
      if(version !== this.datasetVersion){
        this.datasetVersion = version;
        this.buildSearchIndex(list);
      }
    },
    _getTemporalBoost: function(query, appName){
      var stats = this.getRuleStats();
      var queryKey = lowerText(query);
      var item = (((stats[queryKey] || {}).apps || {})[appName]) || null;
      if(!item) return 0;
      var hour = String(getHour());
      var hourly = (item.hourly || {})[hour] || 0;
      var allTime = item.total || 0;
      return Math.min(90, hourly * 18 + allTime * 4);
    },
    _getWeightBoost: function(query, appName){
      var weights = this.getRuleWeights();
      var queryKey = lowerText(query);
      var weight = (((weights[queryKey] || {})[appName]));
      if(typeof weight !== 'number') return 0;
      // P1-3 修复：clamp weight 到 [0,1] 防止 NaN/Infinity 导致评分异常
      if(!isFinite(weight)) return 0;
      weight = clamp(weight, 0, 1);
      // 仅返回正向 boost：weight<0.5 时返回 0（不惩罚已有基础分）
      // 避免 weight=0 时 score -=110 把正分压成负数导致命中 app 被错误剔除
      return Math.max(0, Math.round((weight - 0.5) * 220));
    },
    _getLaunchCountBoost: function(appName){
      try{
        var stats = readJSON('goto_app_stats', {}) || {};
        var appId = '';
        (global._appDataset || []).forEach(function(a){
          if(a.name === appName){ appId = a.id || a.name; }
        });
        if(!appId) return 0;
        var uses = ((stats[appId] || {}).uses) || 0;
        return Math.min(80, uses * 2);
      }catch(_){ return 0; }
    },
    _getInstalledBoost: function(appName){
      try{
        var installed = readJSON('goto_installed_apps', []) || [];
        if(installed.indexOf(appName) >= 0) return 60;
        return 0;
      }catch(_){ return 0; }
    },
    // v3.3: 模式频率统计 — 记录每次搜索周期中用户最终选择的匹配方式
    _recordModeFrequency: function(mode){
      try{
        if(!mode) return;
        var freq = readJSON(STORAGE.modeFrequency, {}) || {};
        freq[mode] = (freq[mode] || 0) + 1;
        freq.__total = (freq.__total || 0) + 1;
        writeJSON(STORAGE.modeFrequency, freq);
      }catch(_){}
    },
    // v3.3: 模式频率 Boost — 常用匹配方式适当加分
    _getModeFrequencyBoost: function(mode){
      try{
        if(!mode) return 0;
        var freq = readJSON(STORAGE.modeFrequency, {}) || {};
        var total = freq.__total || 0;
        if(total < 5) return 0; // 样本不足时不干预
        var count = freq[mode] || 0;
        var probability = count / total;
        // 概率 > 0.2 时开始加分，最高 +40
        if(probability > 0.2){
          return Math.min(40, Math.round((probability - 0.2) * 100));
        }
        return 0;
      }catch(_){ return 0; }
    },
    // v3.3: 误操作检测 — 短时间内快速搜索→点击视为误操作
    _isRapidMisfire: function(searchTs, clickTs){
      if(!searchTs || !clickTs) return false;
      var delta = clickTs - searchTs;
      // < 120ms 视为误操作（人类有意点击的最快反应时间约 150ms）
      return delta < 120;
    },
    // v3.3: 记录搜索周期时间戳
    _recordCycleTimestamp: function(type, ts){
      try{
        var timestamps = readJSON(STORAGE.cycleTimestamps, { searches: [], clicks: [] }) || { searches: [], clicks: [] };
        var arr = (type === 'search') ? timestamps.searches : timestamps.clicks;
        arr.push(ts);
        if(arr.length > 50) arr.shift(); // 保留最近 50 次
        writeJSON(STORAGE.cycleTimestamps, timestamps);
      }catch(_){}
    },
    _contextRuleBoost: function(query, app){
      var ctx = this.context;
      if(!ctx || !ctx.previousAppPackage) return 0;
      var packageName = lowerText(ctx.previousAppPackage);
      var queryText = normalizeText(query);
      var appName = app.name || '';
      var boost = 0;
      var clipboard = lowerText((ctx.extra || {}).clipboard || '');
      var isTracking = /[a-z0-9]{8,}/i.test(clipboard);
      if((packageName.indexOf('chrome') >= 0 || packageName.indexOf('browser') >= 0 || packageName.indexOf('edge') >= 0) && isTracking){
        if(appName.indexOf('菜鸟') >= 0 || appName.indexOf('快递') >= 0) boost += 220;
      }
      if(packageName.indexOf('王者') >= 0 && /联系|聊天|沟通|开黑/.test(queryText)){
        if(/微信|qq|tim/i.test(appName)) boost += 180;
        if(/飞书|钉钉|企业微信/.test(appName)) boost -= 35;
      }
      return boost;
    },

    // ═══ 工具：把对象或字符串统一解析为 appId ═══
    _resolveAppId: function(appOrId){
      if(!appOrId) return '';
      if(typeof appOrId === 'string' || typeof appOrId === 'number') return String(appOrId);
      return String(appOrId.id || appOrId.name || appOrId.packageName || '');
    },

    // ═══ 统计型排序分（不依赖模拟智能开关）═══
    _getLaunchCountBoostById: function(appId){
      try{
        var stats = readJSON('goto_app_stats', {}) || {};
        var uses = ((stats[appId] || {}).uses) || 0;
        return Math.min(80, uses * 2);
      }catch(_){ return 0; }
    },
    _getLastUsedBoostById: function(appId){
      try{
        var stats = readJSON('goto_app_stats', {}) || {};
        var lastUsed = (stats[appId] || {}).lastUsed;
        if(!lastUsed) return 0;
        var days = (Date.now() - lastUsed) / 86400000;
        if(days < 1) return 28;
        if(days < 3) return 18;
        if(days < 7) return 10;
        if(days < 30) return 4;
        return 0;
      }catch(_){ return 0; }
    },
    _getUsageScore: function(app, query, mode){
      var id = app.id || app.name;
      var name = app.name || '';
      var score = 0;
      score += this._getTemporalBoost(query, name);
      score += this._getLaunchCountBoostById(id);
      score += this._getInstalledBoost(name);
      score += this._getModeFrequencyBoost(mode);
      score += this._getLastUsedBoostById(id);
      return score;
    },

    // ═══ 精确/前缀结果统一格式化（含个性化加权与屏蔽过滤）═══
    _formatResult: function(apps, query, hitLabel, modeLabel, modeKey, t0){
      var q = normalizeText(query);
      var list = apps || [];
      var out = [];
      list.forEach(function(app){
        var name = app.name || '';
        var id = app.id || app.name;
        // 基础命中分：精确 > 前缀
        var score = (hitLabel === '精确') ? 1000 : 800;
        // 统计型排序分（启动次数 / 最近使用 / 已安装 / 时段 / 模式频率）不依赖模拟智能
        score += engine._getUsageScore(app, q, hitLabel);
        if(engine.isSimIntEnabled()){
          score += engine._getWeightBoost(q, name);
          score += engine._contextRuleBoost(q, app);
          score += engine._getProContextBoost(q, app);
          if(engine.isEnhancedSimIntEnabled()) score += engine._getMicroContextBoost(q, app);
        }
        out.push({ app: app, score: Math.max(0, Math.round(score)), appId: id });
      });
      if(engine.isSimIntEnabled()){
        out = out.filter(function(item){ return !engine.isBlockFlagged(q, item.app.name || ''); });
      }
      out.sort(function(a, b){ return b.score - a.score; });
      var scores = {}, hits = {}, modeMap = {};
      out.forEach(function(item){
        scores[item.appId] = item.score;
        hits[item.appId] = [hitLabel];
        modeMap[item.appId] = modeLabel;
      });
      return {
        list: out.slice(0, 30).map(function(item){ return item.app; }),
        scores: scores,
        hits: hits,
        modeMap: modeMap,
        mode: modeKey,
        dt: nowTs() - (t0 || nowTs())
      };
    },

    // ═══ 1. 精确匹配：命中完整 term 才返回 ═══
    exactSearch: function(query, apps){
      var q = normalizeText(query);
      if(!q) return { list:[], mode:'idle', scores:{}, hits:{}, modeMap:{}, dt:0 };
      var t0 = nowTs();
      var lower = q.toLowerCase();
      var searchApps = apps || global._appDataset || [];
      this.watchAppDataset(searchApps);
      var idx = this.searchIndex;
      var matches = [];
      if(idx.built && idx.trie){
        var ids = _trieExactIds(idx.trie, lower);
        if(ids && ids.size > 0){
          ids.forEach(function(id){
            var app = idx.byAppId.get(id);
            if(app) matches.push(app);
          });
        }
      }
      if(matches.length === 0){
        // fallback：线性精确匹配
        searchApps.forEach(function(app){
          if(lowerText(app.name) === lower || lowerText(app.py) === lower || lowerText(app.en) === lower || lowerText(app.abbr) === lower){
            matches.push(app);
          }
        });
      }
      return this._formatResult(matches, q, '精确', '精确匹配', 'exact', t0);
    },

    // ═══ 2. 前缀索引：通过前缀树取出以 query 开头的全部 App ═══
    prefixSearch: function(query, apps){
      var q = normalizeText(query);
      if(!q) return { list:[], mode:'idle', scores:{}, hits:{}, modeMap:{}, dt:0 };
      var t0 = nowTs();
      var lower = q.toLowerCase();
      var searchApps = apps || global._appDataset || [];
      this.watchAppDataset(searchApps);
      var idx = this.searchIndex;
      var matches = [];
      if(idx.built && idx.trie){
        var ids = _triePrefixIds(idx.trie, lower);
        if(ids && ids.size > 0){
          ids.forEach(function(id){
            var app = idx.byAppId.get(id);
            if(app) matches.push(app);
          });
        }
      }
      if(matches.length === 0){
        // fallback：线性前缀匹配
        searchApps.forEach(function(app){
          var name = lowerText(app.name), py = lowerText(app.py), en = lowerText(app.en), abbr = lowerText(app.abbr);
          if(name.indexOf(lower) === 0 || py.indexOf(lower) === 0 || en.indexOf(lower) === 0 || abbr.indexOf(lower) === 0){
            matches.push(app);
          }
        });
      }
      return this._formatResult(matches, q, '前缀', '前缀索引', 'prefix', t0);
    },

    // ═══ 3. 模糊匹配（兜底）═══
    fuzzySearch: function(query, apps){
      var q = normalizeText(query);
      if(!q) return { list:[], mode:'idle', scores:{}, hits:{}, modeMap:{}, dt:0 };
      // v3.3: 增强模拟智能启用时自动 Mock 微观上下文（无需 UI 权限开关）
      if(this.isEnhancedSimIntEnabled()){
        try{ this.autoMockMicroContext(); }catch(_){}
      }
      var t0 = nowTs();
      var lower = q.toLowerCase();
      var isT9Mode = (global._inputLayout === 't9');
      var useT9 = isT9Mode && /^[2-9]+$/.test(lower) && engine._featureFlags.t9;
      // v3.3: useSuper 改为读 FeatureFlags.fuzzyMatch，兼容旧版 super-match classList
      var useSuper = engine._featureFlags.fuzzyMatch;
      try{
        if(!useSuper && typeof document !== 'undefined' && document.body && document.body.classList.contains('super-match')){
          useSuper = true;
        }
      }catch(_){}
      var idx = this.searchIndex;
      var searchApps = apps || global._appDataset || [];
      this.watchAppDataset(searchApps);

      // v3.3: IndexTree 快速路径 — 当 indexTree flag 开启且 IndexTree 已构建时，先查快捷索引
      // 快捷索引命中（priority=1000）直接返回，跳过完整模糊匹配
      if(engine._featureFlags.indexTree && global._indexTree && typeof global._indexTree.search === 'function'){
        try{
          var treeResult = global._indexTree.search(lower);
          if(treeResult.shortcut && treeResult.appIds.length > 0){
            // 快捷索引命中，直接返回
            var hitApps = [];
            treeResult.appIds.forEach(function(id){
              for(var i=0;i<searchApps.length;i++){
                if((searchApps[i].id || searchApps[i].name) === id){
                  hitApps.push(searchApps[i]);
                  break;
                }
              }
            });
            if(hitApps.length > 0){
              var quickScores = {};
              var quickHits = {};
              var quickMode = {};
              hitApps.forEach(function(app, i){
                var id = app.id || app.name;
                quickScores[id] = 1000 - i * 10;
                quickHits[id] = ['快捷索引'];
                quickMode[id] = '快捷索引';
              });
              return {
                list: hitApps,
                scores: quickScores,
                hits: quickHits,
                modeMap: quickMode,
                mode: 'shortcut',
                dt: nowTs() - t0
              };
            }
          }
        }catch(_){ /* IndexTree 失败则回退正常匹配 */ }
      }

      try{
        var candidateSet = null;
        if(idx.built && searchApps === global._appDataset){
          var seenIds = new Set();
          if(useT9){
            (idx.byT9.get(lower) || []).forEach(function(id){ seenIds.add(id); });
            (idx.byT9.get(lower.substring(0, Math.min(lower.length, 2))) || []).forEach(function(id){ seenIds.add(id); });
          }else{
            // 前缀树召回：把 query 当作前缀，取子树下的全部 App（精确匹配的延伸）
            var trieIds = _triePrefixIds(idx.trie, lower);
            if(trieIds) trieIds.forEach(function(id){ seenIds.add(id); });
            if(lower.length === 1){
              (idx.byChar.get(lower) || []).forEach(function(id){ seenIds.add(id); });
            }else if(lower.length === 2){
              (idx.byPrefix.get(lower) || []).forEach(function(id){ seenIds.add(id); });
              (idx.byChar.get(lower[0]) || []).forEach(function(id){ seenIds.add(id); });
              (idx.byChar.get(lower[1]) || []).forEach(function(id){ seenIds.add(id); });
            }else{
              (idx.byPrefix.get(lower.substring(0, 2)) || []).forEach(function(id){ seenIds.add(id); });
              for(var ci=0;ci<Math.min(lower.length, 4);ci++){
                (idx.byChar.get(lower[ci]) || []).forEach(function(id){ seenIds.add(id); });
              }
            }
          }
          if(seenIds.size > 0) candidateSet = Array.from(seenIds);
        }
        if(candidateSet && candidateSet.length > 0 && candidateSet.length < searchApps.length){
          searchApps = candidateSet.map(function(id){ return idx.byAppId.get(id); }).filter(Boolean);
        }
      }catch(_){}

      var out = [];
      searchApps.forEach(function(app){
        var name = app.name || '';
        var py = lowerText(app.py);
        var en = lowerText(app.en);
        var abbr = lowerText(app.abbr);
        var cat = lowerText(app.cat);
        var tags = app.tags || [];
        var score = 0;
        var hits = [];
        var querySet = null, jac = 0;

        // v3.3: MECE 5 维度匹配 — 互斥维度取最高分，分类/标签作为低分兜底
        var dimScores = {};
        // P1-2 修复：统一小写比较，避免 name==='Taobao' 与 q='taobao' 不一致
        var nameLower = name.toLowerCase();

        // 1. 精确 / 前缀 / 包含（互斥维度）
        if(py === lower || en === lower || nameLower === lower || abbr === lower){
          dimScores['精确'] = 1000;
        }else if(py.indexOf(lower) === 0 || en.indexOf(lower) === 0 || nameLower.indexOf(lower) === 0 || abbr.indexOf(lower) === 0){
          dimScores['前缀'] = 800;
        }else if(py.indexOf(lower) >= 0 || en.indexOf(lower) >= 0 || nameLower.indexOf(lower) >= 0 || abbr.indexOf(lower) >= 0){
          dimScores['包含'] = 600;
        }

        // 4. 模糊匹配（融合 Jaccard + 顺序恢复 + 拼音缩写 + 英文缩写，取最高分）
        // 仅在未命中精确/前缀/包含，且 fuzzyMatch 启用时计算
        if(!dimScores['精确'] && !dimScores['前缀'] && !dimScores['包含'] && engine._featureFlags.fuzzyMatch){
          var fuzzyCandidates = [];

          // 4a. 子序列顺序恢复：query 字符按顺序出现在 target 中（中文同时匹配汉字和拼音）
          var subSeqScore = engine._subsequenceScore(lower, nameLower);
          if(subSeqScore === 0 && py) subSeqScore = engine._subsequenceScore(lower, py);
          if(subSeqScore === 0 && en) subSeqScore = engine._subsequenceScore(lower, en);
          if(subSeqScore > 0) fuzzyCandidates.push({ name: '顺序恢复', score: Math.min(400, subSeqScore) });

          // 4b. Jaccard 字符集相似度（super 模式下启用）
          if(useSuper){
            querySet = new Set(lower.split(''));
            jac = engine._jaccard(querySet, engine._charSetOf(app));
            if(jac > 0.5){ fuzzyCandidates.push({ name: '字符集', score: 400 * jac }); }
          }

          // 4c. 拼音缩写匹配：query 是拼音首字母的子序列（如 "wx" → "微信"）
          if(py || abbr){
            var pyInitials = abbr || (py.indexOf(' ') >= 0 ? py.split(' ').map(function(s){ return s[0] || ''; }).join('') : py);
            if(pyInitials && engine._isSubsequence(lower, pyInitials)){
              fuzzyCandidates.push({ name: '拼音缩写', score: 250 });
            }
          }

          // 4d. 英文缩写匹配：query 是英文单词首字母的子序列（如 "wx" → "WeChat"）
          if(en){
            var enInitials = en.split(/\s+/).map(function(item){ return item[0] || ''; }).join('');
            if(enInitials && engine._isSubsequence(lower, enInitials)){
              fuzzyCandidates.push({ name: '英文缩写', score: 250 });
            }
          }

          // 取模糊匹配中最高分
          if(fuzzyCandidates.length > 0){
            fuzzyCandidates.sort(function(a, b){ return b.score - a.score; });
            dimScores[fuzzyCandidates[0].name] = fuzzyCandidates[0].score;
          }
        }

        // 5. T9 匹配（T9 模式独有）
        if(useT9){
          var appT9 = engine._toT9String(name + py + en);
          if(appT9.indexOf(lower) === 0){ dimScores['T9前缀'] = 700; }
          else if(appT9.indexOf(lower) >= 0){ dimScores['T9包含'] = 500; }
        }

        // 低分兜底：分类（80）和标签（50）— 不与上述 5 维度互斥
        if(useSuper && cat.indexOf(lower) >= 0){
          dimScores['分类'] = 80;
        }
        if(useSuper){
          tags.some(function(tag){
            if(lowerText(tag).indexOf(lower) >= 0){
              dimScores['标签'] = 50;
              return true;
            }
            return false;
          });
        }

        // 独立事件并集：取所有维度的最高分 + 记录所有命中的维度
        Object.keys(dimScores).forEach(function(dim){
          if(dimScores[dim] > score) score = dimScores[dim];
          hits.push(dim);
        });

        // v3.2: 高斯核键距惩罚 — 乘法因子（取代旧的减法 distPenalty）
        // P3-1 修复：query 为纯拉丁字母时，target 必须优先取 py/en（同为拉丁字符），
        // 否则与中文名（如 '淘宝'）比较时 _qwertyDist 全部返回 8，因子≈0，把精确命中分数清零
        if(useSuper && /^[a-z]+$/.test(lower) && hits.length && lower.length >= 2){
          var nameIsLatin = /^[a-z0-9\s]+$/i.test(name || '');
          var target = (nameIsLatin ? (lowerText(name) || py || en || '') : (py || en || lowerText(name) || ''));
          var avgFactor = engine._gaussianKeyFactor(lower, target);
          score = Math.round(score * avgFactor);
        }

        // 行为和时段只能重排已经通过文本规则的候选，不能凭空制造搜索结果。
        if(score > 0){
          score += engine._getTemporalBoost(q, name);
          if(engine.isSimIntEnabled()){
            score += engine._getWeightBoost(q, name);
            score += engine._contextRuleBoost(q, app);
            score += engine._getProContextBoost(q, app);
            // v3.3: 模式频率 Boost — 常用匹配方式适当加分
            if(hits.length){
              score += engine._getModeFrequencyBoost(hits[0]);
            }
            // v3.3: 微观上下文 Micro-Context — 仅在增强模拟智能下启用
            if(engine.isEnhancedSimIntEnabled()){
              score += engine._getMicroContextBoost(q, app);
            }
          }
          score += engine._getLaunchCountBoost(name);
          score += engine._getInstalledBoost(name);
        }

        if(score > 0 && useSuper){
          querySet = new Set(lower.split(''));
          jac = engine._jaccard(querySet, engine._charSetOf(app));
          score = Math.round(score * (1 + jac * 0.2));
        }

        if(score > 0){
          out.push({ app: app, score: Math.max(0, Math.round(score)), hits: hits, appId: app.id || app.name });
        }
      });

      var seen = new Set();
      var uniq = out.filter(function(item){
        if(seen.has(item.appId)) return false;
        seen.add(item.appId);
        return true;
      }).sort(function(a, b){ return b.score - a.score; });

      var blockFiltered = uniq;
      if(engine.isSimIntEnabled()){
        try{
          blockFiltered = uniq.filter(function(item){
            return !engine.isBlockFlagged(q, item.app.name || '');
          });
        }catch(_){ blockFiltered = uniq; }
      }
      var scores = {};
      var hitsMap = {};
      var modeMap = {};
      blockFiltered.forEach(function(item){
        scores[item.appId] = item.score;
        hitsMap[item.appId] = item.hits;
        modeMap[item.appId] = item.hits[0] === '精确' ? '精确命中' : (item.hits[0] || '模糊补位');
      });

      return {
        list: blockFiltered.slice(0, 30).map(function(item){ return item.app; }),
        scores: scores,
        hits: hitsMap,
        modeMap: modeMap,
        mode: useT9 ? 't9' : (useSuper ? 'hyper' : 'basic'),
        dt: nowTs() - t0
      };
    },
    _getCategoryLabel: function(catKey){
      var entry = (this.catalog || this.loadCatalog())[catKey];
      return entry ? (entry.label || catKey) : '待识别';
    },
    _findAppsByNames: function(allApps, patterns){
      return (allApps || []).filter(function(app){
        var name = app.name || '';
        return patterns.some(function(pattern){ return name.indexOf(pattern) >= 0; });
      });
    },
    metaSearch: function(query){
      var q = normalizeText(query);
      if(!q) return { list:[], cats:[], scores:{}, modeMap:{}, intentLabel:'待识别', intentCategory:'' };
      if(!document.body.classList.contains('meta-tag-enabled')) return { list:[], cats:[], scores:{}, modeMap:{}, intentLabel:'待识别', intentCategory:'' };

      if(!this.catalog) this.rebuildIndex();
      var structured = this.extractTokens(q);
      var matchedCats = {};
      var appScores = {};
      var modeMap = {};
      var allApps = global._appDataset || [];
      var appMap = {};
      allApps.forEach(function(app){ appMap[app.name] = app; });

      Object.keys(this.catalog || {}).forEach(function(catKey){
        var entry = engine.catalog[catKey] || {};
        var terms = uniqueStrings([].concat(entry.apps || [], entry.keywords || [], [entry.label || '']));
        terms.forEach(function(term){
          var key = lowerText(term);
          if(!key) return;
          if(structured.lower === key){
            matchedCats[catKey] = (matchedCats[catKey] || 0) + 120;
          }else if(structured.lower.indexOf(key) >= 0 || key.indexOf(structured.lower) >= 0){
            matchedCats[catKey] = (matchedCats[catKey] || 0) + 56;
          }else{
            var overlap = key.split('').filter(function(ch){ return structured.lower.indexOf(ch) >= 0; }).length;
            if(overlap >= Math.ceil(Math.max(2, key.length * 0.6))){
              matchedCats[catKey] = (matchedCats[catKey] || 0) + 24;
            }
          }
        });
        structured.actions.forEach(function(action){
          if((entry.keywords || []).indexOf(action) >= 0){
            matchedCats[catKey] = (matchedCats[catKey] || 0) + 70;
          }
        });
        structured.intents.forEach(function(intent){
          // 原有 6 个意图
          if(intent === 'CONTACT' && catKey === 'communication') matchedCats[catKey] = (matchedCats[catKey] || 0) + 88;
          if(intent === 'SEND' && (catKey === 'communication' || catKey === 'office')) matchedCats[catKey] = (matchedCats[catKey] || 0) + 66;
          if(intent === 'CONSUME' && (catKey === 'video' || catKey === 'music' || catKey === 'reading')) matchedCats[catKey] = (matchedCats[catKey] || 0) + 58;
          if(intent === 'TRAVEL' && catKey === 'maps') matchedCats[catKey] = (matchedCats[catKey] || 0) + 88;
          if(intent === 'BUY' && (catKey === 'shopping' || catKey === 'finance')) matchedCats[catKey] = (matchedCats[catKey] || 0) + 74;
          if(intent === 'WORK' && catKey === 'office') matchedCats[catKey] = (matchedCats[catKey] || 0) + 70;
          // 新增 4 个意图
          if(intent === 'SEARCH' && catKey === 'browser') matchedCats[catKey] = (matchedCats[catKey] || 0) + 75;
          if(intent === 'HEALTH' && (catKey === 'health' || catKey === 'system')) matchedCats[catKey] = (matchedCats[catKey] || 0) + 80;
          if(intent === 'LEARN' && (catKey === 'education' || catKey === 'reading')) matchedCats[catKey] = (matchedCats[catKey] || 0) + 72;
          if(intent === 'OPEN' && catKey === 'system') matchedCats[catKey] = (matchedCats[catKey] || 0) + 50;
          if(intent === 'INSTALL' && catKey === 'system') matchedCats[catKey] = (matchedCats[catKey] || 0) + 60;
        });
      });

      // === 语义关联扩展（可选模块，缺失时静默跳过）===
      try{
        var sem = this.semantic || global.GOTOSemantic;
        if(sem && sem.isReady && sem.isReady() && sem.isEnabled && sem.isEnabled()){
          // 同步 L1：立即扩展，零阻塞
          var expansions = sem._expandSync(q, 10) || [];
          if(expansions.length > 0){
            expansions.forEach(function(exp){
              var expKey = lowerText(exp.term);
              Object.keys(engine.catalog || {}).forEach(function(catKey){
                var entry = engine.catalog[catKey] || {};
                uniqueStrings([].concat(entry.apps||[], entry.keywords||[], [entry.label||''])).forEach(function(term){
                  var key = lowerText(term);
                  if(!key) return;
                  if(expKey === key){
                    matchedCats[catKey] = (matchedCats[catKey] || 0) + Math.round(80 * exp.score);
                  }else if(expKey.indexOf(key) >= 0 || key.indexOf(expKey) >= 0){
                    matchedCats[catKey] = (matchedCats[catKey] || 0) + Math.round(38 * exp.score);
                  }
                });
              });
            });
          }
          // 异步 L2：不阻塞返回，结果通过 UI 重渲染体现
          if(typeof sem._expandAsync === 'function'){
            sem._expandAsync(q, 10).then(function(asyncExps){
              if(asyncExps && asyncExps.length > 0){
                try{
                  if(global._lastSearchContext && global._lastSearchContext.query === q){
                    if(typeof global._searchCacheClear === 'function') global._searchCacheClear();
                    if(typeof global.renderHomeCards === 'function') global.renderHomeCards();
                  }
                }catch(_){}
              }
            }).catch(function(_){});
          }
        }
      }catch(_){ /* 降级：semantic 异常不影响主搜索 */ }

      if(this.isSimIntEnabled()){
        // P0-1 修复：权重注入必须校验文本相关性，避免 taobao→wps 这类跨语义污染
        // 仅对已经通过 catalog/keyword 匹配（即 appScores 已有非零基础分）的 app 应用权重 boost
        // 权重单独不能把完全不相关的 app 拉进结果列表
        var weights = this.getRuleWeights();
        var queryWeights = weights[structured.lower] || {};
        Object.keys(queryWeights).forEach(function(appName){
          if(appScores[appName] && appScores[appName] > 0){
            // 已有基础分：可叠加学习权重
            appScores[appName] += Math.round((queryWeights[appName] || 0.5) * 100);
            modeMap[appName] = '个人学习';
          }
          // 无基础分：跳过（不允权重单独注入）
        });
      }

      var sortedCats = Object.keys(matchedCats).sort(function(a, b){ return matchedCats[b] - matchedCats[a]; });
      sortedCats.forEach(function(catKey){
        var entry = engine.catalog[catKey] || {};
        (entry.apps || []).forEach(function(appName, index){
          if(!appMap[appName]) return;
          appScores[appName] = (appScores[appName] || 0) + Math.max(20, (matchedCats[catKey] || 0) - index * 2);
          appScores[appName] += engine._getTemporalBoost(q, appName);
          if(engine.isSimIntEnabled()){
            appScores[appName] += engine._contextRuleBoost(q, appMap[appName]);
            appScores[appName] += engine._getProContextBoost(q, appMap[appName]);
          }
          appScores[appName] += engine._getLaunchCountBoost(appName);
          appScores[appName] += engine._getInstalledBoost(appName);
          if(!modeMap[appName]) modeMap[appName] = '模拟智能命中';
        });
      });

      var resultApps = Object.keys(appScores).map(function(appName){
        return { app: appMap[appName], score: appScores[appName] || 0, name: appName };
      }).filter(function(item){
        if(!item.app) return false;
        if(!engine.isSimIntEnabled()) return true;
        try{ return !engine.isBlockFlagged(q, item.name); }catch(_){ return true; }
      }).sort(function(a, b){ return b.score - a.score; }).slice(0, 20);

      var scoreMap = {};
      resultApps.forEach(function(item){
        var id = item.app.id || item.app.name;
        scoreMap[id] = Math.round(item.score);
        modeMap[id] = modeMap[item.name] || modeMap[id] || '模拟智能命中';
      });

      return {
        list: resultApps.map(function(item){ return item.app; }),
        cats: sortedCats.slice(0, 3),
        scores: scoreMap,
        modeMap: modeMap,
        intentLabel: sortedCats.length ? this._getCategoryLabel(sortedCats[0]) : '待识别',
        intentCategory: sortedCats[0] || ''
      };
    },
    runSearchPipeline: function(query, apps){
      var list = apps || global._appDataset || [];
      // 搜索管线：精确 → 前缀 → 模糊
      var stageResult = this.exactSearch(query, list);
      if(!(stageResult.list && stageResult.list.length > 0)){
        stageResult = this.prefixSearch(query, list);
        if(!(stageResult.list && stageResult.list.length > 0)){
          stageResult = this.fuzzySearch(query, list);
        }
      }
      var result = {
        list: (stageResult.list || []).slice(),
        scores: Object.assign({}, stageResult.scores || {}),
        hits: Object.assign({}, stageResult.hits || {}),
        modeMap: Object.assign({}, stageResult.modeMap || {}),
        mode: stageResult.mode || 'basic',
        dt: stageResult.dt || 0,
        intentLabel: stageResult.intentLabel || '',
        intentCategory: stageResult.intentCategory || ''
      };

      if(document.body.classList.contains('meta-tag-enabled')){
        var metaResult = this.metaSearch(query);
        result.intentLabel = metaResult.intentLabel || result.intentLabel || '待识别';
        result.intentCategory = metaResult.intentCategory || result.intentCategory || '';
        // 优先级：模糊匹配结果最前，模拟智能仅补充未覆盖项
        var fuzzyIds = new Set((result.list || []).map(function(app){ return app.id || app.name; }));
        // metaSearch 补充 modeMap / scores（仅对 fuzzy 已命中的项）
        Object.keys(metaResult.modeMap || {}).forEach(function(id){
          if(fuzzyIds.has(id)) result.modeMap[id] = result.modeMap[id] || metaResult.modeMap[id];
        });
        Object.keys(metaResult.scores || {}).forEach(function(id){
          if(fuzzyIds.has(id)) result.scores[id] = result.scores[id] || metaResult.scores[id];
        });
        // metaSearch 独有结果追加到末尾，标记为"智能推荐"
        var metaOnly = (metaResult.list || []).filter(function(app){
          return !fuzzyIds.has(app.id || app.name);
        });
        metaOnly.forEach(function(app){
          var id = app.id || app.name;
          result.modeMap[id] = '智能推荐';
          result.scores[id] = metaResult.scores[id] || 30;
          result.hits[id] = result.hits[id] || (metaResult.hits || {})[id] || ['意图推断'];
        });
        result.list = (result.list || []).concat(metaOnly);
      }

      if(this.isSimIntEnabled() && (result.list || []).length === 0 && normalizeText(query).length >= 2){
        // P0-6 修复：不再无条件 recordUnknownApp（避免"搜不到→记为未知→下次推为低权重关联"的污染回路）
        // 仅在用户实际有过该 query 的历史关联时，才提供低权重关联建议
        // recordUnknownApp 应该只在 recordSelection 失败路径中调用（即用户点击了某个 app 之后）
        var suggestions = this.getUnknownAppSuggestions(query);
        if(suggestions.length > 0){
          result.list = suggestions;
          suggestions.forEach(function(app, index){
            var id = app.id || app.name;
            result.scores[id] = result.scores[id] || Math.max(24, 60 - index * 6);
            result.modeMap[id] = result.modeMap[id] || '低权重关联';
          });
        }
      }

      // RAG 兜底：规则匹配 + SimInt 均无结果时，最后调用 RAG（需启用 ragFallback 并提供 _ragRecall）
      if(engine._featureFlags.ragFallback && (result.list || []).length === 0 && normalizeText(query).length >= 2){
        try{
          if(typeof global._ragRecall === 'function'){
            var ragHits = global._ragRecall(query, 10) || [];
            if(ragHits.length > 0){
              result.list = ragHits;
              ragHits.forEach(function(app, index){
                var id = app.id || app.name;
                result.scores[id] = result.scores[id] || Math.max(20, 50 - index * 5);
                result.modeMap[id] = result.modeMap[id] || 'RAG 召回';
              });
              result.mode = result.mode + '+rag';
            }
          }
        }catch(_){ /* RAG 失败不影响主流程 */ }
      }

      result.intentLabel = result.intentLabel || ((result.hits && Object.keys(result.hits).length) ? '应用直达' : '待识别');

      // v4.0: 第四层 — 梳理层（personal rerank）
      // 同步消费缓存快照（保证零延迟）；若快照过期则异步刷新供下次使用
      if(engine._personalRerankEnabled){
        try{
          engine._applyPersonalRerankSync(query, result);
        }catch(_){ /* 梳理层异常不影响主搜索 */ }
        // 异步刷新快照（不阻塞当前返回）
        try{
          engine._refreshPersonalSnapshotAsync(query, result.list || []);
        }catch(_){ /* 异步刷新失败静默 */ }
      }

      return result;
    },
    // v4.0: 同步应用梳理层 — 使用缓存快照
    _applyPersonalRerankSync: function(query, result){
      if(!result || !result.list || result.list.length === 0) return;
      var rerank = _loadRerankModule();
      if(!rerank || typeof rerank.rerankWithPersonalLayer !== 'function') return;
      // 快照过期或不存在 → 跳过（等待异步刷新）
      var now = nowTs();
      if(!this._personalSnapshot || (now - this._personalSnapshotTs) > this._personalSnapshotTTL){
        return;
      }
      var reranked = rerank.rerankWithPersonalLayer(query, result.list, this._personalSnapshot, {});
      if(!reranked || !reranked.applied) return;
      // 原地替换：保留 list 顺序，更新 scores/modeMap
      result.list = reranked.list;
      Object.keys(reranked.scores).forEach(function(pkg){
        result.scores[pkg] = reranked.scores[pkg];
      });
      Object.keys(reranked.modeMap).forEach(function(pkg){
        result.modeMap[pkg] = reranked.modeMap[pkg];
      });
      result.rerankApplied = true;
      result.rerankExplanation = reranked.explanation;
    },
    // v4.0: 异步刷新梳理层快照（不阻塞当前搜索）
    _refreshPersonalSnapshotAsync: function(query, list){
      var self = this;
      if(!_baseBridge || _baseBridge.degraded) return;
      var packages = (list || []).map(function(app){
        return app.packageName || app.id || app.name || '';
      }).filter(Boolean);
      if(packages.length === 0) return;
      var ctx = {
        hour: getHour(),
        weekday: new Date().getDay(),
        geofenceId: (this.context && this.context.geofenceId) || '',
        foregroundPackage: (this.context && this.context.previousAppPackage) || ''
      };
      try{
        Promise.resolve(_baseBridge.getPersonalSnapshot(query, packages, ctx)).then(function(snap){
          if(snap){
            self._personalSnapshot = snap;
            self._personalSnapshotTs = nowTs();
          }
        }).catch(function(_){ /* 快照刷新失败静默 */ });
      }catch(_){ /* 桥接异常静默 */ }
    },
    // v4.0: 注入 Base 桥接（由宿主在 Base 加载完成后调用）
    setBaseBridge: function(bridge){
      _baseBridge = bridge || null;
      return this;
    },
    getBaseBridgeStatus: function(){
      return _baseBridge ? _baseBridge.status() : { available: false, degraded: true };
    },
    // v4.0: 用户点击 → 写入 Base feedback-chain
    // 注意：不替换原有 recordSelection（保留 localStorage 学习路径以兼容），
    // 仅额外写入 Base 个人层，作为梳理层的反馈源
    recordSelectionToBase: function(query, clickedApp, rank, candidateCount, matchMode, context){
      if(!_baseBridge || _baseBridge.degraded) return null;
      if(!clickedApp) return null;
      var q = normalizeText(query);
      var list = (global._lastSearchContext && global._lastSearchContext.list) || [];
      var pkg = clickedApp;
      // 尝试从 dataset 反查 packageName
      try{
        var found = list.find(function(app){ return (app.name || '') === clickedApp; });
        if(found && found.packageName) pkg = found.packageName;
      }catch(_){}
      var evt = {
        query: q,
        normalizedQuery: lowerText(q),
        clickedPackage: pkg,
        clickedAppName: clickedApp,
        clickedRank: typeof rank === 'number' ? rank : -1,
        candidateCount: typeof candidateCount === 'number' ? candidateCount : (list.length || 0),
        matchMode: matchMode || 'fuzzy',
        context: context || {
          hour: getHour(),
          weekday: new Date().getDay(),
          geofenceId: (this.context && this.context.geofenceId) || '',
          foregroundPackage: (this.context && this.context.previousAppPackage) || ''
        }
      };
      try{
        return Promise.resolve(_baseBridge.recordFeedbackChainEvent(evt));
      }catch(_){
        return null;
      }
    },
    _touchRuleStats: function(query, appName){
      var stats = this.getRuleStats();
      var queryKey = lowerText(query);
      if(!stats[queryKey]) stats[queryKey] = { apps:{} };
      if(!stats[queryKey].apps[appName]) stats[queryKey].apps[appName] = { total:0, hourly:{} };
      var item = stats[queryKey].apps[appName];
      var hour = String(getHour());
      item.total = (item.total || 0) + 1;
      item.hourly[hour] = (item.hourly[hour] || 0) + 1;
      this.saveRuleStats(stats);
    },
    _recordActionEdge: function(fromKey, toKey){
      if(!fromKey || !toKey || fromKey === toKey) return;
      var store = this.getChainStore();
      if(!store.edges[fromKey]) store.edges[fromKey] = {};
      store.edges[fromKey][toKey] = (store.edges[fromKey][toKey] || 0) + 1;
      store.lastAction = toKey;
      this.saveChainStore(store);
    },
    _applyNegativeFeedback: function(record, clickedApp){
      var queryKey = lowerText(record.query);
      if(!queryKey) return;
      // v3.0: 先对过期权重做时间衰减（30天半衰期，向 0.5 收敛）
      this._applyTimeDecayToQuery(queryKey);
      var weights = this.getRuleWeights();
      var negative = this.getNegativeState();
      if(!weights[queryKey]) weights[queryKey] = {};
      if(!negative[queryKey]) negative[queryKey] = {};

      var candidates = record.candidates || [];
      var clickedIndex = candidates.findIndex(function(item){ return item.app === clickedApp; });
      if(clickedIndex < 0) return;

      candidates.forEach(function(item, idx){
        var current = typeof weights[queryKey][item.app] === 'number' ? weights[queryKey][item.app] : 0.5;
        if(idx < clickedIndex){
          if(clickedIndex === 1 && idx === 0){
            current = current * 0.7;
          }else if(candidates.length >= 10 && clickedIndex >= Math.floor(candidates.length * 0.7)){
            current = current - 0.05;
          }else{
            current = current - 0.08;
          }
          if(!negative[queryKey][item.app]) negative[queryKey][item.app] = { ignored:0 };
          negative[queryKey][item.app].ignored += 1;
          if(negative[queryKey][item.app].ignored >= 3) current = 0;
        }else if(item.app === clickedApp){
          negative[queryKey][item.app] = { ignored:0 };
          if(candidates.length >= 10 && clickedIndex >= Math.floor(candidates.length * 0.7)){
            current = current + 0.24;
          }else if(clickedIndex === 1){
            current = current + 0.12;
          }else if(clickedIndex > 1){
            current = current + 0.2;
          }else{
            current = current + 0.06;
          }
        }
        weights[queryKey][item.app] = clamp(current, 0, 1);
      });

      // v3.2: Hard Negative Weight Transfer — 零和权重转移（用户跳过 3+ 推荐时）
      // 从被跳过的 top 候选中提取 15% 权重，全部转移给被点击的 app
      if(clickedIndex >= 3){
        var transferTotal = 0;
        var transferRate = 0.15;
        for(var hi=0; hi<clickedIndex; hi++){
          var hiApp = candidates[hi].app;
          var hiWeight = typeof weights[queryKey][hiApp] === 'number' ? weights[queryKey][hiApp] : 0.5;
          var extracted = hiWeight * transferRate;
          weights[queryKey][hiApp] = clamp(hiWeight - extracted, 0, 1);
          transferTotal += extracted;
        }
        var clickedApp2 = candidates[clickedIndex].app;
        var clickedWeight = typeof weights[queryKey][clickedApp2] === 'number' ? weights[queryKey][clickedApp2] : 0.5;
        weights[queryKey][clickedApp2] = clamp(clickedWeight + transferTotal, 0, 1);
      }

      // v3.2: Exposure Decay — 曝光未点击衰减（列表滑动隐性差评）
      // 用户视野内出现过但未被点击的 App，触发 0.8 衰减系数
      if(clickedIndex >= 1){
        for(var ei=0; ei<Math.min(clickedIndex, 10); ei++){
          var exposedApp = candidates[ei].app;
          if(exposedApp === clickedApp) continue;
          var exposedWeight = typeof weights[queryKey][exposedApp] === 'number' ? weights[queryKey][exposedApp] : 0.5;
          // 仅当未被 Hard Negative Transfer 处理过时，额外施加曝光衰减
          if(clickedIndex < 3){
            weights[queryKey][exposedApp] = clamp(exposedWeight * 0.8, 0, 1);
          }
        }
      }

      // v3.0: 相似查询权重传递（从用户已学过的相似查询中继承偏好）
      this._transferFromSimilarQueries(queryKey, candidates, weights);
      // v3.0: 全局偏好递增（点击的 app 在跨所有查询中增加 0.05 偏好）
      this._bumpGlobalPreference(clickedApp);

      this.saveRuleWeights(weights);
      this.saveNegativeState(negative);
      // v3.0: 记录本次更新时间戳（用于下次衰减计算）
      var tsMap = this.getRuleWeightsTs();
      tsMap[queryKey] = nowTs();
      this.saveRuleWeightsTs(tsMap);
    },
    // v3.0: 时间衰减 — 向 0.5 收敛（指数衰减，半衰期 30 天）
    _applyTimeDecayToQuery: function(queryKey){
      var tsMap = this.getRuleWeightsTs();
      var lastTs = tsMap[queryKey];
      if(!lastTs) return; // 首次记录，无需衰减
      var daysSince = (nowTs() - lastTs) / DAY_MS;
      if(daysSince < 1) return; // 1 天内不衰减
      var decayFactor = Math.pow(0.5, daysSince / WEIGHT_DECAY.HALF_LIFE_DAYS);
      var weights = this.getRuleWeights();
      if(!weights[queryKey]) return;
      var changed = false;
      Object.keys(weights[queryKey]).forEach(function(app){
        var cur = weights[queryKey][app];
        // 向 0.5 指数收敛（保留历史，不完全清除）
        var decayed = 0.5 + (cur - 0.5) * decayFactor;
        decayed = Math.max(WEIGHT_DECAY.MIN_FLOOR, decayed);
        if(Math.abs(decayed - cur) > 0.001){
          weights[queryKey][app] = clamp(decayed, 0, 1);
          changed = true;
        }
      });
      if(changed) this.saveRuleWeights(weights);
    },
    // v3.0: 判断两个查询是否相似（前缀相同 或 字符重叠率 ≥50%）
    _isSimilarQuery: function(q1, q2){
      if(!q1 || !q2 || q1 === q2) return q1 === q2;
      var prefix = SIM_TRANSFER.PREFIX_LEN;
      if(q1.length >= prefix && q2.length >= prefix &&
         q1.substring(0, prefix) === q2.substring(0, prefix)) return true;
      var chars1 = q1.split('');
      var chars2 = {};
      q2.split('').forEach(function(c){ chars2[c] = (chars2[c] || 0) + 1; });
      var overlap = chars1.filter(function(c){ return chars2[c] > 0; }).length;
      return overlap / Math.max(q1.length, q2.length) >= SIM_TRANSFER.MIN_OVERLAP;
    },
    // v3.0: 相似查询权重传递（从相似已学过的查询中按 20% 比例继承）
    _transferFromSimilarQueries: function(queryKey, candidates, weights){
      var allWeights = this.getRuleWeights();
      var self = this;
      var candidateAppSet = {};
      candidates.forEach(function(c){ if(c && c.app) candidateAppSet[c.app] = true; });
      Object.keys(allWeights).forEach(function(otherKey){
        if(otherKey === queryKey) return;
        if(!self._isSimilarQuery(queryKey, otherKey)) return;
        Object.keys(allWeights[otherKey]).forEach(function(appName){
          if(!candidateAppSet[appName]) return; // 只影响当前查询的候选
          var otherW = allWeights[otherKey][appName];
          // 相似查询的权重以 0.5 为基准，按 20% 比例叠加到当前权重
          var delta = (otherW - 0.5) * SIM_TRANSFER.RATIO;
          weights[queryKey][appName] = clamp(weights[queryKey][appName] + delta, 0, 1);
        });
      });
    },
    // v3.0: 全局偏好递增（被点击的 app 在所有查询中增加偏好值）
    _bumpGlobalPreference: function(appName){
      if(!appName) return;
      var pref = this.getGlobalPreference();
      pref[appName] = Math.min(1.0, (pref[appName] || 0.5) + 0.05);
      this.saveGlobalPreference(pref);
    },
    // v3.1: 全局衰减 — 对所有过期查询权重复用 _applyTimeDecayToQuery
    // 解决原算法仅在用户点击时才衰减的问题，避免历史偏好永远不衰减
    _decayAllStaleQueries: function(){
      var tsMap = this.getRuleWeightsTs();
      var queryKeys = Object.keys(tsMap);
      if(queryKeys.length === 0) return { decayedCount: 0, totalChecked: 0 };
      var decayedCount = 0;
      for(var i=0;i<queryKeys.length;i++){
        var key = queryKeys[i];
        var lastTs = tsMap[key];
        if(!lastTs) continue;
        var daysSince = (nowTs() - lastTs) / DAY_MS;
        if(daysSince < MAINTENANCE.STALE_THRESHOLD_DAYS) continue;
        var beforeWeights = this.getRuleWeights()[key];
        if(!beforeWeights) continue;
        var beforeSnap = '';
        try{ beforeSnap = JSON.stringify(beforeWeights); }catch(_){}
        this._applyTimeDecayToQuery(key);
        var afterWeights = this.getRuleWeights()[key];
        var afterSnap = '';
        try{ afterSnap = JSON.stringify(afterWeights || {}); }catch(_){}
        if(beforeSnap && beforeSnap !== afterSnap) decayedCount++;
      }
      return { decayedCount: decayedCount, totalChecked: queryKeys.length };
    },
    // v3.1: 链式边修剪 — 清理低频边、限制每节点边数、限制总边数
    // 解决 _recordActionEdge 无界增长导致的内存膨胀和推荐拖慢问题
    _pruneChainStore: function(){
      var store = this.getChainStore();
      var edges = store.edges || {};
      var fromKeys = Object.keys(edges);
      var prunedEdges = 0;
      var totalEdges = 0;

      // 阶段 1：每个 fromKey 内清理低权重 + 限制每节点边数
      fromKeys.forEach(function(fromKey){
        var toMap = edges[fromKey] || {};
        var toKeys = Object.keys(toMap);
        // 清理低于阈值的边
        toKeys.forEach(function(toKey){
          if((toMap[toKey] || 0) < MAINTENANCE.CHAIN_MIN_WEIGHT){
            delete toMap[toKey];
            prunedEdges++;
          }
        });
        // 每节点超出上限时按权重降序剪掉
        var remaining = Object.keys(toMap);
        if(remaining.length > MAINTENANCE.CHAIN_MAX_PER_NODE){
          remaining.sort(function(a, b){ return (toMap[b] || 0) - (toMap[a] || 0); });
          var toRemove = remaining.slice(MAINTENANCE.CHAIN_MAX_PER_NODE);
          toRemove.forEach(function(k){
            delete toMap[k];
            prunedEdges++;
          });
        }
        if(Object.keys(toMap).length === 0){
          delete edges[fromKey];
        } else {
          edges[fromKey] = toMap;
          totalEdges += Object.keys(toMap).length;
        }
      });

      // 阶段 2：总边数超限时按权重降序截断
      if(totalEdges > MAINTENANCE.CHAIN_MAX_EDGES){
        var allEdges = [];
        Object.keys(edges).forEach(function(fk){
          Object.keys(edges[fk]).forEach(function(tk){
            allEdges.push({ from:fk, to:tk, weight:edges[fk][tk] });
          });
        });
        allEdges.sort(function(a, b){ return b.weight - a.weight; });
        var keep = allEdges.slice(0, MAINTENANCE.CHAIN_MAX_EDGES);
        var newEdges = {};
        keep.forEach(function(e){
          if(!newEdges[e.from]) newEdges[e.from] = {};
          newEdges[e.from][e.to] = e.weight;
        });
        prunedEdges += totalEdges - keep.length;
        store.edges = newEdges;
      } else {
        store.edges = edges;
      }

      this.saveChainStore(store);
      return { prunedEdges: prunedEdges, remainingEdges: totalEdges > MAINTENANCE.CHAIN_MAX_EDGES ? MAINTENANCE.CHAIN_MAX_EDGES : totalEdges };
    },
    // v3.1: 旧记忆修剪 — 按时间窗 + 条数双层保险
    _pruneOldMemory: function(){
      var memory = this.getMemory();
      if(memory.length === 0) return { pruned: 0, remaining: 0 };
      var cutoff = nowTs() - MAINTENANCE.MEMORY_MAX_AGE_DAYS * DAY_MS;
      var before = memory.length;
      memory = memory.filter(function(rec){
        return (rec.timestamp || 0) > cutoff;
      });
      if(memory.length > MAINTENANCE.MEMORY_MAX_RECORDS){
        memory = memory.slice(-MAINTENANCE.MEMORY_MAX_RECORDS);
      }
      this.saveMemory(memory);
      return { pruned: before - memory.length, remaining: memory.length };
    },
    // v3.1: 引擎自主维护（启动时自动调用，可手动触发）
    // 顺序：先全局衰减权重 → 再修剪链式边 → 再修剪旧记忆 → 最后清理过期 block flag
    maintain: function(){
      var decayResult = this._decayAllStaleQueries();
      var chainResult = this._pruneChainStore();
      var memoryResult = this._pruneOldMemory();
      try{ this.clearExpiredBlockFlags(); }catch(_){}
      return {
        decayedQueries: decayResult.decayedCount,
        totalQueriesChecked: decayResult.totalChecked,
        prunedChainEdges: chainResult.prunedEdges,
        remainingChainEdges: chainResult.remainingEdges,
        prunedMemoryRecords: memoryResult.pruned,
        remainingMemory: memoryResult.remaining,
        ts: nowTs()
      };
    },
    recordSearch: function(query, result){
      if(!this.isSimIntEnabled()) return;
      var q = this.sanitizeQuery(query);
      if(!q) return;
      var memory = this.getMemory();
      var structured = this.extractTokens(q);
      var searchTs = nowTs();
      // v3.3: 记录搜索周期时间戳（用于误操作检测）
      this._recordCycleTimestamp('search', searchTs);
      var rec = {
        id: String(searchTs) + '_' + Math.random().toString(36).slice(2, 7),
        query: q,
        tokens: {
          action: structured.actions,
          relation: structured.relations,
          target: structured.target,
          intent: structured.intents
        },
        context: this.getContext(),
        intentCategory: result.intentCategory || '',
        intentLabel: result.intentLabel || '待识别',
        candidates: (result.list || []).slice(0, 8).map(function(app){
          var id = app.id || app.name;
          return {
            app: app.name,
            score: (result.scores || {})[id] || 0,
            mode: (result.modeMap || {})[id] || ''
          };
        }),
        clickedApp: '',
        clickedRank: null,
        clickedMode: '',
        timestamp: searchTs
      };
      memory.push(rec);
      this.saveMemory(memory);
      this.lastRecordId = rec.id;
      this.lastSearchTimestamp = searchTs;
      this.refreshSimIntPanel();
    },
    recordSelection: function(query, clickedApp){
      if(!this.isSimIntEnabled()) return;
      var q = this.sanitizeQuery(query);
      if(!q || !clickedApp) return;
      var clickTs = nowTs();
      // v3.3: 误操作检测 — 搜索→点击间隔过短视为误操作
      var searchTs = this.lastSearchTimestamp || 0;
      var isMisfire = this._isRapidMisfire(searchTs, clickTs);
      this._recordCycleTimestamp('click', clickTs);
      var memory = this.getMemory();
      var target = null;
      for(var i = memory.length - 1; i >= 0; i--){
        if(memory[i].id === this.lastRecordId){
          target = memory[i];
          break;
        }
      }
      if(!target){
        target = {
          id: String(clickTs) + '_late',
          query: q,
          tokens: this.extractTokens(q),
          candidates: [],
          timestamp: clickTs
        };
        memory.push(target);
      }

      var ctx = global._lastSearchContext || this.lastSearchContext || {};
      var list = ctx.list || [];
      var idx = list.findIndex(function(app){ return (app.name || '') === clickedApp; });
      var app = idx >= 0 ? list[idx] : null;
      var appId = app ? (app.id || app.name) : clickedApp;
      target.clickedApp = clickedApp;
      target.clickedRank = idx >= 0 ? idx + 1 : null;
      target.clickedMode = ((ctx.info || {}).modeMap || {})[appId] || '';
      target.intentLabel = target.intentLabel || ((ctx.info || {}).intentLabel) || '待识别';
      target.isMisfire = isMisfire; // v3.3: 标记误操作
      this.saveMemory(memory);

      // v4.0: 同步写入 Base feedback-chain（梳理层反馈源）
      // 误操作不写入 Base，避免污染个人层
      if(!isMisfire){
        try{
          this.recordSelectionToBase(
            q, clickedApp,
            target.clickedRank !== null ? (target.clickedRank - 1) : -1,  // 转 0-based
            (target.candidates || []).length,
            target.clickedMode || 'fuzzy'
          );
        }catch(_){ /* Base 写入失败不影响主流程 */ }
      }

      // v3.3: 误操作不更新统计（和自适应刷新同一个重复修正逻辑）
      if(!isMisfire){
        this._touchRuleStats(q, clickedApp);
        // v3.3: 记录模式频率（多周期统计 → 权重调整）
        if(target.clickedMode){
          this._recordModeFrequency(target.clickedMode);
        }
      }
      this._applyNegativeFeedback(target, clickedApp);
      // 记录 app→app 关联边（上次启动的 app → 本次启动的 app）
      var _preChain = this.getChainStore();
      var _preLast = _preChain.lastAction || '';
      if(_preLast && _preLast.indexOf('app:') === 0){
        var _preAppName = _preLast.replace(/^app:/, '');
        if(_preAppName && _preAppName !== clickedApp){
          this._recordActionEdge('app:' + _preAppName, 'app:' + clickedApp);
        }
      }
      this._recordActionEdge('query:' + lowerText(q), 'app:' + clickedApp);
      if(this.context && this.context.previousAppPackage){
        this._recordActionEdge('context:' + lowerText(this.context.previousAppPackage), 'app:' + clickedApp);
      }
      this.refreshSimIntPanel();
      try{
        if(typeof global._searchCacheClear === 'function') global._searchCacheClear();
        if(typeof global.renderHomeCards === 'function') global.renderHomeCards();
      }catch(_){}
    },
    // v3.2: 点击延迟 EMA（指数移动平均）— 用于评估用户置信度
    // 低延迟 (<300ms) = 高置信 = 增强权重；高延迟 (>1500ms) = 低置信 = 减少奖励
    recordClickDelay: function(query, clickedApp, delayMs){
      if(!this.isSimIntEnabled()) return;
      var q = this.sanitizeQuery(query);
      if(!q || !clickedApp || typeof delayMs !== 'number') return;
      var ema = readJSON(STORAGE.clickDelayEMA, { value: 600, samples: 0 }) || { value: 600, samples: 0 };
      var alpha = 0.15;
      ema.value = ema.value * (1 - alpha) + delayMs * alpha;
      ema.samples = (ema.samples || 0) + 1;
      writeJSON(STORAGE.clickDelayEMA, ema);
      // 低延迟 (<300ms) = 高置信 = 增强权重
      // 高延迟 (>1500ms) = 低置信 = 减少奖励
      var confidence = 1.0;
      if(ema.samples >= 3){
        if(delayMs < 300) confidence = 1.5;
        else if(delayMs < ema.value * 0.7) confidence = 1.25;
        else if(delayMs > ema.value * 1.5) confidence = 0.6;
        else if(delayMs > 1500) confidence = 0.4;
      }
      // 将置信度应用到最近一次权重更新
      var weights = this.getRuleWeights();
      var queryKey = lowerText(q);
      if(weights[queryKey] && weights[queryKey][clickedApp]){
        var current = weights[queryKey][clickedApp];
        weights[queryKey][clickedApp] = clamp(0.5 + (current - 0.5) * confidence, 0, 1);
        this.saveRuleWeights(weights);
      }
      // 智能提醒场景 (b)：用户启动应用后，预测下一个可能启动的应用
      try{
        if(typeof global._smartReminderTryExpandAfterLaunch === 'function'){
          global._smartReminderTryExpandAfterLaunch(clickedApp);
        }
      }catch(_){}
    },
    getClickDelayEMA: function(){
      return readJSON(STORAGE.clickDelayEMA, { value: 600, samples: 0 }) || { value: 600, samples: 0 };
    },
    // v3.2: 犹豫补偿延迟 — 自适应刷新系统可调用，返回额外延迟毫秒数
    // 当检测到显著键距时，返回 80ms 额外延迟以等待用户修正输入
    getHesitationDelay: function(query){
      // 自适应刷新层关闭时不延迟
      if(!engine._featureFlags.adaptiveRefresh) return 0;
      if(!this.isSimIntEnabled()) return 0;
      var q = this.sanitizeQuery(query);
      if(!q) return 0;
      var lower = q.toLowerCase();
      // 检查是否会触发高斯键距惩罚
      if(!/^[a-z]+$/.test(lower) || lower.length < 2) return 0;
      // 检查上次搜索是否有结果存在显著键距
      // P3-1 修复：appName 为中文时，应取 py/en 作为键距比较目标，否则因子恒≈0 触发误延迟
      var ctx = global._lastSearchContext || this.lastSearchContext || {};
      var list = ctx.list || [];
      for(var i=0; i<Math.min(list.length, 3); i++){
        var app = list[i] || {};
        var appName = app.name || '';
        var nameIsLatin = /^[a-z0-9\s]+$/i.test(appName);
        var target = nameIsLatin ? appName : (app.py || app.en || appName);
        var factor = this._gaussianKeyFactor(lower, target);
        if(factor < 0.8) return 80; // 犹豫延迟
      }
      return 0;
    },
    recordUnknownApp: function(query){
      var q = this.sanitizeQuery(query);
      if(!q) return;
      var pending = this.getPendingIndex();
      if(!pending[q]){
        pending[q] = { name:q, count:0, coOccur:{}, firstSeen:nowTs(), lastSeen:nowTs() };
      }
      pending[q].count += 1;
      pending[q].lastSeen = nowTs();
      try{
        var recentApps = readJSON('goto_recent_apps', []) || [];
        recentApps.slice(0, 4).forEach(function(appName){
          if(appName && appName !== q){
            pending[q].coOccur[appName] = (pending[q].coOccur[appName] || 0) + 1;
          }
        });
      }catch(_){}
      var keys = Object.keys(pending);
      if(keys.length > 120){
        keys.sort(function(a, b){ return (pending[a].lastSeen || 0) - (pending[b].lastSeen || 0); });
        keys.slice(0, keys.length - 120).forEach(function(key){ delete pending[key]; });
      }
      this.savePendingIndex(pending);
      this.refreshSimIntPanel();
    },
    getUnknownApps: function(){
      var pending = this.getPendingIndex();
      return Object.keys(pending).map(function(key){ return pending[key]; }).sort(function(a, b){
        return (b.count || 0) - (a.count || 0);
      });
    },
    getUnknownAppSuggestions: function(query){
      var q = normalizeText(query);
      if(q.length < 2) return [];
      var pending = this.getPendingIndex();
      var entry = pending[q];
      if(!entry) return [];
      var allApps = global._appDataset || [];
      return Object.keys(entry.coOccur || {}).map(function(name){
        return { name:name, weight:entry.coOccur[name] || 0 };
      }).sort(function(a, b){ return b.weight - a.weight; }).slice(0, 5).map(function(item){
        return allApps.find(function(app){ return app.name === item.name; });
      }).filter(Boolean);
    },
    getChainRoutingSuggestions: function(options){
      var opts = options || {};
      var allApps = opts.allApps || global._appDataset || [];
      var result = [];
      var pushApps = function(apps){
        (apps || []).forEach(function(app){
          if(!app) return;
          if(result.some(function(item){ return (item.id || item.name) === (app.id || app.name); })) return;
          result.push(app);
        });
      };

      var ctx = this.context;
      if(ctx && ctx.previousAppPackage){
        var pkg = lowerText(ctx.previousAppPackage);
        var clipboard = lowerText((ctx.extra || {}).clipboard || '');
        if((pkg.indexOf('browser') >= 0 || pkg.indexOf('chrome') >= 0 || pkg.indexOf('edge') >= 0) && /[a-z0-9]{8,}/i.test(clipboard)){
          pushApps(this._findAppsByNames(allApps, ['菜鸟','快递']));
        }
        if(pkg.indexOf('王者') >= 0){
          pushApps(this._findAppsByNames(allApps, ['微信','QQ','TIM']));
        }
      }

      var chains = this.getChainStore();
      var lastAction = chains.lastAction || '';
      if(lastAction && chains.edges[lastAction]){
        var edges = chains.edges[lastAction];
        var total = Object.keys(edges).reduce(function(sum, key){ return sum + (edges[key] || 0); }, 0);
        Object.keys(edges).sort(function(a, b){ return edges[b] - edges[a]; }).forEach(function(nextKey){
          if(total <= 0) return;
          if((edges[nextKey] / total) < 0.8) return;
          var appName = nextKey.replace(/^app:/, '');
          var found = allApps.find(function(app){ return app.name === appName; });
          if(found) pushApps([found]);
        });
      }

      var query = normalizeText(opts.query);
      if(query){
        pushApps(this.getUnknownAppSuggestions(query));
      }

      return result.slice(0, opts.limit || 6);
    },
    // 关联规则推荐：给定刚启动的 App，返回置信度≥阈值的下一个 App
    getAssociationRecommendation: function(fromApp, opts){
      var o = opts || {};
      var threshold = typeof o.threshold === 'number' ? o.threshold : 0.8;
      var limit = typeof o.limit === 'number' ? o.limit : 3;
      var minCount = typeof o.minCount === 'number' ? o.minCount : 2;
      if(!fromApp) return [];
      var fromKey = 'app:' + normalizeText(fromApp);
      var chains = this.getChainStore();
      var edges = chains.edges[fromKey];
      if(!edges) return [];
      var total = Object.keys(edges).reduce(function(sum, key){ return sum + (edges[key] || 0); }, 0);
      if(total < minCount) return [];
      var recs = [];
      Object.keys(edges).sort(function(a, b){ return edges[b] - edges[a]; }).forEach(function(nextKey){
        if(total <= 0) return;
        var conf = edges[nextKey] / total;
        if(conf < threshold) return;
        var appName = nextKey.replace(/^app:/, '');
        if(!appName) return;
        recs.push({
          app: appName,
          confidence: Math.round(conf * 100) / 100,
          count: edges[nextKey],
          total: total
        });
      });
      return recs.slice(0, limit);
    },
    // 快捷气泡：基于当前查询返回主动推荐建议
    getQuickBubbles: function(query, opts){
      var o = opts || {};
      var limit = typeof o.limit === 'number' ? o.limit : 3;
      var q = normalizeText(query);
      if(!q) return [];
      var queryKey = 'query:' + lowerText(q);
      var chains = this.getChainStore();
      var edges = chains.edges[queryKey];
      var bubbles = [];
      if(edges){
        var total = Object.keys(edges).reduce(function(sum, key){ return sum + (edges[key] || 0); }, 0);
        Object.keys(edges).sort(function(a, b){ return edges[b] - edges[a]; }).forEach(function(nextKey){
          if(total <= 0) return;
          var conf = edges[nextKey] / total;
          if(conf < 0.6) return;
          var appName = nextKey.replace(/^app:/, '');
          if(!appName) return;
          bubbles.push({
            type: 'app',
            label: appName,
            app: appName,
            confidence: Math.round(conf * 100) / 100,
            source: 'association'
          });
        });
      }
      // 意图扩散：基于同义词映射补充气泡
      var tokens = this.extractTokens(q);
      var self = this;
      (tokens.intents || []).forEach(function(intent){
        if(intent === 'TRAVEL' && bubbles.length < limit){
          bubbles.push({ type:'intent', label:'打车出行', app:'高德地图', confidence:0.5, source:'intent:'+intent });
        }else if(intent === 'BUY' && bubbles.length < limit){
          bubbles.push({ type:'intent', label:'点外卖', app:'美团', confidence:0.5, source:'intent:'+intent });
        }else if(intent === 'CONSUME' && bubbles.length < limit){
          bubbles.push({ type:'intent', label:'看视频', app:'B站', confidence:0.5, source:'intent:'+intent });
        }
      });
      // 去重（按 app 名）
      var seen = {};
      bubbles = bubbles.filter(function(b){
        if(seen[b.app]) return false;
        seen[b.app] = true;
        return true;
      });
      return bubbles.slice(0, limit);
    },
    // 24小时分时段统计：返回 24 长度数组，每项含 hour/total/topApps
    getHourlyStats: function(opts){
      var o = opts || {};
      var topN = typeof o.topN === 'number' ? o.topN : 3;
      var stats = this.getRuleStats();
      var hours = [];
      for(var h=0; h<24; h++){
        hours.push({ hour:h, total:0, apps:{} });
      }
      Object.keys(stats).forEach(function(queryKey){
        var apps = (stats[queryKey] && stats[queryKey].apps) || {};
        Object.keys(apps).forEach(function(appName){
          var item = apps[appName] || {};
          var hourly = item.hourly || {};
          Object.keys(hourly).forEach(function(hKey){
            var h = parseInt(hKey, 10);
            if(h >= 0 && h < 24){
              hours[h].total += (hourly[hKey] || 0);
              hours[h].apps[appName] = (hours[h].apps[appName] || 0) + (hourly[hKey] || 0);
            }
          });
        });
      });
      // 每小时 topN apps
      hours.forEach(function(item){
        item.topApps = Object.keys(item.apps).map(function(name){
          return { app:name, count:item.apps[name] };
        }).sort(function(a,b){ return b.count - a.count; }).slice(0, topN);
      });
      return hours;
    },
    // 全时段统计：返回总 query 数、总点击数、top apps
    getFullTimeStats: function(opts){
      var o = opts || {};
      var topN = typeof o.topN === 'number' ? o.topN : 10;
      var stats = this.getRuleStats();
      var totalClicks = 0;
      var queryCount = Object.keys(stats).length;
      var appAgg = {};
      Object.keys(stats).forEach(function(queryKey){
        var apps = (stats[queryKey] && stats[queryKey].apps) || {};
        Object.keys(apps).forEach(function(appName){
          var item = apps[appName] || {};
          var t = item.total || 0;
          totalClicks += t;
          appAgg[appName] = (appAgg[appName] || 0) + t;
        });
      });
      var topApps = Object.keys(appAgg).map(function(name){
        return { app:name, count:appAgg[name] };
      }).sort(function(a,b){ return b.count - a.count; }).slice(0, topN);
      return {
        queryCount: queryCount,
        totalClicks: totalClicks,
        topApps: topApps,
        uniqueApps: Object.keys(appAgg).length
      };
    },
    // 当前时段（小时）推荐：基于 24 小时统计，返回当前小时 top apps
    getCurrentHourStats: function(){
      var h = getHour();
      var hours = this.getHourlyStats({ topN:5 });
      return hours[h] || { hour:h, total:0, topApps:[] };
    },
    // ═══ v3.2 用户统计数据向量化 + 导出 embedding ═══
    // 把用户行为数据转换为数值向量，可用于：
    //   1. 跨设备同步用户偏好（不暴露原始数据）
    //   2. 与其他推荐系统对接（导出 embedding）
    //   3. 异常检测（向量相似度对比）
    // 向量结构：
    //   [24 小时桶频次（24维）, 11 意图分布（11维）, 20 分类偏好（20维）, 全局偏好 top-10（10维）]
    //   共 65 维
    vectorizeUserData: function(){
      try{
        var vector = [];

        // 1. 24 小时桶频次（24维）
        // P2-11 修复：删除恒等三元（STORAGE.stats ? ... : ... 永远走同一分支）
        var hourlyLaunch = readJSON('goto_stats_hourly_launch', {});
        if(!hourlyLaunch || typeof hourlyLaunch !== 'object') hourlyLaunch = {};
        try{
          var rawHourly = JSON.parse(localStorage.getItem('goto_stats_hourly_launch')||'{}');
          if(rawHourly && typeof rawHourly === 'object') hourlyLaunch = rawHourly;
        }catch(_){}
        var maxHourCount = 1;
        for(var h=0; h<24; h++){
          var c = hourlyLaunch[h] || 0;
          if(c > maxHourCount) maxHourCount = c;
        }
        for(var h2=0; h2<24; h2++){
          vector.push((hourlyLaunch[h2] || 0) / maxHourCount);  // 归一化到 [0, 1]
        }

        // 2. 11 意图分布（11维）
        var intentKeys = ['SEND','CONSUME','CONTACT','TRAVEL','BUY','WORK','SEARCH','OPEN','INSTALL','HEALTH','LEARN'];
        var intentCounts = {};
        var memory = this.getMemory();
        (memory || []).forEach(function(rec){
          if(rec && rec.intents && Array.isArray(rec.intents)){
            rec.intents.forEach(function(it){
              if(it) intentCounts[it] = (intentCounts[it] || 0) + 1;
            });
          }
        });
        var maxIntent = 1;
        intentKeys.forEach(function(k){ if(intentCounts[k] > maxIntent) maxIntent = intentCounts[k]; });
        intentKeys.forEach(function(k){
          vector.push((intentCounts[k] || 0) / maxIntent);
        });

        // 3. 20 分类偏好（20维）
        var catalog = this.catalog || this.loadCatalog();
        var catKeys = Object.keys(catalog || {}).sort();
        var catCounts = {};
        (memory || []).forEach(function(rec){
          if(rec && rec.categories && Array.isArray(rec.categories)){
            rec.categories.forEach(function(c){
              if(c) catCounts[c] = (catCounts[c] || 0) + 1;
            });
          }
        });
        var maxCat = 1;
        catKeys.forEach(function(k){ if(catCounts[k] > maxCat) maxCat = catCounts[k]; });
        catKeys.forEach(function(k){
          vector.push((catCounts[k] || 0) / maxCat);
        });

        // 4. 全局偏好 top-10（10维）
        var globalPref = this.getGlobalPreference();
        var prefEntries = Object.keys(globalPref || {})
          .map(function(app){ return { app: app, weight: globalPref[app] || 0 }; })
          .sort(function(a, b){ return b.weight - a.weight; })
          .slice(0, 10);
        var maxPref = 1;
        prefEntries.forEach(function(e){ if(e.weight > maxPref) maxPref = e.weight; });
        for(var i=0; i<10; i++){
          vector.push(prefEntries[i] ? (prefEntries[i].weight / maxPref) : 0);
        }

        return {
          version: '3.2',
          dimension: vector.length,
          vector: vector,
          schema: {
            hourly: { start: 0, end: 24 },
            intents: { start: 24, end: 35, keys: intentKeys },
            categories: { start: 35, end: 35 + catKeys.length, keys: catKeys },
            globalPref: { start: 35 + catKeys.length, end: 35 + catKeys.length + 10 }
          },
          meta: {
            memoryCount: (memory || []).length,
            catalogSize: catKeys.length,
            generatedAt: new Date().toISOString()
          }
        };
      }catch(e){
        console.error('vectorizeUserData:', e);
        return { version: '3.2', dimension: 0, vector: [], error: e.message };
      }
    },

    // 导出 embedding 数据为 JSON 文件 — P8 精简版：去掉冗余字段
    exportEmbedding: function(){
      try{
        var data = this.vectorizeUserData();
        // P8：精简输出 — 仅保留核心字段
        var slim = {
          v: data.version || '3.2',
          dim: data.dimension || 0,
          vec: data.vector || [],
          mem: data.meta ? data.meta.memoryCount : 0,
          cat: data.meta ? data.meta.catalogSize : 0
        };
        var blob = new Blob([JSON.stringify(slim)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'goto_embedding_' + new Date().toISOString().slice(0,10) + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
        return { success: true, dimension: slim.dim, memoryCount: slim.mem };
      }catch(e){
        console.error('exportEmbedding:', e);
        return { success: false, error: e.message };
      }
    },

    // ═══ 前缀树索引外部接口（隐藏入口，但允许任意修改/扩展）═══
    trieIndex: {
      insert: function(term, appOrId){
        var id = engine._resolveAppId(appOrId);
        if(!id || !term) return false;
        _trieInsert(engine.searchIndex.trie, lowerText(term), id);
        return true;
      },
      remove: function(term, appOrId){
        var id = engine._resolveAppId(appOrId);
        if(!id || !term) return false;
        return _trieRemove(engine.searchIndex.trie, lowerText(term), id);
      },
      exactSearch: function(term){
        if(!term) return new Set();
        var ids = _trieExactIds(engine.searchIndex.trie, lowerText(term));
        return ids ? new Set(ids) : new Set();
      },
      prefixSearch: function(prefix){
        if(!prefix) return new Set();
        var ids = _triePrefixIds(engine.searchIndex.trie, lowerText(prefix));
        return ids ? new Set(ids) : new Set();
      },
      getRoot: function(){
        return engine.searchIndex.trie;
      },
      rebuild: function(){
        engine.buildSearchIndex(global._appDataset || []);
        return engine.searchIndex.trie;
      }
    },

    installGlobals: function(){
      global.GOTOEngine = this;
      global.setContext = this.setContext.bind(this);
      global.clearContext = this.clearContext.bind(this);
      global.getGotoEngineContext = this.getContext.bind(this);
      global._fuzzySearch = this.fuzzySearch.bind(this);
      global._exactSearch = this.exactSearch.bind(this);
      global._prefixSearch = this.prefixSearch.bind(this);
      global._buildSearchIndex = this.buildSearchIndex.bind(this);
      global._watchAppDataset = this.watchAppDataset.bind(this);
      global._metaTagSearch = this.metaSearch.bind(this);
      // 前缀树索引扩展接口（隐藏入口）
      global._trieInsert = this.trieIndex.insert.bind(this.trieIndex);
      global._trieRemove = this.trieIndex.remove.bind(this.trieIndex);
      global._trieExactSearch = this.trieIndex.exactSearch.bind(this.trieIndex);
      global._triePrefixSearch = this.trieIndex.prefixSearch.bind(this.trieIndex);
      global._trieRebuild = this.trieIndex.rebuild.bind(this.trieIndex);
      global._trieGetRoot = this.trieIndex.getRoot.bind(this.trieIndex);
      global._refreshSimIntPanel = this.refreshSimIntPanel.bind(this);
      global._recordSimIntSearch = this.recordSearch.bind(this);
      global._recordSimIntSelection = this.recordSelection.bind(this);
      global._recordUnknownApp = this.recordUnknownApp.bind(this);
      global._getUnknownApps = this.getUnknownApps.bind(this);
      global._getUnknownAppSuggestions = this.getUnknownAppSuggestions.bind(this);
      global.runGotoEngineSearch = this.runSearchPipeline.bind(this);
      global._gotoEngineSearchIndex = this.searchIndex;
      global._applySelfHealing = this.applySelfHealing.bind(this);
      global._isBlockFlagged = this.isBlockFlagged.bind(this);
      global._addBlockFlag = this.addBlockFlag.bind(this);
      global._removeBlockFlag = this.removeBlockFlag.bind(this);
      global._getBlockFlagPreview = this.getBlockFlagPreview.bind(this);
      global._clearExpiredBlockFlags = this.clearExpiredBlockFlags.bind(this);
      global._isProEnabled = this.isProEnabled.bind(this);
      global._setProEnabled = this.setProEnabled.bind(this);
      global._getProState = this.getProState.bind(this);
      global._refreshProSnapshot = this.refreshProSnapshot.bind(this);
      global._getProSnapshot = this.getProSnapshot.bind(this);
      global._getFloatWindowState = this.getFloatWindowState.bind(this);
      global._saveFloatWindowState = this.saveFloatWindowState.bind(this);
      global._isFloatWindowEnabled = this.isFloatWindowEnabled.bind(this);
      global._setFloatWindowEnabled = this.setFloatWindowEnabled.bind(this);
      global._updateFloatWindowConfig = this.updateFloatWindowConfig.bind(this);
      global._triggerFloatWindowMorph = this.triggerFloatWindowMorph.bind(this);
      global._clearFloatWindowMorph = this.clearFloatWindowMorph.bind(this);
      global._isFloatWindowMorphActive = this.isFloatWindowMorphActive.bind(this);
      global._getAssociationRecommendation = this.getAssociationRecommendation.bind(this);
      global._getQuickBubbles = this.getQuickBubbles.bind(this);
      global._getHourlyStats = this.getHourlyStats.bind(this);
      global._getFullTimeStats = this.getFullTimeStats.bind(this);
      global._getCurrentHourStats = this.getCurrentHourStats.bind(this);
      // v3.1 引擎自主维护 API 暴露
      global._maintain = this.maintain.bind(this);
      global._decayAllStaleQueries = this._decayAllStaleQueries.bind(this);
      global._pruneChainStore = this._pruneChainStore.bind(this);
      global._pruneOldMemory = this._pruneOldMemory.bind(this);
      // v3.2 用户数据向量化 + 导出 embedding
      global._vectorizeUserData = this.vectorizeUserData.bind(this);
      global._exportEmbedding = this.exportEmbedding.bind(this);
      // v3.2 自适应刷新层 API 暴露 — 供宿主页（如 index.html）调用
      global._recordClickDelay = this.recordClickDelay.bind(this);
      global._getClickDelayEMA = this.getClickDelayEMA.bind(this);
      global._getHesitationDelay = this.getHesitationDelay.bind(this);
      // FeatureFlags 暴露
      global._setEngineFeatureFlags = this.setFeatureFlags.bind(this);
      global._getEngineFeatureFlags = function(){ return Object.assign({}, engine._featureFlags); };
      // v4.0: 第四层（梳理层）+ Base 桥接 API 暴露
      global._setEngineBaseBridge = this.setBaseBridge.bind(this);
      global._getEngineBaseBridgeStatus = this.getBaseBridgeStatus.bind(this);
      global._recordSelectionToBase = this.recordSelectionToBase.bind(this);
      global._applyPersonalRerank = this._applyPersonalRerankSync.bind(this);
      global._refreshPersonalSnapshot = this._refreshPersonalSnapshotAsync.bind(this);
      global._setPersonalRerankEnabled = function(enabled){
        engine._personalRerankEnabled = !!enabled;
        return engine._personalRerankEnabled;
      };
      global._isPersonalRerankEnabled = function(){
        return !!engine._personalRerankEnabled;
      };
      global._getPersonalRerankSnapshot = function(){
        return {
          snapshot: engine._personalSnapshot,
          takenAt: engine._personalSnapshotTs,
          age: nowTs() - (engine._personalSnapshotTs || 0),
          ttl: engine._personalSnapshotTTL
        };
      };
      this.rebuildIndex();
      this.watchAppDataset(global._appDataset || []);
      this.clearExpiredBlockFlags();
      this.getProSnapshot();
      this.refreshSimIntPanel();
      // === v3.1 引擎自主维护（启动时自动执行：全局衰减 + 链式边修剪 + 旧记忆清理）===
      try{ this.maintain(); }catch(_){ /* 维护失败不影响启动 */ }
      // === 语义关联模块挂载（可选）===
      try{
        var sem = global.GOTOSemantic;
        if(sem && typeof sem.init === 'function'){
          this.semantic = sem;
          global._semantic = sem;
          sem.init();  // 异步初始化，不阻塞
        }
      }catch(_){ /* semantic 缺失不影响引擎 */ }
    }
  };

  engine.installGlobals();
})(window);
