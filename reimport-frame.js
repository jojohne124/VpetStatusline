#!/usr/bin/env node
'use strict';
// 外科手術式單幀重匯入：只重轉某一幀，不動其他（可能手調過的）幀。
// 用法: node reimport-frame.js <name> <frameIndex>
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const [,, name, frameIdxStr] = process.argv;
const frameIdx = parseInt(frameIdxStr, 10);
if (!name || Number.isNaN(frameIdx)) {
  console.error('用法: node reimport-frame.js <name> <frameIndex>');
  process.exit(1);
}

const dir = path.join(__dirname, 'characters', name);
const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const TARGET = config.targetSize || 16;
const fname = config.frameNames[frameIdx];
const prefix = frameIdx.toString().padStart(2, '0');
const candidates = [
  path.join(dir, `${prefix}_${fname}.png`),
  path.join(dir, `${fname}.png`),
  path.join(dir, `${frameIdx}.png`),
];
const fpath = candidates.find(p => fs.existsSync(p));
if (!fpath) { console.error('找不到來源 PNG：' + candidates.join(' / ')); process.exit(1); }
console.log(`來源：${path.basename(fpath)}`);

(async () => {
  const { data, info } = await sharp(fpath).raw().toBuffer({ resolveWithObject: true });
  const fw = info.width, fh = info.height, ch = info.channels;
  const rgba = Buffer.alloc(fw * fh * 4);
  for (let i = 0; i < fw * fh; i++) {
    rgba[i*4]=data[i*ch]; rgba[i*4+1]=data[i*ch+1]; rgba[i*4+2]=data[i*ch+2];
    rgba[i*4+3] = ch === 4 ? data[i*ch+3] : 255;
  }
  // bgMask: individual 走 alpha（ch===4）；否則 flood-fill（此處角色為 RGBA）
  const hasAlpha = ch === 4;
  const TRANSPARENT_COLOR = config.transparentColor || null;
  function isBgColor(r,g,b){ if(r>220&&g<90&&b>220)return true; const a=(r+g+b)/3; return a>195&&Math.abs(r-g)<15&&Math.abs(g-b)<15&&Math.abs(r-b)<15; }
  const bgMask = new Uint8Array(fw*fh);
  if (TRANSPARENT_COLOR) {
    const tc=TRANSPARENT_COLOR, tol=8;
    for(let i=0;i<fw*fh;i++){const r=rgba[i*4],g=rgba[i*4+1],b=rgba[i*4+2];if(Math.abs(r-tc[0])<=tol&&Math.abs(g-tc[1])<=tol&&Math.abs(b-tc[2])<=tol)bgMask[i]=1;}
  } else if (hasAlpha) {
    for(let i=0;i<fw*fh;i++) bgMask[i]=rgba[i*4+3]<128?1:0;
  } else {
    for(let i=0;i<fw*fh;i++) bgMask[i]=isBgColor(rgba[i*4],rgba[i*4+1],rgba[i*4+2])?1:0;
  }

  // extractFrameDirect（individual：全幀等比例取樣 top=0 left=0 scale=fh/TARGET）
  const srcPixelSz = fh / TARGET;
  const pixels = [];
  for (let oy = 0; oy < TARGET; oy++) for (let ox = 0; ox < TARGET; ox++) {
    const sx = Math.floor((ox + 0.5) * srcPixelSz);
    const sy = Math.floor((oy + 0.5) * srcPixelSz);
    if (sx<0||sx>=fw||sy<0||sy>=fh){pixels.push(null);continue;}
    const si = sy*fw+sx;
    if (bgMask[si]){pixels.push(null);continue;}
    pixels.push([rgba[si*4],rgba[si*4+1],rgba[si*4+2]]);
  }

  // 比對現有 frame
  const pxPath = path.join(dir, 'pixels.json');
  const pj = JSON.parse(fs.readFileSync(pxPath, 'utf8'));
  const old = pj.frames[frameIdx];
  let diff = 0;
  for (let i = 0; i < TARGET*TARGET; i++) {
    const a = old[i], b = pixels[i];
    if (!a && !b) continue;
    if (!a || !b || a[0]!==b[0]||a[1]!==b[1]||a[2]!==b[2]) diff++;
  }
  console.log(`frame[${frameIdx}] (${fname}) 差異像素：${diff}/${TARGET*TARGET}（non-null ${pixels.filter(Boolean).length}）`);

  // 寫回 pixels.json
  pj.frames[frameIdx] = pixels;
  fs.writeFileSync(pxPath, JSON.stringify(pj));
  console.log('✓ 更新 pixels.json');

  // 重建 art.json 的該幀（halfblock）
  const artPath = path.join(dir, 'art.json');
  const aj = JSON.parse(fs.readFileSync(artPath, 'utf8'));
  const w = TARGET, h = TARGET;
  const rows = [];
  for (let y = 0; y < h; y += 2) {
    const row = [];
    for (let x = 0; x < w; x++) {
      const up = pixels[y*w+x] || null;
      const lo = pixels[(y+1)*w+x] || null;
      if (!up && !lo) { row.push(null); continue; }
      row.push([up?up[0]:-1,up?up[1]:-1,up?up[2]:-1, lo?lo[0]:-1,lo?lo[1]:-1,lo?lo[2]:-1]);
    }
    rows.push(row);
  }
  aj.frames[frameIdx] = rows;
  fs.writeFileSync(artPath, JSON.stringify(aj));
  console.log('✓ 更新 art.json');
})().catch(e => { console.error(e); process.exit(1); });
