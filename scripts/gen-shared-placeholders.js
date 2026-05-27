#!/usr/bin/env node
'use strict';
/**
 * gen-shared-placeholders.js
 *
 * 產生共用 sprite 的 placeholder 點陣資料，輸出：
 *   shared/manifest.json   — 命名表（sprite name -> frame indices）
 *   shared/sprites.json    — 全部 frame 的 pixel 資料（W×H array of [r,g,b] | null）
 *   shared/art.json        — 對應 half-block cell 資料（給 statusline 渲染用）
 *
 * 多幀動畫支援：
 *   encounter — 紅色驚嘆號（遇敵）；encounter1 → encounter2 → encounter1
 *   boom      — 黃橘色星爆（爆炸）；boom1 → boom2 → boom1
 *
 * 未來要美術圖時，可在 shared/sprites/ 放 PNG 並改用 char-cli 處理。
 */
const fs   = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR   = path.join(REPO_ROOT, 'shared');
const SIZE      = 16;

const COLORS = {
  '.': null,
  'R': [220,  40,  40],   // 紅
  'r': [180,  30,  30],   // 暗紅
  'Y': [255, 220,  80],   // 黃
  'O': [255, 140,  40],   // 橘
  'W': [255, 255, 255],   // 白
  'K': [  0,   0,   0],   // 黑
  'C': [ 80, 220, 240],   // 青（DNA strand A）
  'M': [220,  90, 200],   // 洋紅（DNA strand B）
  'G': [205, 215, 225],   // 淺灰（雲身）
  'g': [130, 140, 155],   // 深灰（雲底陰影）
  'L': [170, 210, 255],   // 淺天藍（睡覺 Z）
};

// 16x16 紅色驚嘆號（encounter1）
const ENCOUNTER1 = [
  '................',
  '................',
  '.....rRRRRr.....',
  '.....RRRRRR.....',
  '.....RRRRRR.....',
  '.....RRRRRR.....',
  '.....rRRRRr.....',
  '......RRRR......',
  '......RRRR......',
  '.......RR.......',
  '................',
  '................',
  '......RRRR......',
  '.....rRRRRr.....',
  '......RRRR......',
  '................',
];

// 16x16 鼓脹版驚嘆號（encounter2）
const ENCOUNTER2 = [
  '................',
  '....rRRRRRRr....',
  '....RRRRRRRR....',
  '...RRRRRRRRRR...',
  '...RRRRRRRRRR...',
  '...RRRRRRRRRR...',
  '....RRRRRRRR....',
  '....rRRRRRRr....',
  '.....RRRRRR.....',
  '......RRRR......',
  '................',
  '................',
  '.....RRRRRR.....',
  '....rRRRRRRr....',
  '.....RRRRRR.....',
  '................',
];

// 16x16 黃橘星爆（boom1）
const BOOM1 = [
  '................',
  '....Y..Y..Y.....',
  '.....Y.Y.Y......',
  'Y.....OYO.....Y.',
  '.Y...OOOOO...Y..',
  '..YOOOOOOOOOY...',
  '...OOYYYYYOO....',
  '..OOYYOOOYYOO...',
  '..OOYOOOOOYOO...',
  '..OOYYOOOYYOO...',
  '...OOYYYYYOO....',
  '..YOOOOOOOOOY...',
  '.Y...OOOOO...Y..',
  'Y.....OYO.....Y.',
  '.....Y.Y.Y......',
  '....Y..Y..Y.....',
];

// 16x16 放大爆炸版（boom2）
const BOOM2 = [
  'Y..Y........Y..Y',
  '................',
  '..Y..........Y..',
  '.YYY..YYYY..YYY.',
  'YY..OOYYYYOO..YY',
  'Y.OOYYYYYYYYOO.Y',
  'YYOO........OOYY',
  'YOOO........OOOY',
  'YOOO........OOOY',
  'YYOO........OOYY',
  'Y.OOYYYYYYYYOO.Y',
  'YY..OOYYYYOO..YY',
  '.YYY..YYYY..YYY.',
  '..Y..........Y..',
  '................',
  'Y..Y........Y..Y',
];

// 16x16 DNA 雙股螺旋 — 進化表演用
// dna1: 三段稀疏螺旋（build-up）
const DNA1 = [
  '................',
  '.C............M.',
  '..C..........M..',
  '...C........M...',
  '................',
  '................',
  '......C..M......',
  '.......CM.......',
  '.......MC.......',
  '......M..C......',
  '................',
  '................',
  '...M........C...',
  '..M..........C..',
  '.M............C.',
  '................',
];

