#!/usr/bin/env node
'use strict';
// 驗證黑影 fallback：silhouetteArt / silhouetteCellRows 把幀染成單色剪影，
// 保留透明結構、frame 索引不變。用法：node scripts/test-shadow-fallback.js
const fs = require('fs');
const path = require('path');
const core = require('../src/runtime/agumon-core.js');
const { silhouetteCellRows, silhouetteArt, silhouettePixels } = core;

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg); } };

const SHADE = [54, 54, 66];
// cell 合法 = null（透明）或 [上RGB, 下RGB]，channel -1 表該半透明
const cellOkShade = c => {
    if (c === null) return true;
    const upOk = c[0] >= 0, loOk = c[3] >= 0;
    const upGood = upOk ? (c[0] === SHADE[0] && c[1] === SHADE[1] && c[2] === SHADE[2])
                        : (c[0] === -1 && c[1] === -1 && c[2] === -1);
    const loGood = loOk ? (c[3] === SHADE[0] && c[4] === SHADE[1] && c[5] === SHADE[2])
                        : (c[3] === -1 && c[4] === -1 && c[5] === -1);
    return upGood && loGood;
};

// ── 1. 合成資料：全彩 / 半透明上 / 半透明下 / 全透明 ──────────────────
console.log('— 合成 cell 染色 —');
const rows = [[
    [10, 20, 30, 40, 50, 60],   // 上下都有色 → 都該變 shade
    null,                       // 透明 → 維持 null
    [5, 5, 5, -1, -1, -1],      // 只有上半 → 上 shade、下維持 -1
    [-1, -1, -1, 9, 9, 9],      // 只有下半 → 下 shade、上維持 -1
]];
const out = silhouetteCellRows(rows)[0];
ok(out[0][0] === 54 && out[0][3] === 54, '全彩 cell 兩半都該染 shade');
ok(out[1] === null, '透明 cell 應維持 null');
ok(out[2][0] === 54 && out[2][3] === -1, '半透明(上)應只染上半');
ok(out[3][0] === -1 && out[3][3] === 54, '半透明(下)應只染下半');

// ── 2. silhouetteArt 保留 frame 數與結構 ──────────────────────────
const fakeArt = { frames: [rows, rows, rows], meta: 'x' };
const sil = silhouetteArt(fakeArt);
ok(sil.frames.length === 3, 'frame 數應不變（戰鬥用同一套索引）');
ok(sil.meta === 'x', '其他欄位應保留');
ok(sil !== fakeArt && sil.frames[0] !== rows, '應回傳新物件、不改原資料');

// ── 3. 真實 agumon art 跑一遍（fallback 的實際來源）──────────────────
console.log('\n— 真實 agumon art —');
const aguArtPath = path.join(__dirname, '..', 'characters', 'Agumon', 'art.json');
const aguArt = JSON.parse(fs.readFileSync(aguArtPath, 'utf8'));
const aguSil = silhouetteArt(aguArt);
ok(aguSil.frames.length === aguArt.frames.length, `frame 數一致（${aguArt.frames.length}）`);
let allShade = true;
for (const f of aguSil.frames) for (const row of f) for (const c of row) if (!cellOkShade(c)) { allShade = false; break; }
ok(allShade, '所有像素都應為 shade 色或透明');
// 確認確實有非透明像素（不是整張空的）
let nonEmpty = 0;
for (const row of aguSil.frames[0]) for (const c of row) if (c) nonEmpty++;
ok(nonEmpty > 0, `agumon 第 0 幀有 ${nonEmpty} 個剪影像素`);
console.log(`  agumon ${aguArt.frames.length} 幀、第 0 幀 ${nonEmpty} 個剪影像素`);

// ── 4. silhouettePixels（pixels.json 格式：flat [r,g,b]|null）──────────
console.log('\n— silhouettePixels —');
const pix = { width: 2, height: 2, frames: [[ [10,20,30], null, [200,100,50], null ]] };
const sp = silhouettePixels(pix);
ok(sp.width === 2 && sp.height === 2, '尺寸欄位應保留');
ok(JSON.stringify(sp.frames[0][0]) === JSON.stringify(SHADE), '有色像素應變 shade');
ok(sp.frames[0][1] === null && sp.frames[0][3] === null, 'null 像素應維持 null');
ok(sp !== pix && sp.frames[0] !== pix.frames[0], '應回傳新物件');

// ── 5. Shadow 角色資產（gen-shadow 產出）──────────────────────────
console.log('\n— Shadow 角色檔案 —');
const shadowDir = path.join(__dirname, '..', 'characters', 'Shadow');
for (const f of ['pixels.json', 'art.json', 'cutin-art.json', 'config.json']) {
    ok(fs.existsSync(path.join(shadowDir, f)), `Shadow/${f} 應存在`);
}
if (fs.existsSync(path.join(shadowDir, 'art.json'))) {
    const sArt = JSON.parse(fs.readFileSync(path.join(shadowDir, 'art.json'), 'utf8'));
    let allShade = true;
    for (const fr of sArt.frames) for (const row of fr) for (const c of row) if (!cellOkShade(c)) { allShade = false; break; }
    ok(allShade, 'Shadow art 全為 shade 或透明');
    console.log(`  Shadow art ${sArt.frames.length} 幀，全 shade ✓`);
}
const sCfg = JSON.parse(fs.readFileSync(path.join(shadowDir, 'config.json'), 'utf8'));
ok(sCfg.name === 'shadow' && Array.isArray(sCfg.evolvesTo) && sCfg.evolvesTo.length === 0, 'config name=shadow 且不進化');

console.log(`\n結果：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
