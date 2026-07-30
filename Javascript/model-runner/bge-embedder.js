'use strict';
/**
 * BGE-small-zh-v1.5 ONNX 推理脚本（GOTO-Engine 侧）
 *
 * - 加载 goto-base/shared/data/model/models/bge-small-zh-v1.5.onnx
 * - 简化版 BertTokenizer（基于 vocab.txt，中文按字、英文按词、加 [CLS]/[SEP]）
 * - 运行 ONNX 推理输出 512 维向量
 * - L2 归一化
 * - 导出 embed(text) 函数
 *
 * 依赖：onnxruntime-node（在 GOTO-Engine 目录下执行
 *   `npm install onnxruntime-node --no-save --prefix .` 安装）
 * 若依赖缺失，embed() 会抛出明确错误并提示安装方式，便于优雅降级。
 */

const path = require('path');
const fs = require('fs');

const MODEL_DIR = path.resolve(__dirname, '../../goto-base/shared/data/model/models');
const MODEL_PATH = path.join(MODEL_DIR, 'bge-small-zh-v1.5.onnx');
const VOCAB_PATH = path.join(MODEL_DIR, 'vocab.txt');
const TOKENIZER_PATH = path.join(MODEL_DIR, 'tokenizer.json');

const EMBED_DIM = 512;
const MAX_LEN = 512;

let _session = null;
let _vocab = null;
let _ort = null;

function requireOrt() {
  if (_ort) return _ort;
  try {
    _ort = require('onnxruntime-node');
    return _ort;
  } catch (e) {
    _ort = null;
    const hint =
      'onnxruntime-node 未安装。请在 GOTO-Engine 目录执行：\n' +
      '  npm install onnxruntime-node --no-save --prefix .\n' +
      '原始错误: ' + (e && e.message ? e.message : String(e));
    throw new Error('[BGE] onnxruntime-node 不可用：' + hint);
  }
}

async function loadModel() {
  if (_session) return _session;
  if (!fs.existsSync(MODEL_PATH)) {
    throw new Error('[BGE] 模型文件不存在: ' + MODEL_PATH);
  }
  try {
    const ort = requireOrt();
    _session = await ort.InferenceSession.create(MODEL_PATH);
    console.log('[BGE] Model loaded:', _session.inputNames, _session.outputNames);
    return _session;
  } catch (e) {
    _session = null;
    throw new Error('[BGE] 加载 ONNX 模型失败: ' + (e && e.message ? e.message : String(e)));
  }
}

function loadVocab() {
  if (_vocab) return _vocab;
  if (!fs.existsSync(VOCAB_PATH)) {
    throw new Error('[BGE] vocab.txt 不存在: ' + VOCAB_PATH);
  }
  const text = fs.readFileSync(VOCAB_PATH, 'utf8');
  const lines = text.split('\n');
  _vocab = new Map();
  for (let i = 0; i < lines.length; i++) {
    const tok = lines[i].replace(/\r$/, '');
    if (tok.length === 0 && i !== 0) {
      // 跳过空行，但保留 vocab 索引连续性：vocab.txt 行号即 token id
      // 这里仅当整行为空时不插入（不破坏既有 id 映射）
      continue;
    }
    _vocab.set(tok, i);
  }
  return _vocab;
}

