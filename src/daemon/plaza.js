'use strict';
/**
 * plaza.js — 廣場的合成與後端客戶端
 *
 * 刻意獨立於 daemon.js（見 docs/plaza-spec.md §七的警告）：daemon.js 已經很長且內嵌
 * 一大段 HTML template，廣場的邏輯全部塞進去會重蹈「什麼都往 daemon.js 丟」的覆轍。
 * daemon.js 只負責模式切換與 HTTP 路由，實際的「畫出廣場」在這裡。
 *
 * 走路演算法不在這裡 —— 在 src/shared/plaza-walk.js，因為那份要與（未來的）
 * 伺服器共用同一份程式碼才能保證每個 client 算出同一個畫面。
 */
const fs   = require('fs');
const path = require('path');       // 讀 assets/yard-layouts.json（編輯器存的自訂切法）
const W  = require('../shared/plaza-walk.js');
const FEST = require('../shared/festival.js');   // 節日配件（帽子／背後插旗）

// ── dot ↔ cell 轉換 ──────────────────────────────────────────────────
// 既有的美術資料都是 cell 格式（1 cell = 1 dot 寬 × 2 dot 高，[ur,ug,ub,lr,lg,lb]，
// -1 = 透明）。但廣場要把 sprite 貼到任意 y，y 是奇數時 sprite 會跨半個 cell ——
// 直接在 cell 層貼會遇到「半格」問題。
//
// 解法是整個合成過程改在 **dot 層**做：先把每個 sprite 拆成 dot、貼到 dot 緩衝、
// 最後才打包回 cell。這樣 y 的奇偶完全不需要特別處理，代價只是多一次轉換。
// 若改用「y 只能是偶數」來迴避，垂直移動的最小單位會變成 2 dot（16 px），
// 跟水平的 1 dot 不對稱，走起來會怪。

/** cell rows -> dots[y][x] = [r,g,b] | null */
function cellsToDots(rows) {
    const dots = [];
    for (const row of rows) {
        const up = [], lo = [];
        for (const c of row) {
            if (!c) { up.push(null); lo.push(null); continue; }
            up.push(c[0] >= 0 ? [c[0], c[1], c[2]] : null);
            lo.push(c[3] >= 0 ? [c[3], c[4], c[5]] : null);
        }
        dots.push(up, lo);
    }
    return dots;
}

/** dots[y][x] -> cell rows（高度奇數時補一列透明） */
function dotsToCells(dots, w) {
    const rows = [];
    for (let y = 0; y < dots.length; y += 2) {
        const up = dots[y] || [], lo = dots[y + 1] || [];
        const row = [];
        for (let x = 0; x < w; x++) {
            const u = up[x] || null, l = lo[x] || null;
            row.push((!u && !l) ? null
                : [u ? u[0] : -1, u ? u[1] : -1, u ? u[2] : -1,
                   l ? l[0] : -1, l ? l[1] : -1, l ? l[2] : -1]);
        }
        rows.push(row);
    }
    return rows;
}

/**
 * 把 src dot 圖貼到 dst，透明處不覆蓋（painter's algorithm 的一筆）。
 *
 * owner 是可選的同尺寸「這個 dot 是誰畫的」緩衝。名牌要判斷自己有沒有被別人擋住
 * 就得知道這件事 —— 光看顏色分不出「這裡本來就是我的黑邊」還是「被前面的人蓋掉了」。
 */
function blit(dst, src, ox, oy, owner, id) {
    for (let y = 0; y < src.length; y++) {
        const ty = oy + y;
        if (ty < 0 || ty >= dst.length) continue;
        const srow = src[y], drow = dst[ty];
        for (let x = 0; x < srow.length; x++) {
            const px = srow[x];
            if (!px) continue;                 // 透明 -> 保留下層
            const tx = ox + x;
            if (tx < 0 || tx >= drow.length) continue;
            drow[tx] = px;
            if (owner) owner[ty][tx] = id;
        }
    }
}

// ── 角色美術 ─────────────────────────────────────────────────────────
// 別人養的角色本機可能沒有（新版才加的、或客製角色）→ 沿用 PvP 已經解過的黑影
// fallback，讀不到就用 Shadow 剪影，不要拒絕顯示。
const _artCache = new Map();

function loadArt(core, charId) {
    if (_artCache.has(charId)) return _artCache.get(charId);
    let out = null;
    for (const id of [charId, 'shadow']) {
        try {
            const ch  = core.loadCharacter(id);
            const art = JSON.parse(fs.readFileSync(ch.artFile, 'utf8'));
            out = { art, rightOffset: ch.charDef.RIGHT_OFFSET, F: ch.charDef.F,
                    shadow: id !== charId };
            break;
        } catch (e) { /* 下一個候選 */ }
    }
    _artCache.set(charId, out);
    return out;
}

/**
 * 某人在這一拍該用哪一幀的 dot 圖（含左右翻面）。
 *
 * IDLE_1 / IDLE_2 一律交替，**停下來時也照演**。初版停下時鎖 IDLE_1，
 * 結果是角色連動畫都停掉，看起來像整個畫面當掉而不是「站著休息」——
 * 家裡的桌寵沒走動時也是持續交替的，這裡沿用同一個處理。
 */
/**
 * @param {string|null} react 表情幀名（'HAPPY' / 'REFUSE' …）。給就蓋掉待機動畫，
 *   讓營地的摸摸能有反應。查不到那個幀就退回待機 —— 有些角色的美術不完整，
 *   寧可沒反應也不要畫出錯幀。
 */
function spriteDots(core, charId, step, facing, react) {
    const a = loadArt(core, charId);
    if (!a) return null;
    const F = a.F || {};
    // BATTLE（廣場對戰中）：IDLE_1 跟 ANGRY 一拍一換，一直循環 —— 兩隻對峙。
    // 沒有 ANGRY 幀的角色退回 IDLE_1（跟前線的戰鬥演出同一個退法，見 core 的 safeF）
    if (react === 'BATTLE') {
        const angry = F.ANGRY != null ? F.ANGRY : F.IDLE_1;
        const rows = core.getFacingRows(a.art, (step % 2 === 0 ? F.IDLE_1 : angry) ?? 0, facing, a.rightOffset);
        return rows ? cellsToDots(rows) : null;
    }
    const forced = react && F[react] != null ? F[react] : null;
    const frameIdx = forced != null ? forced : (step % 2 === 0 ? F.IDLE_1 : F.IDLE_2);
    const rows = core.getFacingRows(a.art, frameIdx ?? 0, facing, a.rightOffset);
    return rows ? cellsToDots(rows) : null;
}

// ── 合成 ─────────────────────────────────────────────────────────────
const R = '\x1b[0m';
const WHITE    = '\x1b[38;2;235;235;245m';
// 自己的名牌用亮黃，別人白色 —— 20 個人時要能一眼找到自己。
const ME_COLOR = '\x1b[38;2;247;198;49m';

