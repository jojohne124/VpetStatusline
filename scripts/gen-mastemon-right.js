#!/usr/bin/env node
'use strict';
/**
 * 產生 Mastemon 的面右幀（pixels.json frames 12..23、<i>_r.png、CutIn_r.png）。
 *
 * 她左半天使（白／銀／金髮／水藍）、右半惡魔（紫黑／黃綠／粉）。用 12 幀的左右
 * 分布統計（bias = (L-R)/(L+R) 逐色）分類，是很乾淨的三段式：
 *
 *      A=天使專屬(bias>=.7)  D=惡魔專屬(bias<=-.7)  -=兩側共用
 *       2 .AAAAAA------DD.
 *       9 .AAAAAAA----DDD.
 *      13 .AAAAA---DDD.DD.
 *
 * 這個左右分色是設計本身、不是視角，所以 runtime 的純鏡射（flipRows）會把黑白
 * 兩半互換 → 像換了一隻。做法比照 G-Greymon 的 _r：輪廓完全鏡射、再改色。
 *
 *   1. 建 天使色 <-> 惡魔色 換色表（FAMILIES）
 *   2. 把左向幀鏡射
 *   3. 對鏡射後的每一點套表
 *
 * 兩個方向的表不對稱，而且是**按落點半邊**選表：輸出 x < 半寬的點來自原圖右半
 * （惡魔），套 d2a；x >= 半寬 的點來自原圖左半（天使），套 a2d。這樣兩側共用的
 * 顏色也能分方向處理 —— 例如 63,55,67 在天使側要打亮、在惡魔側維持原色。
 *
 * ── 為什麼 d2a 比 a2d 亮：_r 面對玩家的是天使側，天使側要更白 ──
 * 惡魔半身本來就暗（平均 lum 70 vs 天使側 110），直接鏡射過來天使側會太多黑點。
 * 所以 d2a 的無彩階整體往上抬約兩階，並把原本「維持原色」的兩個純內部暗色
 * （63,55,67 110點、93,83,97 78點，都是 0% 輪廓）也納進來打亮。
 *
 * ── 但輪廓不能打亮 ──
 * 這個調色盤裡的黑框不是 0,0,0（只有 6 點），而是 22,17,24 / 30,41,46 /
 * 47,55,65 / 28,33,39 這些。22,17,24 有 44% 落在輪廓邊上（128 邊 / 166 內部），
 * 整批打亮框線就消失了。所以無彩色分 edge / inner 兩個目標：邊界一律換成
 * 30,41,46（天使側自己的框線色，66% 是輪廓），內部才打亮。
 * 有彩色（水藍↔粉、金髮↔黃綠）不分 edge，本來就不是框線。
 *
 * 用法：node scripts/gen-mastemon-right.js [--check]
 */
const fs   = require('fs');
const path = require('path');

const DIR   = path.join(__dirname, '..', 'characters', 'Mastemon');
const CHECK = process.argv.includes('--check');

const ANGEL_EDGE = '30,41,46';   // 天使側的框線色（151 邊 / 78 內部）
const DEVIL_EDGE = '22,17,24';   // 惡魔側的框線色（128 邊 / 166 內部）

// ── 1. 換色表 ─────────────────────────────────────────────────────────
// a2d：天使 → 惡魔（_r 的右半用）。同色系內按明暗排序、多對一。
// d2a：惡魔 → 天使（_r 的左半用）。整體比 a2d 亮兩階；無彩色另給 edge 目標。
const FAMILIES = [
    {
        name: '無彩（盔甲／衣體）',
        edgeAware: true,
        a2d: {
            '213,247,255': '47,55,65',  '221,233,239': '47,55,65',  '191,206,213': '47,55,65',
            '156,173,180': '41,35,44',  '167,166,162': '41,35,44',
            '132,131,127': '28,33,39',  '100,100,98':  '28,33,39',  '77,77,71':    '28,33,39',
            '69,46,41':    '57,0,12',
            '30,41,46':    '22,17,24',   // 各自的框線／暗底成對
        },
        d2a: {
            '47,55,65': '213,247,255',   // lum  54 → 238
            '63,55,67': '221,233,239',   //      59 → 230   （0% 輪廓，原本沒換）
            '93,83,97': '221,233,239',   //      88 → 230   （0% 輪廓，原本沒換）
            '53,53,53': '191,206,213',   //      53 → 202
            '41,35,44': '191,206,213',   //      38 → 202   （0% 輪廓）
            '28,33,39': '167,166,162',   //      32 → 166
            '22,17,24': '132,131,127',   //      19 → 131   （內部 166 點）
            '57,0,12':  '100,100,98',    //      18 → 100
        },
    },
    {
        name: '水藍 <-> 粉',
        a2d: {
            '179,226,236': '255,200,212', '141,232,255': '255,200,212',
            '78,201,232':  '206,73,115',
            '45,150,176':  '196,48,80',
            '31,115,135':  '139,30,53',   '0,64,79':     '139,30,53',
        },
        d2a: {
            '255,200,212': '141,232,255',
            '206,73,115':  '78,201,232',
            '196,48,80':   '45,150,176',
            '139,30,53':   '0,64,79',
        },
    },
    {
        name: '金髮 <-> 黃綠',
        a2d: {
            '252,241,181': '245,247,180', '255,232,93': '220,223,119', '203,181,56': '176,179,86',
        },
        d2a: {
            '245,247,180': '252,241,181', '220,223,119': '255,232,93', '176,179,86': '203,181,56',
            '85,87,24':    '203,181,56',   // 惡魔側多出來的暗階，天使側金髮沒有更暗的
        },
    },
];