// dna2: 完整 X 型雙股交叉（intensify）
const DNA2 = [
  '.C............M.',
  '..C..........M..',
  '...C........M...',
  '....C......M....',
  '.....C....M.....',
  '......C..M......',
  '.......CM.......',
  '.......MC.......',
  '.......MC.......',
  '......M..C......',
  '.....M....C.....',
  '....M......C....',
  '...M........C...',
  '..M..........C..',
  '.M............C.',
  'M..............C',
];

// dna3: 密集條紋光繭（peak，角色被包住）
const DNA3 = [
  '.C..M..C..M..C..',
  '..C..M..C..M..C.',
  'M..C..M..C..M..C',
  '.M..C..M..C..M..',
  '..M..C..M..C..M.',
  'C..M..C..M..C..M',
  '.C..M..C..M..C..',
  '..C..M..C..M..C.',
  'M..C..M..C..M..C',
  '.M..C..M..C..M..',
  '..M..C..M..C..M.',
  'C..M..C..M..C..M',
  '.C..M..C..M..C..',
  '..C..M..C..M..C.',
  'M..C..M..C..M..C',
  '.M..C..M..C..M..',
];

// 16x16 dna_end1 光繭密集包覆（角色隱形）
const DNA_END1 = [
  '.....C.M.C.M....',
  '..M.C.M.C.M.C...',
  '.M.C.M.C.M.C.M..',
  '..C.M.C.M.C.M.C.',
  '.C.M.C.M.C.M.C.M',
  'C.M.C.M.C.M.C.M.',
  '.M.C.M.C.M.C.M.C',
  'M.C.M.C.M.C.M.C.',
  '.C.M.C.M.C.M.C.M',
  'C.M.C.M.C.M.C.M.',
  '.M.C.M.C.M.C.M.C',
  'M.C.M.C.M.C.M.C.',
  '.C.M.C.M.C.M.C..',
  '..M.C.M.C.M.C.M.',
  '...C.M.C.M.C.M..',
  '....M.C.M.C.....',
];

// 16x16 dna_end2 光繭破裂（碎片飛散）
const DNA_END2 = [
  'C............M..',
  '..M..C.........C',
  '.C..M...........',
  '..........C.M..C',
  '...........M.C..',
  '............C.M.',
  '.M...........M..',
  'M.C.........M.C.',
  '.C.M...M.....C.M',
  'C.M...M...M...M.',
  '.M...M...M.C...C',
  'M.C...C...C...C.',
  '.C.M...M.C...C..',
  '..M.C.M.C...C.M.',
  '...C.M.C.M.C.M..',
  '....M.C.M.C.....',
];

// 16x16 小太陽（戰勝特效）— 畫在上半部，置中偏上，core 黃 + 橘邊 + 八方光芒
const SUN = [
  '................',
  '.......YY.......',
  '..Y....YY....Y..',
  '....OOYYYYOO....',
  '....OYYYYYYO....',
  '.YY.YYYYYYYY.YY.',
  '....OYYYYYYO....',
  '....OOYYYYOO....',
  '..Y....YY....Y..',
  '.......YY.......',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
];

// 16x16 小烏雲（戰敗特效）— 畫在上半部，淺灰雲身 + 深灰雲底
const CLOUD = [
  '................',
  '................',
  '.......GG.......',
  '.....GGGGGG.....',
  '...GGGGGGGGGG...',
  '..GGGGGGGGGGGG..',
  '.GGGGGGGGGGGGGG.',
  '.gggggggggggggg.',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
];

// 16x16 睡覺 Z（sleep_1 對應）— 內容靠左上（渲染時整張貼到角色右側）
const ZSLEEP1 = [
  '.LLLLL..........',
  '.....L..........',
  '....L...........',
  '...L............',
  '..L.............',
  '.LLLLL..........',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
];

// 16x16 睡覺 zZ（sleep_2 對應）— 小 z 疊大 Z（內容靠左上）
const ZSLEEP2 = [
  '..LLLL..........',
  '....L...........',
  '...L............',
  '..LLLL..........',
  '.LLLLL..........',
  '.....L..........',
  '....L...........',
  '...L............',
  '.LLLLL..........',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
];