// ── NPC（無主的野生 vpet）─────────────────────────────────────────────
// 廣場沒人時空蕩蕩很難看，而且第一期本來就不會有幾個人在線。放幾隻無主的
// vpet 在場上散步，畫面隨時都有東西。
//
// NPC **不需要任何後端支援**：清單寫死、seed 寫死、joinStep 固定 0，
// 所以每個 client 各自算就會得到完全相同的 NPC 走位 —— 這是決定性走路演算法
// 順帶送的。伺服器只要管真人名單。
//
// 沒有 code → 不畫名牌（buildLabels 會跳過），一眼就分得出誰是玩家的寵物。
// seed 刻意用大質數且彼此相距很遠，避免和玩家的 seed 走出相似路徑。
const NPCS = [
    { key: 'npc:agumon',  char: 'agumon',  seed: 8675309 },
    { key: 'npc:gabumon', char: 'gabumon', seed: 5551212 },
];

/**
 * 把在場名單合成成一張廣場畫面。
 *
 * @param core       agumon-core（用它的 getFacingRows / loadCharacter / visLen）
 * @param occupants  [{code, char, seed, joinStep}]
 * @param step       目前是第幾拍（已用 serverNow 校正過）
 * @param opts       { caches: Map, bg: dots|null, me: code, npc: bool, field }
 * @returns          { lines, placed, labels }
 */
// ── 營地畫小一號 ─────────────────────────────────────────────────────
// 走路、分區、落點全部照舊在 YARD_FIELD（52x40 dot）上算 —— 那些是存檔與決定性走路的
// 資料，不動。只有「畫」換到一張更細的格子：場地實際大小不變（約 416x320 px），
// 前端用 6px 一格而不是 8px 來畫，角色的 16 dot 就小一號（128px → 96px）。
//
// 走路格子的範圍**線性鋪滿整張畫布**：最左上（0,0）對到畫布左上角，最右下
// （maxX,maxY）對到「畫布右下角減一隻角色」。上下左右都碰得到邊，四個區一樣大。
//
// ⚠️ 第一版是「放大 4/3 倍、角色在原本的落腳處裡置中、腳貼底」。粗格的落腳處
//    （16 粗格 = 21.3 細格）比 16 細格的角色大一圈，多出來的全塞在**上面**好讓腳貼地，
//    結果畫布最上面 5 格（約 30px）變成誰都到不了的死區：下排兩隻走得到畫布底，
//    上排兩隻永遠碰不到畫布頂，拎起來放到上緣也被拉回來 —— 回報過。
//    線性鋪滿就沒有哪一邊要吃掉多出來的空間。代價是 x、y 的倍率略有不同
//    （約 1.47 與 1.58），角色每走一步的距離不完全一樣，肉眼看不出來。
//
// 前端完全活在「細格」裡（/yard 的 cols/rows、pets 的 x/y、zones），
// 換算只發生在伺服器的邊界上：yardToDraw（走路 → 畫）與 yardFromDraw（放下的落點 → 走路）。
// 兩個倍率都大於 1，所以每個走路格子對到不同的細格，換過去再換回來一定是同一格。
const YARD_RENDER = (() => {
    const s = 8 / 6;
    const F = W.YARD_FIELD, S = W.SPRITE;
    const w = Math.round(F.w * s), h = 2 * Math.round(F.h * s / 2);
    return { s, w, h, kx: (w - S) / F.maxX, ky: (h - S) / F.maxY };
})();
const yardToDraw = (x, y) => ({ x: Math.round(x * YARD_RENDER.kx),
                                y: Math.round(y * YARD_RENDER.ky) });
const yardFromDraw = (x, y) => ({ x: Math.round(x / YARD_RENDER.kx),
                                  y: Math.round(y / YARD_RENDER.ky) });

// ── 廣場（第二版）：大小比照營地，但直接在細格上走 ─────────────────────
// 畫布跟營地畫出來的一樣大（69x54 細格、角色 16 細格），走路**就在這張細格上**，
// 一拍 1 細格。營地是粗格走、放大畫，每步跳 1~2 細格 —— 廣場第一版照抄，
// 回報「步伐很大」。底部留 LABEL_RESERVE 給名牌（見 plaza-walk 的 PLAZA_LIVE_FIELD）。
// 走路座標＝畫的座標，所以不需要換算；plazaToDraw 留著是讓呼叫端不用分兩種寫法。
// （第一版的 96x48 PLAZA_FIELD 留給 plaza-preview 鷹架與既有測試，不再用於真的廣場。）
const PLAZA_LIVE_FIELD = W.PLAZA_LIVE_FIELD;
const PLAZA_RENDER = { w: PLAZA_LIVE_FIELD.w, h: PLAZA_LIVE_FIELD.h, kx: 1, ky: 1 };
const plazaToDraw = (x, y) => ({ x, y });

// ── 圍爐（春節前一週，docs/festival-spec.md「圍爐」）──────────────────────
// 營地與廣場的大家不散步，圍著畫面中間的圓桌坐一圈。座位照名單順序（廣場＝進場順序，
// 每台收到的順序一樣）平均排在桌邊的橢圓上；人多擠不下就把角色縮小（FEAST_SIZES）。
// 營地畫出來跟廣場一樣大（69x54 細格），座位直接用**畫的座標**，不經過走路。
// 換座位（有人進出）／剛進場從畫面外走過來，是各台自己內插的表演 —— 終點大家一樣。
const FEAST_W = 69, FEAST_H = 54;
const FEAST_SIZES = [16, 14, 12, 10];   // 再小就認不出是誰了
const FEAST_SPEED = 12;                  // 走去座位的速度（dot/秒）

