#!/usr/bin/env node
'use strict';
// GOTO 语义模块语料导入脚本（Node.js）
// 用法：
//   node import-corpus.js --input cilin.txt --type cilin --output synonyms/
//   node import-corpus.js --refresh-config
//   node import-corpus.js --help

var fs = require('fs');
var path = require('path');

function parseArgs(){
  var args = {};
  var argv = process.argv.slice(2);
  for(var i = 0; i < argv.length; i++){
    var a = argv[i];
    // --key=value
    var m = a.match(/^--([^=]+)=(.*)$/);
    if(m){
      args[m[1]] = m[2];
      continue;
    }
    // --key value (next arg, if not starting with --)
    var m2 = a.match(/^--([^=]+)$/);
    if(m2){
      var next = argv[i + 1];
      if(next !== undefined && !/^--/.test(next)){
        args[m2[1]] = next;
        i++;
      }else{
        args[m2[1]] = true;
      }
    }
  }
  return args;
}

function showHelp(){
  console.log('GOTO 语义模块语料导入脚本');
  console.log('');
  console.log('用法：');
  console.log('  node import-corpus.js --input <file> --type cilin --output <dir>');
  console.log('    解析哈工大同义词词林原始文件，按拼音首字母分片输出');
  console.log('');
  console.log('  node import-corpus.js --refresh-config');
  console.log('    扫描 synonyms/ 和 vectors/ 目录，重新生成 semantic-config.json');
  console.log('');
  console.log('  node import-corpus.js --help');
  console.log('    显示本帮助');
  console.log('');
  console.log('词林格式示例：');
  console.log('  Aa01A01= 人 士 人物 人士');
  console.log('  Aa02A01= 安静 宁静 寂静 静谧');
}

// 加载 pinyin-index.json（用于中文→首字母路由）
function loadPinyinIndex(){
  var p = path.join(__dirname, 'pinyin-index.json');
  try{
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }catch(_){
    console.warn('Warning: pinyin-index.json not found, fallback to other shard routing');
    return {};
  }
}

function getInitial(word, pinyinIndex){
  if(!word) return null;
  var ch = word.charAt(0);
  if(/[a-z]/i.test(ch)) return ch.toLowerCase();
  if(/[0-9]/.test(ch)) return '0';
  return pinyinIndex[ch] || null;
}

// 解析哈工大同义词词林
// 格式：Aa01A01= 人 士 人物 人士
// 每行一个同义词组，等号前是编码，等号后是空格分隔的同义词列表
function parseCilin(content){
  var groups = {};
  var lines = content.split(/\r?\n/);
  lines.forEach(function(line){
    line = line.trim();
    if(!line) return;
    var parts = line.split('=');
    if(parts.length !== 2) return;
    var code = parts[0].trim();
    var words = parts[1].trim().split(/\s+/).filter(Boolean);
    if(words.length === 0) return;
    // 每个词都关联到本组其他词作为同义词
    words.forEach(function(w){
      if(!groups[w]) groups[w] = [];
      words.forEach(function(other){
        if(other !== w && groups[w].indexOf(other) < 0){
          groups[w].push(other);
        }
      });
    });
  });
  return groups;
}

