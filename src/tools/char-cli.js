#!/usr/bin/env node
'use strict';
const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CHARS_DIR = path.join(REPO_ROOT, 'characters');

function charDir(name) { return path.join(CHARS_DIR, name); }

function loadConfig(name) {
  const p = path.join(charDir(name), 'config.json');
  if (!fs.existsSync(p)) { console.error(`找不到設定：${p}`); process.exit(1); }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ── prepare: sprite.png → pixels.json ────────────────────────────
async function cmdPrepare(name) {
  const sharp  = require('sharp');
  const config = loadConfig(name);
  const dir    = charDir(name);
  const imgPath = path.join(dir, 'sprite.png');
  const outPath = path.join(dir, 'pixels.json');

  const SPRITE_COUNT = config.frameCount;
  const TARGET_SIZE  = config.targetSize || 16;
  const DIRECT_SAMPLE      = config.directSample         ?? false;
  const PALETTE_SIZE       = config.paletteSize          || 20;
  const OUTLINE_MAX        = config.outlineMax           || 150;
  const PALETTE_MAX_BRIGHT = config.paletteMaxBrightness ?? 580;
  const BUCKET_STEP        = config.bucketStep           || 24;

  function isBgColor(r, g, b) {
    if (r > 220 && g < 90 && b > 220) return true;
    const avg = (r + g + b) / 3;
    return avg > 195 && Math.abs(r-g) < 15 && Math.abs(g-b) < 15 && Math.abs(r-b) < 15;
  }

  function buildBgMask(rgba, w, h) {
    const mask = new Uint8Array(w * h), visited = new Uint8Array(w * h), stack = [];
    const push = (x, y) => {
      if (x < 0 || x >= w || y < 0 || y >= h || visited[y * w + x]) return;
      stack.push(x, y);
    };
    for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
    while (stack.length) {
      const y = stack.pop(), x = stack.pop(), idx = y * w + x;
      if (visited[idx]) continue;
      visited[idx] = 1;
      const i = idx * 4;
      if (!isBgColor(rgba[i], rgba[i+1], rgba[i+2])) continue;
      mask[idx] = 1;
      push(x+1, y); push(x-1, y); push(x, y+1); push(x, y-1);
    }
    return mask;
  }

  // snap RGB to nearest palette entry (Euclidean distance)
  function snapColor(r, g, b, palette) {
    let best = palette[0], bestD = Infinity;
    for (const c of palette) {
      const d = (r-c[0])**2 + (g-c[1])**2 + (b-c[2])**2;
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  const LAYOUT     = config.layout    || 'strip';   // 'strip' | 'grid' | 'individual'
  const GRID_COLS  = config.gridCols  || 3;
  const TRANSPARENT_COLOR = config.transparentColor || null; // e.g. [255, 0, 255]

  // 指定透明色的 mask（不用 alpha 也不用 flood-fill）
  function buildColorMask(rgba, w, h, tc, tol = 8) {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const r=rgba[i*4], g=rgba[i*4+1], b=rgba[i*4+2];
      if (Math.abs(r-tc[0])<=tol && Math.abs(g-tc[1])<=tol && Math.abs(b-tc[2])<=tol)
        mask[i] = 1;
    }
    return mask;
  }

  function makeBgMask(rgba, fw, fh, hasAlpha) {
    if (TRANSPARENT_COLOR) return buildColorMask(rgba, fw, fh, TRANSPARENT_COLOR);
    if (hasAlpha) { const m=new Uint8Array(fw*fh); for(let i=0;i<fw*fh;i++) m[i]=rgba[i*4+3]<128?1:0; return m; }
    return buildBgMask(rgba, fw, fh);
  }

  // ── 載入各幀 buffer ──────────────────────────────────────────────
  const frameBuffers = [];
  let frameWidth, frameHeight;

  if (LAYOUT === 'individual') {
    // 每幀獨立檔案，命名：<index>_<frameName>.png
    const firstFile = fs.readdirSync(dir).find(f => f.endsWith('.png'));
    if (!firstFile) { console.error(`找不到 PNG 檔案：${dir}`); process.exit(1); }
    const first = await sharp(path.join(dir, firstFile)).metadata();
    frameWidth = first.width; frameHeight = first.height;
    console.log(`[${name}] individual，${SPRITE_COUNT} 幀，每幀 ${frameWidth}×${frameHeight} → ${TARGET_SIZE}×${TARGET_SIZE}`);
    for (let fi = 0; fi < SPRITE_COUNT; fi++) {
      const prefix = fi.toString().padStart(2, '0');
      const fname  = config.frameNames[fi];
      const fpath  = fs.existsSync(path.join(dir, `${prefix}_${fname}.png`))
        ? path.join(dir, `${prefix}_${fname}.png`)
        : path.join(dir, `${fname}.png`);
      if (!fs.existsSync(fpath)) { console.error(`找不到：${fpath}`); process.exit(1); }
      const { data, info } = await sharp(fpath).raw().toBuffer({ resolveWithObject: true });
      const fw = info.width, fh = info.height;
      const ch = info.channels;
      const rgba = Buffer.alloc(fw * fh * 4);
      for (let i = 0; i < fw * fh; i++) {
        rgba[i*4]=data[i*ch]; rgba[i*4+1]=data[i*ch+1]; rgba[i*4+2]=data[i*ch+2];
        rgba[i*4+3] = ch === 4 ? data[i*ch+3] : 255;
      }
      frameBuffers.push({ rgba, fw, fh, bgMask: makeBgMask(rgba, fw, fh, info.channels===4) });
      process.stdout.write(`\r載入 ${fi+1}/${SPRITE_COUNT}`);
    }
    console.log('');
  } else if (LAYOUT === 'strip' && TRANSPARENT_COLOR) {
    // strip + 指定透明色：掃描全粉紅直行自動找幀邊界，解決不整除問題
    const { data: fd, info: fi2 } = await sharp(imgPath).raw().toBuffer({ resolveWithObject: true });
    const IW = fi2.width, IH = fi2.height, ICH = fi2.channels;
    frameHeight = IH;
    // 建全圖 RGBA buffer + color mask
    const fullRgba = Buffer.alloc(IW * IH * 4);
    for (let i = 0; i < IW * IH; i++) {
      fullRgba[i*4]=fd[i*ICH]; fullRgba[i*4+1]=fd[i*ICH+1]; fullRgba[i*4+2]=fd[i*ICH+2];
      fullRgba[i*4+3] = ICH === 4 ? fd[i*ICH+3] : 255;
    }
    const fullMask = buildColorMask(fullRgba, IW, IH, TRANSPARENT_COLOR);
    // 找全粉紅直行
    const pinkSet = new Set();
    for (let x = 0; x < IW; x++) {
      let all = true;
      for (let y = 0; y < IH; y++) { if (!fullMask[y * IW + x]) { all = false; break; } }
      if (all) pinkSet.add(x);
    }
    // 找內容區段（忽略寬度 < TARGET_SIZE 的雜訊小區段）
    const ranges = [];
    let inC = false, rs = 0;
    for (let x = 0; x <= IW; x++) {
      if (!pinkSet.has(x) && !inC) { inC = true; rs = x; }
      else if ((pinkSet.has(x) || x === IW) && inC) {
        if (x - 1 - rs + 1 >= TARGET_SIZE) ranges.push([rs, x - 1]);
        inC = false;
      }
    }
    if (ranges.length !== SPRITE_COUNT) {
      console.warn(`警告：偵測到 ${ranges.length} 幀區域，期望 ${SPRITE_COUNT}，回退等寬切割`);
      frameWidth = Math.floor(IW / SPRITE_COUNT);
      for (let i = 0; i < SPRITE_COUNT; i++) {
        const { data, info } = await sharp(imgPath).extract({ left: i*frameWidth, top: 0, width: frameWidth, height: IH }).raw().toBuffer({ resolveWithObject: true });
        const ch = info.channels, fw = info.width, fh = info.height;
        const rgba = Buffer.alloc(fw * fh * 4);
        for (let j = 0; j < fw * fh; j++) { rgba[j*4]=data[j*ch]; rgba[j*4+1]=data[j*ch+1]; rgba[j*4+2]=data[j*ch+2]; rgba[j*4+3]=ch===4?data[j*ch+3]:255; }
        frameBuffers.push({ rgba, fw, fh, bgMask: buildColorMask(rgba, fw, fh, TRANSPARENT_COLOR) });
      }
    } else {
      for (let i = 0; i < SPRITE_COUNT; i++) {
        const [x0, x1] = ranges[i];
        const fw = x1 - x0 + 1;
        const { data, info } = await sharp(imgPath).extract({ left: x0, top: 0, width: fw, height: IH }).raw().toBuffer({ resolveWithObject: true });
        const ch = info.channels;
        const rgba = Buffer.alloc(fw * IH * 4);
        for (let j = 0; j < fw * IH; j++) { rgba[j*4]=data[j*ch]; rgba[j*4+1]=data[j*ch+1]; rgba[j*4+2]=data[j*ch+2]; rgba[j*4+3]=ch===4?data[j*ch+3]:255; }
        frameBuffers.push({ rgba, fw, fh: IH, bgMask: buildColorMask(rgba, fw, IH, TRANSPARENT_COLOR) });
      }
      frameWidth = ranges[0][1] - ranges[0][0] + 1;
      console.log(`[${name}] ${IW}×${IH}，strip 自動幀界：${SPRITE_COUNT} 幀，幀寬 ~${frameWidth}px → ${TARGET_SIZE}×${TARGET_SIZE}`);
    }
  } else {
    const metadata  = await sharp(imgPath).metadata();
    const GRID_ROWS = LAYOUT === 'grid' ? Math.ceil(SPRITE_COUNT / GRID_COLS) : 1;
    frameWidth  = LAYOUT === 'grid' ? Math.floor(metadata.width / GRID_COLS)   : Math.floor(metadata.width / SPRITE_COUNT);
    frameHeight = LAYOUT === 'grid' ? Math.floor(metadata.height / GRID_ROWS)  : metadata.height;
    console.log(`[${name}] ${metadata.width}×${metadata.height}，${SPRITE_COUNT} 幀 → ${TARGET_SIZE}×${TARGET_SIZE} (layout=${LAYOUT}${LAYOUT==='grid'?` ${GRID_COLS}x${GRID_ROWS}`:''})`);
    const hasAlpha = metadata.channels === 4 || metadata.hasAlpha;
    for (let fi = 0; fi < SPRITE_COUNT; fi++) {
      const col  = LAYOUT === 'grid' ? fi % GRID_COLS : fi;
      const row  = LAYOUT === 'grid' ? Math.floor(fi / GRID_COLS) : 0;
      const { data, info } = await sharp(imgPath)
        .extract({ left: col*frameWidth, top: row*frameHeight, width: frameWidth, height: frameHeight })
        .raw().toBuffer({ resolveWithObject: true });
      const fw = info.width, fh = info.height, ch = info.channels;
      const rgba = Buffer.alloc(fw * fh * 4);
      for (let i = 0; i < fw * fh; i++) {
        rgba[i*4]=data[i*ch]; rgba[i*4+1]=data[i*ch+1]; rgba[i*4+2]=data[i*ch+2];
        rgba[i*4+3] = ch === 4 ? data[i*ch+3] : 255;
      }
      frameBuffers.push({ rgba, fw, fh, bgMask: makeBgMask(rgba, fw, fh, hasAlpha) });
    }
  }

  // Pass 1: build global palette from all frames using bucketed frequency
  const bucketCounts = new Map();
  for (const { rgba, fw, fh, bgMask } of frameBuffers) {
    for (let i = 0; i < fw * fh; i++) {
      if (bgMask[i]) continue;
      const r=rgba[i*4], g=rgba[i*4+1], b=rgba[i*4+2];
      if (r+g+b < OUTLINE_MAX) continue; // skip outline pixels from palette
      if (r+g+b > PALETTE_MAX_BRIGHT) continue; // skip near-white pixels from palette
      const qr=Math.round(r/BUCKET_STEP)*BUCKET_STEP;
      const qg=Math.round(g/BUCKET_STEP)*BUCKET_STEP;
      const qb=Math.round(b/BUCKET_STEP)*BUCKET_STEP;
      const key=`${qr},${qg},${qb}`;
      bucketCounts.set(key, (bucketCounts.get(key)||0)+1);
    }
  }
  const palette = [...bucketCounts.entries()]
    .sort((a,b) => b[1]-a[1])
    .slice(0, PALETTE_SIZE)
    .map(([k]) => k.split(',').map(Number));
  console.log(`\n調色盤 (${palette.length} 色)：${palette.map(c=>`rgb(${c})`).join(', ')}`);

  // Pass 2: 決定取樣參數
  let topBorder = 0, leftBorder = 0, srcPixelSz, contentH;

  if (LAYOUT === 'individual') {
    // 每幀獨立檔案，直接以幀高等比例取樣，不做邊框偵測
    const { fh } = frameBuffers[0];
    srcPixelSz = fh / TARGET_SIZE;
    contentH   = fh;
    console.log(`\n全幀取樣：scale=${srcPixelSz.toFixed(2)}`);
  } else if (DIRECT_SAMPLE && frameWidth === TARGET_SIZE && frameHeight === TARGET_SIZE) {
    srcPixelSz = 1; contentH = TARGET_SIZE;
    console.log(`\n直接 1:1 取樣（幀尺寸 = 目標尺寸）`);
  } else {
    let bottomBorder = 0;
    let leftMin = Infinity;
    for (const { bgMask, fw, fh } of frameBuffers) {
      for (let y = 0; y < fh && topBorder === 0; y++)
        for (let x = 0; x < fw; x++)
          if (!bgMask[y * fw + x]) { topBorder = y; break; }
      for (let y = fh - 1; y >= 0; y--)
        for (let x = 0; x < fw; x++)
          if (!bgMask[y * fw + x]) { bottomBorder = Math.max(bottomBorder, y); break; }
      for (let x = 0; x < fw; x++) {
        for (let y = topBorder; y <= bottomBorder; y++)
          if (!bgMask[y * fw + x]) { leftMin = Math.min(leftMin, x); break; }
        if (leftMin === 0) break;
      }
    }
    if (leftMin === Infinity) leftMin = 0;
    for (const { bgMask, fw, fh } of frameBuffers) {
      let frameLeft = fw;
      for (let x = 0; x < fw; x++) {
        for (let y = topBorder; y <= bottomBorder; y++)
          if (!bgMask[y * fw + x]) { frameLeft = x; break; }
        if (frameLeft < fw) break;
      }
      leftBorder = Math.max(leftBorder, frameLeft);
    }
    contentH   = bottomBorder - topBorder + 1;
    srcPixelSz = contentH / TARGET_SIZE;
    console.log(`\n偵測邊框: top=${topBorder} left=${leftBorder} size=${contentH}×${contentH} scale=${srcPixelSz.toFixed(2)}`);
  }

  function extractFrameDirect({ rgba, fw, fh, bgMask }) {
    const pixels = [];
    for (let oy = 0; oy < TARGET_SIZE; oy++) {
      for (let ox = 0; ox < TARGET_SIZE; ox++) {
        const sx = Math.floor(leftBorder + (ox + 0.5) * srcPixelSz);
        const sy = Math.floor(topBorder  + (oy + 0.5) * srcPixelSz);
        if (sx < 0 || sx >= fw || sy < 0 || sy >= fh) { pixels.push(null); continue; }
        const si = sy * fw + sx;
        if (bgMask[si]) { pixels.push(null); continue; }
        pixels.push([rgba[si*4], rgba[si*4+1], rgba[si*4+2]]);
      }
    }
    return pixels;
  }

  function extractFrame({ rgba, fw, fh, bgMask }) {
    const pixels = [];
    for (let oy = 0; oy < TARGET_SIZE; oy++) {
      for (let ox = 0; ox < TARGET_SIZE; ox++) {
        // check if center point is bg
        const csx = Math.floor((ox + 0.5) * fw / TARGET_SIZE);
        const csy = Math.floor((oy + 0.5) * fh / TARGET_SIZE);
        if (bgMask[csy * fw + csx]) { pixels.push(null); continue; }

        // collect all fg pixels in region
        const x0 = Math.floor(ox * fw / TARGET_SIZE), x1 = Math.max(x0+1, Math.floor((ox+1) * fw / TARGET_SIZE));
        const y0 = Math.floor(oy * fh / TARGET_SIZE), y1 = Math.max(y0+1, Math.floor((oy+1) * fh / TARGET_SIZE));

        let outlineN = 0, totalFg = 0;
        const fillCounts = new Map();
        let fillModeN = 0, fillMode = null;

        for (let sy = y0; sy < y1 && sy < fh; sy++) {
          for (let sx = x0; sx < x1 && sx < fw; sx++) {
            const i = sy * fw + sx;
            if (bgMask[i]) continue;
            totalFg++;
            const r=rgba[i*4], g=rgba[i*4+1], b=rgba[i*4+2], sum=r+g+b;
            if (sum < OUTLINE_MAX) { outlineN++; continue; }
            // bucket for stable mode counting
            const qr=Math.round(r/BUCKET_STEP)*BUCKET_STEP;
            const qg=Math.round(g/BUCKET_STEP)*BUCKET_STEP;
            const qb=Math.round(b/BUCKET_STEP)*BUCKET_STEP;
            const key=`${qr},${qg},${qb}`;
            const c=(fillCounts.get(key)||0)+1;
            fillCounts.set(key, c);
            if (c > fillModeN) { fillModeN=c; fillMode=[qr,qg,qb]; }
          }
        }

        if (totalFg === 0) { pixels.push(null); continue; }
        const outlineRatio = outlineN / totalFg;

        if (outlineRatio >= 0.6 && outlineN >= 2) {
          pixels.push([0, 0, 0]);
        } else if (fillMode) {
          pixels.push(snapColor(fillMode[0], fillMode[1], fillMode[2], palette));
        } else {
          pixels.push([0, 0, 0]);
        }
      }
    }
    return pixels;
  }

  function addOutline(pixels, w, h) {
    const out = pixels.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!pixels[i]) continue;
      const nb = [
        y > 0   ? pixels[(y-1)*w+x] : null,
        y < h-1 ? pixels[(y+1)*w+x] : null,
        x > 0   ? pixels[y*w+x-1]   : null,
        x < w-1 ? pixels[y*w+x+1]   : null,
      ];
      if (nb.some(v => !v)) out[i] = [0, 0, 0];
    }
    return out;
  }

  // individual layout：手繪圖用中心點取樣（保留原色，不補輪廓）
  const useDirect = DIRECT_SAMPLE || LAYOUT === 'individual';
  const frames = [];
  for (let i = 0; i < SPRITE_COUNT; i++) {
    const px = useDirect ? extractFrameDirect(frameBuffers[i]) : extractFrame(frameBuffers[i]);
    frames.push(useDirect ? px : addOutline(px, TARGET_SIZE, TARGET_SIZE));
    process.stdout.write(`\r提取 ${i+1}/${SPRITE_COUNT}`);
  }
  console.log('');

  // 如果設定了 rightOffset，附加右向幀（優先保留既有編輯）
  if (config.rightOffset) {
    let rightFrames = null;
    try {
      const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      if (existing.frames && existing.frames.length >= config.rightOffset + SPRITE_COUNT) {
        rightFrames = existing.frames.slice(config.rightOffset);
        console.log(`保留已編輯的右向幀（${rightFrames.length} 幀）`);
      }
    } catch(e) {}
    if (!rightFrames) {
      if (LAYOUT === 'individual') {
        // individual：優先讀 _r.png，找不到才翻轉左向幀
        rightFrames = [];
        let fromFile = 0, fromFlip = 0;
        for (let fi = 0; fi < SPRITE_COUNT; fi++) {
          const prefix = fi.toString().padStart(2, '0');
          const fname  = config.frameNames[fi];
          const rpath  = [path.join(dir, `${prefix}_${fname}_r.png`), path.join(dir, `${fname}_r.png`)]
            .find(p => fs.existsSync(p));
          if (rpath) {
            const { data, info } = await sharp(rpath).raw().toBuffer({ resolveWithObject: true });
            const fw = info.width, fh = info.height, ch = info.channels;
            const rgba = Buffer.alloc(fw * fh * 4);
            for (let i = 0; i < fw * fh; i++) {
              rgba[i*4]=data[i*ch]; rgba[i*4+1]=data[i*ch+1]; rgba[i*4+2]=data[i*ch+2];
              rgba[i*4+3] = ch === 4 ? data[i*ch+3] : 255;
            }
            const bgMask = makeBgMask(rgba, fw, fh, info.channels === 4);
            rightFrames.push(extractFrameDirect({ rgba, fw, fh, bgMask }));
            fromFile++;
          } else {
            const f = frames[fi];
            const flipped = [];
            for (let y = 0; y < TARGET_SIZE; y++) {
              const row = f.slice(y * TARGET_SIZE, (y+1) * TARGET_SIZE);
              flipped.push(...row.slice().reverse());
            }
            rightFrames.push(flipped);
            fromFlip++;
          }
        }
        console.log(`右向幀：${fromFile} 幀讀自 _r.png，${fromFlip} 幀自動翻轉`);
      } else {
        rightFrames = frames.map(f => {
          const result = [];
          for (let y = 0; y < TARGET_SIZE; y++) {
            const row = f.slice(y * TARGET_SIZE, (y+1) * TARGET_SIZE);
            result.push(...row.slice().reverse());
          }
          return result;
        });
        console.log(`自動生成右向幀（${rightFrames.length} 幀翻轉）`);
      }
    }
    frames.push(...rightFrames);
  }

  fs.writeFileSync(outPath, JSON.stringify({ frames, width: TARGET_SIZE, height: TARGET_SIZE }));
  console.log(`✓ ${outPath}`);
  console.log(`接著：node char-cli.js build ${name}`);
}

