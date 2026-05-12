const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const TARGET_SIZE  = 16;
const SPRITE_COUNT = 12;

const IN_PNG = path.join(__dirname, 'input', 'agumon_pixel_color.png');
const OUT_JSON = path.join(__dirname, '..', 'assets', 'agumon_pixels_color.json');

function isBgColor(r, g, b) {
  if (r > 220 && g < 90 && b > 220) return true; // 粉紅
  const avg = (r + g + b) / 3;
  if (avg > 195 && Math.abs(r - g) < 15 && Math.abs(g - b) < 15 && Math.abs(r - b) < 15) return true; // 灰/白
  return false;
}

function buildBgMask(rgba, w, h) {
  const mask = new Uint8Array(w * h);
  const visited = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const idx = y * w + x;
    if (visited[idx]) return;
    stack.push(x, y);
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    const idx = y * w + x;
    if (visited[idx]) continue;
    visited[idx] = 1;
    const i = idx * 4;
    if (!isBgColor(rgba[i], rgba[i + 1], rgba[i + 2])) continue;
    mask[idx] = 1;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  return mask;
}

async function main() {
  if (!fs.existsSync(IN_PNG)) {
    console.error(`找不到輸入檔：${IN_PNG}`);
    console.error('請把彩色原圖放到 packaged/tooling/input/agumon_pixel_color.png');
    process.exit(1);
  }

  const metadata = await sharp(IN_PNG).metadata();
  console.log(`原始圖片: ${metadata.width}×${metadata.height}`);

  const frameWidth = Math.floor(metadata.width / SPRITE_COUNT);
  const frameHeight = metadata.height;
  console.log(`每幀原始: ${frameWidth}×${frameHeight} → ${TARGET_SIZE}×${TARGET_SIZE}`);

  async function extractFrame(index) {
    const left = index * frameWidth;
    const safeWidth = Math.min(frameWidth, metadata.width - left);

    const { data: fullData, info } = await sharp(IN_PNG)
      .extract({ left, top: 0, width: safeWidth, height: frameHeight })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const fw = info.width, fh = info.height;
    const rgba = Buffer.alloc(fw * fh * 4);
    for (let i = 0; i < fw * fh; i++) {
      rgba[i * 4]     = fullData[i * 3];
      rgba[i * 4 + 1] = fullData[i * 3 + 1];
      rgba[i * 4 + 2] = fullData[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    }
    const bgMask = buildBgMask(rgba, fw, fh);

    const OUTLINE_MAX = 150;
    const HIGHLIGHT_MIN = 600;
    const pixels = [];
    for (let oy = 0; oy < TARGET_SIZE; oy++) {
      for (let ox = 0; ox < TARGET_SIZE; ox++) {
        const sx = Math.floor((ox + 0.5) * fw / TARGET_SIZE);
        const sy = Math.floor((oy + 0.5) * fh / TARGET_SIZE);
        const si = sy * fw + sx;
        if (bgMask[si]) { pixels.push(null); continue; }

        const cR = rgba[si * 4], cG = rgba[si * 4 + 1], cB = rgba[si * 4 + 2];
        const centerIsOutline = (cR + cG + cB) < OUTLINE_MAX;

        const x0 = Math.floor(ox * fw / TARGET_SIZE);
        const x1 = Math.max(x0 + 1, Math.floor((ox + 1) * fw / TARGET_SIZE));
        const y0 = Math.floor(oy * fh / TARGET_SIZE);
        const y1 = Math.max(y0 + 1, Math.floor((oy + 1) * fh / TARGET_SIZE));

        let outlineN = 0, highlightN = 0;
        const fillCounts = new Map();
        let fillMode = null, fillModeN = 0;
        let darkest = [cR, cG, cB], darkestSum = cR + cG + cB;
        let brightest = [cR, cG, cB], brightestSum = cR + cG + cB;

        for (let sy2 = y0; sy2 < y1 && sy2 < fh; sy2++) {
          for (let sx2 = x0; sx2 < x1 && sx2 < fw; sx2++) {
            const i = sy2 * fw + sx2;
            if (bgMask[i]) continue;
            const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
            const sum = r + g + b;
            if (sum < OUTLINE_MAX) {
              outlineN++;
              if (sum < darkestSum) { darkestSum = sum; darkest = [r, g, b]; }
            } else {
              if (sum > HIGHLIGHT_MIN) {
                highlightN++;
                if (sum > brightestSum) { brightestSum = sum; brightest = [r, g, b]; }
              }
              const key = `${r},${g},${b}`;
              const c = (fillCounts.get(key) || 0) + 1;
              fillCounts.set(key, c);
              if (c > fillModeN) { fillModeN = c; fillMode = [r, g, b]; }
            }
          }
        }

        const fillN = fillModeN > 0 ? Array.from(fillCounts.values()).reduce((a, b) => a + b, 0) : 0;
        const totalFg = outlineN + fillN;
        const outlineRatio = totalFg > 0 ? outlineN / totalFg : 0;
        const highlightRatio = totalFg > 0 ? highlightN / totalFg : 0;

        const isOutlineFeature = outlineRatio >= 0.65 && outlineN >= 2;
        const isHighlight = highlightN > 0 && (highlightRatio >= 0.12 || highlightN >= 2);

        if (isOutlineFeature) pixels.push(darkest);
        else if (isHighlight) pixels.push(brightest);
        else if (fillMode) pixels.push(!centerIsOutline ? [cR, cG, cB] : fillMode);
        else pixels.push(darkest);
      }
    }

    const OUTLINE_COLOR = [0, 0, 0];
    function addOutline(px, w, h, outlineColor) {
      const out = px.slice();
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!px[i]) continue;
        const nb = [
          y > 0     ? px[(y - 1) * w + x] : null,
          y < h - 1 ? px[(y + 1) * w + x] : null,
          x > 0     ? px[y * w + x - 1] : null,
          x < w - 1 ? px[y * w + x + 1] : null,
        ];
        if (nb.some(v => !v)) out[i] = outlineColor;
      }
      return out;
    }

    return addOutline(pixels, TARGET_SIZE, TARGET_SIZE, OUTLINE_COLOR);
  }

  const frames = [];
  for (let i = 0; i < SPRITE_COUNT; i++) {
    frames.push(await extractFrame(i));
    process.stdout.write(`\r提取 ${i + 1}/${SPRITE_COUNT}`);
  }
  console.log('\n');

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify({ frames, width: TARGET_SIZE, height: TARGET_SIZE }));
  console.log(`完成 → ${OUT_JSON}`);
  console.log('接著執行：node color_convert_to_cells.js');
}

main().catch(err => {
  console.error('錯誤:', err.message);
  process.exit(1);
});

