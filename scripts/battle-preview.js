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
// 預設依 cut-in art 可用性自動選 v2；--v1 強制 v1；--v2 強制 v2（即使沒 cut-in）
const forceV1   = args.includes('--v1');
const forceV2   = args.includes('--v2');
const autoVer   = core.pickBattleVersion(me, enemy);
const version   = forceV1 ? 1 : forceV2 ? 2 : autoVer;
const useCutIn  = version === 2;
const length    = core.battleLength(version);

function loadArt(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) { return null; } }

const meChar       = core.loadCharacter(me);
const enemyChar    = core.loadCharacter(enemy);
const meArt        = loadArt(meChar.artFile);
const enemyArt     = loadArt(enemyChar.artFile);
const meBullet     = loadArt(meChar.bulletArtFile);
const enemyBullet  = loadArt(enemyChar.bulletArtFile);
const meCutIn      = loadArt(meChar.cutinArtFile);
const enemyCutIn   = loadArt(enemyChar.cutinArtFile);
const shared       = core.loadShared();

console.log(`[preview] me=${me}  enemy=${enemy}  win=${win}  version=v${version}  length=${length}`);
console.log(`[preview] cutin: me=${meCutIn ? 'yes' : 'no'}, enemy=${enemyCutIn ? 'yes' : 'no'}\n`);

const F = meChar.charDef.F;

for (let t = 0; t < length; t++) {
    const frame = core.decideBattleFrame(t, win, enemy, F, useCutIn);
    const lines = core.composeBattleScene({
        frame,
        meArt, enemyArt,
        meBulletArt:    meBullet,
        enemyBulletArt: enemyBullet,
        meCutInArt:     meCutIn,
        enemyCutInArt:  enemyCutIn,
        shared,
        meRightOffset:    meChar.charDef.RIGHT_OFFSET,
        enemyRightOffset: enemyChar.charDef.RIGHT_OFFSET,
    });
    const tag = frame.phase
        + (frame.sharedSpriteName ? `/${frame.sharedSpriteName}` : '')
        + (frame.sharedFrameIdx != null ? `[${frame.sharedFrameIdx}]` : '')
        + (frame.meCutIn || frame.enemyCutIn ? ' +cutin' : '');
    console.log(`── step ${t.toString().padStart(2, ' ')} (${tag}) ──`);
    for (const line of lines) console.log(line);
    console.log('');
}