// 兩個方向都不換：框線黑、膚色、嘴紅、青綠（棉被／下半身）、兩側都亮的粉。
// 臉就是臉，不分天使惡魔。
const KEEP = new Set([
    '0,0,0', '25,28,25',
    '255,235,231', '210,180,173', '149,111,102', '99,24,25', '165,36,41',
    '252,84,121', '255,141,166',
    '214,243,239', '165,206,206', '132,190,181', '82,117,115', '74,101,99',
]);

const A2D = new Map(), D2A = new Map(), EDGE_AWARE = new Set();
for (const fam of FAMILIES) {
    for (const [a, d] of Object.entries(fam.a2d)) A2D.set(a, d);
    for (const [d, a] of Object.entries(fam.d2a)) D2A.set(d, a);
    if (fam.edgeAware) {
        for (const k of Object.keys(fam.a2d)) EDGE_AWARE.add(k);
        for (const k of Object.keys(fam.d2a)) EDGE_AWARE.add(k);
    }
}

// cut-in 是 96x48、有自己一套 47 色（17 色不在角色調色盤裡），查不到就取 RGB
// 最近的表內色沿用它的配對；KEEP 也算候選，所以膚色類會正確地維持原色。
const CAND = [...new Set([...A2D.keys(), ...D2A.keys(), ...KEEP])]
    .map(k => ({ k, rgb: k.split(',').map(Number) }));
const nearestLog = new Map();
const unmapped = new Map();

// toDevil：這一點落在輸出的右半（來自原圖左半）→ 套 a2d；否則套 d2a。
// edge：這一點在鏡射後的輪廓邊上（無彩色才理它）。
function convert(c, toDevil, edge, allowNearest) {
    let k = c.join(',');
    if (!KEEP.has(k) && !A2D.has(k) && !D2A.has(k)) {
        if (!allowNearest) { unmapped.set(k, (unmapped.get(k) || 0) + 1); return c.slice(); }
        let best = null, bestD = Infinity;
        for (const cand of CAND) {
            const d = (cand.rgb[0]-c[0])**2 + (cand.rgb[1]-c[1])**2 + (cand.rgb[2]-c[2])**2;
            if (d < bestD) { bestD = d; best = cand.k; }
        }
        nearestLog.set(k, best);
        k = best;
    }
    if (KEEP.has(k)) return k.split(',').map(Number);
    if (edge && EDGE_AWARE.has(k)) return (toDevil ? DEVIL_EDGE : ANGEL_EDGE).split(',').map(Number);
    const t = (toDevil ? A2D : D2A).get(k);
    return (t || k).split(',').map(Number);
}

// ── 2+3. 鏡射，然後逐點換色（每點都有對應，不需要補色） ────────────────
function mirrorConvert(get, W, H, allowNearest) {
    const out = new Array(W * H).fill(null);
    const solid = (x, y) => !!get(x, y);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const sx = W - 1 - x;
        const c = get(sx, y);
        if (!c) continue;
        // 輪廓邊 = 鏡射後上下左右有一邊是空的（在來源座標上判斷，結果一樣）
        const edge = !solid(sx - 1, y) || !solid(sx + 1, y) || !solid(sx, y - 1) || !solid(sx, y + 1);
        out[y * W + x] = convert(c, x >= W / 2, edge, allowNearest);
    }
    return out;
}

// ── pixels.json 是權威來源（prepare 重跑不等於它，手調過）──────────────
const pxPath = path.join(DIR, 'pixels.json');
const px = JSON.parse(fs.readFileSync(pxPath, 'utf8'));
const N = px.width;
if (px.width !== px.height) { console.log(`pixels.json 不是正方 ${px.width}x${px.height}`); process.exit(1); }
const base = px.frames.slice(0, 12);
if (base.length !== 12) { console.log(`左向幀不是 12 幀（${base.length}）`); process.exit(1); }

const right = base.map(f => mirrorConvert((x, y) => (x < 0 || y < 0 || x >= N || y >= N) ? null : (f[y * N + x] || null), N, N, false));

