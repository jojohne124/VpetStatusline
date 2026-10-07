#!/usr/bin/env node
'use strict';
/*
 * gen-plaza-icon.js — 產生廣場伺服器的 tray 圖示 tools/plaza.ico
 *
 * 用法：node scripts/gen-plaza-icon.js
 *
 * 跟 vpet.ico（角色臉）刻意不同：工作列上兩顆圖示要一眼分得出哪顆是桌寵、哪顆是廣場。
 * 圖是手畫的 16x16 點陣（下面的 ART），放大 x2 成 32x32。
 * 零相依：PNG 用 node 內建 zlib 組，ICO 直接內嵌 PNG（Vista 以後支援，同 gen-tray-icon.js）。
 */
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT   = path.join(__dirname, '..', 'tools', 'plaza.ico');
const SCALE = 2;

// 一座有柱子的小廣場建築。'.' = 透明
const ART = [
    '.......DD.......',
    '.....DDRRDD.....',
    '...DDRRRRRRDD...',
    '.DDRRRRRRRRRRDD.',
    'DRRRRRRRRRRRRRRD',
    'DDDDDDDDDDDDDDDD',
    '.DBBBBBBBBBBBBD.',
    '..WS.WS..WS.WS..',
    '..WS.WS..WS.WS..',
    '..WS.WS..WS.WS..',
    '..WS.WS..WS.WS..',
    '..WS.WS..WS.WS..',
    '.DBBBBBBBBBBBBD.',
    'DBBBBBBBBBBBBBBD',
    'DDDDDDDDDDDDDDDD',
    '................',
];
const PAL = {
    R: [232, 163, 61],    // 屋頂
    W: [240, 240, 240],   // 柱子亮面
    S: [185, 194, 207],   // 柱子暗面
    B: [139, 148, 158],   // 台基
    D: [45, 51, 59],      // 輪廓
};

function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
        raw[y * (w * 4 + 1)] = 0;   // filter: none
        rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGBA
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const N = 16 * SCALE;
const px = Buffer.alloc(N * N * 4, 0);
ART.forEach((row, y) => [...row].forEach((ch, x) => {
    const c = PAL[ch]; if (!c) return;
    for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) {
        const i = ((y * SCALE + dy) * N + (x * SCALE + dx)) * 4;
        px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
}));
const img = png(N, N, px);
const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
const dir = Buffer.alloc(16);
dir[0] = N; dir[1] = N; dir[2] = 0; dir[3] = 0;
dir.writeUInt16LE(1, 4); dir.writeUInt16LE(32, 6);
dir.writeUInt32LE(img.length, 8); dir.writeUInt32LE(22, 12);
fs.writeFileSync(OUT, Buffer.concat([head, dir, img]));
console.log('已產生 ' + OUT);
