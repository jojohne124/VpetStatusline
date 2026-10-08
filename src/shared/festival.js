'use strict';
/**
 * festival.js — 特殊節日（docs/festival-spec.md）
 *
 * 一張節日表 + 配件點陣 + 「把配件穿到角色身上」。daemon 合成畫面時用，
 * 廣場伺服器不需要它（伺服器只轉送每個人「要不要讓別人看到造型」的旗標）。
 *
 * 期間 = 節日當天往前 LEAD_DAYS 天的 00:00 起，到節日當天 23:59:59 止，**本機時區**。
 * 廣場那邊拿伺服器時間來判斷（daemon 傳 Date.now()+skew 進來），大家同一刻切換。
 */

const LEAD_DAYS = 7;

// acc：這個節日的配件。從簡（規格 §三）：只有帽子、背後插旗兩種。
// 加節日就加一行；同一天撞到兩個節日時，先列的贏。
const FESTIVALS = [
    { id: 'doubleten', name: '雙十', month: 10, day: 10, acc: 'flag' },
    { id: 'halloween', name: '萬聖節', month: 10, day: 31, acc: 'hat' },
];

function windowOf(f, year) {
    const end   = new Date(year, f.month - 1, f.day + 1).getTime();          // 隔天 00:00（不含）
    const start = new Date(year, f.month - 1, f.day - LEAD_DAYS).getTime();
    return { start, end };
}

/** 這個時間點在哪個節日期間裡；不在任何節日 → null。override = 節日 id（預覽／測試用）。 */
function active(ms, override) {
    if (override) return FESTIVALS.find(f => f.id === override) || null;
    const y = new Date(ms).getFullYear();
    for (const f of FESTIVALS) {
        // 跨年的節日（例如 1/3 的節日，期間從前一年 12/27 開始）兩個年份都要看
        for (const yy of [y, y + 1]) {
            const w = windowOf(f, yy);
            if (ms >= w.start && ms < w.end) return f;
        }
    }
    return null;
}

// ── 配件點陣 ─────────────────────────────────────────────────────────
// 每列一個字串，一個字 = 一個 dot；'.' 透明，其他字查 PAL。
const PAL = {
    K: [58, 40, 82],     // 巫師帽：深紫
    k: [92, 66, 124],    // 帽子亮面
    O: [240, 146, 40],   // 帽帶：南瓜橘
    B: [0, 56, 168],     // 國旗：藍
    W: [255, 255, 255],  // 國旗：白日
    R: [222, 32, 40],    // 國旗：紅
    P: [150, 120, 90],   // 旗桿
};
// 巫師帽：尖端往後歪一格。最後一列是帽簷，會疊在頭頂第一列上（看起來是戴著，不是浮著）。
const HAT = [
    '....K..',
    '...kK..',
    '..kKK..',
    '..kKKK.',
    '.OOOOO.',
    'KKKKKKK',
];
// 國旗（青天白日滿地紅）：6x4，左上角是藍底白日。朝右的版本；插在背後時依朝向翻面。
const FLAG = [
    'BBBRRR',
    'BWBRRR',
    'BBBRRR',
    'RRRRRR',
];
const FLAG_POLE_UP = 4;   // 旗桿頂超出頭頂幾個 dot
const HEAD_MIN = 5;       // 帽子要戴在至少這麼寬的一列上（見 dress）

const toDots = (art) => art.map(row => [...row].map(ch => (ch === '.' ? null : PAL[ch].slice())));
const HAT_DOTS  = toDots(HAT);
const FLAG_DOTS = toDots(FLAG);

/** 不透明 dot 的外框；全透明 → null */
function bbox(dots) {
    let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
    dots.forEach((row, y) => row.forEach((c, x) => {
        if (!c) return;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
    }));
    return maxX < 0 ? null : { minX, maxX, minY, maxY };
}