// 座位貼著桌緣分兩排，正左正右不坐人 —— 角色只有左右兩個面向，坐在正側邊的那隻跟桌子
// 沒有前後關係，看起來桌子在牠頭上或腳下（回報過）：
//   後排：腳在桌面後緣往內 2 dot → 下半身被桌子擋住，坐在桌後、面對我們
//   前排：腳在桌裙前面再往前 0.45 隻 → 身體下半截在桌子前面，坐在桌前（不是站在桌上，回報過）
// 桌子是扁的橢圓（俯視的圓桌），座位只用前後各 ±FEAST_ARC_DEG 的範圍，依 x 平均分。
const FEAST_ARC_DEG = 50;
const FEAST_SKIRT = 3;   // 桌裙高度（feastTable 畫的）
/** 這個角色大小的桌子 { cx, cy, rx, ry }：上面留頭和帽子、下面留前排和名牌，左右讓兩端的人不出界 */
function feastTableOf(S) {
    const top = S + 3, frontFoot = FEAST_H - W.LABEL_RESERVE;
    const ry = Math.floor((frontFoot - Math.round(S * 0.45) - FEAST_SKIRT - top) / 2);
    const cx = FEAST_W / 2, sin = Math.sin(FEAST_ARC_DEG * Math.PI / 180);
    return { cx, cy: top + ry, rx: Math.min(30, Math.floor((cx - S / 2 - 1) / sin)), ry };
}
// 一排 m 個座位的腳底 x：人少時靠中間（間距 1.1 隻），人多就攤到 ±ARC 的範圍
function feastRowXs(T, m, S) {
    if (m <= 0) return [];
    if (m === 1) return [T.cx];
    const X = T.rx * Math.sin(FEAST_ARC_DEG * Math.PI / 180);
    const half = Math.min(X, (m - 1) * S * 1.1 / 2);
    return Array.from({ length: m }, (_, k) => T.cx - half + 2 * half * k / (m - 1));
}
// 第 i 個座位（角色左上角）。順序：後排由左到右，再前排由右到左（順時針一圈）。
// 單數時後排多一個 —— 只有一個人就坐在桌子後面看著我們。面向桌子中線（正中那隻左右交錯）。
function feastSeats(n, S) {
    const T = feastTableOf(S), nb = Math.ceil(n / 2), nf = n - nb, out = [];
    const seat = (fx, back, i) => {
        const e = T.ry * Math.sqrt(Math.max(0, 1 - ((fx - T.cx) / T.rx) ** 2));   // 這個 x 的桌緣離中線多遠
        const fy = back ? T.cy - e + 2 : T.cy + e + FEAST_SKIRT + Math.round(S * 0.45);
        const facing = fx < T.cx - 0.5 ? 'right' : fx > T.cx + 0.5 ? 'left' : (i % 2 ? 'left' : 'right');
        out.push({ x: Math.round(fx - S / 2), y: Math.round(fy - S), facing, back });
    };
    feastRowXs(T, nb, S).forEach((fx) => seat(fx, true, out.length));
    feastRowXs(T, nf, S).reverse().forEach((fx) => seat(fx, false, out.length));
    return out;
}
// 同一排相鄰兩個座位左右錯開不到 0.7 隻 → 擠不下，換小一號（最小那號就算擠也照排）
function feastFits(n, S) {
    const s = feastSeats(n, S);
    for (let i = 1; i < n; i++) {
        if (s[i].back === s[i - 1].back && Math.abs(s[i].x - s[i - 1].x) < S * 0.7) return false;
    }
    return true;
}
/** n 個人的圍爐：{ size, seats, table:{cx,cy,rx,ry} }。角色越小桌子越大 */
function feastLayout(n) {
    const S = FEAST_SIZES.find(s => feastFits(n, s)) || FEAST_SIZES[FEAST_SIZES.length - 1];
    return { size: S, seats: feastSeats(n, S), table: feastTableOf(S) };
}

// 最近點縮放（像素風，不內插）
function scaleDots(d, k) {
    if (k === 1 || !d || !d.length) return d;
    const h = d.length, w = d[0].length, H = Math.max(1, Math.round(h * k)), Wd = Math.max(1, Math.round(w * k));
    const out = [];
    for (let y = 0; y < H; y++) {
        const src = d[Math.min(h - 1, Math.floor((y + 0.5) / k))], row = [];
        for (let x = 0; x < Wd; x++) row.push(src[Math.min(w - 1, Math.floor((x + 0.5) / k))]);
        out.push(row);
    }
    return out;
}

// dot 圖 → 精簡的傳輸格式 { w, h, pal:['#rrggbb'…], px }：px 一個字一個 dot，'.' = 透明，
// 其餘 = 色盤第 (字碼 - 48) 個。圍爐圖層一拍要送二十幾張圖，直接送 [r,g,b] 陣列太肥。
function packDots(d) {
    const pal = [], idx = new Map();
    let px = '';
    for (const row of d) for (const c of row) {
        if (!c) { px += '.'; continue; }
        const hex = '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
        if (!idx.has(hex)) { idx.set(hex, pal.length); pal.push(hex); }
        px += String.fromCharCode(48 + idx.get(hex));
    }
    return { w: d.length ? d[0].length : 0, h: d.length, pal, px };
}

// 圓桌＋火鍋。回傳 dot 圖與它左上角在畫布上的位置；step 讓熱氣飄動
const TB = {
    cloth: [190, 38, 42], clothHi: [214, 64, 60], trim: [232, 182, 70], skirt: [128, 22, 30], skirtLo: [96, 16, 24],
    potRim: [70, 74, 82], potIn: [44, 46, 52], soup: [222, 96, 40], soupHi: [246, 150, 70],
    tofu: [245, 240, 225], veg: [80, 170, 80], meat: [236, 140, 150],
    plate: [235, 235, 240], steam: [225, 228, 235],
};
function feastTable(t, step) {
    const { rx, ry } = t, SK = FEAST_SKIRT, UP = 7;   // SK：桌裙高度；UP：熱氣往上飄的空間
    const w = rx * 2 + 1, h = ry * 2 + 1 + SK + UP;
    const dots = []; for (let y = 0; y < h; y++) dots.push(new Array(w).fill(null));
    const put = (x, y, c) => { if (y >= 0 && y < h && x >= 0 && x < w) dots[y][x] = c; };
    const inE = (x, y, a, b) => (x * x) / (a * a) + (y * y) / (b * b) <= 1;
    // 桌裙：桌面下緣往下延伸（只有前半圈看得到）
    for (let x = -rx; x <= rx; x++) {
        const yb = Math.round(ry * Math.sqrt(Math.max(0, 1 - (x * x) / (rx * rx))));
        for (let k = 1; k <= SK; k++) put(x + rx, yb + k + ry + UP, k === SK ? TB.skirtLo : TB.skirt);
    }
    // 桌面＋金邊（外圈一格）
    for (let y = -ry; y <= ry; y++) for (let x = -rx; x <= rx; x++) {
        if (!inE(x, y, rx + 0.5, ry + 0.5)) continue;
        const edge = !inE(x, y, rx - 0.6, ry - 0.6);
        put(x + rx, y + ry + UP, edge ? TB.trim : (y < -ry / 3 && x < 0 ? TB.clothHi : TB.cloth));
    }
    // 火鍋：中間一圈鍋，裡面是湯和料
    const pa = Math.max(3, Math.round(rx * 0.3)), pb = Math.max(2, Math.round(pa * 0.55));
    const pcy = ry + UP - 1;
    for (let y = -pb - 1; y <= pb + 1; y++) for (let x = -pa - 1; x <= pa + 1; x++) {
        if (!inE(x, y, pa + 1.5, pb + 1.5)) continue;
        const inner = inE(x, y, pa - 0.3, pb - 0.3);
        put(x + rx, y + pcy, inner ? ((x + y + step) % 5 === 0 ? TB.soupHi : TB.soup) : TB.potRim);
    }
    for (let x = -pa; x <= pa; x++) put(x + rx, pcy + pb + 2, TB.potIn);   // 鍋身
    const food = [[-2, 0, TB.tofu], [1, -1, TB.veg], [2, 1, TB.meat], [-1, 1, TB.veg], [0, 0, TB.tofu]];
    for (const [fx, fy, c] of food) if (inE(fx, fy, pa - 1, pb - 0.5)) put(fx + rx, fy + pcy, c);
    // 盤子：沿著桌面一圈擺幾盤菜（桌子大才擺得多）
    const nPlate = rx >= 20 ? 8 : rx >= 14 ? 6 : 4;
    const dishes = [TB.veg, TB.meat, TB.tofu, TB.soupHi];
    for (let i = 0; i < nPlate; i++) {
        const a = Math.PI / nPlate + 2 * Math.PI * i / nPlate;
        const px = Math.round(Math.cos(a) * (rx * 0.66)), py = Math.round(Math.sin(a) * (ry * 0.62));
        for (let dx = -1; dx <= 1; dx++) put(px + dx + rx, py + ry + UP, TB.plate);
        put(px + rx, py + ry + UP, dishes[i % dishes.length]);
    }
    // 熱氣：三縷，兩拍一換
    const ph = step % 2;
    for (const [sx, s0] of [[-2, 0], [0, 1], [2, 0]]) {
        for (let k = 0; k < 3; k++) {
            const yy = pcy - pb - 3 - k * 2 - ((s0 + ph) % 2);
            put(sx + ((k + ph + s0) % 2) + rx, yy, TB.steam);
        }
    }
    return { dots, x: Math.round(t.cx - rx - 0.5), y: Math.round(t.cy - ry) - UP, base: t.cy };
}

