'use strict';
/**
 * 从 goto-base/shared/data/seeds/*.json 合并生成 GithubPages/GOTO-Base/seeds.json
 *
 * 输出格式：数组，每项为完整 AppRecord。
 * 用于浏览器端模糊匹配（goto-base-bundle.js 会读取该文件）。
 *
 * 用法：
 *   node GOTO-Engine/model-runner/build-seeds-bundle.js
 */

const path = require('path');
const fs = require('fs');

const SEEDS_DIR = path.resolve(__dirname, '../../goto-base/shared/data/seeds');
const OUTPUT_PATH = path.resolve(__dirname, '../../GithubPages/GOTO-Base/seeds.json');

function main() {
  if (!fs.existsSync(SEEDS_DIR)) {
    throw new Error('seeds 目录不存在: ' + SEEDS_DIR);
  }
  const files = fs.readdirSync(SEEDS_DIR).filter(f => f.endsWith('.json'));
  const records = [];
  for (const f of files) {
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(SEEDS_DIR, f), 'utf8'));
      if (obj && obj.androidPackageName) {
        records.push(obj);
      }
    } catch (e) {
      console.error('[build-seeds-bundle] SKIP ' + f + ': ' + e.message);
    }
  }
  // 按 packageName 排序，保证稳定
  records.sort((a, b) => {
    const pa = a.androidPackageName || '';
    const pb = b.androidPackageName || '';
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });

  const outDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(records, null, 2), 'utf8');
  console.log('[build-seeds-bundle] Wrote', OUTPUT_PATH);
  console.log('[build-seeds-bundle] Total records:', records.length);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  }
}

module.exports = { main, SEEDS_DIR, OUTPUT_PATH };
