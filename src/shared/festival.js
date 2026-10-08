'use strict';
/**
 * festival.js — 特殊節日（docs/festival-spec.md）
 *
 * 一張節日表 + 配件點陣 + 「把配件穿到角色身上」。daemon 合成畫面時用，
 * 廣場伺服器不需要它（伺服器只轉送每個人「要不要讓別人看到造型」的旗標）。
 *
 * 期間 = 節日當天往前 lead 天（預設 LEAD_DAYS）的 00:00 起，到節日當天再往後 after 天
 * （預設 0）的 23:59:59 止，**本機時區**。
 * 廣場那邊拿伺服器時間來判斷（daemon 傳 Date.now()+skew 進來），大家同一刻切換。
 */

const LEAD_DAYS = 7;

// 查表節日的國曆日期：農曆節日＋清明（節氣，4/4 或 4/5）。各年不同，沒有簡單規則可算。
// 2026-10-08 逐筆查核過：農曆對照網路行事曆、清明對照節氣時刻（換成 UTC+8）。
// 別改用 Intl 的 chinese 曆法自動算：新月剛好落在午夜附近的年份它會差一天
// （2027 春節 2/6、2030 春節 2/3，它算成 2/7、2/2）。
// 表用完前 test-festival 會先紅（見那邊的檢查），記得往後補。
const LUNAR = {
    lunarny:    { 2026: [2, 17], 2027: [2, 6],  2028: [1, 26], 2029: [2, 13], 2030: [2, 3]  },  // 春節（初一）
    lantern:    { 2026: [3, 3],  2027: [2, 20], 2028: [2, 9],  2029: [2, 27], 2030: [2, 17] },  // 元宵（正月十五）
    dragonboat: { 2026: [6, 19], 2027: [6, 9],  2028: [5, 28], 2029: [6, 16], 2030: [6, 5]  },  // 端午（五月初五）
    qixi:       { 2026: [8, 19], 2027: [8, 8],  2028: [8, 26], 2029: [8, 16], 2030: [8, 5]  },  // 七夕（七月初七）
    qingming:   { 2026: [4, 5],  2027: [4, 5],  2028: [4, 4],  2029: [4, 4],  2030: [4, 5]  },  // 清明（節氣）
    midautumn:  { 2026: [9, 25], 2027: [9, 15], 2028: [10, 3], 2029: [9, 22], 2030: [9, 12] },  // 中秋（八月十五）
};

// acc：這個節日的配件（ACC 的 key）。配件只有兩類（規格 §三）：帽子、背後插的東西（旗）。
// 國曆節日寫 month/day；農曆節日（和清明）寫 lunar: true，日期查 LUNAR。acc: null＝只換背景。
// 期間重疊時（例如 2027 春節跟情人節）看「離正日最近」的那個，見 active()。
const FESTIVALS = [
    { id: 'doubleten',  name: '雙十',   month: 10, day: 10, acc: 'rocflag' },
    { id: 'halloween',  name: '萬聖節', month: 10, day: 31, acc: 'witch' },
    { id: 'christmas',  name: '聖誕節', month: 12, day: 25, acc: 'santa' },
    // 跨年：期間開頭跟聖誕節重疊，聖誕節當天以前算聖誕（見 active），12/26 起才是跨年
    { id: 'newyear',    name: '跨年',   month: 1,  day: 1,  acc: 'party' },
    // 春節：除夕前一週起，過到初五
    { id: 'lunarny',    name: '春節',   lunar: true, acc: 'chun', after: 4 },
    { id: 'lantern',    name: '元宵',   lunar: true, acc: 'lantern' },
    { id: 'valentine',  name: '情人節', month: 2,  day: 14, acc: 'heart' },
    // 清明：掃墓的日子，不換造型，背景低調（毛毛雨＋柳枝）。只有當天和隔天 ——
    // 前一週都是兒童節；2028 兩個同一天，列在前面的清明贏（見 active 的平手規則）
    { id: 'qingming',   name: '清明',   lunar: true, acc: null, lead: 0, after: 1 },
    { id: 'children',   name: '兒童節', month: 4,  day: 4,  acc: 'propeller' },
    { id: 'dragonboat', name: '端午',   lunar: true, acc: 'dragon' },
    { id: 'qixi',       name: '七夕',   lunar: true, acc: 'flower' },
    { id: 'midautumn',  name: '中秋',   lunar: true, acc: 'pomelo' },
];

