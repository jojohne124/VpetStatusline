#!/usr/bin/env node
'use strict';
/*
 * gen-tray-icon.js — 從角色 idle 幀產生工作列 tray 圖示 tools/vpet.ico
 *
 * 用法：node scripts/gen-tray-icon.js [角色資料夾名]   （預設 Agumon）
 *
 * 為什麼要自己組 ICO：sharp 不支援 ico 輸出。但 Vista 以後的 ICO 允許直接內嵌 PNG，
 * 容器只有 6 bytes 檔頭 + 16 bytes 目錄項，手工組裝即可（比拉一個 ico 套件划算）。
 *
 * art.json 的每個 cell = 上下兩個像素（[ur,ug,ub,lr,lg,lb]，-1 = 透明），
 * 所以 16 cells × 8 rows 展開就是 16×16 像素。放大 ×2 成 32×32 給 tray 用。
 */
const fs   = require('fs');
const path = require('path');
const sharp = require('sharp');

const REPO = path.resolve(__dirname, '..');
const CHAR = process.argv[2] || 'Agumon';
const OUT  = path.join(REPO, 'tools', 'vpet.ico');
const SCALE = 2;                     // 16×16 → 32×32

function main() {
    const artPath = path.join(REPO, 'characters', CHAR, 'art.json');
    const cfgPath = path.join(REPO, 'characters', CHAR, 'config.json');
    const art = JSON.parse(fs.readFileSync(artPath, 'utf8'));
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const idle = (cfg.frames && cfg.frames.IDLE_1) ?? 0;
    const rows = art.frames[idle];
    if (!rows) throw new Error(`${CHAR} 沒有 IDLE_1 幀`);

    const W = rows[0].length;        // 16 cells
    const H = rows.length * 2;       // 8 rows × 上下 = 16 px
    const px = Buffer.alloc(W * H * 4, 0);   // RGBA，預設全透明
    for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < rows[r].length; c++) {
            const cell = rows[r][c];
            if (!cell) continue;
            const put = (y, R, G, B) => {
                if (R < 0) return;                       // -1 = 透明
                const i = ((y * W) + c) * 4;
                px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = 255;
            };
            put(r * 2,     cell[0], cell[1], cell[2]);   // 上半
            put(r * 2 + 1, cell[3], cell[4], cell[5]);   // 下半
        }
    }

    sharp(px, { raw: { width: W, height: H, channels: 4 } })
        .resize(W * SCALE, H * SCALE, { kernel: 'nearest' })   // 保持像素感
        .png()
        .toBuffer()
        .then(png => {
            const w = W * SCALE, h = H * SCALE;
            const header = Buffer.alloc(6);
            header.writeUInt16LE(0, 0);       // reserved
            header.writeUInt16LE(1, 2);       // type = icon
            header.writeUInt16LE(1, 4);       // 1 張圖
            const dir = Buffer.alloc(16);
            dir[0] = w >= 256 ? 0 : w;        // 寬（256 以 0 表示）
            dir[1] = h >= 256 ? 0 : h;        // 高
            dir[2] = 0;                       // 調色盤數
            dir[3] = 0;                       // reserved
            dir.writeUInt16LE(1, 4);          // color planes
            dir.writeUInt16LE(32, 6);         // bpp
            dir.writeUInt32LE(png.length, 8); // 資料大小
            dir.writeUInt32LE(22, 12);        // 資料位移 = 6 + 16
            fs.mkdirSync(path.dirname(OUT), { recursive: true });
            fs.writeFileSync(OUT, Buffer.concat([header, dir, png]));
            console.log(`✓ ${OUT}  (${CHAR} IDLE_1 → ${w}×${h}, ${png.length} bytes PNG)`);
        })
        .catch(e => { console.error('產生失敗：' + e.message); process.exit(1); });
}
main();
