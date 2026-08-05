#!/usr/bin/env node
/*
 * make-bg.js — 把任意照片轉成 daemon 舞台的底圖（彩度極低的灰白紋理）。
 *
 * 用法：
 *   node scripts/make-bg.js <照片路徑> [選項]
 *   node scripts/make-bg.js photo.jpg --mode light          # 灰白面板（比照原版）
 *   node scripts/make-bg.js photo.jpg --mode dark           # 深色底紋（配深色 UI）
 *   node scripts/make-bg.js photo.jpg --lo 200 --hi 240     # 自訂亮度帶
 *   node scripts/make-bg.js photo.jpg --pos top --blur 3
 *   node scripts/make-bg.js photo.jpg --out preview.png     # 不覆蓋正式底圖，只產預覽
 *
 * 為什麼不是單純 grayscale：
 *   去彩度只拿掉顏色，亮度仍是 0–255 全域。照片放在角色後面時，亮處會把角色的黑描邊
 *   吃掉（跟當初純黑背景吃掉描邊是同一個問題，只是反過來）。真正讓照片退成「紋理」的
 *   是把亮度壓進一個窄帶 —— lo/hi 就是那個帶。blur 則是殺掉高頻細節，否則照片的細紋
 *   會跟 8x8 的像素塊互相打架。
 *
 * 預設輸出到 ~/.claude/agumon-statusline/bg.png；daemon 偵測到就用，沒有就維持純色。
 */
const sharp = require('sharp');
const path  = require('path');
const os    = require('os');
const fs    = require('fs');

const DEFAULT_OUT = path.join(os.homedir(), '.claude', 'agumon-statusline', 'bg.png');

// 舞台最大 736x144（SU 五格進化樹）。輸出 2x 讓高 DPI 螢幕不糊；
// 圖本身低對比又模糊，PNG 壓縮率很高，2x 也不會大到哪去。
const OUT_W = 1472, OUT_H = 288;

// 亮度帶預設值。light = 比照原版的灰白面板；dark = 配現行深色 UI 的暗紋理。
const MODES = {
    light: { lo: 205, hi: 235 },
    dark:  { lo: 20,  hi: 45  },
};

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

async function main() {
    const src = process.argv[2];
    if (!src || src.startsWith('--')) {
        console.log('用法：node scripts/make-bg.js <照片路徑> [--mode light|dark] [--lo N] [--hi N] [--blur N] [--sat N] [--pos center|top|bottom] [--out 路徑]');
        process.exit(1);
    }
    if (!fs.existsSync(src)) { console.log(`找不到照片：${src}`); process.exit(1); }

    const mode = arg('mode', 'light');
    const base = MODES[mode] || MODES.light;
    const lo   = +arg('lo', base.lo);
    const hi   = +arg('hi', base.hi);
    const blur = +arg('blur', 2);
    const sat  = +arg('sat', 0.08);      // 0 = 全灰；留一點點才不會死板
    const pos  = arg('pos', 'center');
    const out  = path.resolve(arg('out', DEFAULT_OUT));

    // out = a*in + b：把 0–255 壓進 lo–hi
    const a = (hi - lo) / 255, b = lo;

    fs.mkdirSync(path.dirname(out), { recursive: true });
    const meta = await sharp(src).metadata();

    await sharp(src)
        .resize(OUT_W, OUT_H, { fit: 'cover', position: pos })
        .blur(blur > 0 ? blur : undefined)
        .modulate({ saturation: sat })     // 彩度極低（不是全灰）
        .linear(a, b)                      // 壓縮亮度帶 ← 關鍵
        .png({ compressionLevel: 9 })
        .toFile(out);

    const kb = (fs.statSync(out).size / 1024).toFixed(0);
    console.log(`✅ ${path.basename(out)}  ${OUT_W}x${OUT_H}  ${kb} KB`);
    console.log(`   來源 ${meta.width}x${meta.height} → cover/${pos}`);
    console.log(`   mode=${mode}  亮度帶 ${lo}–${hi}  blur=${blur}  彩度=${sat}`);
    console.log(`   → ${out}`);
}

main().catch(e => { console.log('失敗：' + e.message); process.exit(1); });
