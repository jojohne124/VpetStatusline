#!/usr/bin/env node
'use strict';
/**
 * gen-shadow.js — 產生 Shadow（黑影）角色的 placeholder 資產：把 agumon 各檔塗黑。
 *
 * Shadow 是「對手角色本機沒有」時的 fallback 演出角色（幽靈對戰主題）。
 * 用法：node scripts/gen-shadow.js
 *
 * 產出 characters/Shadow/：
 *   - pixels.json    （body 中介檔，editor 角色模式吃這個 → 可編輯）
 *   - art.json       （body 終端 cell，12 幀；戰鬥只用 IDLE_1/ANGRY/ATTACK）
 *   - cutin-art.json （cut-in，editor cut-in 模式可編）
 *   - bullet.json / bullet-art.json（子彈）
 *   - config.json    （沿用 agumon 的 frames/layout，name=shadow，不進化、不進 roster）
 *
 * Shadow 不放進 roster.json → 不會被當隨機/自動對手抽到，只在 fallback 被明確 load。
 * 之後在 editor 編輯這 4 個關鍵幀（IDLE_1/ANGRY/ATTACK + cut-in）即可換成自訂造型。
 */
const fs   = require('fs');
const path = require('path');
const core = require('../src/runtime/agumon-core.js');

const CHARS = path.join(__dirname, '..', 'characters');
const SRC   = path.join(CHARS, 'Agumon');
const DST   = path.join(CHARS, 'Shadow');

const readJSON  = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJSON = (p, o) => fs.writeFileSync(p, JSON.stringify(o));

fs.mkdirSync(DST, { recursive: true });

// 1. pixels.json（body 中介，可編輯）→ silhouettePixels
writeJSON(path.join(DST, 'pixels.json'), core.silhouettePixels(readJSON(path.join(SRC, 'pixels.json'))));

// 2. art.json（body cell）→ silhouetteArt
writeJSON(path.join(DST, 'art.json'), core.silhouetteArt(readJSON(path.join(SRC, 'art.json'))));

// 3. cutin-art.json（cut-in cell）→ silhouetteArt
writeJSON(path.join(DST, 'cutin-art.json'), core.silhouetteArt(readJSON(path.join(SRC, 'cutin-art.json'))));

// 4. bullet：bullet.json（中介）+ bullet-art.json（cell）
if (fs.existsSync(path.join(SRC, 'bullet.json')))
    writeJSON(path.join(DST, 'bullet.json'), core.silhouettePixels(readJSON(path.join(SRC, 'bullet.json'))));
writeJSON(path.join(DST, 'bullet-art.json'), core.silhouetteArt(readJSON(path.join(SRC, 'bullet-art.json'))));

// 5. config.json：沿用 agumon 的 frames/layout（戰鬥用同一套索引），改名、清進化
const cfg = readJSON(path.join(SRC, 'config.json'));
cfg.name      = 'shadow';
cfg.power     = 0;          // 純視覺 fallback，PvP 勝負用卡片數據、與此無關
cfg.stage     = 'UnStage';  // 不參與同階配對（也不在 roster，雙重保險）
cfg.evolvesTo = [];
writeJSON(path.join(DST, 'config.json'), cfg);

console.log('✓ Shadow 角色已生成於 characters/Shadow/（塗黑 agumon）');
console.log('  檔案：' + fs.readdirSync(DST).join(', '));
console.log('  下一步：npm run install-runtime 部署；之後可在 editor 編輯 IDLE_1/ANGRY/ATTACK + cut-in');
