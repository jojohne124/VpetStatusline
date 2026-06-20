#!/usr/bin/env node
'use strict';
// vpet — 全域指令薄殼（npm bin 進入點，跨平台）。
// 轉呼叫部署在 ~/.claude/agumon-statusline/ 的 statusline-cheat.js。
// 該檔用 __dirname 定位 assets/state，所以必須以「它的位置」執行 →
// 用 spawn 指 node 跑那支（不能 require，否則 __dirname 會落在本檔）。
const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const target = path.join(os.homedir(), '.claude', 'agumon-statusline', 'statusline-cheat.js');
if (!fs.existsSync(target)) {
    console.error('vpet：找不到已部署的 statusline-cheat.js');
    console.error(`  預期位置：${target}`);
    console.error('  請先在 agumon-cli repo 跑：npm run install-runtime');
    process.exit(1);
}

const r = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' });
if (r.error) { console.error(`vpet：執行失敗 ${r.error.message}`); process.exit(1); }
process.exit(r.status == null ? 0 : r.status);