/** 真的廣場：在場名單（伺服器發的）→ 畫面。原住民（NPC）先不放。 */
function composePlazaLive(core, occupants, step, opts = {}) {
    return composePlaza(core, occupants, step, { ...opts, npc: false, field: PLAZA_LIVE_FIELD, textLabels: false });
}

// opts.render：{ w, h, toDraw(x,y) } —— 畫在另一張格子上（營地用）。沒給就跟走路同一張（廣場）。
function composePlaza(core, occupants, step, opts = {}) {
    const caches = opts.caches instanceof Map ? opts.caches : new Map();
    const field  = opts.field || W.PLAZA_FIELD;
    const render = opts.render || null;
    const bw = render ? render.w : field.w, bh = render ? render.h : field.h;

    // 1. 空的 dot 緩衝（或底圖）+ 同尺寸的「這個 dot 是誰的」緩衝
    const dots = [], owner = [];
    for (let y = 0; y < bh; y++) {
        dots.push(new Array(bw).fill(null));
        owner.push(new Array(bw).fill(-1));
    }
    if (opts.bg) blit(dots, opts.bg, 0, 0);

    // 2. 算出每個人（含 NPC）的位置
    const all = opts.npc === false
        ? occupants
        : [...occupants, ...NPCS.map(n => ({ ...n, joinStep: 0 }))];
    const placed = [];
    for (const o of all) {
        // key 而不是 code：NPC 沒有 code，全部共用一個快取槽會互相汙染
        const key = o.key || o.code;
        // o.field = 這一隻自己的可走範圍（營地分區）。沒帶就用整場（廣場一直是這樣）。
        // 畫布尺寸與名牌仍然吃外層的 field —— 分區只縮走路範圍，不縮畫面。
        // o.walk = 廣場的完整走法（自動或手動，見 plaza-walk 的 walkPos），要用毫秒算；
        // 沒有就是營地／舊版的 seed + joinStep。
        const p = o.walk
            ? W.walkPos(o.walk, opts.nowMs != null ? opts.nowMs : step * W.STEP_MS, caches.get(key), o.field || field)
            : W.posAt({ seed: o.seed, joinStep: o.joinStep, origin: o.origin, anchor: o.anchor },
                      step, caches.get(key), o.field || field);
        caches.set(key, p.cache);
        // 手動模式放著太久 → 睡著：換成睡覺幀（兩張輪流，跟家裡睡覺同一個節奏）
        const react = p.sleeping ? (Math.floor(step / 2) % 2 ? 'SLEEP_2' : 'SLEEP_1') : o.react;
        placed.push({ ...o, key, x: p.x, y: p.y, facing: p.facing, moving: p.moving,
                      sleeping: !!p.sleeping, react });
    }

    // 2b. 圍爐：位置換成座位（畫的座標），角色縮成座位表決定的大小。不睡覺（手動模式的
    //     睡著是「放著太久」，圍爐大家都坐著，不算）。
    const feast = opts.feast ? feastLayout(placed.length) : null;
    if (feast) {
        const t = opts.nowMs != null ? opts.nowMs : Date.now();
        placed.forEach((p, i) => {
            const seat = feast.seats[i], ck = 'feast:' + p.key;
            let cur = caches.get(ck);
            if (!cur) {
                // 第一次看到：從畫面外走進來的（廣場剛進場）就從那裡走過來，其他人直接坐好
                const g = render ? render.toDraw(p.x, p.y) : { x: p.x, y: p.y };
                const off = g.x + W.SPRITE <= 0 || g.x >= bw || g.y + W.SPRITE <= 0 || g.y >= bh;
                cur = off ? { x: g.x, y: g.y, t } : { x: seat.x, y: seat.y, t };
            }
            const dt = Math.min(1000, Math.max(0, t - cur.t)) / 1000;
            const dx = seat.x - cur.x, dy = seat.y - cur.y, d = Math.hypot(dx, dy);
            const k = d > 0 ? Math.min(1, FEAST_SPEED * dt / d) : 0;
            const nx = cur.x + dx * k, ny = cur.y + dy * k;
            caches.set(ck, { x: nx, y: ny, t });
            const moving = Math.hypot(seat.x - nx, seat.y - ny) > 0.5;
            p.x = Math.round(nx); p.y = Math.round(ny); p.size = feast.size; p.seated = true;
            p.facing = moving ? (dx < 0 ? 'left' : dx > 0 ? 'right' : p.facing) : seat.facing;
            p.moving = moving; p.sleeping = false; p.react = all[i].react;
            p.seatBack = moving ? null : seat.back;
        });
    }

    // 3. y 小的先畫 -> y 大的（比較靠近觀眾）蓋在上面。
    //    y 相同時用 key 排序，讓每個 client 的疊法一致（不然兩邊看到的遮擋會相反）。
    placed.sort((a, b) => (a.y - b.y) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    // 圍爐的桌子也參加前後排序：腳在桌子中線後面的先畫（桌子擋住下半身），前面的後畫
    const table = feast ? feastTable(feast.table, step) : null;
    // 圍爐的角色和桌子不畫進 dot 緩衝，改成一層「原圖＋縮放倍率」交給前端畫（layer）：
    // 縮小時不丟像素 —— 16x16 原圖整張送過去，前端每個像素畫成 k 個 dot 大（回報過：
    // 最近點縮放把眼睛、輪廓吃掉）。順序就是前後關係。owner 還是照縮小後的範圍算
    //（名牌遮擋、點擊判定用），所以另外畫在一張不輸出的緩衝上。
    const layer = feast ? [] : null;
    const ghost = feast ? dots.map(r => new Array(r.length).fill(null)) : null;
    let tableDrawn = !table, tableZ = null;   // tableZ：桌子前面畫了幾隻（= 坐在桌後的）
    const drawTable = (z) => {
        if (tableDrawn) return;
        layer.push({ x: table.x, y: table.y, k: 1, ...packDots(table.dots) });
        tableDrawn = true; tableZ = z;
    };

    placed.forEach((p, i) => {
        // 坐好的照座位分排（弧的兩端腳的高度很接近桌子中線，用 y 判會判錯邊）；走動中看腳在中線前後
        if (!tableDrawn && (p.seatBack != null ? !p.seatBack : p.y + (p.size || W.SPRITE) > table.base)) drawTable(i);
        // 換角色（愚人節的百變怪）：跟配件同一套 —— o.swap 優先（廣場本人決定），沒有就用整場的
        // 營地另外帶 swapSalt（每次進營地換一個）→ 進出一次重抽一次變色版
        const swap = p.swap !== undefined ? p.swap : opts.swap;
        const skey = opts.swapSalt ? p.key + '|' + opts.swapSalt : p.key;
        let sp = spriteDots(core, swap ? FEST.swapChar(swap, skey) : p.char, step, p.facing, p.react);
        // 節日配件：穿進 dot 圖本身，所以遮擋與名牌挖洞（owner）都自動算在這隻身上。
        // o.acc 優先（廣場：每個人自己決定給不給看），沒有就用整場的 opts.acc（營地）。
        const acc = p.acc !== undefined ? p.acc : opts.acc;
        let aox = 0, aoy = 0;
        if (sp && acc) {
            const d = FEST.dress(sp, acc, p.facing); sp = d.dots; aox = d.ox; aoy = d.oy;
            // 旗桿／帽子會高出原本的 16x16：記下來，前端的對話泡泡和 z 才不會壓在帽子上
            const b = FEST.bbox(sp);
            p.accTop = b ? Math.min(0, b.minY + aoy) : 0;
        }
        // 跳躍只影響**畫在哪**，不影響上面那個 y 排序，也不影響名牌（名牌釘在腳下的
        // 地面位置）。跳起來就切到別人前面、名牌跟著飛，兩個都不對。
        // 貼著上緣時往上頂會超出畫面 -> 夾住，那一下就看不到跳（很少見，可接受）。
        p.jumpDy = p.jump ? Math.min(p.jump, p.y - (p.seated ? 0 : field.minY)) : 0;
        // 圍爐：縮小（配件一起縮），座位本來就是畫的座標 → 不再換算
        const k = p.size ? p.size / W.SPRITE : 1, full = sp, fox = aox, foy = aoy;
        if (k !== 1 && sp) {
            sp = scaleDots(sp, k); aox = Math.round(aox * k); aoy = Math.round(aoy * k);
            if (p.accTop) p.accTop = Math.round(p.accTop * k);
        }
        const toDraw = render && !p.seated ? render.toDraw : (x, y) => ({ x, y });
        // dx/dy = **畫出來**的位置（細格；含跳躍）。前端的命中判定要用這個。
        const at = toDraw(p.x, p.y - p.jumpDy);
        p.dx = at.x; p.dy = at.y;
        // 地面位置（不含跳躍）：名牌釘在這裡的腳下，要跟畫面同一套座標
        const g = toDraw(p.x, p.y);
        p.gx = g.x; p.gy = g.y;
        if (sp && layer) {
            blit(ghost, sp, at.x + aox, at.y + aoy, owner, i);
            layer.push({ x: at.x + fox * k, y: at.y + foy * k, k, ...packDots(full) });
        } else if (sp) blit(dots, sp, at.x + aox, at.y + aoy, owner, i);
        p.z = i;                                 // 繪製順序 = 前後關係
    });
    drawTable(placed.length);   // 全部都坐在後面（或沒人）

    // 4. dot -> cell -> ANSI，名牌另外走文字層（見下）
    //    天氣**不在這裡**：做過「依天氣把角色調色」，實際看了拿掉 —— 16x16 的點陣圖
    //    顏色本來就少，一染就分不出誰是誰。天氣整層都在前端疊，不動角色本身。
    const cells  = dotsToCells(dots, bw);
    // 名牌在**畫出來的**格子上排（有 render 時是細格），尺寸也用畫布的
    const labels = buildLabels(placed, core, opts.me, owner, render ? { w: bw, h: bh } : field);
    // labels 一併回傳：測試要驗「哪些字因為遮擋而沒畫」，從 ANSI 字串反推很脆弱
    // opts.textLabels === false：名牌不塞進格子，改回傳位置讓前端用真的字型畫（見 nameTags）
    if (opts.textLabels === false) {
        // owner：每個 dot 是誰畫的（繪製順序 z，-1 = 空）。前端畫名牌時用它把「被站在前面的角色
        // 蓋住的部分」挖掉 —— 名牌的前後關係才會跟角色一樣（回報過：重疊時後排的名字浮在前排身上）。
        return { lines: renderWithLabels(cells, new Map()), placed, labels, tags: nameTags(placed, labels, opts.me), owner, tableZ, layer };
    }
    return { lines: renderWithLabels(cells, labels), placed, labels, layer };
}

/**
 * 名牌文字層：key = cell 列號，value = [{col, text, wide, me, z, code}]。
 * 每個項目是**一個字**，不是整條名牌 —— 遮擋要逐字判斷，見下。
 *
 * 為什麼不直接畫進 dot 緩衝：名牌是**文字**（要支援中文名牌），一個字佔一到兩個
 * cell，沒有 dot 級的字模。既有 PvP 名牌也是渲染成 ANSI 之後才貼字（captionRow），
 * 這裡沿用同樣的分層，只是位置從「畫面最底一列」改成「各自腳下」。
 */
function buildLabels(placed, core, me, owner, field = W.PLAZA_FIELD) {
    const lastRow = field.h / 2 - 1;
    const vis = (t) => (core && core.visLen ? core.visLen(t) : t.length);
    const rows = new Map();
    for (const p of placed) {
        if (!p.code) continue;
        const wide = vis(p.code), S = p.size || W.SPRITE;   // 圍爐會縮小
        // gx/gy = 畫出來的地面位置（composePlaza 給的）；直接呼叫的測試沒有，退回走路座標
        const px = p.gx != null ? p.gx : p.x, py = p.gy != null ? p.gy : p.y;
        const col0 = Math.max(0, Math.min(field.w - wide,
                     px + Math.floor((S - wide) / 2)));

        // 名牌**一律標在腳下**（固定位置，不會忽上忽下）。腳下是慣例 ——
        // PvP 的名牌就在腳下，玩家對這個位置有既有預期。
        //
        // 走過的四版，都是看畫面才發現問題：
        //   1. 只放腳下、放不下就省略 → 走到最底時名牌整個消失（場地高 = 角色高 +
        //      可走範圍，y 頂到 MAX_Y 時腳正好貼下緣，那一列已在畫面外）。
        //   2. 腳下放不下就改標頭上 → 兩邊都看得到了，但角色一走動名牌就上下跳。
        //   3. 一律頭上 → 幾乎不會被遮擋（擋住我的人必定 y 比我大，構不到我頭頂
        //      那一列），顯示率 97~100%，但不合慣例。
        //   4. 一律腳下 + 場地底部保留一列（本版）→ 位置固定又合慣例。
        const row = Math.floor((py + S) / 2);
        if (row < 0 || row > lastRow) continue;

        // 遮擋逐「字」判斷，不是整條名牌一起消失。切在字的邊界上，不會出現半個字。
        //
        // ⚠️ 別期待這能救回顯示率：擋住你的 sprite 有 16 cell 寬，名牌才 2~3 cell，
        // 蓋到通常就是整條蓋住。實測逐字判斷只把「部分可讀」從 0% 拉到 2~8%，
        // 「完全看不到」的比例（5 人 15% / 20 人 55%）幾乎沒變。
        // 真正決定顯示率的是**名牌放哪裡**：腳下就是前排角色會站的地方。
        // 標在頭上可以到 97~100%（擋住我的人 y 必定比我大，構不到我頭頂），
        // 但那不合慣例 —— 這裡選擇合慣例，接受被站在前面的人擋住。
        let cx = col0;
        for (const ch of [...p.code]) {
            const w = vis(ch);
            if (!occluded(owner, row, cx, w, p.z)) {
                if (!rows.has(row)) rows.set(row, []);
                rows.get(row).push({ col: cx, text: ch, wide: w, me: p.code === me, z: p.z, code: p.code, color: p.color || null });
            }
            cx += w;
        }
    }
    // 同一列多人 -> 依 col 排序；重疊時保留站得比較前面（z 大）的那個，
    // 與遮擋規則一致 —— 前排的名字蓋掉後排的，而不是先來先贏。
    for (const [row, list] of rows) {
        list.sort((a, b) => a.col - b.col);
        const keep = [];
        for (const it of list) {
            const prev = keep[keep.length - 1];
            if (!prev || it.col > prev.col + prev.wide - 1) { keep.push(it); continue; }
            if (it.z > prev.z) keep[keep.length - 1] = it;   // 換成前排那個
        }
        rows.set(row, keep);
    }
    return rows;
}

/** 名牌要佔的那幾格裡，有沒有任何一個 dot 是「比我前面的人」畫的 */
function occluded(owner, row, col, wide, z) {
    if (!owner || z == null) return false;
    const y0 = row * 2, y1 = y0 + 1;
    for (let y = y0; y <= y1; y++) {
        const r = owner[y];
        if (!r) continue;
        for (let x = col; x < col + wide; x++) {
            if (r[x] > z) return true;
        }
    }
    return false;
}

// 名牌改由前端畫（廣場用）：格子只有 6x12 px，把字塞進格子裡，中文會被壓成細長條、
// 字跟字黏在一起，小寫英文也擠不下 —— 回報過。改成回傳「名牌該畫在哪」，前端用
// 正常字型、置中畫在腳下。遮擋規則不變：buildLabels 判出來整條都被擋住的就不畫
// （有任何一個字露出來就整條畫，不會出現半個名字）。
// x = 角色中心、y = 腳底（都是畫出來的 dot 座標）。
const NAME_DEFAULT_COLOR = '#ebebf5';
function nameTags(placed, labels, me) {
    const seen = new Set();
    for (const list of labels.values()) for (const it of list) seen.add(it.code);
    return placed.filter(p => p.code && seen.has(p.code)).map(p => ({
        text: p.code, me: p.code === me, key: p.key,   // key：前端用來對上這個人說的話（對話泡泡）
        // 所有人看到的顏色一律相同：有選就用選的，沒選就是同一個預設色。
        // 以前沒選時「自己黃、別人白」—— 結果自己看到的跟別人看到的不一樣（回報過）。
        color: p.color || NAME_DEFAULT_COLOR,
        x: p.gx + (p.size || W.SPRITE) / 2, y: p.gy + (p.size || W.SPRITE),
        sleeping: !!p.sleeping, top: p.gy + (p.accTop || 0),   // 睡著時前端在頭上畫 z；含節日配件的高度
        battling: !!p.battle,                         // 對戰中：前端在頭上畫 ⚔
        happy: p.react === 'HAPPY',                   // 開心鈕演出中（測試用來確認大家都看得到）
        z: p.z,                                       // 前後順序（大的在前面），配合 owner 決定名牌哪裡被擋
    }));
}

// 名牌顏色：玩家自選的（#rrggbb）優先；沒選就照舊 —— 自己亮黃、別人白。
function labelColor(it) {
    const m = it.color && /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(it.color);
    if (m) return `[38;2;${parseInt(m[1], 16)};${parseInt(m[2], 16)};${parseInt(m[3], 16)}m`;
    return it.me ? ME_COLOR : WHITE;
}

function renderWithLabels(cells, labels) {
    const lines = [];
    for (let r = 0; r < cells.length; r++) {
        const row = cells[r];
        const lab = labels.get(r) || [];
        let line = '', x = 0, li = 0;
        while (x < row.length) {
            const it = lab[li];
            if (it && it.col === x) {
                line += labelColor(it) + it.text + R;
                x += it.wide; li++;
                continue;
            }
            line += cellToAnsi(row[x]);
            x++;
        }
        lines.push(line);
    }
    return lines;
}

// 與 core.renderCells 同一套規則，但這裡要能逐格插入名牌，所以拆成單格版。
function cellToAnsi(c) {
    if (!c) return '⠀';
    const [ur, ug, ub, lr, lg, lb] = c;
    const upOk = ur >= 0, loOk = lr >= 0;
    if (upOk && loOk) return `\x1b[38;2;${ur};${ug};${ub}m\x1b[48;2;${lr};${lg};${lb}m▀${R}`;
    if (upOk)         return `\x1b[38;2;${ur};${ug};${ub}m▀${R}`;
    if (loOk)         return `\x1b[38;2;${lr};${lg};${lb}m▄${R}`;
    return '⠀';
}

// ── 營地院子（docs/ranch-spec.md 階段 2）──────────────────────────────
// 與廣場的差別只有「名單從哪來」：廣場是伺服器發的在場名單，院子是本機 ranch.json。
// 畫面層（走路、y 排序、名牌、遮擋）完全共用，一行都不用改 —— 這正是先做營地
// 再做廣場的理由。
//
// seed 由每隻的 id 雜湊而來，不需要伺服器分配（那是廣場為了跨 client 一致才需要的）。
// 同一隻每次開院子的走位都一樣，看久了會有「這隻習慣待在那一角」的感覺。
// joinStep 一律用「這個 daemon 這次啟動的時間」，不是 0，也不是 keptAt。
//   joinStep = 0  → 要從 epoch 重播 24 億拍（實際踩過，daemon 直接卡死）
//   joinStep = keptAt → 收很久的那隻要重播數百萬拍，第一次開院子會頓一下
// 院子只有一個 client，不需要跨機器一致，所以「這次開機才開始走」完全夠用；
// 副作用是重開 daemon 大家會回到各自的起點，那反而像「早上剛出門」。
const SESSION_START = Date.now();

/**
 * 院子這次開機的起拍。導出純粹是為了讓測試餵得到有效的 step ——
 * 不知道這個數字就只會餵到 target = 0（負的被夾成 0），每一拍都算出同一個起點，
 * 斷言全部退化成「拿同一張圖跟自己比」而看起來是綠的。踩過：跳躍夾住那條就是這樣空掉的。
 */
function yardJoinStep() { return W.stepAt(SESSION_START); }

function yardOccupants(core, ranch, activeState, react, layout, coreForLayouts) {
    const base = W.stepAt(SESSION_START);
    void activeState;   // 現役不進院子（見下），保留參數是為了呼叫端不用改
    const list = [];
    // 每隻分到一塊自己的可走範圍，否則三隻擠在 37x25 裡有七成的時間互相蓋住。
    // ⚠️ 索引取自**完整名單**而不是過濾後的 list：拿在手上的那一隻會被 continue
    //    跳過，用 list.length 當索引的話，牠一被抓起來其他隻的區域就整組位移。
    const n = (ranch.pets || []).length;
    const zones = coreForLayouts ? yardZonesFor(coreForLayouts, n, layout)
                                 : W.yardZones(n, undefined, undefined, layout);
    let idx = -1;
    for (const p of (ranch.pets || [])) {
        idx++;
        const id = p.state && p.state.characterId;
        if (!id) continue;
        // 刻意不給 code —— buildLabels 看到沒有 code 就不畫名牌（與 NPC 同一條路）。
        // 院子只有 52 dot 寬，8 隻的名牌會互相擠掉一半；要知道是誰改用右鍵選單，
        // 那比一排彼此覆蓋的名字可靠。
        // 摸摸的反應。**只存在記憶體裡**（daemon 的 Map），不寫進 ranch.json ——
        // 營地是冰箱，反應是純表演，不該在快照裡留下任何痕跡。
        const r = react ? react.get(p.id) : null;
        // 拿在手上的那隻不進合成 —— 它由前端跟著游標畫在疊加層上。
        // 兩邊都畫的話會看到兩個分身（伺服器那張還停在被抓起的位置）。
        if (r && r.held) continue;
        list.push({
            key:      'ranch:' + p.id,
            ranchId:  p.id,
            name:     core.getDisplayName ? core.getDisplayName(id) : id,
            char:     id,
            seed:     W.hash2(hashStr(p.id), 0),
            // 開心的時候會原地跳，停走那幾拍要從時間軸扣掉，落地才不會瞬移
            // （holdSteps 的來由見 yard-touch.js settleHold）。
            // 被放下過的那隻改用落點當起點、落下那一拍當 joinStep（見 plaza-walk 的 origin）。
            joinStep: (r && r.anchor ? r.anchor.step : base) + (r ? r.holdSteps || 0 : 0),
            origin:   r && r.anchor ? r.anchor.origin : null,
            react:    r ? r.frame : null,
            jump:     r ? r.jump || 0 : 0,
            zoneIdx:  idx,
            field:    zones[idx] || W.YARD_FIELD,
            // 放下的落點在區域外時，先走回這裡再接回正常的鏈（見 plaza-walk 的 returnLeg）
            anchor:   W.zoneAnchor(zones[idx] || W.YARD_FIELD),
        });
    }
    // 現役**不**放進院子。草案原本要放（想說「不然院子會像少了一隻」），但那是搞混了
    // 兩件事：院子是「收起來的那些」，現役正在你身邊過生活，不在冰箱裡。
    // 兩邊都出現反而看不出「收進去」和「拿出來」的差別。
    return list;
}

/** 字串 → 32-bit 整數。id 是亂數字串，要先變成數字才能餵給 seed。 */
function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < String(s).length; i++) {
        h ^= String(s).charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
}