// 平鋪到 art.frames 的順序（決定 art.frames[i] 對應哪個模板）
// 功能相近的 sprite 放一起，方便在 editor 內切換
const FRAME_TEMPLATES = [
  { id: 'encounter1', template: ENCOUNTER1 },
  { id: 'encounter2', template: ENCOUNTER2 },
  { id: 'boom1',      template: BOOM1      },
  { id: 'boom2',      template: BOOM2      },
  { id: 'dna1',       template: DNA1       },
  { id: 'dna2',       template: DNA2       },
  { id: 'dna3',       template: DNA3       },
  { id: 'dna_end1',   template: DNA_END1   },
  { id: 'dna_end2',   template: DNA_END2   },
  { id: 'sun',        template: SUN        },
  { id: 'cloud',      template: CLOUD      },
  { id: 'zsleep1',    template: ZSLEEP1    },
  { id: 'zsleep2',    template: ZSLEEP2    },
];

// sprite 名稱 -> 動畫序列（id 序列）
const SPRITE_SEQUENCES = {
  encounter: ['encounter1', 'encounter2', 'encounter1'],
  boom:      ['boom1',      'boom2',     'boom1'],
  dna:       ['dna1',       'dna2',      'dna3'],
  dna_end1:  ['dna_end1'],
  dna_end2:  ['dna_end2'],
  sun:       ['sun'],
  cloud:     ['cloud'],
  zsleep1:   ['zsleep1'],
  zsleep2:   ['zsleep2'],
};

function rasterize(rows) {
  if (rows.length !== SIZE) throw new Error(`row count ${rows.length} != ${SIZE}`);
  const pixels = [];
  for (let y = 0; y < SIZE; y++) {
    if (rows[y].length !== SIZE) throw new Error(`row ${y} length ${rows[y].length} != ${SIZE}`);
    for (let x = 0; x < SIZE; x++) {
      const ch = rows[y][x];
      if (!(ch in COLORS)) throw new Error(`unknown char "${ch}" at (${x},${y})`);
      pixels.push(COLORS[ch]);
    }
  }
  return pixels;
}

function pixelsToArt(pixels, w, h) {
  const rows = [];
  for (let y = 0; y < h; y += 2) {
    const row = [];
    for (let x = 0; x < w; x++) {
      const up = pixels[y * w + x] || null;
      const lo = pixels[(y + 1) * w + x] || null;
      if (!up && !lo) { row.push(null); continue; }
      row.push([
        up ? up[0] : -1, up ? up[1] : -1, up ? up[2] : -1,
        lo ? lo[0] : -1, lo ? lo[1] : -1, lo ? lo[2] : -1,
      ]);
    }
    rows.push(row);
  }
  return rows;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const pixelFrames = [];
  const artFrames   = [];
  const idToIndex   = {};

  for (const spec of FRAME_TEMPLATES) {
    const px  = rasterize(spec.template);
    const art = pixelsToArt(px, SIZE, SIZE);
    idToIndex[spec.id] = pixelFrames.length;
    pixelFrames.push(px);
    artFrames.push(art);
    console.log(`  [frame ${idToIndex[spec.id]}] ${spec.id}`);
  }

  const manifest = { version: 1, sprites: {} };
  for (const [name, seq] of Object.entries(SPRITE_SEQUENCES)) {
    const indices = seq.map(id => {
      if (!(id in idToIndex)) throw new Error(`sprite "${name}" references unknown frame "${id}"`);
      return idToIndex[id];
    });
    manifest.sprites[name] = {
      indices,
      frames: indices.length,
      size:   SIZE,
    };
    console.log(`  [${name}] indices=${JSON.stringify(indices)}`);
  }

  const spritesJson = { width: SIZE, height: SIZE, frames: pixelFrames };
  const artJson     = { style: 'color-halfblock', width: SIZE, height: SIZE / 2, frames: artFrames };

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'sprites.json'),  JSON.stringify(spritesJson));
  fs.writeFileSync(path.join(OUT_DIR, 'art.json'),      JSON.stringify(artJson));

  console.log(`\n  寫入 ${path.relative(REPO_ROOT, path.join(OUT_DIR, 'manifest.json'))}`);
  console.log(`  寫入 ${path.relative(REPO_ROOT, path.join(OUT_DIR, 'sprites.json'))}`);
  console.log(`  寫入 ${path.relative(REPO_ROOT, path.join(OUT_DIR, 'art.json'))}`);
  console.log(`\n完成。sprite：${Object.keys(SPRITE_SEQUENCES).join(', ')}`);
}

if (require.main === module) main();
