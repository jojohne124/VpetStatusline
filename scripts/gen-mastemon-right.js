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
 * 左三分之一、右三分之一各有專屬色階，中間是共用的輪廓／膚色／陰影。這個左右
 * 分色是設計本身、不是視角，所以 runtime 的純鏡射會把黑白兩半互換 → 像換了一隻。
 *
 * 做法（比照 G-Greymon 的 _r：輪廓完全鏡射、再改色）：
 *   1. 建立 天使色 <-> 惡魔色 換色表（FAMILIES）
 *   2. 把左向幀鏡射
 *   3. 對鏡射後的每一點套換色表
 * 專屬色階因此換回原本那半邊，而姿勢是真的翻過去的。
 *
 * 換色表怎麼來的：先試「同幀鏡射位置的顏色」做結構對應，只有 47,55,65 <-> 213,247,255
 * 一組高信心（22/90）—— 兩半邊不是逐部位對稱。惡魔側無彩只有 4 階、天使側 10 階，
 * 所以其餘用「同色系內明暗排序」配對（多對一；G-Greymon 的表也是這樣，
 * 247,154,41 和 247,178,41 都併到 115,117,132）。
 * 反向（惡魔→天使）取該階「像素數最多」的那一色當代表 —— 用第一色會挑到
 * 69,46,41(棕,77px) 而不是 30,41,46(暗底,229px)，畫面會冒出一堆棕色塊。
 *
 * 用法：node scripts/gen-mastemon-right.js [--check]
 */
const fs   = require('fs');
const path = require('path');

const DIR   = path.join(__dirname, '..', 'characters', 'Mastemon');
const CHECK = process.argv.includes('--check');

// ── 1. 換色表：同色系內按明暗排序配對（括號是 lum） ────────────────────
// angel 由亮到暗、devil 由亮到暗；groups 把 angel 切成 devil 階數那麼多組。
const FAMILIES = [
    {
        name:  '無彩（盔甲／衣體）',
        angel: ['213,247,255', '221,233,239', '191,206,213',    // 238 230 202
                '156,173,180', '167,166,162',                   // 169 166
                '132,131,127', '100,100,98', '77,77,71',        // 131 100  76
                '69,46,41',    '30,41,46'],                     //  52  38
        devil: ['47,55,65', '41,35,44', '28,33,39', '57,0,12'],  //  54  38  32  18
        groups: [3, 2, 3, 2],
    },
    {
        name:  '水藍 <-> 粉',
        angel: ['179,226,236', '141,232,255',                   // 213 207
                '78,201,232',                                   // 168
                '45,150,176',                                   // 122
                '31,115,135', '0,64,79'],                       //  92  47
        devil: ['255,200,212', '206,73,115', '196,48,80', '139,30,53'],  // 218 118 96 65
        groups: [2, 1, 1, 2],
    },
    {
        name:  '金髮 <-> 黃綠',
        angel: ['252,241,181', '255,232,93', '203,181,56'],     // 237 223 173
        devil: ['245,247,180', '220,223,119', '176,179,86'],    // 239 210 168
        groups: [1, 1, 1],
        // 85,87,24（lum 79）是惡魔側多出來的暗階，天使側金髮沒有更暗的 → 併到最暗那階
        devilExtra: { '85,87,24': '203,181,56' },
    },
];

// 兩側共用、換了會壞掉的：輪廓黑、共用陰影、膚色、嘴紅。臉就是臉，不分天使惡魔。
const KEEP = new Set([
    '0,0,0', '22,17,24', '63,55,67', '53,53,53', '93,83,97', '74,101,99',
    '214,243,239', '165,206,206', '132,190,181', '82,117,115',
    '255,235,231', '210,180,173', '149,111,102', '99,24,25', '165,36,41',
    '252,84,121', '255,141,166', '25,28,25',
]);

// ── pixels.json 是權威來源（prepare 重跑不等於它，手調過）──────────────
const pxPath = path.join(DIR, 'pixels.json');
const px = JSON.parse(fs.readFileSync(pxPath, 'utf8'));
const N = px.width;
if (px.width !== px.height) { console.log(`pixels.json 不是正方 ${px.width}x${px.height}`); process.exit(1); }
const base = px.frames.slice(0, 12);
if (base.length !== 12) { console.log(`左向幀不是 12 幀（${base.length}）`); process.exit(1); }