/**
 * 某一隻現在的位置、面向與**兩張待機幀**。抓起來的那一刻要把牠交給前端自己畫，
 * 所以得先問「牠現在在哪、朝哪邊、長什麼樣」。
 * 回傳 null = 這隻不在營地裡（或讀不到美術）。
 *
 * 為什麼給兩張而不是一張：拿在手上的那隻要繼續呼吸（IDLE_1/IDLE_2 輪替）。
 * 兩張一起傳只多約 2 KB、而且只在抓起的那一次 —— 換成讓前端每幀回頭問伺服器，
 * 就得把 /yard 拉到 60fps，完全不划算。
 *
 * 用 step 0 / 1 取兩張，而不是指定幀名字串：spriteDots 本來就用 step 的奇偶挑
 * IDLE_1/IDLE_2，走同一條路才不會有「這裡叫 IDLE_1、那裡叫 Idle_1」的分叉。
 *
 * 刻意不走 composeYard —— 那會為了一隻而合成整張圖，而且被抓著的那隻本來就被略過了。
 */
function yardSpriteFor(core, ranch, id, step, opts = {}) {
    // layout 要跟 composeYard 用同一個，否則抓起來那一下的位置會對不上畫面
    const pets = ranch.pets || [];
    const idx = pets.findIndex(p => p.id === id);
    const pet = pets[idx];
    const cid = pet && pet.state && pet.state.characterId;
    if (!cid) return null;
    // 一定要用**這一隻自己的區域**算 —— 用整場算的話，抓起來那一下回報的位置
    // 會跟畫面上的不一樣，游標一接手就跳一格。
    const zone = yardZonesFor(core, pets.length, opts.layout)[idx] || W.YARD_FIELD;
    const p = W.posAt({ seed: W.hash2(hashStr(id), 0),
                        joinStep: opts.joinStep != null ? opts.joinStep : W.stepAt(SESSION_START),
                        origin: opts.origin || null,
                        anchor: W.zoneAnchor(zone) },
                      step, null, zone);
    // 愚人節：拿在手上的也要是同一隻百變怪（key 跟 yardOccupants 一樣、salt 跟合成時一樣）
    const skey = 'ranch:' + id + (opts.swapSalt ? '|' + opts.swapSalt : '');
    const draw = opts.swap ? FEST.swapChar(opts.swap, skey) : cid;
    const a = spriteDots(core, draw, 0, p.facing, null);
    const b = spriteDots(core, draw, 1, p.facing, null);
    return a ? { frames: [a, b || a], x: p.x, y: p.y, facing: p.facing } : null;
}

