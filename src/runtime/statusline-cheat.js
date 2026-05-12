#!/usr/bin/env node
// 作弊碼：強制切換角色 / reset 到隨機 starter
// 用法：node statusline-cheat.js <index|name>
//       node statusline-cheat.js --reset
const fs   = require('fs');
const path = require('path');

const INSTALL_ROOT = __dirname;
const ROSTER_FILE  = path.join(INSTALL_ROOT, 'assets', 'roster.json');
const FORCE_FILE   = path.join(INSTALL_ROOT, 'state', 'force-char.json');

const rosterData = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
const roster   = Array.isArray(rosterData) ? rosterData : rosterData.roster;
const starters = Array.isArray(rosterData) ? rosterData : (rosterData.starters || [rosterData.roster[0]]);

const arg = process.argv[2];

if (!arg) {
    console.log('用法: node statusline-cheat.js <index|name|--reset>');
    console.log('目前角色列表:');
    roster.forEach((name, i) => console.log(`  #${i + 1} ${name}`));
    console.log('Starters:', starters.join(', '));
    process.exit(1);
}

let target;
if (arg === '--reset') {
    target = starters[Math.floor(Math.random() * starters.length)];
    console.log(`🎲 隨機抽到：${target}`);
} else {
    const idx = parseInt(arg, 10);
    target = isNaN(idx) ? arg : roster[idx - 1];
}

if (!target || !roster.includes(target)) {
    console.log(`找不到角色: ${arg}`);
    roster.forEach((name, i) => console.log(`  #${i + 1} ${name}`));
    process.exit(1);
}

fs.writeFileSync(FORCE_FILE, JSON.stringify({ character: target, resetCostBase: true }));
console.log(`✓ 已切換至 ${target}（下次 refresh 生效）`);
