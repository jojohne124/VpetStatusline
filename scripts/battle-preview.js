#!/usr/bin/env node
'use strict';
/**
 * battle-preview.js
 *
 * 在終端直接走完整套戰鬥分鏡，方便人眼檢查 sprite 對齊 / 子彈位置。
 * 從 ~/.claude/agumon-statusline/ 讀資源，直接使用 core.decideBattleFrame 確保
 * 與實際 statusline 運作一致。
 *
 * 用法：
 *   node scripts/battle-preview.js [me] [enemy] [--win|--lose]
 * 範例：
 *   node scripts/battle-preview.js agumon godzilla_1999 --win
 */
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const INSTALL_DIR = path.join(os.homedir(), '.claude', 'agumon-statusline');
const core = require(path.join(INSTALL_DIR, 'agumon-core'));

const args   = process.argv.slice(2);
const me     = args.find(a => !a.startsWith('--')) || 'agumon';
const enemy  = args.filter(a => !a.startsWith('--'))[1] || 'godzilla_1999';
const win    = args.includes('--win')  ? true
             : args.includes('--lose') ? false
             : Math.random() < 0.5;

console.log(`[preview] me=${me}  enemy=${enemy}  win=${win}  battle_length=${core.BATTLE_LENGTH}\n`);

function loadArt(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) { return null; } }

const meChar     = core.loadCharacter(me);
const enemyChar  = core.loadCharacter(enemy);
const meArt      = loadArt(meChar.artFile);
const enemyArt   = loadArt(enemyChar.artFile);
const meBullet   = loadArt(meChar.bulletArtFile);
const enemyBullet= loadArt(enemyChar.bulletArtFile);
const shared     = core.loadShared();

const F = meChar.charDef.F;

for (let t = 0; t < core.BATTLE_LENGTH; t++) {
    const frame = core.decideBattleFrame(t, win, enemy, F);
    const lines = core.composeBattleScene({
        frame,
        meArt, enemyArt,
        meBulletArt:    meBullet,
        enemyBulletArt: enemyBullet,
        shared,
        meRightOffset:    meChar.charDef.RIGHT_OFFSET,
        enemyRightOffset: enemyChar.charDef.RIGHT_OFFSET,
    });
    const tag = frame.phase
        + (frame.sharedSpriteName ? `/${frame.sharedSpriteName}` : '')
        + (frame.sharedFrameIdx != null ? `[${frame.sharedFrameIdx}]` : '');
    console.log(`── step ${t.toString().padStart(2, ' ')} (${tag}) ──`);
    for (const line of lines) console.log(line);
    console.log('');
}
