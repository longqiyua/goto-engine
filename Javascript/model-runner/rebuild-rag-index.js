'use strict';
/**
 * RAG 向量库重建脚本（GOTO-Engine 侧）
 *
 * 使用 bge-embedder.js 的真实 BGE-small-zh-v1.5 ONNX 模型，
 * 重新生成 goto-base/shared/data/rag/vector-store.json 中每个应用的 512 维向量。
 *
 * 行为：
 *   1. 读取 vector-store.json（不修改 Base 源文件结构，仅替换 vector 字段）
 *   2. 对每个应用的 documentText 调用 embed() 生成真实向量
 *   3. 替换 vectors[*].vector
 *   4. 更新顶层 embeddingModel / vectorGenerator / note
 *   5. 写回 vector-store.json
 *   6. 同步更新 rag-index.json 的 embeddingModel / vectorGenerator
 *
 * 注意：rag-index.json 的 byPackage / byCategory / byIntentTag 索引基于应用元数据，
 *      重建向量不影响这些索引，因此仅同步顶层模型字段。
 *
 * 用法：
 *   cd GOTO-Engine
 *   node model-runner/rebuild-rag-index.js           # 重建全部
 *   node model-runner/rebuild-rag-index.js --dry-run  # 仅打印，不写回
 *   node model-runner/rebuild-rag-index.js --limit 5  # 只处理前 5 条（调试）
 */

const path = require('path');
const fs = require('fs');

const { embed, loadModel, EMBED_DIM, MODEL_PATH } = require('./bge-embedder');

const RAG_DIR = path.resolve(__dirname, '../../goto-base/shared/data/rag');
const VECTOR_STORE_PATH = path.join(RAG_DIR, 'vector-store.json');
const RAG_INDEX_PATH = path.join(RAG_DIR, 'rag-index.json');

const NEW_EMBEDDING_MODEL = 'bge-small-zh-v1.5';
const NEW_VECTOR_GENERATOR = 'bge-small-zh-v1.5-onnx';

function parseArgs(argv) {
  const args = { dryRun: false, limit: 0 };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--limit=')) args.limit = parseInt(a.slice(8), 10) || 0;
    else if (a === '--limit') args.limit = 1; // 占位，下个参数处理略
  }
  // 支持 --limit N 形式
  const limitIdx = argv.indexOf('--limit');
  if (limitIdx !== -1 && argv[limitIdx + 1]) {
    const n = parseInt(argv[limitIdx + 1], 10);
    if (!Number.isNaN(n)) args.limit = n;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!fs.existsSync(VECTOR_STORE_PATH)) {
    throw new Error('vector-store.json 不存在: ' + VECTOR_STORE_PATH);
  }
  if (!fs.existsSync(RAG_INDEX_PATH)) {
    throw new Error('rag-index.json 不存在: ' + RAG_INDEX_PATH);
  }

  console.log('[rebuild] Using model:', MODEL_PATH);
  console.log('[rebuild] Loading BGE model...');
  await loadModel();
  console.log('[rebuild] Model ready. Embedding dimension:', EMBED_DIM);

  const store = JSON.parse(fs.readFileSync(VECTOR_STORE_PATH, 'utf8'));
  const vectors = store.vectors || [];
  console.log('[rebuild] Total apps in vector-store:', vectors.length);

  const originalDimension = store.dimension;
  if (originalDimension !== EMBED_DIM) {
    console.warn('[rebuild] WARNING: store.dimension=' + originalDimension + ' but model outputs ' + EMBED_DIM + '. Will update dimension field.');
    store.dimension = EMBED_DIM;
  }

  const limit = args.limit > 0 ? Math.min(args.limit, vectors.length) : vectors.length;
  console.log('[rebuild] Processing', limit, 'apps' + (args.dryRun ? ' (dry-run)' : '') + '...');

  let success = 0;
  let failed = 0;
  for (let i = 0; i < limit; i++) {
    const app = vectors[i];
    const doc = app.documentText || '';
    try {
      const vec = await embed(doc);
      if (!Array.isArray(vec) || vec.length !== EMBED_DIM) {
        throw new Error('embed() 返回维度异常: ' + (vec && vec.length));
      }
      // 保留 6 位小数以减小文件体积
      app.vector = vec.map(v => Math.round(v * 1e6) / 1e6);
      success++;
      if ((i + 1) % 10 === 0 || i === limit - 1) {
        console.log('[rebuild]   [' + (i + 1) + '/' + limit + '] ' + app.packageName + ' (' + app.appName + ') OK');
      }
    } catch (e) {
      failed++;
      console.error('[rebuild]   [' + (i + 1) + '/' + limit + '] ' + app.packageName + ' FAIL: ' + e.message);
    }
  }

  console.log('[rebuild] Embedded: success=' + success + ' failed=' + failed);

  // 更新顶层元数据
  store.embeddingModel = NEW_EMBEDDING_MODEL;
  store.vectorGenerator = NEW_VECTOR_GENERATOR;
  store.note =
    '由 GOTO-Engine/model-runner/rebuild-rag-index.js 调用真实 BGE-small-zh-v1.5 ONNX 模型生成向量。' +
    ' 向量已 L2 归一化，cosine similarity 等价于点积。';

  if (args.dryRun) {
    console.log('[rebuild] --dry-run 模式：不写回文件。');
    console.log('[rebuild] Sample vector[0] (first 8 dims):', vectors[0].vector.slice(0, 8));
    console.log('[rebuild] New embeddingModel:', store.embeddingModel);
    console.log('[rebuild] New vectorGenerator:', store.vectorGenerator);
    return { success, failed };
  }

  // 写回 vector-store.json（保留 4 空格缩进，与原文件一致）
  fs.writeFileSync(VECTOR_STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
  console.log('[rebuild] Wrote vector-store.json');

  // 同步 rag-index.json 顶层字段（索引结构不变）
  const index = JSON.parse(fs.readFileSync(RAG_INDEX_PATH, 'utf8'));
  index.dimension = EMBED_DIM;
  index.embeddingModel = NEW_EMBEDDING_MODEL;
  index.vectorGenerator = NEW_VECTOR_GENERATOR;
  // totalVectors / byPackage / byCategory / byIntentTag 不变（应用数量与元数据未改）
  fs.writeFileSync(RAG_INDEX_PATH, JSON.stringify(index, null, 2), 'utf8');
  console.log('[rebuild] Wrote rag-index.json');

  console.log('[rebuild] DONE. success=' + success + ' failed=' + failed);
  return { success, failed };
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

module.exports = { main, VECTOR_STORE_PATH, RAG_INDEX_PATH };