// ── build: pixels.json → art.json ─────────────────────────────────
function cmdBuild(name) {
  const dir     = charDir(name);
  const inPath  = path.join(dir, 'pixels.json');
  const outPath = path.join(dir, 'art.json');

  if (!fs.existsSync(inPath)) { console.error(`找不到 pixels.json，請先執行 prepare`); process.exit(1); }

  const { frames, width, height } = JSON.parse(fs.readFileSync(inPath, 'utf8'));

  const artFrames = frames.map((pixels, i) => {
    const rows = [];
    for (let y = 0; y < height; y += 2) {
      const row = [];
      for (let x = 0; x < width; x++) {
        const up = pixels[y * width + x] || null;
        const lo = pixels[(y+1) * width + x] || null;
        if (!up && !lo) { row.push(null); continue; }
        row.push([
          up ? up[0] : -1, up ? up[1] : -1, up ? up[2] : -1,
          lo ? lo[0] : -1, lo ? lo[1] : -1, lo ? lo[2] : -1,
        ]);
      }
      rows.push(row);
    }
    process.stdout.write(`\r轉換 ${i+1}/${frames.length}`);
    return rows;
  });
  console.log('');

  fs.writeFileSync(outPath, JSON.stringify({
    style: 'color-halfblock', width, height: Math.ceil(height / 2), frames: artFrames,
  }));
  console.log(`✓ ${outPath}`);
}