// ── 編輯器存的自訂切法 ───────────────────────────────────────────────
// 內建表（plaza-walk 的 YARD_LAYOUTS）是出廠值；編輯器把改動存成資料檔，
// 這裡合併：同名覆蓋、新名字新增、default 可改指定哪一個。
// 放在 assets/ 而不是編進程式 —— 編輯器存完就生效，不用重跑 install
// （跟路線編輯器同一套作法）。檔案壞掉就當作沒有，不能讓院子開不起來。
const YARD_LAYOUTS_FILE = 'yard-layouts.json';
let _layoutCache = { mtime: 0, data: null };

function loadYardLayouts(core) {
    try {
        const p = path.join(core.ASSETS_DIR, YARD_LAYOUTS_FILE);
        const st = fs.statSync(p);
        if (_layoutCache.data && _layoutCache.mtime === st.mtimeMs) return _layoutCache.data;
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        const data = { layouts: j.layouts || {}, default: j.default || {} };
        _layoutCache = { mtime: st.mtimeMs, data };
        return data;
    } catch (e) {
        _layoutCache = { mtime: 0, data: null };
        return { layouts: {}, default: {} };
    }
}

// 這個隻數有哪些切法可挑（內建 + 自訂），以及目前預設是哪一個
function yardLayoutsFor(core, n) {
    const over = loadYardLayouts(core);
    const names = [...new Set([...(W.yardLayoutNames(n) || []),
                               ...Object.keys((over.layouts || {})[n] || {})])];
    const def = (over.default || {})[n] || W.YARD_LAYOUT_DEFAULT[n] || null;
    return { names, def };
}