/**
 * 把配件穿到一幀角色 dot 圖上。回傳 { dots, ox, oy }：配件會超出原本 16x16，
 * 所以回一張比較大的圖，(ox, oy) 是它相對原圖左上角的位移（負的）。
 *
 * 位置**每一幀現找**（頭頂 = 最上面那列不透明的 dot），不是每隻角色手調 ——
 * 一百多隻角色、每隻好幾幀，手調不可能維護；待機兩幀身體上下動，帽子要跟著動。
 *
 *   hat ：帽子置中在頭頂那一列的不透明範圍上，帽簷蓋住頭頂第一列。
 *   flag：旗桿插在**背後**（朝右時在左緣、朝左時在右緣），從身體中段往上超出頭頂，
 *         旗面往背後飄。整支畫在角色**後面**（只填透明的地方），不會蓋到身體。
 */
function dress(dots, acc, facing) {
    const b = dots && bbox(dots);
    if (!b || (acc !== 'hat' && acc !== 'flag')) return { dots, ox: 0, oy: 0 };
    const PAD = 8;
    const h = dots.length, w = dots[0].length;
    const out = [];
    for (let y = 0; y < h + PAD * 2; y++) out.push(new Array(w + PAD * 2).fill(null));
    const put = (x, y, c, under) => {
        const row = out[y + PAD]; if (!row) return;
        const X = x + PAD; if (X < 0 || X >= row.length) return;
        if (under && row[X]) return;
        row[X] = c;
    };
    dots.forEach((row, y) => row.forEach((c, x) => { if (c) put(x, y, c); }));

    if (acc === 'hat') {
        // 頭頂 = 由上往下第一列「連續不透明 ≥ HEAD_MIN 格」的那一段。不能直接用最上面那列：
        // 有角、有耳朵的角色（加布獸）最上面只有角尖一兩格，帽子會頂在角尖上（預覽看過）。
        // 整張都沒有夠寬的列（很細長的角色）就退回最上面那列。
        let hy = b.minY, l = -1, r = -1;
        for (let y = b.minY; y <= b.maxY && l < 0; y++) {
            let s = -1;
            for (let x = 0; x <= w; x++) {
                const on = x < w && dots[y][x];
                if (on && s < 0) s = x;
                if (!on && s >= 0) {
                    if (x - s >= HEAD_MIN && (l < 0 || x - 1 - s > r - l)) { l = s; r = x - 1; hy = y; }
                    s = -1;
                }
            }
        }
        if (l < 0) {
            dots[b.minY].forEach((c, x) => { if (c) { if (l < 0) l = x; r = x; } });
            hy = b.minY;
        }
        const cx = Math.round((l + r) / 2);
        const hw = HAT_DOTS[0].length;
        // 尖端往後歪：朝右的時候「後」在左邊 → 左右翻
        const art = facing === 'right' ? HAT_DOTS.map(rw => rw.slice().reverse()) : HAT_DOTS;
        const x0 = cx - Math.floor(hw / 2), y0 = hy - (art.length - 1);
        art.forEach((rw, y) => rw.forEach((c, x) => { if (c) put(x0 + x, y0 + y, c); }));
    } else {
        // 朝右 → 背在左邊。旗桿往身體裡收一格，看起來是插著而不是貼在旁邊。
        const back = facing === 'right' ? -1 : 1;
        const px = back < 0 ? b.minX + 1 : b.maxX - 1;
        const topY = b.minY - FLAG_POLE_UP;
        const botY = Math.round((b.minY + b.maxY) / 2);
        for (let y = topY; y <= botY; y++) put(px, y, PAL.P, true);
        // 旗面掛在桿子頂端、往背後飄；朝右時翻面，藍底白日永遠靠旗桿那一側
        FLAG_DOTS.forEach((rw, y) => rw.forEach((c, x) => {
            if (!c) return;
            const fx = back < 0 ? px - 1 - x : px + 1 + x;
            put(fx, topY + y, c, true);
        }));
    }
    return { dots: out, ox: -PAD, oy: -PAD };
}

module.exports = { FESTIVALS, LEAD_DAYS, active, windowOf, dress, bbox, HAT, FLAG, PAL };
