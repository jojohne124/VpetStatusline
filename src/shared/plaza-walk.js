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
const PLAZA_H = 48;   // dot（= 384 px）
const SPRITE  = 16;   // 角色寬高（dot）
// 高度 96 → 64 → 48（2026-08-20 兩次調矮）。原本是正方形 —— 注意「視覺正方形」是
// dot 數相等而不是 cell 數相等（1 cell = 1 dot 寬 × 2 dot 高）—— 但 768×768 在
// 瀏覽器裡連表頭都要捲動才看得完。現在是 2:1 的橫幅。
// 改這兩個常數就會改場地，其餘程式（合成、名牌、畫布尺寸、測試）全部從這裡推導。

// 一拍多長。家裡的 statusline 是 1000ms —— 那個數字是被 Claude Code 的
// statusLine.refreshInterval（最快 1 秒）綁住的，不是美感選擇。廣場只在 daemon 的
// 瀏覽器畫面跑，沒有那個限制，所以拍子可以更細、走起來更順。
// ⚠️ 這是**時間契約的一部分**：所有 client 都要用同一個值把牆鐘換成 step，
// 改了就等於改變所有人的走路速度，不能單邊調。
const STEP_MS  = 750;
const DOT_PER  = 1;   // 每拍移動 1 dot

// ── 走位：任意斜率的「一段路」──────────────────────────────────────────
// 演算法改過兩次，兩次都是看了畫面才發現問題：
//
// v1「每 4 拍走 4 dot」→ 碎步磨蹭，一小時只走訪 486 格。
// v2「一次抽一段路（上下左右 + 四斜向）」→ 範圍夠了，但**軌跡只有 8 種角度**，
//    放久了整張圖是水平線、垂直線、45 度線疊出來的網格，看起來像在走既定路線。
// v3（本版）改成**有理斜率**：方向不再是 8 個單位向量，而是一組互質向量
//    （分量 |v| <= 3，例如 3:1、2:3），用 Bresenham 走出來。角度從 8 種變成 32 種，
//    而且長度連續（不再全是偶數），路徑就不會反覆疊在同幾條線上。
//
// 為什麼不用 cos/sin 取連續角度：那會引入超越函數。整個廣場的前提是
// **每個 client 算出位元級相同的結果**，而 Math.sin/cos 的精確值不在 IEEE754
// 的保證範圍內（不同引擎/版本可能差 1 ulp）。互質向量 + Bresenham 全程整數運算，
// 沒有這個風險。

// 分量 |v| <= 3 的互質向量（含各象限）。互質才不會有重複角度（(2,2) 等同 (1,1)）。
const DIR_VECTORS = (() => {
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const out = [];
    for (let vx = -3; vx <= 3; vx++) {
        for (let vy = -3; vy <= 3; vy++) {
            if (!vx && !vy) continue;
            if (gcd(Math.abs(vx), Math.abs(vy)) !== 1) continue;
            out.push([vx, vy]);
        }
    }
    return out;   // 32 個方向
})();

// 一段路走幾拍：連續整數，不是固定清單。v2 的清單全是偶數，
// 導致每段的終點永遠落在同一個奇偶晶格上，轉彎點也跟著規律化。
const RUN_MIN = 6, RUN_MAX = 34;
// 停一次幾拍。注意「抽中停的機率」與「站著的時間佔比」差很多 ——
// 一段路平均 15 拍、一次停平均 6 拍，所以 1/4 的抽中率換算成時間只有約 12%。
// v1 曾經是時間 37%，畫面上就是一群角色在發呆。
// 停下時角色仍持續演 IDLE_1/IDLE_2（見 plaza.js spriteDots），
// 所以停 4~8 拍讀起來是「站著休息」而不是「當掉」。
const STAY_MIN = 4, STAY_MAX = 8;
const STAY_CHANCE = 1 / 4;

const MAX_X = PLAZA_W - SPRITE;
const MAX_Y = PLAZA_H - SPRITE - 2;   // 見下方 LABEL_RESERVE
// 底部保留一個 cell 列（2 dot）給名牌。名牌固定標在**腳下**（見 plaza.js
// buildLabels），沒有這段保留區的話，角色走到最底時腳下那一列會落到畫面外，
// 名牌就整個不見。代價只有 2 dot 的可走範圍，換到的是「名牌位置永遠固定」。
const LABEL_RESERVE = 2;
const MIN_X = 0;
const MIN_Y = 0;

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
        x: MIN_X + Math.min(MAX_X - MIN_X, Math.floor(rand01(seed, -1) * (MAX_X - MIN_X + 1))),
        y: MIN_Y + Math.min(MAX_Y - MIN_Y, Math.floor(rand01(seed, -2) * (MAX_Y - MIN_Y + 1))),
        facing: rand01(seed, -3) < 0.5 ? 'left' : 'right',
    };
}

/**
 * 沿方向向量 (vx, vy) 走 t 拍之後的位移（Bresenham，主軸每拍恰好 1 dot）。
 *
 * 主軸 = |v| 較大的那一軸，每拍走 1 dot；副軸依比例四捨五入。
 * 用整數算式一次求出第 t 拍的位置（不是逐拍累加）—— 這樣任何 client 從任何
 * 時間點切進來都得到同一個值，也不必擔心累加誤差。
 */
function offsetAt(vx, vy, t) {
    const ax = Math.abs(vx), ay = Math.abs(vy);
    const major = Math.max(ax, ay);
    if (major === 0) return [0, 0];
    // 四捨五入用整數寫法：floor((2*t*minor + major) / (2*major))
    const proj = (m) => Math.floor((2 * t * m + major) / (2 * major));
    return ax >= ay
        ? [Math.sign(vx) * t, Math.sign(vy) * proj(ay)]
        : [Math.sign(vx) * proj(ax), Math.sign(vy) * t];
}