function importCilin(args){
  var input = args.input;
  var output = args.output || 'synonyms/';
  if(!input){
    console.error('Error: --input not specified');
    process.exit(1);
  }
  if(!fs.existsSync(input)){
    console.error('Error: input file not found: ' + input);
    process.exit(1);
  }
  console.log('Reading:', input);
  var content = fs.readFileSync(input, 'utf8');
  console.log('Parsing cilin format...');
  var groups = parseCilin(content);
  var totalWords = Object.keys(groups).length;
  console.log('Parsed ' + totalWords + ' unique words');

  var pinyinIndex = loadPinyinIndex();
  var shards = {};
  var noInitial = 0;
  Object.keys(groups).forEach(function(word){
    var initial = getInitial(word, pinyinIndex);
    if(!initial){
      initial = '0'; // 兜底分片
      noInitial++;
    }
    if(!shards[initial]) shards[initial] = { words: {} };
    shards[initial].words[word] = groups[word];
  });

  if(noInitial > 0){
    console.warn('Warning: ' + noInitial + ' words could not be routed by pinyin initial, placed in shard-0.json');
  }

  var outDir = path.isAbsolute(output) ? output : path.join(__dirname, output);
  if(!fs.existsSync(outDir)){
    fs.mkdirSync(outDir, { recursive: true });
  }

  var shardCount = Object.keys(shards).length;
  Object.keys(shards).forEach(function(initial){
    var fp = path.join(outDir, 'shard-' + initial + '.json');
    var data = shards[initial];
    fs.writeFileSync(fp, JSON.stringify(data), 'utf8');
    var n = Object.keys(data.words).length;
    console.log('  Wrote ' + fp + ' (' + n + ' words)');
  });

  console.log('');
  console.log('Done. ' + shardCount + ' shards generated in ' + outDir);
  console.log('Run `node import-corpus.js --refresh-config` to update semantic-config.json');
}

function refreshConfig(){
  var cfgPath = path.join(__dirname, 'semantic-config.json');
  var cfg = {};
  try{
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  }catch(_){
    cfg = {
      version: '1.0.0',
      synonyms: { count: 0, shards: {} },
      vectors: { available: false, dim: 0, count: 0, metaFile: 'vectors/meta.json', shards: {} },
      pinyinIndex: 'pinyin-index.json'
    };
  }

  // 扫描 synonyms/
  var synDir = path.join(__dirname, 'synonyms');
  cfg.synonyms = cfg.synonyms || { count: 0, shards: {} };
  cfg.synonyms.shards = {};
  cfg.synonyms.count = 0;
  if(fs.existsSync(synDir)){
    fs.readdirSync(synDir).forEach(function(f){
      var m = f.match(/^shard-([a-z0-9]+)\.json$/);
      if(!m) return;
      var initial = m[1];
      var fp = path.join(synDir, f);
      try{
        var data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        var n = Object.keys(data.words || {}).length;
        cfg.synonyms.shards[initial] = { file: f, count: n };
        cfg.synonyms.count += n;
      }catch(e){
        console.warn('Warning: failed to parse ' + f + ': ' + e.message);
      }
    });
  }

  // 扫描 vectors/
  var vecDir = path.join(__dirname, 'vectors');
  cfg.vectors = cfg.vectors || { available: false, shards: {} };
  cfg.vectors.available = fs.existsSync(path.join(vecDir, 'meta.json'));
  cfg.vectors.shards = {};
  if(cfg.vectors.available && fs.existsSync(vecDir)){
    fs.readdirSync(vecDir).forEach(function(f){
      var m = f.match(/^vec-shard-([a-z0-9]+)\.json$/);
      if(!m) return;
      cfg.vectors.shards[m[1]] = { file: f };
    });
  }

  cfg.generatedAt = new Date().toISOString();
  cfg.pinyinIndex = cfg.pinyinIndex || 'pinyin-index.json';
  cfg.l1CoreInline = true;

  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  console.log('Config refreshed: ' + cfgPath);
  console.log('  synonyms: ' + cfg.synonyms.count + ' words, ' + Object.keys(cfg.synonyms.shards).length + ' shards');
  console.log('  vectors: ' + (cfg.vectors.available ? 'available' : 'not available'));
}

function main(){
  var args = parseArgs();
  if(args.help){
    showHelp();
    process.exit(0);
  }
  if(args['refresh-config']){
    refreshConfig();
    return;
  }
  if(args.type === 'cilin'){
    importCilin(args);
    return;
  }
  // 默认显示帮助
  showHelp();
  process.exit(0);
}

main();
