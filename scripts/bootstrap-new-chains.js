#!/usr/bin/env node
'use strict';
// 一次性 scaffold：六條新進化鏈的 config.json + 跑 prepare/build/cutin
//   用法：node scripts/bootstrap-new-chains.js
// 流程：
//   1. 寫 24 個 config.json（rank/power/evolvesTo 串好）
//   2. 對每隻跑 process（prepare→build） + cutin
//   3. 把 24 個 id 加進 characters/roster.json（不動 starters）

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const CHARS_DIR = path.join(REPO_ROOT, 'characters');
const CLI       = path.join(REPO_ROOT, 'src', 'tools', 'char-cli.js');

// 共用的 frame 結構（沿用 agumon 家族慣例）
const FRAME_NAMES = ['Idle_1','Idle_2','Eat_1','Eat_2','Sleep_1','Sleep_2','Refuse','Happy','Angry','Hurt','Sad','Attack'];
const FRAMES_MAP = {
  IDLE_1: 0, IDLE_2: 1, EAT_1: 2, EAT_2: 3,
  SLEEP_1: 4, SLEEP_2: 5, REFUSE: 6, HAPPY: 7,
  ANGRY: 8, HURT: 9, SAD: 10, ATTACK: 11,
};

// folderName 對應磁碟上的資料夾；id 是 roster / runtime 使用的小寫名（與 install.js 一致）
const CHAINS = [
  [
    { folder: 'Patamon',             rank: 'Child',    power: 10 },
    { folder: 'Angemon',             rank: 'Adult',    power: 80 },
    { folder: 'MagnaAngemon',        rank: 'Perfect',  power: 130 },
    { folder: 'Dominimon',           rank: 'Ultimate', power: 175 },
  ],
  [
    { folder: 'Salamon',             rank: 'Child',    power: 10 },
    { folder: 'Gatomon',             rank: 'Adult',    power: 55 },
    { folder: 'Angewomon',           rank: 'Perfect',  power: 130 },
    { folder: 'Magnadramon',         rank: 'Ultimate', power: 175 },
  ],
  [
    { folder: 'Gomamon',             rank: 'Child',    power: 10 },
    { folder: 'Ikkakumon',           rank: 'Adult',    power: 60 },
    { folder: 'Zudomon',             rank: 'Perfect',  power: 110 },
    { folder: 'Vikemon',             rank: 'Ultimate', power: 160 },
  ],
  [
    { folder: 'Tentomon',            rank: 'Child',    power: 15 },
    { folder: 'Kabuterimon',         rank: 'Adult',    power: 65 },
    { folder: 'MegaKabuterimon',     rank: 'Perfect',  power: 115 },
    { folder: 'HerculesKabuterimon', rank: 'Ultimate', power: 165 },
  ],
  [
    { folder: 'Palmon',              rank: 'Child',    power: 10 },
    { folder: 'Togemon',             rank: 'Adult',    power: 60 },
    { folder: 'Lillymon',            rank: 'Perfect',  power: 110 },
    { folder: 'Rosemon',             rank: 'Ultimate', power: 160 },
  ],
  [
    { folder: 'Biyomon',             rank: 'Child',    power: 15 },
    { folder: 'Birdramon',           rank: 'Adult',    power: 65 },
    { folder: 'Garudamon',           rank: 'Perfect',  power: 115 },
    { folder: 'Phoenixmon',          rank: 'Ultimate', power: 165 },
  ],
];

function buildConfig(node, nextNode) {
  return {
    name: node.folder.toLowerCase(),
    rank: node.rank,
    power: node.power,
    frameCount: 12,
    targetSize: 16,
    layout: 'individual',
    frameNames: FRAME_NAMES,
    frames: FRAMES_MAP,
    sleepFrames: [4, 5],
    sleepPeriod: 2,
    roarFrames: [11, 0, 11],
    tokenResetFrames: [7, 0, 7],
    exprs: [{ frames: [2] }, { frames: [8] }],
    evolvesTo: nextNode
      ? [{ character: nextNode.folder.toLowerCase(), conditions: [{ type: 'cost_threshold', usd: 10 }] }]
      : [],
  };
}

function writeConfigs() {
  console.log('\n=== [1/3] 寫 config.json ===');
  for (const chain of CHAINS) {
    for (let i = 0; i < chain.length; i++) {
      const node     = chain[i];
      const nextNode = chain[i + 1] || null;
      const dir      = path.join(CHARS_DIR, node.folder);
      if (!fs.existsSync(dir)) { console.warn(`  [skip] 找不到資料夾 ${dir}`); continue; }
      const cfg      = buildConfig(node, nextNode);
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
      console.log(`  ✓ ${node.folder}/config.json  (rank=${node.rank}, power=${node.power}${nextNode ? `, → ${nextNode.folder.toLowerCase()}` : ' (末代)'})`);
    }
  }
}

function runCli(cmd, name) {
  const r = spawnSync(process.execPath, [CLI, cmd, name], { stdio: 'inherit' });
  if (r.status !== 0) console.warn(`  [warn] ${name} ${cmd} 退出碼 ${r.status}`);
  return r.status === 0;
}

function runCliBatch() {
  console.log('\n=== [2/3] 跑 process + cutin ===');
  for (const chain of CHAINS) {
    for (const node of chain) {
      const dir = path.join(CHARS_DIR, node.folder);
      if (!fs.existsSync(path.join(dir, 'config.json'))) continue;
      console.log(`\n--- ${node.folder} ---`);
      runCli('process', node.folder);
      if (fs.existsSync(path.join(dir, 'CutIn.png'))) runCli('cutin', node.folder);
      else console.log(`  [info] ${node.folder} 無 CutIn.png，跳過`);
    }
  }
}

function updateRoster() {
  console.log('\n=== [3/3] 更新 roster.json ===');
  const rosterPath = path.join(CHARS_DIR, 'roster.json');
  const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
  const existing = new Set(roster.roster);
  const ids = CHAINS.flatMap(chain => chain.map(n => n.folder.toLowerCase()));
  let added = 0;
  for (const id of ids) {
    if (!existing.has(id)) { roster.roster.push(id); existing.add(id); added++; }
  }
  fs.writeFileSync(rosterPath, JSON.stringify(roster, null, 2) + '\n');
  console.log(`  ✓ roster.json：新增 ${added} 個 id（總計 ${roster.roster.length}）`);
}

writeConfigs();
runCliBatch();
updateRoster();
console.log('\n完成。下一步：node scripts/install.js');