/** 某節日在某一年的期間 { start, end, day }（ms，end 不含）；農曆表查不到那一年 → null */
function windowOf(f, year) {
    let m = f.month, d = f.day;
    if (f.lunar) {
        const md = LUNAR[f.id] && LUNAR[f.id][year];
        if (!md) return null;
        [m, d] = md;
    }
    const lead = f.lead != null ? f.lead : LEAD_DAYS, after = f.after || 0;
    return {
        start: new Date(year, m - 1, d - lead).getTime(),
        end:   new Date(year, m - 1, d + after + 1).getTime(),   // 最後一天的隔天 00:00（不含）
        day:   new Date(year, m - 1, d).getTime(),
    };
}

/**
 * 這個時間點在哪個節日期間裡；不在任何節日 → null。override = 節日 id（預覽／測試用）。
 * 同時落在兩個節日裡 → 正日當天的贏（2029 情人節剛好是大年初二，不然整段被春節蓋掉）；
 * 再來是離正日近的（已經過了正日、還在 after 裡的算 0）；一樣近 → 先列的贏。
 */
function active(ms, override) {
    if (override) return FESTIVALS.find(f => f.id === override) || null;
    const y = new Date(ms).getFullYear();
    let best = null, bestD = Infinity;
    for (const f of FESTIVALS) {
        // 元旦的期間從前一年 12 月就開始 → 明年的也要看
        for (const yy of [y, y + 1]) {
            const w = windowOf(f, yy);
            if (!w || ms < w.start || ms >= w.end) continue;
            const dist = ms >= w.day && ms < w.day + 864e5 ? -1 : Math.max(0, w.day - ms);
            if (dist < bestD) { best = f; bestD = dist; }
        }
    }
    return best;
}

