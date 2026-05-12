const fs = require('fs');

// ── 轉換風格 ─────────────────────────────────────────────────────
// 每「點」顯示面積（字元格單位，越小越細）
// 'braille'   : 2x4 點陣 → 每點 0.25    （最細，原版）
// 'hybrid'    : braille + 自動合併 2×2 實心區塊為 quadrant 字元（推薦）  ← NEW
// 'sextant'   : 2x3 六分之一塊 → 每點 0.33
// 'quadrant'  : 2x2 四分之一塊 → 每點 0.5
// 'halfblock' : 1x2 半區塊 → 每點 1.0
const STYLE = 'braille';

const FRAME_NAMES = ['正常', '踏步', '高興', '生氣', '大吼', '瞪眼', '說話', '驚訝', '睡覺', '沮喪1', '沮喪2'];

const pixelData = JSON.parse(fs.readFileSync('agumon_pixels.json', 'utf8'));

// ── Braille 模式 ─────────────────────────────────────────────────
function pixelsToBraille(block) {
    const dotMap = [0, 1, 2, 6, 3, 4, 5, 7];
    let code = 0x2800;
    for (let i = 0; i < 8; i++) {
        if (block[i]) code += Math.pow(2, dotMap[i]);
    }
    return String.fromCharCode(code);
}

function convertBraille(pixels, width, height) {
    let output = '';
    for (let y = 0; y < height; y += 4) {
        for (let x = 0; x < width; x += 2) {
            const block = [];
            for (let dx = 0; dx < 2; dx++) {
                for (let dy = 0; dy < 4; dy++) {
                    block.push(pixels[(y + dy) * width + (x + dx)] || 0);
                }
            }
            output += pixelsToBraille(block);
        }
        output += '\n';
    }
    return output;
}

// ── Hybrid：braille 為底，純 2×2 實心組合自動換成 quadrant 字元 ──
// Braille 2×4 可切為上下兩個 2×2 quadrant：
//   TL=dots 1,2 (bits 0,1)=0x03  TR=dots 4,5 (bits 3,4)=0x18
//   BL=dots 3,7 (bits 2,6)=0x44  BR=dots 6,8 (bits 5,7)=0xA0
// 16 種「純淨」組合 → quadrant chars；其餘保留為 braille
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

// ── Half-block 模式：每字元代表 2 個上下堆疊像素 ──────────────────
// 為保持與 braille 相同的輸出尺寸（16 字元寬 × 8 行高），先將 32x32 降為 16x16
function downsample(pixels, srcW, srcH, dstW, dstH) {
    const stepX = srcW / dstW, stepY = srcH / dstH;
    const out = new Array(dstW * dstH).fill(0);
    for (let y = 0; y < dstH; y++) {
        for (let x = 0; x < dstW; x++) {
            // 取樣 2x2 區塊多數決（任一像素為黑即視為黑）
            let hit = 0, total = 0;
            const sy0 = Math.floor(y * stepY), sy1 = Math.floor((y + 1) * stepY);
            const sx0 = Math.floor(x * stepX), sx1 = Math.floor((x + 1) * stepX);
            for (let sy = sy0; sy < sy1; sy++) {
                for (let sx = sx0; sx < sx1; sx++) {
                    total++;
                    if (pixels[sy * srcW + sx]) hit++;
                }
            }
            out[y * dstW + x] = hit * 2 >= total ? 1 : 0;
        }
    }
    return out;
}