// 各色像素數 —— 反向對應要用它挑代表色
const COUNT = new Map();
for (const f of base) for (const c of f) if (c) { const k = c.join(','); COUNT.set(k, (COUNT.get(k) || 0) + 1); }

const TABLE = new Map();
for (const fam of FAMILIES) {
    let i = 0;
    fam.groups.forEach((count, tier) => {
        const tierAngel = fam.angel.slice(i, i + count);
        for (const a of tierAngel) TABLE.set(a, fam.devil[tier]);            // 天使 → 惡魔
        // 惡魔 → 天使：取該階像素數最多的那一色
        const rep = tierAngel.reduce((b, a) => (COUNT.get(a) || 0) > (COUNT.get(b) || 0) ? a : b);
        if (!TABLE.has(fam.devil[tier])) TABLE.set(fam.devil[tier], rep);
        i += count;
    });
    if (i !== fam.angel.length) throw new Error(`${fam.name}: groups 加總 ${i} 不等於 angel ${fam.angel.length}`);
    for (const [d, a] of Object.entries(fam.devilExtra || {})) TABLE.set(d, a);
}

// cut-in 是 96x48、有自己一套 47 色（17 色不在角色調色盤裡），查不到就取
// RGB 最近的表內色沿用它的配對；KEEP 也算候選，所以膚色類會正確地維持原色。
const CAND = [...[...TABLE.keys()], ...KEEP].map(k => ({ k, rgb: k.split(',').map(Number) }));
const nearestLog = new Map();
function convert(c, allowNearest) {
    const k = c.join(',');
    if (KEEP.has(k)) return c.slice();
    const t = TABLE.get(k);
    if (t) return t.split(',').map(Number);
    if (!allowNearest) { unmapped.set(k, (unmapped.get(k) || 0) + 1); return c.slice(); }
    let best = null, bestD = Infinity;
    for (const { k: kk, rgb } of CAND) {
        const d = (rgb[0]-c[0])**2 + (rgb[1]-c[1])**2 + (rgb[2]-c[2])**2;
        if (d < bestD) { bestD = d; best = kk; }
    }
    nearestLog.set(k, best);
    const mapped = TABLE.get(best);
    return mapped ? mapped.split(',').map(Number) : c.slice();
}
const unmapped = new Map();

// ── 2+3. 鏡射，然後逐點換色（每點都有對應，不需要補色） ────────────────
function mirrorConvert(get, W, H, allowNearest) {
    const out = new Array(W * H).fill(null);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const c = get(W - 1 - x, y);
        out[y * W + x] = c ? convert(c, allowNearest) : null;
    }
    return out;
}

const right = base.map(f => mirrorConvert((x, y) => f[y * N + x] || null, N, N, false));

if (unmapped.size) {
    console.log('⚠ 換色表沒收到的顏色（維持原色）：');
    for (const [k, n] of [...unmapped].sort((a, b) => b[1] - a[1])) console.log(`    ${k}  x${n}`);
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
    console.log(`\n換色表 ${TABLE.size} 條：`);
    for (const [a, d] of TABLE) console.log(`    ${a.padEnd(14)} -> ${d}`);
    console.log(`維持原色 ${KEEP.size} 色`);
    process.exit(0);
}

px.frames = base.concat(right);
fs.writeFileSync(pxPath, JSON.stringify(px));
console.log(`✓ pixels.json  ${px.frames.length} 幀`);

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
    console.log(`✓ 0_r.png … 11_r.png（${S}x${S}）`);

    // ── CutIn_r.png：同一張表，96x48 逐點做，中間色用最近色配對 ──
    const cutP = path.join(DIR, 'cutin.png');
    if (fs.existsSync(cutP)) {
        const { data, info } = await sharp(cutP).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const W = info.width, H = info.height;
        const get = (x, y) => {
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
        console.log(`✓ CutIn_r.png（${W}x${H}）  ${nearestLog.size} 個中間色用最近色配對：`);
        for (const [k, near] of nearestLog) console.log(`    ${k.padEnd(14)} ~ ${near.padEnd(14)} -> ${TABLE.get(near) || '(維持原色)'}`);
    }
})().catch(e => { console.log('✗ ' + e.message); process.exit(1); });
