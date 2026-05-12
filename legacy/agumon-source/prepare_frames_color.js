const sharp = require('sharp');
const fs = require('fs');

// 目標輸出解析度
// 16 = 16×8 字元 (最小，弧形會變平直，不推薦)
// 20 = 20×10 字元 (推薦，最小仍能看到弧形的解析度) ← 目前
// 24 = 24×12 字元 (清晰，footprint 較大)
// 32 = 32×16 字元 (最清晰，footprint 最大)
const TARGET_SIZE  = 16;
const SPRITE_COUNT = 12;

const FRAME_NAMES = [
    '正常','踏步','驚訝','高興','睡覺1','睡覺2',
    '瞪眼','大高興','大生氣','沮喪1','沮喪2','大吼',
];

// 判定「可能是背景色」──只當像素 *連通到邊緣* 時才視為背景
// 粉紅分隔: RGB(244,45,255) 附近
// Sprite 內底色: RGB(224,224,224) 附近
function isBgColor(r, g, b) {
    if (r > 220 && g < 90 && b > 220) return true;           // 粉紅
    const avg = (r + g + b) / 3;
    if (avg > 195 &&
        Math.abs(r - g) < 15 && Math.abs(g - b) < 15 && Math.abs(r - b) < 15) return true;  // 灰/白
    return false;
}

