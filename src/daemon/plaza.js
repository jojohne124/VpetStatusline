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
const fs = require('fs');
const W  = require('../shared/plaza-walk.js');

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

/** 把 src dot 圖貼到 dst，透明處不覆蓋（painter's algorithm 的一筆） */
function blit(dst, src, ox, oy) {
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

/** 某人在這一拍該用哪一幀的 dot 圖（含左右翻面） */
function spriteDots(core, charId, step, facing, moving) {
    const a = loadArt(core, charId);
    if (!a) return null;
    const F = a.F || {};
    // 走路 = IDLE_1 / IDLE_2 交替（與家裡同一套節奏）；停下來時固定 IDLE_1，
    // 免得原地踏步看起來像抽搐。
    const frameIdx = moving ? (step % 2 === 0 ? F.IDLE_1 : F.IDLE_2) : F.IDLE_1;
    const rows = core.getFacingRows(a.art, frameIdx ?? 0, facing, a.rightOffset);
    return rows ? cellsToDots(rows) : null;
}

// ── 合成 ─────────────────────────────────────────────────────────────
const R = '\x1b[0m';
const WHITE    = '\x1b[38;2;235;235;245m';
// 自己的名牌用亮黃，別人白色 —— 20 個人時要能一眼找到自己。
const ME_COLOR = '\x1b[38;2;247;198;49m';

/**
 * 把在場名單合成成一張廣場畫面。
 *
 * @param core       agumon-core（用它的 getFacingRows / loadCharacter / visLen）
 * @param occupants  [{code, char, seed, joinStep}]
 * @param step       目前是第幾拍（已用 serverNow 校正過）
 * @param opts       { caches: Map, bg: dots|null, me: code }
 * @returns          { lines: string[], placed: [...] }
 */
function composePlaza(core, occupants, step, opts = {}) {
    const caches = opts.caches instanceof Map ? opts.caches : new Map();

    // 1. 空的 dot 緩衝（或底圖）
    const dots = [];
    for (let y = 0; y < W.PLAZA_H; y++) dots.push(new Array(W.PLAZA_W).fill(null));
    if (opts.bg) blit(dots, opts.bg, 0, 0);

    // 2. 算出每個人的位置
    const placed = [];
    for (const o of occupants) {
        const p = W.posAt({ seed: o.seed, joinStep: o.joinStep }, step, caches.get(o.code));
        caches.set(o.code, p.cache);
        placed.push({ ...o, x: p.x, y: p.y, facing: p.facing, moving: p.moving });
    }

    // 3. y 小的先畫 -> y 大的（比較靠近觀眾）蓋在上面。
    //    y 相同時用 code 排序，讓每個 client 的疊法一致（不然兩邊看到的遮擋會相反）。
    placed.sort((a, b) => (a.y - b.y) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

    for (const p of placed) {
        const sp = spriteDots(core, p.char, step, p.facing, p.moving);
        if (sp) blit(dots, sp, p.x, p.y);
    }

    // 4. dot -> cell -> ANSI，名牌另外走文字層（見下）
    const cells  = dotsToCells(dots, W.PLAZA_W);
    const labels = buildLabels(placed, core, opts.me);
    return { lines: renderWithLabels(cells, labels), placed };
}

/**
 * 名牌文字層：key = cell 列號，value = [{col, text, wide, me}]。
 *
 * 為什麼不直接畫進 dot 緩衝：名牌是**文字**（要支援中文名牌），一個字佔一整個 cell，
 * 沒有 dot 級的字模。既有 PvP 名牌也是渲染成 ANSI 之後才貼字（captionRow），
 * 這裡沿用同樣的分層，只是位置從「畫面最底一列」改成「各自腳下」。
 */
function buildLabels(placed, core, me) {
    const rows = new Map();
    for (const p of placed) {
        if (!p.code) continue;
        const row = Math.floor((p.y + W.SPRITE) / 2);      // 腳下那一列
        if (row >= W.PLAZA_H / 2) continue;                 // 貼著下緣 -> 沒地方放，省略
        const wide = core.visLen ? core.visLen(p.code) : p.code.length;
        const col  = Math.max(0, Math.min(W.PLAZA_W - wide,
                     p.x + Math.floor((W.SPRITE - wide) / 2)));
        if (!rows.has(row)) rows.set(row, []);
        rows.get(row).push({ col, text: p.code, wide, me: p.code === me });
    }
    // 同一列多人 -> 依 col 排序，重疊的後者讓位（直接丟掉，總比疊成亂碼好）
    for (const [row, list] of rows) {
        list.sort((a, b) => a.col - b.col);
        const keep = [];
        let cur = -1;
        for (const it of list) {
            if (it.col > cur) { keep.push(it); cur = it.col + it.wide - 1; }
        }
        rows.set(row, keep);
    }
    return rows;
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
                line += (it.me ? ME_COLOR : WHITE) + it.text + R;
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

module.exports = {
    PLAZA_W: W.PLAZA_W, PLAZA_H: W.PLAZA_H,
    cellsToDots, dotsToCells, blit,
    loadArt, spriteDots,
    composePlaza, buildLabels, renderWithLabels, cellToAnsi,
};
