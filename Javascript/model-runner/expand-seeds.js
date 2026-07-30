'use strict';
/**
 * 种子扩库脚本（GOTO-Engine 侧）
 *
 * 把内置的紧凑应用清单展开为完整 AppRecord JSON，写入
 * goto-base/shared/data/seeds/ 目录。已存在的 packageName 会被跳过。
 *
 * 数据来源：Play Store / Apple App Store / F-Droid 公开主流应用，
 *           由人工整理为紧凑清单，覆盖 13 个 MECE 一级类目。
 *
 * 用法：
 *   node GOTO-Engine/model-runner/expand-seeds.js           # 写入新种子
 *   node GOTO-Engine/model-runner/expand-seeds.js --dry-run # 仅打印不写入
 *
 * 配套：
 *   - expand-seeds-data.js   紧凑应用清单（按分类分块）
 *   - build-rag-from-seeds.js 从 seeds 重建 vector-store.json 结构
 *   - rebuild-rag-index.js    用 BGE 模型重新生成向量
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const SEEDS_DIR = path.resolve(__dirname, '../../goto-base/shared/data/seeds');
const { SEED_ENTRIES } = require('./expand-seeds-data');

function parseArgs(argv) {
  const args = { dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

// MECE 一级类目 ID → 中文名 映射（与 mece-categories.json 对齐）
const CATEGORY_MAP = {
  social_communication: '社交通讯',
  news_information: '资讯新闻',
  entertainment: '影视娱乐',
  life_services: '生活服务',
  shopping: '购物消费',
  travel_navigation: '出行导航',
  finance: '金融理财',
  office_collaboration: '办公协作',
  education_learning: '教育学习',
  health_medical: '健康医疗',
  tools: '工具',
  system_security: '系统安全',
  smart_hardware: '智能硬件'
};

// 二级子类目 ID → 中文名 映射
const SUBCATEGORY_MAP = {
  // social_communication
  instant_messaging: '即时通讯',
  social_network: '社交网络',
  contacts_phone: '通讯录电话',
  // news_information
  news_feed: '新闻资讯',
  microblog: '微博客',
  community_forum: '社区论坛',
  // entertainment
  online_video: '在线视频',
  short_video: '短视频',
  music: '音乐',
  audio_podcast: '听书播客',
  game: '游戏',
  // life_services
  food_delivery: '外卖美食',
  express_logistics: '快递物流',
  weather: '天气服务',
  housekeeping_housing: '家政房产',
  pet_services: '宠物服务',
  // shopping
  comprehensive_ecommerce: '综合电商',
  second_hand: '二手交易',
  cross_border: '海淘跨境',
  flash_sale: '特卖优选',
  content_ecommerce: '内容电商',
  // travel_navigation
  map_navigation: '地图导航',
  ride_hailing: '打车出行',
  train_ticket: '火车票务',
  flight_hotel_tour: '机酒旅游',
  // finance
  payment_wallet: '支付钱包',
  banking: '银行服务',
  stock_fund: '股票基金',
  insurance: '保险服务',
  lottery: '彩票',
  // office_collaboration
  office_communication: '办公通讯',
  video_conference: '视频会议',
  document_office: '文档办公',
  notes_knowledge: '笔记知识',
  task_todo: '任务待办',
  cloud_storage: '网盘存储',
  // education_learning
  online_course: '在线课程',
  language_learning: '语言学习',
  reading_ebook: '阅读电子书',
  exam_preparation: '考试备考',
  parenting: '育儿启蒙',
  knowledge_paid: '知识付费',
  // health_medical
  fitness: '运动健身',
  health_management: '健康管理',
  online_medical: '在线医疗',
  // tools
  browser: '浏览器',
  search_engine: '搜索引擎',
  translate_dictionary: '翻译词典',
  calculator: '计算换算',
  clock_alarm: '时钟闹钟',
  recording: '录音转写',
  screenshot: '截图标注',
  file_manager: '文件管理',
  input_method: '输入法',
  cleaner: '清理加速',
  battery: '电池优化',
  network_proxy: '网络代理',
  scan_ocr: '扫描识别',
  pdf_tool: 'PDF工具',
  // system_security
  security_protection: '安全防护',
  permission_management: '权限管理',
  // smart_hardware
  smart_home: '智能家居',
  smart_wearable: '智能穿戴'
};

function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * 把紧凑记录展开为完整 AppRecord。
 *
 * 紧凑格式：
 *   {
 *     pkg, name, cat (subcategory id), dev, aliases[], kw[], cap[], intent[], desc,
 *     region[], tier, score, iosTrackId?
 *   }
 */