// Flood-fill：從所有邊緣出發，只標記連通到邊緣的背景色
function buildBgMask(rgba, w, h) {
    const mask = new Uint8Array(w * h); // 1 = 透明背景
    const visited = new Uint8Array(w * h);
    const stack = [];

    const push = (x, y) => {
        if (x < 0 || x >= w || y < 0 || y >= h) return;
        if (visited[y * w + x]) return;
        stack.push(x, y);
    };

    // 從 4 邊所有像素入口
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
    // 來源圖：使用 standard 版 (69×69)
    // 注意：hi-res 版 (85×87) 在 16~20 低解析度輸出時反而更雜亂，
    // 因為 85 不能整除 16/20 造成採樣點偏移
    const imagePath = 'agumon_pixel_color.png';
    console.log(`使用原圖: ${imagePath}`);
    const metadata = await sharp(imagePath).metadata();

    console.log(`原始圖片: ${metadata.width}×${metadata.height}`);

    const frameWidth = Math.floor(metadata.width / SPRITE_COUNT);
    const frameHeight = metadata.height;

    console.log(`每幀原始: ${frameWidth}×${frameHeight} → ${TARGET_SIZE}×${TARGET_SIZE}`);

    async function extractFrame(index) {
        const left = index * frameWidth;
        const safeWidth = Math.min(frameWidth, metadata.width - left);

        // 1. 在原始解析度讀取 RGB
        const { data: fullData, info } = await sharp(imagePath)
            .extract({ left, top: 0, width: safeWidth, height: frameHeight })
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        const fw = info.width, fh = info.height;
        // 建立 RGBA buffer（方便後面做 mask 檢查）
        const rgba = Buffer.alloc(fw * fh * 4);
        for (let i = 0; i < fw * fh; i++) {
            rgba[i * 4]     = fullData[i * 3];
            rgba[i * 4 + 1] = fullData[i * 3 + 1];
            rgba[i * 4 + 2] = fullData[i * 3 + 2];
            rgba[i * 4 + 3] = 255;
        }

        // 2. Flood-fill 邊緣背景
        const bgMask = buildBgMask(rgba, fw, fh);

        // NN + 特徵偵測：保留真實內部 outline 特徵（肚子分界、手臂線），
        // 只在 outline 像素是偶然 sampling 命中時改用 fill
        // 規則：block 內 outline 達 fill 數量的 50% 以上 → 視為真實特徵 → 保留 outline
        const OUTLINE_MAX = 150;
        const pixels = [];
        for (let oy = 0; oy < TARGET_SIZE; oy++) {
            for (let ox = 0; ox < TARGET_SIZE; ox++) {
                const sx = Math.floor((ox + 0.5) * fw / TARGET_SIZE);
                const sy = Math.floor((oy + 0.5) * fh / TARGET_SIZE);
                const si = sy * fw + sx;

                if (bgMask[si]) {
                    pixels.push(null);
                    continue;
                }

                const cR = rgba[si * 4], cG = rgba[si * 4 + 1], cB = rgba[si * 4 + 2];
                const centerIsOutline = (cR + cG + cB) < OUTLINE_MAX;

                // 計算 block 內 outline/fill 比例
                const x0 = Math.floor(ox * fw / TARGET_SIZE);
                const x1 = Math.max(x0 + 1, Math.floor((ox + 1) * fw / TARGET_SIZE));
                const y0 = Math.floor(oy * fh / TARGET_SIZE);
                const y1 = Math.max(y0 + 1, Math.floor((oy + 1) * fh / TARGET_SIZE));

                const HIGHLIGHT_MIN = 600;  // RGB 總和 > 600 視為亮點（白色、爪子等）

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

                // 特徵偵測優先順序：
                //   1. outline 特徵（粗線條/分界）≥ 55%
                //   2. highlight 特徵（白色爪子/反光）≥ 12% 或 絕對數量 ≥ 2
                //   3. 預設用 fill 眾數或 NN 中心
                const isOutlineFeature = outlineRatio >= 0.65 && outlineN >= 2;
                const isHighlight = highlightN > 0 && (highlightRatio >= 0.12 || highlightN >= 2);

                if (isOutlineFeature) {
                    pixels.push(darkest);
                } else if (isHighlight) {
                    pixels.push(brightest); // 保留白色/亮點（爪、牙、眼睛反光）
                } else if (fillMode) {
                    if (!centerIsOutline) {
                        pixels.push([cR, cG, cB]);
                    } else {
                        pixels.push(fillMode);
                    }
                } else {
                    pixels.push(darkest);
                }
            }
        }
        return pixels;
    }

    // 後處理：邊緣偵測。對每個 non-null 像素，若有 4-鄰居為 null → 標為描邊色
    function addOutline(pixels, w, h, outlineColor) {
        const out = pixels.slice();
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                if (!pixels[i]) continue;
                const nb = [
                    y > 0     ? pixels[(y - 1) * w + x] : null,
                    y < h - 1 ? pixels[(y + 1) * w + x] : null,
                    x > 0     ? pixels[y * w + x - 1]   : null,
                    x < w - 1 ? pixels[y * w + x + 1]   : null,
                ];
                if (nb.some(v => !v)) out[i] = outlineColor;
            }
        }
        return out;
    }

    // 弧形增強：只處理 sprite 最頂列 + 最底列，避免中間 features（手、臂）出現弧形斷裂
    function enhanceArc(pixels, w, h, outlineColor) {
        const out = pixels.slice();

        // 找最頂列（第一個有 fg 的 row）
        let topRow = -1;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (pixels[y * w + x]) { topRow = y; break; }
            }
            if (topRow >= 0) break;
        }

        // 在最頂列上方加弧形
        if (topRow > 0) {
            // 只處理最頂列的「主 run」（最長的連續 outline run）
            let runStart = -1, bestS = -1, bestE = -1, bestLen = 0;
            for (let x = 0; x <= w; x++) {
                const has = x < w && pixels[topRow * w + x];
                if (has && runStart < 0) runStart = x;
                else if (!has && runStart >= 0) {
                    const len = x - runStart;
                    if (len > bestLen) { bestLen = len; bestS = runStart; bestE = x - 1; }
                    runStart = -1;
                }
            }
            if (bestLen >= 4) {
                for (let x = bestS + 1; x <= bestE - 1; x++) {
                    const ai = (topRow - 1) * w + x;
                    if (!out[ai]) out[ai] = outlineColor;
                }
            }
        }

        return out;
    }

    // 強制純黑描邊，對比度最高（原圖描邊是 RGB(24,20,0) 深棕，終端中較不顯眼）
    const OUTLINE_COLOR = [0, 0, 0];

    const frames = [];
    for (let i = 0; i < SPRITE_COUNT; i++) {
        const raw = await extractFrame(i);
        const outlined = addOutline(raw, TARGET_SIZE, TARGET_SIZE, OUTLINE_COLOR);
        // 20+ 解析度下不需要 arc enhancement 補救，原生就有弧形
        frames.push(outlined);
        process.stdout.write(`\r提取 ${i + 1}/${SPRITE_COUNT}`);
    }
    console.log('\n');

    fs.writeFileSync('agumon_pixels_color.json', JSON.stringify({
        frames, width: TARGET_SIZE, height: TARGET_SIZE
    }));

    // ASCII 預覽（實心 = 不透明）
    for (let i = 0; i < SPRITE_COUNT; i++) {
        console.log(`\n--- Frame ${i}: ${FRAME_NAMES[i]} ---`);
        const p = frames[i];
        for (let y = 0; y < TARGET_SIZE; y++) {
            let line = '';
            for (let x = 0; x < TARGET_SIZE; x++) {
                line += p[y * TARGET_SIZE + x] ? '##' : '  ';
            }
            console.log(line);
        }
    }
    console.log('\n接著: node convert_to_color.js');
}

main().catch(err => { console.error('錯誤:', err.message); process.exit(1); });
