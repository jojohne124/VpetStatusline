const fs = require('fs');
const path = require('path');

// 把「目前專案根目錄」的像素 JSON 複製到 packaged/assets（不改原檔）
// 用途：讓打包版預設就帶你已調好的像素資料，接著可用 packaged/tooling editor 再微調。

const repoRoot = path.join(__dirname, '..', '..');
const src = path.join(repoRoot, 'agumon_pixels_color.json');

const assetsDir = path.join(__dirname, '..', 'assets');
const dst = path.join(assetsDir, 'agumon_pixels_color.json');

if (!fs.existsSync(src)) {
  console.error(`找不到來源檔：${src}`);
  process.exit(1);
}

fs.mkdirSync(assetsDir, { recursive: true });
fs.copyFileSync(src, dst);

console.log(`✓ 已複製到：${dst}`);
console.log('接著請執行：node color_convert_to_cells.js（重生 agumon_art_color.json）');

