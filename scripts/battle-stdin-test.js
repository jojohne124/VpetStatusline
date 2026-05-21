#!/usr/bin/env node
'use strict';
/**
 * battle-stdin-test.js
 *
 * 模擬 Claude CLI 給 statusline-agumon-color.js 的 stdin payload，
 * 跑一次後檢查 stdout 是否輸出戰鬥畫面（含 BOOM 或子彈白色色碼）。
 *
 * 用法：
 *   node scripts/battle-stdin-test.js              用目前角色觸發 1 次戰鬥
 *   node scripts/battle-stdin-test.js narrow       模擬寬度不足（render_width_chars=70）
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const INSTALL_DIR = path.join(os.homedir(), '.claude', 'agumon-statusline');
const STATUSLINE  = path.join(INSTALL_DIR, 'statusline-agumon-color.js');
const FORCE_FILE  = path.join(INSTALL_DIR, 'state', 'force-char.json');
const STATE_FILE  = path.join(INSTALL_DIR, 'state', 'color-state.json');
const CHEAT       = path.join(INSTALL_DIR, 'statusline-cheat.js');

const mode = process.argv[2] || 'normal';
const renderW = mode === 'narrow' ? 70 : 200;

const nowSec = Math.floor(Date.now() / 1000);
const payload = {
    model: { display_name: 'Claude 4 Opus', id: 'claude-opus-4', param_summary: '(Thinking)' },
    context_window: { used_percentage: 30 },
    cost: { total_cost_usd: 1.5 },
    rate_limits: {
        five_hour: { used_percentage: 20, resets_at: nowSec + 3600 },
        seven_day: { used_percentage: 5,  resets_at: nowSec + 7*86400 },
    },
    cwd: process.cwd(),
    render_width_chars: renderW,
};

// 1) 用 cheat 排入 battle（每次都新觸發）
const c = spawnSync('node', [CHEAT, '--battle', 'godzilla_1999', '--win'], { encoding: 'utf8' });
process.stdout.write(c.stdout || '');
if (c.stderr) process.stderr.write(c.stderr);

// 2) 重置 step 起點：清掉殘留 battleStartStep（避免上次測試殘留）
try {
    const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    delete st.battleStartStep; delete st.battleEnemy; delete st.battleWin;
    delete st.battlePending; delete st.thinkingPrimed; delete st.lastThinking;
    fs.writeFileSync(STATE_FILE, JSON.stringify(st));
} catch(e) {}

// 3) pipe payload 給 statusline
const r = spawnSync('node', [STATUSLINE], { input: JSON.stringify(payload), encoding: 'utf8' });
const out = r.stdout || '';
const err = r.stderr || '';

console.log(`\n[mode=${mode}, render_width_chars=${renderW}]`);
console.log('── statusline stdout ──');
console.log(out);
if (err) console.error('── stderr ──\n' + err);

// 啟發式檢測
const hasBoom    = /255;220;80/.test(out) && /255;140;40/.test(out);  // 爆炸顏色
const hasBullet  = /255;255;255/.test(out);                            // 白色子彈
const hasEnemy   = /godzilla|0;0;0;0;0;0/.test(out);
const linesCount = out.split('\n').length;

console.log(`\n[checks] lines=${linesCount}  hasBullet/Boom-colors=${hasBullet || hasBoom}`);