// ── cutin: CutIn.png (96x48 RGBA) → cutin-art.json (32x8 halfblock) ──
// 規格：原圖 96x48 RGBA，alpha < 128 視為透明；3:1 nearest-neighbor
// downsample 到 32x16 pixels，再轉成 32 寬 × 8 高 halfblock cells。
//   frames[0] = 左向（CutIn.png；給敵方原樣，給我方翻轉）
//   frames[1] = 客製右向（如有 CutIn_r.png 才會輸出；給我方使用，不翻轉）
async function cmdCutin(name) {
  const sharp = require('sharp');
  const dir    = charDir(name);
  const leftP  = path.join(dir, 'CutIn.png');
  const rightP = path.join(dir, 'CutIn_r.png');
  const outP   = path.join(dir, 'cutin-art.json');
  if (!fs.existsSync(leftP)) { console.error(`找不到 ${leftP}`); process.exit(1); }

  const TW = 32, TH = 16;

  async function pngToCells(p) {
    const { data, info } = await sharp(p).raw().toBuffer({ resolveWithObject: true });
    const SW = info.width, SH = info.height, CH = info.channels;
    if (SW % TW !== 0 || SH % TH !== 0) {
      console.warn(`警告：${path.basename(p)} ${SW}x${SH} 不能整除 ${TW}x${TH}，仍用 nearest 取樣`);
    }
    const sx = SW / TW, sy = SH / TH;
    const pixels = [];
    for (let y = 0; y < TH; y++) {
      for (let x = 0; x < TW; x++) {
        const ssx = Math.min(SW - 1, Math.floor((x + 0.5) * sx));
        const ssy = Math.min(SH - 1, Math.floor((y + 0.5) * sy));
        const i = (ssy * SW + ssx) * CH;
        const a = CH === 4 ? data[i + 3] : 255;
        if (a < 128) { pixels.push(null); continue; }
        pixels.push([data[i], data[i+1], data[i+2]]);
      }
    }
    const rows = [];
    for (let y = 0; y < TH; y += 2) {
      const row = [];
      for (let x = 0; x < TW; x++) {
        const up = pixels[y * TW + x] || null;
        const lo = pixels[(y + 1) * TW + x] || null;
        if (!up && !lo) { row.push(null); continue; }
        row.push([
          up ? up[0] : -1, up ? up[1] : -1, up ? up[2] : -1,
          lo ? lo[0] : -1, lo ? lo[1] : -1, lo ? lo[2] : -1,
        ]);
      }
      rows.push(row);
    }
    return { rows, SW, SH };
  }

  const left = await pngToCells(leftP);
  const frames = [left.rows];
  let line = `[${name}] CutIn ${left.SW}x${left.SH} → ${TW}x${TH} (左向)`;
  if (fs.existsSync(rightP)) {
    const right = await pngToCells(rightP);
    frames.push(right.rows);
    line += `  + CutIn_r ${right.SW}x${right.SH} (客製右向)`;
  }
  console.log(line);

  fs.writeFileSync(outP, JSON.stringify({
    style: 'color-halfblock', width: TW, height: TH / 2, frames,
  }));
  console.log(`✓ ${outP}`);
}

