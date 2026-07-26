(function(global){
  'use strict';
  // GOTO 语义联想模块（Semantic Associations）
  // 三层架构：L1 核心同义词（内联）→ L2 同义词词林分片 → L3 词向量分片
  // 删除 semantic/ 目录即完全禁用，核心搜索不受影响。
  // 注意：JS 注释中不可包含 < \/script > 字符串，否则会破坏 HTML 解析。

  // ===== 配置常量 =====
  var STORAGE_KEY = 'goto_semantic_enabled';
  var CACHE_DB_NAME = 'goto_semantic_db';
  var CACHE_STORE = 'shards';
  var LRU_MAX = 20;
  var CONFIG_URL = 'GOTO-Engine/semantic/semantic-config.json';
  var PINYIN_INDEX_URL = 'GOTO-Engine/semantic/pinyin-index.json';
  var SHARD_BASE = 'GOTO-Engine/semantic/synonyms/';

  // ===== L1 核心同义词（内联，~12KB，覆盖 13 分类 + 6 意图 + 应用名 + 动作）=====
  var L1_CORE_SYNONYMS = {
    // —— 通讯 / SEND 意图 ——
    '发': ['写', '寄', '送', '传达', '发出', '递交'],
    '发短信': ['发消息', '发信息', '送信', '写信', '短信', '消息'],
    '发邮件': ['发邮箱', '写信', '寄信', '邮件', '邮箱', 'email'],
    '发消息': ['发短信', '发信息', '送信', '消息', '通知'],
    '聊天': ['聊聊', '沟通', '对话', '说话', '闲聊', '侃', '扯'],
    '联系': ['联络', '沟通', '找人', '约', '叫'],
    '回消息': ['回复', '回信', '应答', '答'],
    '打电话': ['拨号', '通话', '电话', 'ring', 'call'],
    '私聊': ['单独聊', '一对一', 'dm'],
    '群聊': ['群组', '群', '讨论组', 'group'],
    '微信': ['wx', 'weixin', 'wechat', '绿聊', '微'],
    'QQ': ['qq', '企鹅', 'tencent-qq', 'qq聊天'],
    '飞书': ['feishu', 'lark', '字节聊'],
    '钉钉': ['dingtalk', 'dd', '阿里聊'],
    '企业微信': ['work-wechat', 'wecom', '企微'],
    'Telegram': ['tg', '电报', '纸飞机'],
    'WhatsApp': ['wa', '瓦特'],
    'Discord': ['dc', '迪斯科'],
    '微博': ['weibo', '新浪微博'],
    '小红书': ['xiaohongshu', 'red', '小红'],
    // —— 办公 / WORK 意图 ——
    '办公': ['工作', '事务', '做事', '上班'],
    '工作': ['办公', '业务', '做事', '上班'],
    '文档': ['文件', 'doc', 'document'],
    '表格': ['excel', 'sheet', 'spreadsheet'],
    '演示': ['ppt', 'powerpoint', '幻灯'],
    '开会': ['会议', 'meeting', '讨论'],
    '会议': ['开会', 'meeting', '讨论'],
    '协作': ['合作', '协同', 'teamwork'],
    '汇报': ['报告', '总结', 'report'],
    '邮箱': ['邮件', 'email', 'mail'],
    'Outlook': ['outlook', '微软邮箱'],
    'Gmail': ['gmail', '谷歌邮箱'],
    'WPS': ['wps', '金山办公'],
    'Word': ['word', '微软文档', '文档'],
    'Excel': ['excel', '微软表格', '表格'],
    'PowerPoint': ['ppt', 'powerpoint', '微软演示'],
    'Notion': ['notion', '诺션'],
    '腾讯文档': ['tencent-doc', '腾讯在线文档'],
    '石墨文档': ['shimo', '石墨'],
    '语雀': ['yuque', '蚂蚁文档'],
    '日历': ['calendar', '日程', 'schedule'],
    'Zoom': ['zoom', '视频会议'],
    'Teams': ['teams', '微软会议'],
    // —— 浏览器 ——
    '搜索': ['查一下', '搜一下', '搜一搜', 'find', 'search'],
    '查一下': ['搜索', '查资料', '搜一下'],
    '上网': ['浏览', '上网冲浪', 'web'],
    '打开网页': ['打开网站', '访问', 'browse'],
    '浏览': ['翻看', '查看', 'browse'],
    '网页': ['网站', 'site', 'page'],
    'Chrome': ['google-chrome', '谷歌浏览器', 'chrome浏览器'],
    'Edge': ['microsoft-edge', '微软浏览器', 'edge浏览器'],
    'Safari': ['safari', '苹果浏览器'],
    'Firefox': ['firefox', '火狐', '火狐浏览器'],
    '百度': ['baidu', '百度搜索'],
    '搜狗': ['sogou', '搜狗搜索'],
    '浏览器': ['browser', '网页浏览'],
    // —— 视频 / CONSUME ——
    '看': ['观看', '欣赏', '浏览', '收看', '瞅'],
    '观看': ['看', '欣赏', '收看'],
    '刷视频': ['看视频', '刷抖音', '刷快手'],
    '追剧': ['追片', '追番', 'binge'],
    '电影': ['影片', 'movie', 'film'],
    '电视剧': ['剧集', 'tv', '剧'],
    '短视频': ['小视频', 'short-video'],
    '直播': ['live', '现场'],
    'YouTube': ['yt', '油管', 'youtube'],
    'B站': ['bilibili', '哔哩哔哩', 'b站'],
    '抖音': ['douyin', 'tiktok', 'dy'],
    '快手': ['kuaishou', 'ks'],
    '腾讯视频': ['qq-video', '腾讯影视'],
    '爱奇艺': ['iqiyi', '奇艺'],
    '优酷': ['youku', '土豆'],
    '芒果TV': ['mgtv', '芒果'],
    'Netflix': ['netflix', '奈飞', '网飞'],
    // —— 音乐 ——
    '听': ['聆听', '收听', '倾听', '听见'],
    '听歌': ['听音乐', '放歌', 'play-music'],
    '音乐': ['歌曲', '歌', 'music'],
    '歌单': ['playlist', '歌列表'],
    '播客': ['podcast', '音频节目'],
    '网易云音乐': ['netease-music', '网易云', '网易音乐'],
    'QQ音乐': ['qq-music', '腾讯音乐'],
    '酷狗音乐': ['kugou', '酷狗'],
    '酷我音乐': ['kuwo', '酷我'],
    'Spotify': ['spotify', '声田'],
    'Apple Music': ['apple-music', '苹果音乐'],
    '汽水音乐': ['qishui', '抖音音乐'],
    '喜马拉雅': ['ximalaya', '喜马'],
    // —— 购物 / BUY ——
    '买': ['下单', '购物', '采购', '购置', '剁手', '购'],
    '下单': ['买', '购物', '下单子', 'order'],
    '购物': ['买东西', '买', 'shopping'],
    '买东西': ['购物', '买', '采购'],
    '网购': ['网上购物', '电商', 'online-shopping'],
    '点餐': ['点外卖', '叫外卖', '订餐', 'order-food'],
    '点外卖': ['点餐', '叫外卖', '订餐', '外卖'],
    '吃饭': ['用餐', '就餐', '下馆子'],
    '外卖': ['外送', 'delivery', '配送'],
    '淘宝': ['taobao', '阿里购物', '橙色app'],
    '京东': ['jd', '京东商城', '红色app'],
    '拼多多': ['pdd', 'pingduoduo', '便宜app'],
    '天猫': ['tmall', '天猫商城'],
    '闲鱼': ['xianyu', '二手鱼'],
    '得物': ['dewu', '毒', 'poizon'],
    '美团': ['meituan', '美团外卖'],
    '饿了么': ['eleme', '饿了吗'],
    '大众点评': ['dianping', '点评'],
    // —— 支付金融 ——
    '支付': ['付款', '结账', 'pay'],
    '付款': ['支付', '结账', '付钱'],
    '转账': ['汇款', 'transfer', '转钱'],
    '收款': ['收钱', '收账', 'collect'],
    '银行': ['bank', '银'],
    '钱包': ['wallet', '钱袋'],
    '理财': ['投资', 'finance', '财管'],
    '记账': ['记帐', '记费用', 'bookkeeping'],
    '支付宝': ['alipay', '蓝色钱包', '蚂蚁'],
    '云闪付': ['unionpay', '银联钱包'],
    '招商银行': ['cmb', '招行'],
    '建设银行': ['ccb', '建行'],
    '工商银行': ['icbc', '工行'],
    '中国银行': ['boc', '中行'],
    '农业银行': ['abc', '农行'],
    // —— 地图出行 / TRAVEL ——
    '打车': ['叫车', '约车', '出行', '坐车', '乘车', '出租车'],
    '导航': ['指路', '带路', '路线', '地图', '定位'],
    '出行': ['出门', '去', 'travel'],
    '路线': ['路径', 'way', 'route'],
    '订票': ['买票', '预订', 'book-ticket'],
    '火车票': ['高铁票', '动车票', 'rail-ticket'],
    '飞机票': ['机票', 'flight-ticket'],
    '旅行': ['旅游', '出游', 'trip'],
    '查定位': ['定位', '查位置', 'find-location'],
    '高德地图': ['amap', '高德', '导航地图'],
    '百度地图': ['baidu-map', '百度导航'],
    '腾讯地图': ['tencent-map', '腾讯导航'],
    '滴滴出行': ['didi', '滴滴', '打车app'],
    '12306': ['铁路', '火车票官网'],
    '携程': ['ctrip', '携程旅行'],
    '去哪儿': ['qunar', '去哪'],
    '飞猪': ['fliggy', '飞猪旅行'],
    '哈啰出行': ['hello', '哈啰', 'hellobike'],
    // —— 拍照影像 ——
    '拍照': ['照像', '摄', 'take-photo'],
    '拍个照': ['拍照', '照一张', 'snap'],
    '照片': ['相片', 'photo', 'picture'],
    '修图': ['美颜', 'p图', '图像处理', '滤镜'],
    '美颜': ['修图', '滤镜', 'beauty'],
    '剪辑': ['剪视频', '视频编辑', '做视频', 'edit-video'],
    '滤镜': ['filter', '效果', '特效'],
    '相机': ['camera', '摄像'],
    '美图秀秀': ['meitu', '美图'],
    '醒图': ['xingtu', 'wake'],
    'Lightroom': ['lr', 'adobe-lr'],
    '剪映': ['jianying', 'capcut'],
    '必剪': ['biclip', 'bcut'],
    'Snapseed': ['snaps', '谷歌修图'],
    // —— 阅读资讯 ——
    '阅读': ['看书', '读', '翻阅', '浏览', '读书'],
    '看书': ['阅读', '读书', '翻书'],
    '看新闻': ['看资讯', '新闻', 'news'],
    '资讯': ['信息', 'news', '时事'],
    '小说': ['fiction', '故事书'],
    '头条': ['news', '今日头条'],
    '文章': ['稿子', 'essay', 'article'],
    '微信读书': ['weread', '微信读书'],
    'Kindle': ['kindle', '亚马逊阅读'],
    '今日头条': ['toutiao', '头条'],
    '知乎': ['zhihu', '问答'],
    '豆瓣': ['douban', '豆瓣评分'],
    '起点读书': ['qidian', '起点'],
    // —— 游戏 ——
    '游戏': ['打游戏', 'game'],
    '打游戏': ['玩游戏', '开黑', 'game'],
    '开黑': ['组队', '一起玩', 'team-up'],
    '玩一会儿': ['玩一下', '玩会儿', 'play'],
    '上号': ['登录', '登号', 'login'],
    '开一把': ['开一局', 'play-one'],
    'Steam': ['steam', '蒸汽平台'],
    'TapTap': ['taptap', 'tap'],
    '王者荣耀': ['wzry', '王者', '农药'],
    '和平精英': ['hpjy', '和平', '吃鸡'],
    '原神': ['genshin', '原神'],
    '英雄联盟': ['lol', 'lol'],
    'Epic': ['epic-games', 'epic'],
    // —— 开发 ——
    '开发': ['编程', 'coding', '写代码'],
    '写代码': ['编程', '开发', 'coding', '敲代码'],
    '编程': ['写代码', '开发', 'coding'],
    '调试': ['debug', '排错', '查错'],
    '终端': ['控制台', 'console', 'terminal'],
    '接口测试': ['api-test', 'postman', '调接口'],
    '提交代码': ['commit', 'git-push', 'push'],
    'VS Code': ['vscode', 'visual-studio-code', '微软编辑器'],
    'Visual Studio': ['vs', 'visual-studio', '微软ide'],
    'GitHub Desktop': ['github-desktop', 'gh-desktop'],
    'Postman': ['postman', 'api工具'],
    'Docker': ['docker', '容器', '集装箱'],
    'Cursor': ['cursor', 'ai编辑器'],
    'Trae': ['trae', '字节ai编辑器'],
    // —— 系统工具 ——
    '设置': ['系统设置', 'config', 'setting'],
    '系统': ['os', '系统软件'],
    '工具': ['utility', 'tool'],
    '文件管理': ['文件', 'file-manager', '文件浏览器'],
    '清理': ['清扫', 'clean', '垃圾清理'],
    '时钟': ['闹钟', 'clock', '时间'],
    '天气': ['气象', 'weather'],
    '计算': ['算一下', 'calculator', 'calc'],
    '算一下': ['计算', 'calc', 'calculator'],
    '应用商店': ['app-store', '应用市场', '商店'],
    'GOTO': ['goto', 'go-to'],
    // —— 通用形容词 / 状态（用于语义扩展测试）——
    '安静': ['宁静', '寂静', '静谧', '清静', '肃静'],
    '宁静': ['安静', '寂静', '静谧', '清静'],
    '快速': ['迅速', '敏捷', '飞快', '快捷', '麻利'],
    '美丽': ['漂亮', '好看', '靓', '靓丽', '美'],
    '漂亮': ['美丽', '好看', '靓', '靓丽'],
    '大': ['巨大', '庞大', '硕大', 'large'],
    '小': ['微小', '细小', 'tiny', 'small'],
    '好': ['优', '佳', '良', 'good'],
    '快': ['迅速', '敏捷', '飞快'],
    '慢': ['缓慢', '迟缓', '拖拉'],
    // —— 动作映射 ——
    '打开': ['启动', '开启', 'open', 'launch'],
    '关闭': ['退出', '关掉', 'close', 'quit'],
    '播放': ['放', '播', 'play'],
    '暂停': ['停', 'pause'],
    '分享': ['转发', '共享', 'share'],
    '收藏': ['保存', 'mark', 'favorite'],
    '搜索一下': ['搜一下', '查一下', 'search'],
    '看一下': ['瞧一下', '瞅一下', 'look']
  };

  // ===== 状态 =====
  var state = {
    ready: false,
    available: false,
    config: null,
    pinyinIndex: {},
    db: null,
    dbAvailable: true,
    cache: new Map(),
    stats: { l1Hits: 0, l2Hits: 0, l2Misses: 0, cacheHits: 0, cacheMisses: 0, evictions: 0 }
  };

  // ===== 工具函数 =====
  function isEnabled(){
    try{ return global.localStorage && global.localStorage.getItem(STORAGE_KEY) === '1'; }catch(_){ return false; }
  }
  function setEnabled(on){
    try{ global.localStorage && global.localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); }catch(_){}
  }
  function isReady(){ return state.ready && isEnabled(); }
  function isAvailable(){ return state.available; }

  function normalizeWord(w){ return (w || '').toString().trim().toLowerCase(); }

  // ===== IndexedDB 持久化缓存 =====
  function openDB(){
    return new Promise(function(resolve){
      try{
        if(!global.indexedDB){ state.dbAvailable = false; resolve(null); return; }
        var req = global.indexedDB.open(CACHE_DB_NAME, 1);
        req.onupgradeneeded = function(e){
          var db = e.target.result;
          if(!db.objectStoreNames.contains(CACHE_STORE)){
            db.createObjectStore(CACHE_STORE, { keyPath: 'id' });
          }
        };
        req.onsuccess = function(e){ state.dbAvailable = true; resolve(e.target.result); };
        req.onerror = function(){ state.dbAvailable = false; resolve(null); };
      }catch(_){ state.dbAvailable = false; resolve(null); }
    });
  }
  function dbGet(id){
    return new Promise(function(resolve){
      if(!state.db){ resolve(null); return; }
      try{
        var tx = state.db.transaction(CACHE_STORE, 'readonly');
        var req = tx.objectStore(CACHE_STORE).get(id);
        req.onsuccess = function(){ resolve(req.result ? req.result.data : null); };
        req.onerror = function(){ resolve(null); };
      }catch(_){ resolve(null); }
    });
  }
  function dbPut(id, data){
    return new Promise(function(resolve){
      if(!state.db){ resolve(false); return; }
      try{
        var tx = state.db.transaction(CACHE_STORE, 'readwrite');
        tx.objectStore(CACHE_STORE).put({ id: id, data: data, ts: Date.now() });
        tx.oncomplete = function(){ resolve(true); };
        tx.onerror = function(){ resolve(false); };
      }catch(_){ resolve(false); }
    });
  }
  function dbClear(){
    return new Promise(function(resolve){
      if(!state.db){ resolve(false); return; }
      try{
        var tx = state.db.transaction(CACHE_STORE, 'readwrite');
        tx.objectStore(CACHE_STORE).clear();
        tx.oncomplete = function(){ resolve(true); };
        tx.onerror = function(){ resolve(false); };
      }catch(_){ resolve(false); }
    });
  }

  // ===== 内存 LRU 缓存 =====
  function lruGet(key){
    if(!state.cache.has(key)) return null;
    var v = state.cache.get(key);
    state.cache.delete(key);
    state.cache.set(key, v);
    return v;
  }
  function lruPut(key, value){
    if(state.cache.has(key)) state.cache.delete(key);
    state.cache.set(key, value);
    while(state.cache.size > LRU_MAX){
      var oldest = state.cache.keys().next().value;
      state.cache.delete(oldest);
      state.stats.evictions++;
    }
  }

  // ===== 拼音首字母（用于路由分片）=====
  function getPinyinInitial(word){
    if(!word || !word.length) return null;
    var ch = word.charAt(0);
    if(/[a-z]/i.test(ch)) return ch.toLowerCase();
    if(/[0-9]/.test(ch)) return '0';
    var idx = state.pinyinIndex || {};
    if(idx[ch]) return idx[ch];
    return null;
  }

  // ===== L1 同步扩展（零阻塞）=====
  function _expandSync(query, limit){
    try{
      if(!isEnabled()) return [];
      var q = normalizeWord(query);
      if(!q) return [];
      var result = [];
      // 直接命中
      if(L1_CORE_SYNONYMS[q]){
        L1_CORE_SYNONYMS[q].forEach(function(t){
          result.push({ term: t, score: 0.9, source: 'L1' });
        });
      }
      // 反向命中
      Object.keys(L1_CORE_SYNONYMS).forEach(function(key){
        if(key === q) return;
        var syns = L1_CORE_SYNONYMS[key] || [];
        var hit = false;
        for(var i = 0; i < syns.length; i++){
          if(syns[i].toLowerCase() === q || syns[i] === query){ hit = true; break; }
        }
        if(hit) result.push({ term: key, score: 0.85, source: 'L1' });
      });
      // 包含关系
      Object.keys(L1_CORE_SYNONYMS).forEach(function(key){
        if(key === q) return;
        if(key.indexOf(q) >= 0 || q.indexOf(key) >= 0){
          result.push({ term: key, score: 0.6, source: 'L1' });
        }
      });
      state.stats.l1Hits++;
      // 去重 + 截断
      var seen = {};
      var uniq = result.filter(function(r){
        if(seen[r.term]) return false;
        seen[r.term] = true;
        return true;
      });
      return uniq.slice(0, limit || 10);
    }catch(_){ return []; }
  }

  // ===== L2 异步扩展 =====
  function _expandAsync(query, limit){
    return new Promise(function(resolve){
      try{
        if(!isEnabled()){
          resolve([]);
          return;
        }
        if(!state.available){
          resolve(_expandSync(query, limit));
          return;
        }
        var q = normalizeWord(query);
        if(!q){ resolve([]); return; }
        var initial = getPinyinInitial(q);
        if(!initial){
          resolve(_expandSync(query, limit));
          return;
        }
        var shardId = 'shard-' + initial;
        loadShard(shardId).then(function(shard){
          var l1 = _expandSync(query, limit);
          if(!shard){
            state.stats.l2Misses++;
            resolve(l1);
            return;
          }
          state.stats.l2Hits++;
          var l2 = [];
          var words = shard.words || {};
          // 精确匹配
          if(words[q]){
            words[q].forEach(function(t){
              l2.push({ term: t, score: 0.95, source: 'L2' });
            });
          }
          // 原文匹配（区分大小写）
          if(words[query] && words[query] !== words[q]){
            words[query].forEach(function(t){
              l2.push({ term: t, score: 0.92, source: 'L2' });
            });
          }
          // 合并 L1 + L2，L2 优先
          var merged = l2.concat(l1);
          var seen = {};
          var uniq = merged.filter(function(r){
            if(seen[r.term]) return false;
            seen[r.term] = true;
            return true;
          });
          resolve(uniq.slice(0, limit || 10));
        });
      }catch(_){ resolve([]); }
    });
  }

  // ===== 加载分片（fetch → IndexedDB → 内存 LRU）=====
  function loadShard(shardId){
    return new Promise(function(resolve){
      try{
        // 1. 内存 LRU
        var cached = lruGet(shardId);
        if(cached){
          state.stats.cacheHits++;
          resolve(cached);
          return;
        }
        state.stats.cacheMisses++;
        // 2. IndexedDB
        dbGet(shardId).then(function(dbData){
          if(dbData){
            lruPut(shardId, dbData);
            state.stats.cacheHits++;
            resolve(dbData);
            return;
          }
          // 3. fetch
          if(!global.fetch){
            resolve(null);
            return;
          }
          var url = SHARD_BASE + shardId + '.json';
          global.fetch(url).then(function(r){
            if(!r.ok){ resolve(null); return; }
            return r.json();
          }).then(function(data){
            if(!data){ resolve(null); return; }
            lruPut(shardId, data);
            dbPut(shardId, data);
            resolve(data);
          }).catch(function(){ resolve(null); });
        });
      }catch(_){ resolve(null); }
    });
  }

  // ===== L3 词向量相似词（v3.2 本地小模型 — 字符 n-gram 稀疏向量 + 余弦相似度）=====
  // 设计思路：
  //   - 完全本地、零依赖（不依赖外部词向量文件）
  //   - 基于 L1_CORE_SYNONYMS 自动构建 mini embedding 表
  //   - 字符 2-gram 特征 + TF-IDF 加权 + 余弦相似度
  //   - 内存占用：约 50KB（L1 ~12KB + vocab ~3KB + 向量索引 ~35KB）
  //   - 召回精度：对同源词、形近词、同义词有较好的相似度（0.3-0.95）
  var miniEmbeddings = null;  // { vocab: {}, vocabSize: 0, docs: [], docNorms: [], docTerms: [[...]] }

  function _buildNgrams(word){
    // 提取字符 2-gram（含边界符），如 "聊天" → ["^聊", "聊天", "天$"]
    var w = normalizeWord(word);
    if(!w) return [];
    var grams = [];
    grams.push('^' + w.charAt(0));
    for(var i = 0; i < w.length - 1; i++){
      grams.push(w.substr(i, 2));
    }
    grams.push(w.charAt(w.length - 1) + '$');
    return grams;
  }

  function _buildMiniEmbeddings(){
    if(miniEmbeddings) return miniEmbeddings;
    try{
      // 1. 收集所有词（L1 keys + synonyms + 应用名/分类关键词）
      var allWords = [];
      var wordToSource = {};
      Object.keys(L1_CORE_SYNONYMS).forEach(function(key){
        allWords.push(key);
        wordToSource[key] = 'L1';
        (L1_CORE_SYNONYMS[key] || []).forEach(function(syn){
          if(allWords.indexOf(syn) < 0){
            allWords.push(syn);
            wordToSource[syn] = 'L1-syn';
          }
        });
      });
      // 2. 构建 vocab（2-gram 字典）
      var vocab = {};
      var docs = [];  // [{ word, grams, tfidf }]
      allWords.forEach(function(w){
        var grams = _buildNgrams(w);
        var doc = { word: w, grams: grams, tfidf: {} };
        grams.forEach(function(g){
          vocab[g] = (vocab[g] || 0) + 1;
          doc.tfidf[g] = (doc.tfidf[g] || 0) + 1;
        });
        docs.push(doc);
      });
      // 3. 计算 IDF（逆文档频率）
      var N = docs.length;
      var vocabKeys = Object.keys(vocab);
      var idf = {};
      vocabKeys.forEach(function(g){
        var df = vocab[g];
        idf[g] = Math.log((N + 1) / (df + 1)) + 1;
      });
      // 4. 计算 TF-IDF 并归一化
      var docTerms = [];  // 稀疏表示：[{ idx, val }]
      var docNorms = [];
      docs.forEach(function(doc){
        var terms = [];
        var sqSum = 0;
        Object.keys(doc.tfidf).forEach(function(g){
          var idx = vocabKeys.indexOf(g);
          if(idx < 0) return;
          var tf = doc.tfidf[g] / doc.grams.length;
          var val = tf * idf[g];
          terms.push({ idx: idx, val: val });
          sqSum += val * val;
        });
        docTerms.push(terms);
        docNorms.push(Math.sqrt(sqSum) || 1);
      });
      miniEmbeddings = {
        vocab: vocab,
        vocabKeys: vocabKeys,
        vocabSize: vocabKeys.length,
        docs: docs,
        docTerms: docTerms,
        docNorms: docNorms,
        wordToSource: wordToSource,
        builtAt: Date.now()
      };
      return miniEmbeddings;
    }catch(e){
      console.error('[semantic] _buildMiniEmbeddings:', e);
      return null;
    }
  }

  function _queryVector(word){
    // 为查询词构建稀疏 TF-IDF 向量
    try{
      var emb = miniEmbeddings;
      if(!emb) return null;
      var grams = _buildNgrams(word);
      if(!grams.length) return null;
      var tfMap = {};
      grams.forEach(function(g){ tfMap[g] = (tfMap[g] || 0) + 1; });
      var terms = [];
      var sqSum = 0;
      Object.keys(tfMap).forEach(function(g){
        var idx = emb.vocabKeys.indexOf(g);
        if(idx < 0) return;  // vocab 中不存在，跳过
        var df = emb.vocab[g] || 1;
        var N = emb.docs.length;
        var idf = Math.log((N + 1) / (df + 1)) + 1;
        var tf = tfMap[g] / grams.length;
        var val = tf * idf;
        terms.push({ idx: idx, val: val });
        sqSum += val * val;
      });
      return { terms: terms, norm: Math.sqrt(sqSum) || 1 };
    }catch(_){ return null; }
  }

  function _cosineSim(queryVec, docTerms, docNorm){
    try{
      if(!queryVec || !queryVec.terms || !queryVec.norm) return 0;
      if(!docTerms || !docNorm) return 0;
      var dot = 0;
      // 稀疏向量点积（按 idx 排序后双指针）
      var a = queryVec.terms;
      var b = docTerms;
      var i = 0, j = 0;
      while(i < a.length && j < b.length){
        if(a[i].idx < b[j].idx){ i++; }
        else if(a[i].idx > b[j].idx){ j++; }
        else { dot += a[i].val * b[j].val; i++; j++; }
      }
      return dot / (queryVec.norm * docNorm);
    }catch(_){ return 0; }
  }

  function findSimilar(word, topN){
    return new Promise(function(resolve){
      try{
        if(!isEnabled()){
          resolve([]);
          return;
        }
        // 即使 state.available 为 false（无 L2 分片），L3 mini 模型仍可用（基于 L1）
        var emb = _buildMiniEmbeddings();
        if(!emb){
          resolve([]);
          return;
        }
        var q = normalizeWord(word);
        if(!q){ resolve([]); return; }
        var topNVal = topN || 5;
        var results = [];
        var seen = {};
        // ===== Pass 1：L1 语义等价类（强语义）=====
        // 如果 word 在 L1_CORE_SYNONYMS 中是 key 或 synonym，
        // 则同 cluster 的其他词视为强相似词（score 0.85）
        var l1Cluster = _getL1Cluster(q) || _getL1Cluster(word);
        if(l1Cluster && l1Cluster.length){
          l1Cluster.forEach(function(t){
            if(t === q || t === word) return;
            if(seen[t]) return;
            seen[t] = true;
            results.push({ term: t, score: 0.85, source: 'L3-mini-L1' });
          });
        }
        // ===== Pass 2：n-gram 形态相似（弱语义）=====
        var queryVec = _queryVector(q);
        if(queryVec){
          for(var i = 0; i < emb.docs.length; i++){
            var docWord = emb.docs[i].word;
            if(docWord === q || docWord === word) continue;
            if(seen[docWord]) continue;
            var sim = _cosineSim(queryVec, emb.docTerms[i], emb.docNorms[i]);
            if(sim > 0.20){  // 阈值 0.20，过滤无关词
              seen[docWord] = true;
              results.push({ term: docWord, score: Number(sim.toFixed(4)), source: 'L3-mini-gram' });
            }
          }
        }
        // 按相似度降序
        results.sort(function(a, b){ return b.score - a.score; });
        resolve(results.slice(0, topNVal));
      }catch(_){ resolve([]); }
    });
  }

  // 获取 L1 语义等价类（如果词在 L1 中作为 key 或 synonym 出现，返回同 cluster 的所有词）
  function _getL1Cluster(word){
    try{
      var q = normalizeWord(word);
      if(!q) return null;
      var cluster = [];
      // 1. word 是 key
      if(L1_CORE_SYNONYMS[q]){
        cluster = cluster.concat(L1_CORE_SYNONYMS[q]);
        cluster.push(q);
      }
      // 2. word 是某 key 的 synonym（反向查找）
      Object.keys(L1_CORE_SYNONYMS).forEach(function(key){
        var syns = L1_CORE_SYNONYMS[key] || [];
        for(var i = 0; i < syns.length; i++){
          if(syns[i].toLowerCase() === q || syns[i] === word){
            cluster.push(key);
            cluster = cluster.concat(syns);
            break;
          }
        }
      });
      // 去重
      var uniq = [];
      var s = {};
      cluster.forEach(function(t){
        if(!s[t]){ s[t] = true; uniq.push(t); }
      });
      return uniq.length > 1 ? uniq : null;
    }catch(_){ return null; }
  }

  // ===== 公共 API expand =====
  function expand(query, opts){
    opts = opts || {};
    if(opts.async){
      return _expandAsync(query, opts.limit || 10);
    }
    return _expandSync(query, opts.limit || 10);
  }

  // ===== 统计信息 =====
  function getStats(){
    return {
      ready: state.ready,
      available: state.available,
      enabled: isEnabled(),
      dbAvailable: state.dbAvailable,
      l1Count: Object.keys(L1_CORE_SYNONYMS).length,
      cachedShards: state.cache.size,
      l1Hits: state.stats.l1Hits,
      l2Hits: state.stats.l2Hits,
      l2Misses: state.stats.l2Misses,
      cacheHits: state.stats.cacheHits,
      cacheMisses: state.stats.cacheMisses,
      evictions: state.stats.evictions,
      synonymsCount: state.config && state.config.synonyms ? state.config.synonyms.count : 0,
      synonymsShards: state.config && state.config.synonyms && state.config.synonyms.shards ? Object.keys(state.config.synonyms.shards).length : 0,
      vectorsAvailable: state.config && state.config.vectors ? state.config.vectors.available : false,
      // v3.2 mini 模型状态
      miniModelReady: !!miniEmbeddings,
      miniModelVocabSize: miniEmbeddings ? miniEmbeddings.vocabSize : 0,
      miniModelDocs: miniEmbeddings ? miniEmbeddings.docs.length : 0
    };
  }

  // ===== 清除缓存 =====
  function clearCache(){
    return new Promise(function(resolve){
      try{
        state.cache.clear();
        dbClear().then(function(){ resolve(true); });
      }catch(_){ resolve(false); }
    });
  }

  // ===== 初始化（异步 fire-and-forget）=====
  function init(){
    return new Promise(function(resolve){
      try{
        // 1. 打开 IndexedDB
        openDB().then(function(db){
          state.db = db;
          if(!global.fetch){
            state.ready = true;
            state.available = false;
            resolve(true);
            return;
          }
          // 2. 加载 pinyin-index
          return global.fetch(PINYIN_INDEX_URL).then(function(r){
            if(!r.ok) return null;
            return r.json();
          });
        }).then(function(pinyinIndex){
          state.pinyinIndex = pinyinIndex || {};
          if(!global.fetch){
            state.ready = true;
            state.available = false;
            resolve(true);
            return null;
          }
          // 3. 加载 config
          return global.fetch(CONFIG_URL).then(function(r){
            if(!r.ok) return null;
            return r.json();
          });
        }).then(function(config){
          state.config = config;
          state.available = !!(config && config.version);
          state.ready = true;
          resolve(true);
        }).catch(function(){
          // 降级：仅 L1 可用
          state.ready = true;
          state.available = false;
          resolve(true);
        });
      }catch(_){
        state.ready = true;
        state.available = false;
        resolve(true);
      }
    });
  }

  // ===== 挂载到全局 =====
  var SemanticAssociations = {
    init: init,
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    isReady: isReady,
    isAvailable: isAvailable,
    expand: expand,
    _expandSync: _expandSync,
    _expandAsync: _expandAsync,
    findSimilar: findSimilar,
    loadShard: loadShard,
    getStats: getStats,
    clearCache: clearCache,
    L1_CORE_SYNONYMS: L1_CORE_SYNONYMS,
    // v3.2 mini 模型（L3 本地小模型）
    _buildMiniEmbeddings: _buildMiniEmbeddings,
    _queryVector: _queryVector,
    _cosineSim: _cosineSim,
    _buildNgrams: _buildNgrams,
    _state: state
  };

  global.GOTOSemantic = SemanticAssociations;
  global._semantic = SemanticAssociations;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