function pixelsToHalfBlock(upper, lower) {
    if (upper && lower) return '\u2588';  // █ 全滿
    if (upper)          return '\u2580';  // ▀ 上半
    if (lower)          return '\u2584';  // ▄ 下半
    return '\u2800';                       // ⠀ 空（braille 空白，避免被 trim）
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

// ── Quadrant 模式：每字元代表 2x2 像素（中等方塊，推薦）────────────
// bit 0=UL, 1=UR, 2=LL, 3=LR
const QUADRANT_CHARS = [
    '\u2800', // 0000 empty → use braille blank (不被 trim)
    '\u2598', // 0001 ▘ UL
    '\u259D', // 0010 ▝ UR
    '\u2580', // 0011 ▀ top half
    '\u2596', // 0100 ▖ LL
    '\u258C', // 0101 ▌ left half
    '\u259E', // 0110 ▞ UR+LL
    '\u259B', // 0111 ▛ UL+UR+LL
    '\u2597', // 1000 ▗ LR
    '\u259A', // 1001 ▚ UL+LR
    '\u2590', // 1010 ▐ right half
    '\u259C', // 1011 ▜ UL+UR+LR
    '\u2584', // 1100 ▄ bottom half
    '\u2599', // 1101 ▙ UL+LL+LR
    '\u259F', // 1110 ▟ UR+LL+LR
    '\u2588', // 1111 █ full
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

// 垂直壓縮：每 2 行合併為 1 行（任一像素為黑即視為黑）
// 補償字元格 1:2 寬高比造成的垂直拉伸
function squashVertical(pixels, w, h) {
    const newH = Math.floor(h / 2);
    const out = new Array(w * newH).fill(0);
    for (let y = 0; y < newH; y++) {
        for (let x = 0; x < w; x++) {
            const a = pixels[(y * 2)     * w + x] || 0;
            const b = pixels[(y * 2 + 1) * w + x] || 0;
            out[y * w + x] = (a || b) ? 1 : 0;
        }
    }
    return out;
}

// ── Sextant 模式：每字元代表 2x3 像素 ─────────────────────────────
// bit 0=TL, 1=TR, 2=ML, 3=MR, 4=BL, 5=BR
// 64 種組合中 4 種在其他 Unicode 區段，另 60 種在 U+1FB00~U+1FB3B
function sextantChar(v) {
    if (v === 0)  return '\u2800'; // 空（用 braille blank 避免被 trim）
    if (v === 21) return '\u258C'; // 左半 ▌
    if (v === 42) return '\u2590'; // 右半 ▐
    if (v === 63) return '\u2588'; // 全滿 █
    // 其他 60 種：依值在 U+1FB00 基底上偏移（跳過 21、42 兩個值）
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
            const tl = get(x, y);
            const tr = get(x + 1, y);
            const ml = get(x, y + 1);
            const mr = get(x + 1, y + 1);
            const bl = get(x, y + 2);
            const br = get(x + 1, y + 2);
            const v = (tl ? 1 : 0) | (tr ? 2 : 0) | (ml ? 4 : 0) | (mr ? 8 : 0) | (bl ? 16 : 0) | (br ? 32 : 0);
            output += sextantChar(v);
        }
        output += '\n';
    }
    return output;
}

// ── 主流程 ──────────────────────────────────────────────────────
console.log(`--- Converting to art (style: ${STYLE}) ---\n`);

const { frames, width, height } = pixelData;
const artFrames = frames.map((pixels, i) => {
    let art;
    if (STYLE === 'halfblock') {
        const ds = downsample(pixels, width, height, width / 2, height / 2);
        art = convertHalfBlock(ds, width / 2, height / 2);
    } else if (STYLE === 'quadrant') {
        // 垂直壓縮一半後再轉換，讓輸出高度符合字元格寬高比（避免拉長）
        // 32×32 → squash → 32×16 → quadrant → 16×8 字元（與 halfblock 同尺寸）
        const sq = squashVertical(pixels, width, height);
        art = convertQuadrant(sq, width, height / 2);
    } else if (STYLE === 'hybrid') {
        // 先用 braille 轉換，再將純 2×2 實心組合替換為 quadrant
        art = hybridFromBraille(convertBraille(pixels, width, height));
    } else if (STYLE === 'sextant') {
        // sextant 每字元 2×3 像素；3 列要再垂直壓縮 2:3 補償 1:2 字元格
        // 32×32 → squash 2:3 → 32×~21 → sextant → 16×7 字元
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
        art = convertSextant(sq, width, newH);
    } else {
        art = convertBraille(pixels, width, height);
    }
    console.log(`=== Frame ${i}: ${FRAME_NAMES[i]} ===`);
    console.log(art);
    return art;
});

fs.writeFileSync('agumon_art.json', JSON.stringify({ style: STYLE, frames: artFrames }));
console.log(`\n完成！style=${STYLE}, 共 ${artFrames.length} 幀 → agumon_art.json`);