// 依名稱取出實際的區域。名稱查得到自訂就用自訂的矩形，否則交給內建表。
//
// ⚠️ 指名的切法查不到（網址參數打錯、或那個切法剛被刪）要退回**目前生效的**預設，
//    不是內建的預設 —— 後者的症狀是「刪掉自訂切法之後畫面靜靜跳回出廠值」，
//    而且 dev 下拉顯示的名字跟實際走的切法對不起來。
function yardZonesFor(core, n, layout) {
    const over = loadYardLayouts(core);
    const custom = (over.layouts || {})[n] || {};
    const builtin = W.YARD_LAYOUTS[n] || {};
    const known = (nm) => !!nm && !!(custom[nm] || builtin[nm]);
    const name = (known(layout) && layout)
              || (over.default || {})[n]
              || W.YARD_LAYOUT_DEFAULT[n] || null;
    return W.yardZones(n, W.YARD_FIELD, W.ZONE_MARGIN, custom[name] || name);
}

/**
 * 畫出院子。回傳 null 代表營地是空的 —— 呼叫端自己決定顯示什麼（不要畫一張空圖，
 * 那看起來像壞掉）。
 * NPC 一律關掉：院子是你自己的地方，不該有野生 vpet 亂入。
 */
function composeYard(core, ranch, activeState, step, opts = {}) {
    const occ = yardOccupants(core, ranch, activeState, opts.react, opts.layout, core);
    if (!occ.length) return null;
    return composePlaza(core, occ, step, { ...opts, npc: false, field: W.YARD_FIELD,
                                           render: { w: YARD_RENDER.w, h: YARD_RENDER.h, toDraw: yardToDraw } });
}

