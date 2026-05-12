const fs = require('fs');
const path = require('path');

// 可調：braille / hybrid / sextant / quadrant / halfblock
const STYLE = 'braille';

const IN_JSON  = path.join(__dirname, '..', 'assets', 'agumon_pixels.json');
const OUT_JSON = path.join(__dirname, '..', 'assets', 'agumon_art.json');

const pixelData = JSON.parse(fs.readFileSync(IN_JSON, 'utf8'));

function pixelsToBraille(block) {
  const dotMap = [0, 1, 2, 6, 3, 4, 5, 7];
  let code = 0x2800;
  for (let i = 0; i < 8; i++) if (block[i]) code += Math.pow(2, dotMap[i]);
  return String.fromCharCode(code);
}

function convertBraille(pixels, width, height) {
  let output = '';
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 2) {
      const block = [];
      for (let dx = 0; dx < 2; dx++) {
        for (let dy = 0; dy < 4; dy++) block.push(pixels[(y + dy) * width + (x + dx)] || 0);
      }
      output += pixelsToBraille(block);
    }
    output += '\n';
  }
  return output;
}

const BRAILLE_TO_QUADRANT = {
  0x03: '\u2598', 0x18: '\u259D', 0x44: '\u2596', 0xA0: '\u2597',
  0x1B: '\u2580', 0x47: '\u258C', 0xA3: '\u259A', 0x5C: '\u259E',
  0xB8: '\u2590', 0xE4: '\u2584', 0x5F: '\u259B', 0xBB: '\u259C',
  0xE7: '\u2599', 0xFC: '\u259F', 0xFF: '\u2588',
};
function hybridFromBraille(brailleStr) {
  return [...brailleStr].map(ch => {
    const cp = ch.codePointAt(0);
    if (cp < 0x2800 || cp > 0x28FF) return ch;
    const v = cp - 0x2800;
    return BRAILLE_TO_QUADRANT[v] || ch;
  }).join('');
}

function downsample(pixels, srcW, srcH, dstW, dstH) {
  const stepX = srcW / dstW, stepY = srcH / dstH;
  const out = new Array(dstW * dstH).fill(0);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      let hit = 0, total = 0;
      const sy0 = Math.floor(y * stepY), sy1 = Math.floor((y + 1) * stepY);
      const sx0 = Math.floor(x * stepX), sx1 = Math.floor((x + 1) * stepX);
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) { total++; if (pixels[sy * srcW + sx]) hit++; }
      }
      out[y * dstW + x] = hit * 2 >= total ? 1 : 0;
    }
  }
  return out;
}

function pixelsToHalfBlock(upper, lower) {
  if (upper && lower) return '\u2588';
  if (upper) return '\u2580';
  if (lower) return '\u2584';
  return '\u2800';
}
function convertHalfBlock(pixels, width, height) {
  let output = '';
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x++) {
      const up = pixels[y * width + x] || 0;
      const lo = pixels[(y + 1) * width + x] || 0;
      output += pixelsToHalfBlock(up, lo);
    }
    output += '\n';
  }
  return output;
}

const QUADRANT_CHARS = [
  '\u2800','\u2598','\u259D','\u2580','\u2596','\u258C','\u259E','\u259B',
  '\u2597','\u259A','\u2590','\u259C','\u2584','\u2599','\u259F','\u2588',
];
function convertQuadrant(pixels, width, height) {
  let output = '';
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const ul = pixels[y * width + x] || 0;
      const ur = pixels[y * width + x + 1] || 0;
      const ll = pixels[(y + 1) * width + x] || 0;
      const lr = pixels[(y + 1) * width + x + 1] || 0;
      const idx = (ul ? 1 : 0) | (ur ? 2 : 0) | (ll ? 4 : 0) | (lr ? 8 : 0);
      output += QUADRANT_CHARS[idx];
    }
    output += '\n';
  }
  return output;
}
function squashVertical(pixels, w, h) {
  const newH = Math.floor(h / 2);
  const out = new Array(w * newH).fill(0);
  for (let y = 0; y < newH; y++) for (let x = 0; x < w; x++) out[y * w + x] = (pixels[(y*2)*w + x] || pixels[(y*2+1)*w + x]) ? 1 : 0;
  return out;
}

function sextantChar(v) {
  if (v === 0) return '\u2800';
  if (v === 21) return '\u258C';
  if (v === 42) return '\u2590';
  if (v === 63) return '\u2588';
  let idx = v - 1;
  if (v > 21) idx--;
  if (v > 42) idx--;
  return String.fromCodePoint(0x1FB00 + idx);
}
function convertSextant(pixels, width, height) {
  let output = '';
  const get = (x, y) => (y < height && x < width) ? (pixels[y * width + x] || 0) : 0;
  for (let y = 0; y < height; y += 3) {
    for (let x = 0; x < width; x += 2) {
      const tl = get(x, y), tr = get(x + 1, y);
      const ml = get(x, y + 1), mr = get(x + 1, y + 1);
      const bl = get(x, y + 2), br = get(x + 1, y + 2);
      const v = (tl?1:0)|(tr?2:0)|(ml?4:0)|(mr?8:0)|(bl?16:0)|(br?32:0);
      output += sextantChar(v);
    }
    output += '\n';
  }
  return output;
}

const { frames, width, height } = pixelData;
const artFrames = frames.map((pixels) => {
  if (STYLE === 'halfblock') {
    const ds = downsample(pixels, width, height, width / 2, height / 2);
    return convertHalfBlock(ds, width / 2, height / 2);
  }
  if (STYLE === 'quadrant') {
    const sq = squashVertical(pixels, width, height);
    return convertQuadrant(sq, width, height / 2);
  }
  if (STYLE === 'hybrid') return hybridFromBraille(convertBraille(pixels, width, height));
  if (STYLE === 'sextant') {
    const newH = Math.round(height * 2 / 3);
    const sq = new Array(width * newH).fill(0);
    for (let y = 0; y < newH; y++) {
      for (let x = 0; x < width; x++) {
        const srcY0 = Math.floor(y * 3 / 2);
        const srcY1 = Math.min(height - 1, Math.floor((y + 1) * 3 / 2) - 1);
        let hit = 0;
        for (let sy = srcY0; sy <= srcY1; sy++) hit = hit || (pixels[sy * width + x] || 0);
        sq[y * width + x] = hit ? 1 : 0;
      }
    }
    return convertSextant(sq, width, newH);
  }
  return convertBraille(pixels, width, height);
});

fs.writeFileSync(OUT_JSON, JSON.stringify({ style: STYLE, frames: artFrames }));
console.log(`完成！style=${STYLE} → ${OUT_JSON}`);