/**
 * 第 k 段路：方向向量 + 長度（拍）。
 *
 * 撞牆的處理是**走到牆邊就停、下一段重新抽方向**。
 * v1 是「整段作廢」—— 貼邊的角色會一直決策了但沒動，看起來像卡住。
 * v2 改成反彈，能動了，但固定 8 方向的反彈會走出撞球檯般的週期軌跡，
 * 反而強化了「路線很單一」的感覺。走到牆邊換方向最自然，
 * 而且順帶讓「最長段不得超過場地」這條隱形限制消失（縮小場地不會再穿牆）。
 *
 * 依賴這一段起點的座標，所以不是純 f(seed,k) —— 但座標本身是決定性的，
 * 整條鏈仍然可重播。
 */
function legAt(seed, k, x, y) {
    if (rand01(seed, k * 3) < STAY_CHANCE) {
        const len = STAY_MIN + Math.floor(rand01(seed, k * 3 + 1) * (STAY_MAX - STAY_MIN + 1));
        return { vx: 0, vy: 0, len: Math.min(len, STAY_MAX), stay: true };
    }
    const v    = DIR_VECTORS[Math.floor(rand01(seed, k * 3 + 1) * DIR_VECTORS.length) % DIR_VECTORS.length];
    const want = RUN_MIN + Math.floor(rand01(seed, k * 3 + 2) * (RUN_MAX - RUN_MIN + 1));

    // 截短到剛好停在牆邊。位移在兩軸都單調，往回找第一個界內的 t 即可；
    // want 最多 RUN_MAX，成本可忽略。
    const fit = (vx, vy) => {
        let n = Math.min(want, RUN_MAX);
        while (n > 0) {
            const [ox, oy] = offsetAt(vx, vy, n);
            if (x + ox >= MIN_X && x + ox <= MAX_X && y + oy >= MIN_Y && y + oy <= MAX_Y) return n;
            n--;
        }
        return 0;
    };

    let len = fit(v[0], v[1]);
    if (len > 0) return { vx: v[0], vy: v[1], len, stay: false };

    // 已經貼在牆上、朝外走一步都不行 → 掉頭走同一條線。
    // 不這樣做的話只能當成「停」，而貼牆是很常發生的事，停留比例會被灌水
    // （實測 12% → 21%），畫面上就是一堆角色在邊緣發呆。
    len = fit(-v[0], -v[1]);
    if (len > 0) return { vx: -v[0], vy: -v[1], len, stay: false };

    return { vx: 0, vy: 0, len: STAY_MIN, stay: true };   // 理論上到不了（場地至少放得下一步）
}

/**
 * 某人在第 step 拍的位置。
 *
 * 段長不固定，所以「第幾段」無法由 step 直接除出來 —— cache 要記到哪一拍為止，
 * 從那裡往前推。不傳 cache 也正確，只是要從進場重播（一小時約 200 段，幾毫秒）。
 * 全程整數，任何 client 從任何時間點重播都得到完全一樣的結果，無浮點漂移。
 *
 * @param {{seed:number, joinStep:number}} occ
 * @param {number} step
 * @param {{k:number,at:number,x:number,y:number,facing:string}|null} cache
 * @returns {{x,y,facing,k,moving,cache}}
 */
function posAt(occ, step, cache) {
    const { seed, joinStep } = occ;
    const target = Math.max(0, step - joinStep);

    // 快取只在「沒有倒退」時可用（倒退＝時鐘校正把 step 拉回來了）
    let st = (cache && cache.at <= target)
        ? { ...cache }
        : { ...startPos(seed), k: 0, at: 0 };

    // 推進完整的段
    let leg = legAt(seed, st.k, st.x, st.y);
    while (st.at + leg.len <= target) {
        const [ox, oy] = offsetAt(leg.vx, leg.vy, leg.len);
        st.x += ox; st.y += oy;
        if (leg.vx < 0) st.facing = 'left';
        else if (leg.vx > 0) st.facing = 'right';
        // 純垂直 / 停 → 維持前一個面向（只有左右兩種幀，美術限制）
        st.at += leg.len;
        st.k  += 1;
        leg = legAt(seed, st.k, st.x, st.y);
    }

    // 這一段已經走了幾拍（零頭）→ 補上，移動才連續而不是每段瞬移
    const within = target - st.at;
    const [ox, oy] = offsetAt(leg.vx, leg.vy, within);
    const x = st.x + ox, y = st.y + oy;
    let facing = st.facing;
    // within === 0 的那一拍畫的其實是「上一段的終點」—— 位置還沒動，就先套新方向的
    // 面向會讓角色在最後一步往右走的同時臉朝左，每次轉向都閃一格反向。
    // 要等真的邁出第一步（within >= 1）才轉身。
    if (within > 0) {
        if (leg.vx < 0) facing = 'left';
        else if (leg.vx > 0) facing = 'right';
    }

    return { x, y, facing, k: st.k, moving: !leg.stay, cache: st };
}

/**
 * 牆鐘毫秒 → 第幾拍。所有 client 共用這一個換算，時鐘先用 serverNow 校正過
 * （clockSkew = serverNow - localNow），否則各機器差幾秒就會看到不同畫面。
 */
function stepAt(ms) { return Math.floor(ms / STEP_MS); }

module.exports = {
    PLAZA_W, PLAZA_H, SPRITE, STEP_MS, DOT_PER, MIN_X, MIN_Y, MAX_X, MAX_Y, LABEL_RESERVE,
    DIR_VECTORS, RUN_MIN, RUN_MAX, STAY_MIN, STAY_MAX, STAY_CHANCE,
    hash2, rand01, startPos, offsetAt, legAt, posAt, stepAt,
};