function tokenize(text, maxLen = MAX_LEN) {
  const vocab = loadVocab();
  const unkId = vocab.has('[UNK]') ? vocab.get('[UNK]') : 100;
  const tokens = ['[CLS]'];

  // 中英文混合切分：中文按单字、英文按连续字母、数字按连续数字、其余非空白按单字符
  const segments = text.match(/[\u4e00-\u9fa5]|[a-zA-Z]+|[0-9]+|[^\s\u4e00-\u9fa5a-zA-Z0-9]/g) || [];

  for (const seg of segments) {
    if (tokens.length >= maxLen - 1) break;
    if (vocab.has(seg)) {
      tokens.push(seg);
    } else if (vocab.has(seg.toLowerCase()) && seg.match(/[a-zA-Z]+/)) {
      // 英文词尝试小写回退（vocab 中部分英文 token 为小写）
      tokens.push(seg.toLowerCase());
    } else {
      tokens.push('[UNK]');
    }
  }
  tokens.push('[SEP]');

  const ids = tokens.map(t => (vocab.has(t) ? vocab.get(t) : unkId));
  const attentionMask = new Array(ids.length).fill(1);
  const tokenTypeIds = new Array(ids.length).fill(0);
  return { ids, attentionMask, tokenTypeIds, tokens };
}

async function embed(text) {
  const session = await loadModel();
  const ort = requireOrt();
  const { ids, attentionMask, tokenTypeIds } = tokenize(text);

  const inputIdsTensor = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]);
  const attentionMaskTensor = new ort.Tensor('int64', BigInt64Array.from(attentionMask.map(BigInt)), [1, ids.length]);
  const tokenTypeIdsTensor = new ort.Tensor('int64', BigInt64Array.from(tokenTypeIds.map(BigInt)), [1, ids.length]);

  // 按 inputNames 顺序映射：通常为 [input_ids, attention_mask, token_type_ids]
  const feeds = {};
  const names = session.inputNames;
  if (names[0]) feeds[names[0]] = inputIdsTensor;
  if (names[1]) feeds[names[1]] = attentionMaskTensor;
  if (names[2]) feeds[names[2]] = tokenTypeIdsTensor;

  const output = await session.run(feeds);
  const outputName = session.outputNames[0];
  const data = output[outputName].data;

  // BGE 输出 shape 通常为 [batch, seq_len, hidden=512]，取 [CLS]（seq 第 0 位）做 pooling
  let pooled;
  const arr = Array.from(data);
  if (arr.length === EMBED_DIM) {
    pooled = arr;
  } else {
    // [seq_len, 512] -> mean pooling（按 attention_mask 加权）
    const seqLen = Math.floor(arr.length / EMBED_DIM);
    pooled = new Array(EMBED_DIM).fill(0);
    let cnt = 0;
    for (let i = 0; i < seqLen; i++) {
      if (attentionMask[i] === 0) continue;
      cnt++;
      for (let d = 0; d < EMBED_DIM; d++) {
        pooled[d] += arr[i * EMBED_DIM + d];
      }
    }
    if (cnt > 0) {
      for (let d = 0; d < EMBED_DIM; d++) pooled[d] /= cnt;
    }
  }

  // L2 归一化
  const norm = Math.sqrt(pooled.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? pooled.map(v => v / norm) : pooled;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // 向量已 L2 归一化，点积即余弦相似度
}

module.exports = {
  loadModel,
  embed,
  tokenize,
  cosineSimilarity,
  MODEL_PATH,
  VOCAB_PATH,
  TOKENIZER_PATH,
  EMBED_DIM
};

// CLI 自测
if (require.main === module) {
  (async () => {
    try {
      console.log('Loading BGE model...');
      await loadModel();
      console.log('Model loaded. Testing embed()...');
      const v1 = await embed('微信');
      const v2 = await embed('聊天');
      const v3 = await embed('支付');
      const norm = Math.sqrt(v1.reduce((s, v) => s + v * v, 0));
      console.log('微信 vector dim:', v1.length, 'norm:', norm.toFixed(4));
      console.log('cosine(微信, 聊天):', cosineSimilarity(v1, v2).toFixed(4));
      console.log('cosine(微信, 支付):', cosineSimilarity(v1, v3).toFixed(4));
      console.log('cosine(聊天, 支付):', cosineSimilarity(v2, v3).toFixed(4));
      console.log('PASS');
    } catch (e) {
      console.error('FAIL:', e.message);
      process.exit(1);
    }
  })();
}
