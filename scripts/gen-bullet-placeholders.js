#!/usr/bin/env node
'use strict';
/**
 * gen-bullet-placeholders.js
 *
 * 為 characters/ 下每個角色產生暫代子彈資產：
 *   characters/<Name>/bullet.json        — 16×16 pixel data（單幀）
 *   characters/<Name>/bullet-art.json    — 對應 half-block cell 資料
 *
 * 暫代圖為白球 + 左側拖尾（指向「右」，敵方靠 flipRows 翻成指向左）。
 * 已存在的 bullet-art.json 預設保留不覆寫；加 --force 才強制覆寫。
 */
const fs   = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const CHARS_DIR = path.join(REPO_ROOT, 'characters');
const SIZE      = 16;
const FORCE     = process.argv.includes('--force');

const COLORS = {
  '.': null,
  'W': [255, 255, 255],
  'g': [120, 120, 120],
};

// 16x16 白球 + 左側拖尾，朝右
const BULLET = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '......WWWW......',
  '.....WWWWWW.....',
  '...ggWWWWWWWW...',
  '...ggWWWWWWWW...',
  '.....WWWWWW.....',
  '......WWWW......',
  '................',
  '................',
  '................',
  '................',
  '................',
];

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
  if (!fs.existsSync(CHARS_DIR)) {
    console.error(`找不到 ${CHARS_DIR}`);
    process.exit(1);
  }

  const px  = rasterize(BULLET);
  const art = pixelsToArt(px, SIZE, SIZE);

  const bulletJson = { frames: [px], width: SIZE, height: SIZE };
  const bulletArt  = { style: 'color-halfblock', width: SIZE, height: SIZE / 2, frames: [art] };

  let created = 0, skipped = 0;
  for (const entry of fs.readdirSync(CHARS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(CHARS_DIR, entry.name);
    const bulletPath    = path.join(dir, 'bullet.json');
    const bulletArtPath = path.join(dir, 'bullet-art.json');

    if (!FORCE && fs.existsSync(bulletArtPath)) {
      console.log(`  [skip] ${entry.name}: bullet-art.json 已存在`);
      skipped++;
      continue;
    }
    fs.writeFileSync(bulletPath,    JSON.stringify(bulletJson));
    fs.writeFileSync(bulletArtPath, JSON.stringify(bulletArt));
    console.log(`  [write] ${entry.name}/bullet.json + bullet-art.json`);
    created++;
  }

  console.log(`\n完成。寫入 ${created} 個角色，跳過 ${skipped} 個（用 --force 可強制覆寫）。`);
}

if (require.main === module) main();