function expand(entry) {
  const subcategoryZh = SUBCATEGORY_MAP[entry.cat];
  if (!subcategoryZh) {
    throw new Error('未知 subcategory id: ' + entry.cat + ' (pkg=' + entry.pkg + ')');
  }
  // subcategory id → 一级类目 id
  const primaryCatId = _resolvePrimaryCategory(entry.cat);
  const primaryCategoryZh = CATEGORY_MAP[primaryCatId];

  const aliases = Array.from(new Set([entry.name, entry.name.toLowerCase(), ...(entry.aliases || [])]));
  const keywords = entry.kw || [];
  const capabilities = entry.cap || [];
  const userIntents = entry.intent || [];
  const usageScenarios = entry.scenarios || [];
  const negativeIntents = entry.neg || [];

  const documentText = [
    entry.name,
    aliases.join(' '),
    keywords.join(' '),
    capabilities.join(' '),
    userIntents.join(' '),
    entry.desc
  ].filter(Boolean).join(' ');

  const record = {
    recordId: 'android:' + entry.pkg,
    androidPackageName: entry.pkg,
    canonicalName: entry.name,
    localizedNames: {
      'zh-CN': entry.nameZh || entry.name,
      'en': entry.nameEn || entry.name
    },
    developerName: entry.dev || '',
    platforms: ['android'],
    categories: [primaryCategoryZh],
    subcategories: [entry.cat],
    primaryCategory: primaryCategoryZh,
    primarySubcategory: subcategoryZh,
    aliases: aliases,
    abbreviations: entry.abbr || [],
    keywords: keywords,
    capabilities: capabilities,
    userIntents: userIntents,
    usageScenarios: usageScenarios,
    negativeIntents: negativeIntents,
    semanticDescription: entry.desc,
    popularityTier: entry.tier || 'tier-c',
    popularityScore: typeof entry.score === 'number' ? entry.score : 0.4,
    region: entry.region || ['GLOBAL'],
    languages: entry.lang || ['en'],
    sourceRecords: [
      {
        source: 'manual',
        license: 'user-contributed',
        fetchedAt: '2026-07-30T00:00:00Z',
        updatedAt: nowIso(),
        locale: 'zh-CN',
        contentHash: sha256(entry.pkg + '|' + entry.name)
      }
    ],
    confidence: 0.8,
    createdAt: '2026-07-30T00:00:00Z',
    updatedAt: nowIso(),
    schemaVersion: '1.0.0',
    metadata: {
      verified: false,
      phase: 'phase-2-expand'
    },
    contentHash: sha256(documentText)
  };

  if (entry.iosTrackId) {
    record.iosTrackId = entry.iosTrackId;
  }

  return record;
}

// subcategory id → primary category id 反向映射
const _SUB_TO_PRIMARY = {
  instant_messaging: 'social_communication',
  social_network: 'social_communication',
  contacts_phone: 'social_communication',
  news_feed: 'news_information',
  microblog: 'news_information',
  community_forum: 'news_information',
  online_video: 'entertainment',
  short_video: 'entertainment',
  music: 'entertainment',
  audio_podcast: 'entertainment',
  game: 'entertainment',
  food_delivery: 'life_services',
  express_logistics: 'life_services',
  weather: 'life_services',
  housekeeping_housing: 'life_services',
  pet_services: 'life_services',
  comprehensive_ecommerce: 'shopping',
  second_hand: 'shopping',
  cross_border: 'shopping',
  flash_sale: 'shopping',
  content_ecommerce: 'shopping',
  map_navigation: 'travel_navigation',
  ride_hailing: 'travel_navigation',
  train_ticket: 'travel_navigation',
  flight_hotel_tour: 'travel_navigation',
  payment_wallet: 'finance',
  banking: 'finance',
  stock_fund: 'finance',
  insurance: 'finance',
  lottery: 'finance',
  office_communication: 'office_collaboration',
  video_conference: 'office_collaboration',
  document_office: 'office_collaboration',
  notes_knowledge: 'office_collaboration',
  task_todo: 'office_collaboration',
  cloud_storage: 'office_collaboration',
  online_course: 'education_learning',
  language_learning: 'education_learning',
  reading_ebook: 'education_learning',
  exam_preparation: 'education_learning',
  parenting: 'education_learning',
  knowledge_paid: 'education_learning',
  fitness: 'health_medical',
  health_management: 'health_medical',
  online_medical: 'health_medical',
  browser: 'tools',
  search_engine: 'tools',
  translate_dictionary: 'tools',
  calculator: 'tools',
  clock_alarm: 'tools',
  recording: 'tools',
  screenshot: 'tools',
  file_manager: 'tools',
  input_method: 'tools',
  cleaner: 'tools',
  battery: 'tools',
  network_proxy: 'tools',
  scan_ocr: 'tools',
  pdf_tool: 'tools',
  security_protection: 'system_security',
  permission_management: 'system_security',
  smart_home: 'smart_hardware',
  smart_wearable: 'smart_hardware'
};

function _resolvePrimaryCategory(subId) {
  const p = _SUB_TO_PRIMARY[subId];
  if (!p) throw new Error('未配置 subcategory→primary 映射: ' + subId);
  return p;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!fs.existsSync(SEEDS_DIR)) {
    throw new Error('seeds 目录不存在: ' + SEEDS_DIR);
  }

  // 收集已有 packageName
  const existing = new Set();
  for (const f of fs.readdirSync(SEEDS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(SEEDS_DIR, f), 'utf8'));
      if (obj && obj.androidPackageName) existing.add(obj.androidPackageName);
    } catch (_) {}
  }
  console.log('[expand] Existing seeds:', existing.size);

  let added = 0;
  let skipped = 0;
  let failed = 0;
  const byCategory = {};

  for (const entry of SEED_ENTRIES) {
    if (existing.has(entry.pkg)) {
      skipped++;
      continue;
    }
    try {
      const record = expand(entry);
      const file = path.join(SEEDS_DIR, entry.pkg + '.json');
      if (args.dryRun) {
        console.log('[expand] (dry-run) would write', file);
      } else {
        fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
      }
      added++;
      const c = record.primaryCategory;
      byCategory[c] = (byCategory[c] || 0) + 1;
    } catch (e) {
      failed++;
      console.error('[expand] FAIL', entry.pkg, ':', e.message);
    }
  }

  console.log('[expand] Added:', added, 'Skipped (existing):', skipped, 'Failed:', failed);
  console.log('[expand] By category:');
  for (const k of Object.keys(byCategory).sort()) {
    console.log('  ' + k + ': ' + byCategory[k]);
  }
  console.log('[expand] DONE.');
}

if (require.main === module) {
  (async () => {
    try {
      await main();
    } catch (e) {
      console.error('FAIL:', e.message);
      process.exit(1);
    }
  })();
}

module.exports = { expand, SEEDS_DIR };
