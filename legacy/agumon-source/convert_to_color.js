const fs = require('fs');

// 讀取 prepare_frames_color.js 產生的 RGB 像素資料
const data = JSON.parse(fs.readFileSync('agumon_pixels_color.json', 'utf8'));
const { frames, width, height } = data; // 16×16 expected

console.log(`Converting ${frames.length} frames @ ${width}×${height} → half-block RGB...`);

// 每幀轉成 2D 陣列 [row][col] = cell
// cell = null（完全透明）或 [upR,upG,upB,loR,loG,loB]（上下各一個像素，null 用 -1 表示）
// 為 JSON 簡潔：每格存 6 個數字，null 通道用 -1 表示
function frameToCells(pixels, w, h) {
    const rows = [];
    for (let y = 0; y < h; y += 2) {
        const row = [];
        for (let x = 0; x < w; x++) {
            const up = pixels[y * w + x]       || null;
            const lo = pixels[(y + 1) * w + x] || null;
            if (!up && !lo) {
                row.push(null);
            } else {
                row.push([
                    up ? up[0] : -1, up ? up[1] : -1, up ? up[2] : -1,
                    lo ? lo[0] : -1, lo ? lo[1] : -1, lo ? lo[2] : -1,
                ]);
            }
        }
        rows.push(row);
    }
    return rows;
}

const artFrames = frames.map((p, i) => {
    const cells = frameToCells(p, width, height);
    console.log(`  Frame ${i}: ${cells.length} rows × ${cells[0].length} cols`);
    return cells;
});

fs.writeFileSync('agumon_art_color.json', JSON.stringify({
    style: 'color-halfblock',
    width: width,                // 每行 cells 數
    height: Math.ceil(height / 2), // 行數
    frames: artFrames,
}));

console.log(`\n完成 → agumon_art_color.json`);

// ── Preview：直接印出第 0 幀彩色 ANSI ────────────────────────────
function render(cells) {
    const R = '\x1b[0m';
    let out = '';
    for (const row of cells) {
        for (const c of row) {
            if (!c) { out += '\u2800'; continue; }
            const [ur, ug, ub, lr, lg, lb] = c;
            const upOk = ur >= 0, loOk = lr >= 0;
            if (upOk && loOk) {
                out += `\x1b[38;2;${ur};${ug};${ub}m\x1b[48;2;${lr};${lg};${lb}m\u2580${R}`;
            } else if (upOk) {
                out += `\x1b[38;2;${ur};${ug};${ub}m\u2580${R}`;
            } else if (loOk) {
                out += `\x1b[38;2;${lr};${lg};${lb}m\u2584${R}`;
            } else {
                out += '\u2800';
            }
        }
        out += '\n';
    }
    return out;
}

console.log('\n=== Frame 0 (NORMAL) 預覽 ===');
console.log(render(artFrames[0]));
console.log('=== Frame 11 (ROAR) 預覽 ===');
console.log(render(artFrames[11]));