if (unmapped.size) {
    console.log('⚠ 換色表沒收到的顏色（維持原色）：');
    for (const [k, n] of [...unmapped].sort((a, b) => b[1] - a[1])) console.log(`    ${k}  x${n}`);
}

// ── 亮度報表：_r 的天使側要比原圖天使側更亮 ────────────────────────────
function halfStats(frames, half) {
    const lum = c => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    let n = 0, sum = 0, white = 0, black = 0;
    for (const f of frames) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        if ((x < N / 2 ? 0 : 1) !== half) continue;
        const c = f[y * N + x]; if (!c) continue;
        const L = lum(c); n++; sum += L;
        if (L >= 150) white++;
        if (L < 60) black++;
    }
    return { n, mean: sum / n, white, black };
}
function report() {
    console.log('\n              點數  平均lum   亮點(>=150)    暗點(<60)');
    for (const [label, frames, half] of [
        ['原圖 天使側', base,  0], ['_r   天使側', right, 0],
        ['原圖 惡魔側', base,  1], ['_r   惡魔側', right, 1],
    ]) {
        const s = halfStats(frames, half);
        console.log(label.padEnd(13), String(s.n).padStart(4), s.mean.toFixed(1).padStart(8),
                    String(s.white).padStart(7) + ` (${(100*s.white/s.n).toFixed(0)}%)`,
                    String(s.black).padStart(7) + ` (${(100*s.black/s.n).toFixed(0)}%)`);
    }
}

if (CHECK) {
    const s = JSON.stringify;
    let shapeAll = 0, recAll = 0, totAll = 0;
    for (let i = 0; i < 12; i++) {
        const f = base[i], r = right[i];
        let shape = 0, rec = 0, tot = 0;
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
            const k = y * N + x, m = f[y * N + (N - 1 - x)] || null;
            if (!!m !== !!r[k]) shape++;
            else if (m) { tot++; if (s(m) !== s(r[k])) rec++; }
        }
        console.log(`frame ${String(i).padStart(2)}  輪廓差 ${shape}  同位置換色 ${String(rec).padStart(3)} / ${tot}`);
        shapeAll += shape; recAll += rec; totAll += tot;
    }
    console.log(`合計  輪廓差 ${shapeAll}  換色 ${recAll}/${totAll}`);
    console.log(`\na2d ${A2D.size} 條、d2a ${D2A.size} 條、維持原色 ${KEEP.size} 色`);
    console.log(`輪廓邊改用：天使側 ${ANGEL_EDGE}、惡魔側 ${DEVIL_EDGE}`);
    report();
    process.exit(0);
}

px.frames = base.concat(right);
fs.writeFileSync(pxPath, JSON.stringify(px));
console.log(`✓ pixels.json  ${px.frames.length} 幀`);
report();

// ── <i>_r.png：算好的 16x16 用 3x nearest 放大回 48x48（逐點可還原）─────
(async () => {
    const sharp = require('sharp');
    const BLOCK = 3, S = N * BLOCK;
    for (let i = 0; i < 12; i++) {
        const raw = Buffer.alloc(S * S * 4);
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
            const c = right[i][y * N + x];
            if (!c) continue;
            for (let dy = 0; dy < BLOCK; dy++) for (let dx = 0; dx < BLOCK; dx++) {
                const o = ((y * BLOCK + dy) * S + x * BLOCK + dx) * 4;
                raw[o] = c[0]; raw[o+1] = c[1]; raw[o+2] = c[2]; raw[o+3] = 255;
            }
        }
        await sharp(raw, { raw: { width: S, height: S, channels: 4 } })
            .png().toFile(path.join(DIR, `${i}_r.png`));
    }
    console.log(`\n✓ 0_r.png … 11_r.png（${S}x${S}）`);

    // ── CutIn_r.png：同一套表，96x48 逐點做，中間色用最近色配對 ──
    const cutP = path.join(DIR, 'cutin.png');
    if (fs.existsSync(cutP)) {
        const { data, info } = await sharp(cutP).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const W = info.width, H = info.height;
        const get = (x, y) => {
            if (x < 0 || y < 0 || x >= W || y >= H) return null;
            const i = (y * W + x) * 4;
            return data[i + 3] < 128 ? null : [data[i], data[i+1], data[i+2]];
        };
        const cells = mirrorConvert(get, W, H, true);
        const out = Buffer.alloc(W * H * 4);
        cells.forEach((c, k) => {
            if (!c) return;
            out[k*4] = c[0]; out[k*4+1] = c[1]; out[k*4+2] = c[2]; out[k*4+3] = 255;
        });
        await sharp(out, { raw: { width: W, height: H, channels: 4 } })
            .png().toFile(path.join(DIR, 'CutIn_r.png'));
        console.log(`✓ CutIn_r.png（${W}x${H}）  ${nearestLog.size} 個中間色用最近色配對`);
    }
})().catch(e => { console.log('✗ ' + e.message); process.exit(1); });