// ── edit: 啟動 sprite editor ───────────────────────────────────────
function cmdEdit(name) {
  loadConfig(name);
  const editor = path.join(REPO_ROOT, 'src', 'editor', 'sprite_editor_server.js');
  spawn('node', [editor, name], { stdio: 'inherit' })
    .on('exit', code => process.exit(code));
}

// ── main ───────────────────────────────────────────────────────────
const [,, cmd, name] = process.argv;

if (!cmd || !name) {
  console.log([
    '用法: node char-cli.js <command> <character>',
    '  prepare <name>   sprite.png → pixels.json',
    '  build <name>     pixels.json → art.json',
    '  process <name>   prepare + build',
    '  cutin <name>     CutIn.png → cutin-art.json',
    '  edit <name>      啟動 sprite editor',
  ].join('\n'));
  process.exit(0);
}

const cmds = {
  prepare: () => cmdPrepare(name).catch(e => { console.error(e.message); process.exit(1); }),
  build:   () => cmdBuild(name),
  process: () => cmdPrepare(name).then(() => cmdBuild(name)).catch(e => { console.error(e.message); process.exit(1); }),
  cutin:   () => cmdCutin(name).catch(e => { console.error(e.message); process.exit(1); }),
  edit:    () => cmdEdit(name),
};
(cmds[cmd] || (() => { console.error('未知指令：' + cmd); process.exit(1); }))();
