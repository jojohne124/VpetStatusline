'use strict';
/**
 * plaza-walk.js — 廣場走路演算法（純函數，零相依）
 *
 * 放在 src/shared/ 是因為它必須被**多方共用且算出完全相同的結果**：
 * 每個 client 各自算出「所有人」的位置，伺服器只存名單、不推進任何位置。
 * 這是廣場「所有人看到同一畫面」能成立的原因（見 docs/plaza-spec.md §二）。
 * 因此本檔不得 require 任何東西 —— 未來要塞進 Cloudflare Worker 也直接可用。
 *
 * 決定性的三個前提：同樣的輸入（seed / joinStep 由伺服器發）、同樣的函數（本檔）、
 * 同樣的時間（client 用 serverNow 校正時鐘後算 step）。
 *
 * 座標系：以 dot 為單位，原點左上。角色 sprite 16×16 dot，
 * 所以左上角座標 x ∈ [0, W-16]、y ∈ [0, H-16]。
 */

// ── 場地與節奏（docs/plaza-spec.md 附錄 C #1 #5）────────────────────
const PLAZA_W = 96;   // dot（= 768 px；1 dot = 8 px）
const PLAZA_H = 96;   // dot —— 視覺正方形 = dot 數相等，不是 cell 數相等
const SPRITE  = 16;   // 角色寬高（dot）

const STEP_T   = 4;   // 每 4 拍決策一次
const DOT_PER  = 1;   // 每拍移動 1 dot → 一次決策共 4 dot
// 停留佔 6 格中的 2 格（1/3），看起來比較不躁動。
// 撞牆時該次決策視為「停」而不重抽 —— 重抽會讓「第 k 次決策」不再是純函數。
const DIRS = [
    [ 0, -1], [ 0, 1], [-1, 0], [ 1, 0],   // 上 下 左 右
    [ 0,  0], [ 0, 0],                     // 停 停
];

const MAX_X = PLAZA_W - SPRITE;
const MAX_Y = PLAZA_H - SPRITE;

// ── 雜湊（與 agumon-core 的 seedRand01 同一族，但這裡吃兩個參數）──────
function hash2(a, b) {
    let h = (Math.floor(a) ^ 0x9e3779b9) >>> 0;
    h = (Math.imul(h ^ Math.floor(b), 0x85ebca6b)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0x45d9f3b) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0);
}
const rand01 = (a, b) => hash2(a, b) / 0x100000000;

// 進場位置也由 seed 決定 —— 否則所有人都從 (0,0) 疊在一起。
// 用 k = -1 / -2 這兩個「決策序號之外」的槽，避免與走路的 k >= 0 撞號。
function startPos(seed) {
    return {
        x: Math.min(MAX_X, Math.floor(rand01(seed, -1) * (MAX_X + 1))),
        y: Math.min(MAX_Y, Math.floor(rand01(seed, -2) * (MAX_Y + 1))),
        facing: rand01(seed, -3) < 0.5 ? 'left' : 'right',
    };
}

// 第 k 次決策的方向。撞牆判定要在這裡做（吃當下位置），所以不是純 f(seed,k)。
function dirAt(seed, k) {
    return DIRS[Math.floor(rand01(seed, k) * DIRS.length) % DIRS.length];
}

/**
 * 把狀態從 fromK 推進到 toK（完整決策），回傳新的 {x, y, facing}。
 * 只走完整決策；同一次決策內的零頭由 posAt 另外補。
 */
function advance(seed, st, fromK, toK) {
    let { x, y, facing } = st;
    for (let k = fromK; k < toK; k++) {
        const [dx, dy] = dirAt(seed, k);
        const nx = x + dx * STEP_T * DOT_PER;
        const ny = y + dy * STEP_T * DOT_PER;
        // 出界 → 這次決策整個當作「停」（不重抽）
        if (nx < 0 || nx > MAX_X || ny < 0 || ny > MAX_Y) continue;
        x = nx; y = ny;
        if (dx < 0) facing = 'left';
        else if (dx > 0) facing = 'right';
        // 上 / 下 / 停 → 維持前一個面向（只有左右兩種幀，美術限制）
    }
    return { x, y, facing };
}

/**
 * 某人在第 step 拍的位置。
 *
 * cache 是「已經算到第 cache.k 次決策」的快照，傳進來就只推進差量。
 * 不傳也正確，只是要從進場重播（3600 拍 ≈ 900 次決策，一次也才幾毫秒）。
 * 整數格子累加 → 任何 client 從任何時間點重播都得到完全一樣的結果，無浮點漂移。
 *
 * @param {{seed:number, joinStep:number}} occ
 * @param {number} step
 * @param {{k:number,x:number,y:number,facing:string}|null} cache
 * @returns {{x:number,y:number,facing:string,k:number,moving:boolean}}
 */
function posAt(occ, step, cache) {
    const { seed, joinStep } = occ;
    const elapsed = Math.max(0, step - joinStep);
    const k = Math.floor(elapsed / STEP_T);          // 已完成的決策數
    const within = elapsed - k * STEP_T;             // 這次決策已走幾拍

    // 快取只在「同一人、且沒有倒退」時可用（倒退＝時鐘校正把 step 拉回來了）
    const base = (cache && cache.k <= k) ? cache : { ...startPos(seed), k: 0 };
    const done = advance(seed, base, base.k, k);
    done.k = k;

    // 這次決策的零頭：逐 dot 補上，讓移動看起來是連續的而不是每 4 拍瞬移
    const [dx, dy] = dirAt(seed, k);
    let x = done.x, y = done.y, facing = done.facing;
    const wouldX = done.x + dx * STEP_T * DOT_PER;
    const wouldY = done.y + dy * STEP_T * DOT_PER;
    const blocked = wouldX < 0 || wouldX > MAX_X || wouldY < 0 || wouldY > MAX_Y;
    const moving = !blocked && (dx !== 0 || dy !== 0);
    if (moving) {
        x += dx * within * DOT_PER;
        y += dy * within * DOT_PER;
        if (dx < 0) facing = 'left';
        else if (dx > 0) facing = 'right';
    }

    return { x, y, facing, k, moving, cache: done };
}

module.exports = {
    PLAZA_W, PLAZA_H, SPRITE, STEP_T, DOT_PER, MAX_X, MAX_Y, DIRS,
    hash2, rand01, startPos, dirAt, posAt,
};
