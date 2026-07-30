'use strict';
/**
 * 从 seeds 目录构建完整 RAG 向量库（GOTO-Engine 侧）
 *
 * 扫描 goto-base/shared/data/seeds/*.json，对每个种子：
 *   1. 构建 documentText（与既有 vector-store.json 格式一致）
 *   2. 调用 BGE-small-zh-v1.5 ONNX 模型生成 512 维归一化向量
 *   3. 写入 vectors[] 数组
 *
 * 同时重建 rag-index.json：
 *   - byPackage:     packageName -> { idx, appName, category, subcategory }
 *   - byCategory:    primaryCategory -> [idx...]
 *   - byIntentTag:   userIntents[*] -> [idx...]
 *
 * 用法：
 *   node model-runner/build-rag-from-seeds.js           # 全量重建
 *   node model-runner/build-rag-from-seeds.js --dry-run # 仅打印
 *   node model-runner/build-rag-from-seeds.js --limit 5 # 只处理前 5 条（调试）
 */

const path = require('path');
const fs = require('fs');

const { embed, loadModel, EMBED_DIM, MODEL_PATH } = require('./bge-embedder');

const SEEDS_DIR = path.resolve(__dirname, '../../goto-base/shared/data/seeds');
const RAG_DIR = path.resolve(__dirname, '../../goto-base/shared/data/rag');
const VECTOR_STORE_PATH = path.join(RAG_DIR, 'vector-store.json');
const RAG_INDEX_PATH = path.join(RAG_DIR, 'rag-index.json');

const EMBEDDING_MODEL = 'bge-small-zh-v1.5';
const VECTOR_GENERATOR = 'bge-small-zh-v1.5-onnx';

function parseArgs(argv) {
  const args = { dryRun: false, limit: 0 };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--limit') {
      const n = parseInt(rest[i + 1], 10);
      if (!Number.isNaN(n)) args.limit = n;
      i++;
    } else if (a.startsWith('--limit=')) {
      const n = parseInt(a.slice(8), 10);
      if (!Number.isNaN(n)) args.limit = n;
    }
  }
  return args;
}

/**
 * 构建 documentText，与既有 vector-store.json 中格式保持一致。
 * 顺序：canonicalName + aliases + keywords + capabilities + userIntents + usageScenarios + semanticDescription
 */
function buildDocumentText(seed) {
  const parts = [];
  if (seed.canonicalName) parts.push(seed.canonicalName);
  if (Array.isArray(seed.aliases)) parts.push(seed.aliases.join(' '));
  if (Array.isArray(seed.keywords)) parts.push(seed.keywords.join(' '));
  if (Array.isArray(seed.capabilities)) parts.push(seed.capabilities.join(' '));
  if (Array.isArray(seed.userIntents)) parts.push(seed.userIntents.join(' '));
  if (Array.isArray(seed.usageScenarios)) parts.push(seed.usageScenarios.join(' '));
  if (seed.semanticDescription) parts.push(seed.semanticDescription);
  return parts.filter(Boolean).join(' ');
}