// ── 營地第二頁（docs/yard-page2-spec.md）──────────────────────────────
// 每頁就是「一個 ≤4 隻的營地」：第 1～4 隻在第一頁、第 5～8 隻在第二頁，各自用既有的
// 1～4 隻切法、各自合成。走路、分區、摸摸、拎起來、右鍵全部原封不動 —— 只是名單換成那一頁的。
// 每隻只在自己那頁走（第一版不跨頁）。換頁的鏡頭滑行在前端（拿兩頁的畫面並排平移）。
const YARD_PAGE_SIZE = 4;

/** 分頁後的名單。解鎖且超過 4 隻才分頁；圍爐（opts.feast）大家坐同一桌，不分頁。 */
function yardPages(ranch, opts = {}) {
    const pets = (ranch && ranch.pets) || [];
    if (opts.feast || !(ranch && ranch.page2At) || pets.length <= YARD_PAGE_SIZE) return [pets];
    const out = [];
    for (let i = 0; i < pets.length; i += YARD_PAGE_SIZE) out.push(pets.slice(i, i + YARD_PAGE_SIZE));
    return out;
}
/** 第 page 頁的「營地」（同一個 ranch，只是 pets 換成那頁的）。頁碼超出就夾住。 */
function yardPageRanch(ranch, page, opts = {}) {
    const pages = yardPages(ranch, opts);
    const k = Math.max(0, Math.min(pages.length - 1, page | 0));
    return { ...ranch, pets: pages[k] };
}
/** 這隻在第幾頁（找不到回 0）。拎起來／放下要用牠那一頁的名單算區域。 */
function yardPageOf(ranch, id, opts = {}) {
    const k = yardPages(ranch, opts).findIndex(ps => ps.some(p => p.id === id));
    return k < 0 ? 0 : k;
}

// 第二階段的對峙（規格「表演」）：我方站左側面向右、生氣；敵人站右側面向左、待機兩幀交替。
// 不走路 —— 位置寫死，畫在營地的細格上（跟 composeYard 同一張畫布大小）。
// enemyDx：敵人往右挪多少細格（輸了退場用，挪出畫面就不畫）。
const STANDOFF_SLOTS = [{ x: 18, y: 8 }, { x: 2, y: 16 }, { x: 18, y: 26 }, { x: 2, y: 34 }];
function composeYardStandoff(core, pets, enemyId, step, opts = {}) {
    const bw = YARD_RENDER.w, bh = YARD_RENDER.h, S = W.SPRITE;
    const dots = [], owner = [];
    for (let y = 0; y < bh; y++) { dots.push(new Array(bw).fill(null)); owner.push(new Array(bw).fill(-1)); }
    const placed = pets.slice(0, STANDOFF_SLOTS.length).map((p, i) => ({
        id: p.id, char: p.state && p.state.characterId, x: STANDOFF_SLOTS[i].x, y: STANDOFF_SLOTS[i].y,
        facing: 'right', react: 'ANGRY',
    }));
    const ex = bw - S - 4 + (opts.enemyDx || 0), ey = Math.round((bh - S) / 2);
    const all = ex < bw ? [...placed, { id: null, char: enemyId, x: ex, y: ey, facing: 'left', react: null }] : placed;
    all.sort((a, b) => a.y - b.y);
    all.forEach((p, i) => {
        const sp = p.char ? spriteDots(core, p.char, step, p.facing, p.react) : null;
        if (sp) blit(dots, sp, p.x, p.y, owner, i);
    });
    const cells = dotsToCells(dots, bw);
    return {
        lines: renderWithLabels(cells, new Map()),
        // 前端的命中判定（選一隻出戰）：畫出來的位置，跟 /yard 的 pets 同一套座標
        pets: placed.map(p => ({ id: p.id, char: p.char, x: p.x, y: p.y, size: S })),
        enemy: ex < bw ? { x: ex, y: ey, size: S } : null,
    };
}

module.exports = {
    YARD_PAGE_SIZE, yardPages, yardPageRanch, yardPageOf, composeYardStandoff,
    PLAZA_W: W.PLAZA_W, PLAZA_H: W.PLAZA_H, YARD_FIELD: W.YARD_FIELD, SPRITE: W.SPRITE,
    cellsToDots, dotsToCells, blit,
    loadArt, spriteDots,
    composePlaza, buildLabels, renderWithLabels, nameTags, NAME_DEFAULT_COLOR, cellToAnsi, occluded, NPCS,
    yardOccupants, composeYard, hashStr, yardJoinStep, yardSpriteFor,
    YARD_RENDER, yardToDraw, yardFromDraw,
    PLAZA_RENDER, plazaToDraw, PLAZA_LIVE_FIELD, composePlazaLive,
    FEAST_SIZES, FEAST_ARC_DEG, feastLayout, feastTable, scaleDots, packDots,
    yardZones: W.yardZones, zoneAnchor: W.zoneAnchor, ZONE_MARGIN: W.ZONE_MARGIN,
    yardLayoutNames: W.yardLayoutNames, YARD_LAYOUT_DEFAULT: W.YARD_LAYOUT_DEFAULT,
    YARD_LAYOUTS_FILE, loadYardLayouts, yardLayoutsFor, yardZonesFor,
};