// ── 配件點陣 ─────────────────────────────────────────────────────────
// 每列一個字串，一個字 = 一個 dot；'.' 透明，其他字查 PAL。
const PAL = {
    K: [58, 40, 82],     // 巫師帽：深紫
    k: [92, 66, 124],    // 帽子亮面
    O: [240, 146, 40],   // 帽帶：南瓜橘
    B: [0, 56, 168],     // 國旗：藍
    W: [255, 255, 255],  // 國旗：白日／聖誕帽白邊
    R: [222, 32, 40],    // 國旗：紅／聖誕帽／燈籠
    P: [150, 120, 90],   // 旗桿
    G: [255, 204, 51],   // 金（春字斗方、燈籠穗、龍舟旗）
    M: [235, 80, 160],   // 派對帽：桃紅
    C: [80, 200, 220],   // 派對帽：青
    Y: [255, 230, 90],   // 黃（派對帽頂球、竹蜻蜓）
    H: [240, 60, 110],   // 愛心
    N: [60, 160, 80],    // 綠（龍舟旗、葉子）
    F: [255, 150, 190],  // 花：粉
    L: [214, 222, 110],  // 柚子皮：黃綠
    l: [245, 245, 215],  // 柚子皮內側：米白
    S: [110, 80, 50],    // 柚子蒂
    X: [34, 30, 30],     // 財神帽簷：黑
};
// 帽子：最後一列是帽簷，會疊在頭頂那一列上（看起來是戴著，不是浮著）。
// 尖端／裝飾往**右**歪＝朝左時的背後；朝右時左右翻。寬度 ≤ 7（財神帽的帽翅例外，9）。
// 旗（背後插的東西）：畫在旗桿頂端、往背後延伸，x=0 是緊貼旗桿那一格；朝右時翻面。
const ACC = {
    witch: { kind: 'hat', art: [     // 萬聖節：巫師帽
        '....K..',
        '...kK..',
        '..kKK..',
        '..kKKK.',
        '.OOOOO.',
        'KKKKKKK',
    ] },
    rocflag: { kind: 'flag', art: [  // 雙十：國旗（青天白日滿地紅），藍底白日靠旗桿
        'BBBRRR',
        'BWBRRR',
        'BBBRRR',
        'RRRRRR',
    ] },
    santa: { kind: 'hat', art: [     // 聖誕帽：尖端垂向背後、白毛球
        '.....W.',
        '....RR.',
        '...RRR.',
        '..RRRR.',
        '.RRRRR.',
        'WWWWWWW',
    ] },
    party: { kind: 'hat', art: [     // 跨年：條紋派對尖帽
        '...Y...',
        '...M...',
        '..MCM..',
        '..CMC..',
        '.MCMCM.',
        '.CMCMC.',
    ] },
    // 春節：財神帽（紅官帽、兩側金帽翅、頂上金珠、黑帽簷）。
    // ⚠️ 不要畫成「紅色長方形旗、靠旗桿那側一小塊金」—— 那就是五星旗的構圖（第一版就踩到）。
    // 帽翅一定要伸出帽子兩側（9 格寬）：只到 7 格的版本在角色頭上看不出是帽翅，像一頂小紅帽
    chun: { kind: 'hat', art: [
        '....G....',
        '..RRRRR..',
        'GGRRGRRGG',
        '..XXXXX..',
    ] },
    lantern: { kind: 'flag', art: [  // 元宵：竿子挑一盞紅燈籠
        'PPPP..',
        '...G..',
        '..RRR.',
        '.RRGRR',
        '.RRRRR',
        '..RRR.',
        '...G..',
    ] },
    heart: { kind: 'flag', art: [    // 情人節：愛心
        'HH.HH',
        'HHHHH',
        '.HHH.',
        '..H..',
    ] },
    propeller: { kind: 'hat', art: [ // 兒童節：竹蜻蜓帽
        '.YY.YY.',
        '...P...',
        '..RBY..',
        '.RRBYY.',
        'RRRBYYY',
    ] },
    dragon: { kind: 'flag', art: [   // 端午：龍舟三角令旗（綠底金邊）
        'GGGGGG',
        'GNNNG.',
        'GNNG..',
        'GG....',
    ] },
    flower: { kind: 'hat', art: [    // 七夕：花圈
        '.F.F.F.',
        'FNFNFNF',
    ] },
    pomelo: { kind: 'hat', art: [    // 中秋：柚子皮帽（經典梗）
        '...SN..',
        '..LLL..',
        '.LLLLL.',
        'LLLLLLL',
        'lllllll',
    ] },
};
ACC.hat = ACC.witch;       // 舊名（最早只有帽子、旗子各一種）
ACC.flag = ACC.rocflag;
const HAT = ACC.witch.art, FLAG = ACC.rocflag.art;
const FLAG_POLE_UP = 4;   // 旗桿頂超出頭頂幾個 dot
const HEAD_MIN = 5;       // 帽子要戴在至少這麼寬的一列上（見 dress）

const toDots = (art) => art.map(row => [...row].map(ch => (ch === '.' ? null : PAL[ch].slice())));
for (const a of Object.values(ACC)) if (!a.dots) a.dots = toDots(a.art);

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
    const a = acc && ACC[acc];
    const b = a && dots && bbox(dots);
    if (!b) return { dots, ox: 0, oy: 0 };
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

    if (a.kind === 'hat') {
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
        const hw = a.dots[0].length;
        // 尖端往後歪：朝右的時候「後」在左邊 → 左右翻
        const art = facing === 'right' ? a.dots.map(rw => rw.slice().reverse()) : a.dots;
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
        a.dots.forEach((rw, y) => rw.forEach((c, x) => {
            if (!c) return;
            const fx = back < 0 ? px - 1 - x : px + 1 + x;
            put(fx, topY + y, c, true);
        }));
    }
    return { dots: out, ox: -PAD, oy: -PAD };
}

module.exports = { FESTIVALS, LEAD_DAYS, LUNAR, ACC, active, windowOf, dress, bbox, HAT, FLAG, PAL };