function loadSeeds() {
  if (!fs.existsSync(SEEDS_DIR)) {
    throw new Error('seeds 目录不存在: ' + SEEDS_DIR);
  }
  const files = fs.readdirSync(SEEDS_DIR).filter(f => f.endsWith('.json'));
  const seeds = [];
  for (const f of files) {
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(SEEDS_DIR, f), 'utf8'));
      if (obj && obj.androidPackageName) {
        seeds.push(obj);
      }
    } catch (e) {
      console.error('[build] SKIP ' + f + ': ' + e.message);
    }
  }
  // 按 packageName 排序，保证索引稳定
  seeds.sort((a, b) => {
    const pa = a.androidPackageName || '';
    const pb = b.androidPackageName || '';
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
  return seeds;
}

async function main() {
  const args = parseArgs(process.argv);

  console.log('[build] Using model:', MODEL_PATH);
  console.log('[build] Loading BGE model...');
  await loadModel();
  console.log('[build] Model ready. Embedding dimension:', EMBED_DIM);

  const seeds = loadSeeds();
  console.log('[build] Loaded seeds:', seeds.length);

  const limit = args.limit > 0 ? Math.min(args.limit, seeds.length) : seeds.length;
  console.log('[build] Processing', limit, 'apps' + (args.dryRun ? ' (dry-run)' : '') + '...');

  const vectors = [];
  const byPackage = {};
  const byCategory = {};
  const byIntentTag = {};

  let success = 0;
  let failed = 0;

  for (let i = 0; i < limit; i++) {
    const seed = seeds[i];
    const pkg = seed.androidPackageName;
    const doc = buildDocumentText(seed);
    try {
      const vec = await embed(doc);
      if (!Array.isArray(vec) || vec.length !== EMBED_DIM) {
        throw new Error('embed() 返回维度异常: ' + (vec && vec.length));
      }
      const rounded = vec.map(v => Math.round(v * 1e6) / 1e6);
      vectors.push({
        packageName: pkg,
        appName: seed.canonicalName || seed.localizedNames && seed.localizedNames['zh-CN'] || pkg,
        primaryCategory: seed.primaryCategory || '',
        primarySubcategory: seed.primarySubcategory || '',
        documentText: doc,
        vector: rounded
      });

      const idx = vectors.length - 1;
      byPackage[pkg] = {
        idx: idx,
        appName: vectors[idx].appName,
        category: seed.primaryCategory || '',
        subcategory: seed.primarySubcategory || ''
      };

      const cat = seed.primaryCategory || '未分类';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(idx);

      if (Array.isArray(seed.userIntents)) {
        for (const intent of seed.userIntents) {
          if (!intent) continue;
          if (!byIntentTag[intent]) byIntentTag[intent] = [];
          byIntentTag[intent].push(idx);
        }
      }

      success++;
      if ((i + 1) % 10 === 0 || i === limit - 1) {
        console.log('[build]   [' + (i + 1) + '/' + limit + '] ' + pkg + ' OK');
      }
    } catch (e) {
      failed++;
      console.error('[build]   [' + (i + 1) + '/' + limit + '] ' + pkg + ' FAIL: ' + e.message);
    }
  }

  console.log('[build] Embedded: success=' + success + ' failed=' + failed);
  console.log('[build] Total vectors:', vectors.length);
  console.log('[build] Categories:', Object.keys(byCategory).length);
  console.log('[build] Intent tags:', Object.keys(byIntentTag).length);

  if (args.dryRun) {
    console.log('[build] --dry-run 模式：不写回文件。');
    console.log('[build] Sample vector[0] (first 8 dims):', vectors[0] ? vectors[0].vector.slice(0, 8) : null);
    return { success, failed, total: vectors.length };
  }

  // 确保输出目录存在
  if (!fs.existsSync(RAG_DIR)) {
    fs.mkdirSync(RAG_DIR, { recursive: true });
  }

  // 写 vector-store.json
  const store = {
    version: '1.0.0',
    description: 'GOTO Base 公共 RAG 向量库。每个应用一个向量，由应用分类+名字+意图倾向度+关键词+语义描述生成。',
    embeddingModel: EMBEDDING_MODEL,
    dimension: EMBED_DIM,
    vectorGenerator: VECTOR_GENERATOR,
    note:
      '由 GOTO-Engine/model-runner/build-rag-from-seeds.js 调用真实 BGE-small-zh-v1.5 ONNX 模型生成向量。' +
      ' 向量已 L2 归一化，cosine similarity 等价于点积。',
    vectors: vectors
  };
  fs.writeFileSync(VECTOR_STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
  console.log('[build] Wrote vector-store.json (' + vectors.length + ' vectors)');

  // 写 rag-index.json
  const index = {
    version: '1.0.0',
    dimension: EMBED_DIM,
    vectorGenerator: VECTOR_GENERATOR,
    embeddingModel: EMBEDDING_MODEL,
    totalVectors: vectors.length,
    byPackage: byPackage,
    byCategory: byCategory,
    byIntentTag: byIntentTag
  };
  fs.writeFileSync(RAG_INDEX_PATH, JSON.stringify(index, null, 2), 'utf8');
  console.log('[build] Wrote rag-index.json');

  console.log('[build] DONE. success=' + success + ' failed=' + failed);
  return { success, failed, total: vectors.length };
}

if (require.main === module) {
  (async () => {
    try {
      await main();
      console.log('PASS');
    } catch (e) {
      console.error('FAIL:', e.message);
      process.exit(1);
    }
  })();
}

module.exports = { main, buildDocumentText, SEEDS_DIR, VECTOR_STORE_PATH, RAG_INDEX_PATH };
