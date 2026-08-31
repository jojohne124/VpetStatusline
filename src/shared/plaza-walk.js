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
// 掃描替代方向時的跳躍步長。與 DIR_VECTORS.length（32）互質才會走遍全部方向；
// 用 1 的話會一路試相鄰角度，那些方向對著同一面牆，等於白掃。
const DIR_SCAN_STRIDE = 7;
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
// 撞牆截短之後還剩幾拍，才算「這段值得走」。低於這個數就改抽別的方向 —— 見 legAt。
const MIN_LEG = 5;
// 停一次幾拍。注意「抽中停的機率」與「站著的時間佔比」差很多 ——
// 一段路平均 15 拍、一次停平均 6 拍，所以 1/4 的抽中率換算成時間只有約 12%。
// v1 曾經是時間 37%，畫面上就是一群角色在發呆。
// 停下時角色仍持續演 IDLE_1/IDLE_2（見 plaza.js spriteDots），
// 所以停 4~8 拍讀起來是「站著休息」而不是「當掉」。
const STAY_MIN = 4, STAY_MAX = 8;
const STAY_CHANCE = 1 / 4;

// 底部保留一個 cell 列（2 dot）給名牌。名牌固定標在**腳下**（見 plaza.js
// buildLabels），沒有這段保留區的話，角色走到最底時腳下那一列會落到畫面外，
// 名牌就整個不見。代價只有 2 dot 的可走範圍，換到的是「名牌位置永遠固定」。
const LABEL_RESERVE = 2;

/**
 * 場地。廣場與院子是**不同的空間**，尺寸各自決定 ——
 * 廣場要塞 20 個人但得跟家裡的舞台擠同一個版面；院子最多 8 隻、獨佔畫面，可以大方些。
 * 所以場地不是模組層的常數，而是一個傳進來的物件。
 *
 * 用工廠函式而不是各自宣告一組常數，是因為 minX/maxY 這些是**推導**出來的
 * （要扣角色寬高、扣名牌保留區）；讓呼叫端自己算遲早會有人算錯一格，
 * 而算錯的症狀是「偶爾有隻角色被裁掉半個身體」這種很難聯想到原因的東西。
 */
function makeField(w, h, labelReserve = LABEL_RESERVE) {
    return {
        w, h,
        minX: 0, maxX: w - SPRITE,
        minY: 0, maxY: h - SPRITE - labelReserve,
    };
}

const PLAZA_FIELD = makeField(PLAZA_W, PLAZA_H);
// 院子：52 x 40 dot（416 x 320 px）。寬度刻意對齊家裡（前線）的舞台 —— 兩個畫面
// 在同一個版位切換，寬度一樣才不會每按一次按鈕整頁就跳一下。
// ⚠️ 這個尺寸對 8 隻來說很擠：可站位置只有 37 x 24，而角色是 16 x 16，
// 幾乎一定會互相重疊。是刻意先試小的，不是算錯。
// 第三個參數 0 = 不留名牌位：院子不顯示名字（要看是誰就右鍵），
// 省下來的 2 dot 直接還給可走範圍。
const YARD_FIELD  = makeField(52, 40, 0);

// ── 營地分區 ─────────────────────────────────────────────────────────
// 3 隻共用 37x25 的可站範圍時，有 73.7% 的拍數會有一對蓋掉對方 25% 以上的身體
// （量測見 docs/ranch-spec.md）。sprite 面積其實只佔場地 37%，擠在一起純粹是
// 走路各走各的、沒人管彼此。所以按隻數把可走範圍切開，每隻一個 field ——
// posAt / legAt / startPos 本來就吃 field 參數，演算法一行都不用改。
//
// ⚠️ 只切直欄沒有用：37 寬切三欄每欄 12 格，比角色本身的 16 還窄，鄰欄註定重疊
//    （實測只從 73.7% 降到 53.5%）。要二維切，縱向也拉開，才降得到個位數。
//
// ZONE_MARGIN = 相鄰區域允許重疊幾格。0 = 完全不重疊但區域只剩 11x5，角色一直
// 撞牆（貼場地邊 11.8%，超過測試門檻 8%）。4 是掃出來的甜蜜點：
//   margin  區域    嚴重重疊  貼真實邊
//     0     11x5      0.0%     11.8%   ← 撞牆太頻繁
//     2     13x7      0.1%      9.3%
//     3     14x8      1.8%      8.3%
//     4     15x9      7.4%      7.3%   ← 三條既有門檻全過，且「些許重疊比較自然」
const ZONE_MARGIN = 4;

/**
 * 切法表。**要調整分區就改這裡**，其他地方不用動。
 *
 * 每塊區域寫成 [x0, y0, x1, y1]，0~1 的比例，指的是**角色左上角**能站的範圍。
 * 貼齊 0 或 1 的邊 = 場地邊界，原樣採用；**中間的接縫會自動讓開** 半個角色寬
 * （SPRITE/2 = 8 dot）再依 ZONE_MARGIN 放寬 —— 讓滿 8 才真的不會重疊，
 * ZONE_MARGIN 是「刻意還回去多少」，回去越多越自然、也越容易疊到。
 *
 * 量測（30 組 seed x 3000 拍；「嚴重重疊」= 一對蓋掉對方 25% 以上身體）：
 *
 *   n=2  切法        嚴重重疊  場地利用  貼場地邊  區域
 *        leftRight      1.1%     100%      6.1%   15x25 15x25   ← 預設
 *        topBottom      2.5%     100%      6.7%   37x9  37x9
 *        （不分區）     34.4%     100%      5.2%
 *
 *   n=3  切法        嚴重重疊  場地利用  貼場地邊  區域
 *        quadFull       6.6%     100%      6.9%   15x9 15x9 37x9   ← 預設
 *        quad           7.2%      83%      7.3%   15x9 15x9 15x9   右下是死區
 *        triangle       3.6%      80%      6.4%   15x9 15x9 11x9   重疊最少，但下方兩側空著
 *        rows          46.0%     100%      8.3%   37x5 37x1 37x5   橫帶只差 8 < 角色 16，等於沒分
 *        cols          14.2%     100%      6.2%   9x25 5x25 9x25   中間那欄只剩 5 格
 *        （不分區）     73.7%     100%      5.2%
 *
 * 三隻要同時「重疊少」與「用滿場地」，就得讓其中一塊吃掉整條邊 —— 場地只有
 * 37x25 而角色 16x16，切成四等分的話第四塊沒人站，那塊就是死區（quad 的 83%）。
 * rows / cols 留在表裡是為了能在 dev 下拉裡看出「為什麼不能那樣切」。
 */
const YARD_LAYOUTS = {
    1: { solo:      [[0, 0, 1, 1]] },
    2: { leftRight: [[0, 0, .5, 1], [.5, 0, 1, 1]],
         topBottom: [[0, 0, 1, .5], [0, .5, 1, 1]] },
    3: { quadFull:  [[0, 0, .5, .5], [.5, 0, 1, .5], [0, .5, 1, 1]],
         quad:      [[0, 0, .5, .5], [.5, 0, 1, .5], [0, .5, .5, 1]],
         triangle:  [[0, 0, .5, .5], [.5, 0, 1, .5], [.25, .5, .75, 1]],
         rows:      [[0, 0, 1, 1 / 3], [0, 1 / 3, 1, 2 / 3], [0, 2 / 3, 1, 1]],
         cols:      [[0, 0, 1 / 3, 1], [1 / 3, 0, 2 / 3, 1], [2 / 3, 0, 1, 1]] },
};
const YARD_LAYOUT_DEFAULT = { 1: 'solo', 2: 'leftRight', 3: 'quadFull' };

/**
 * 把場地切成 n 個子場地（每隻一個）。順序固定，呼叫端用「第幾隻」索引。
 * n 沒有對應的切法就整場共用（退回分區之前，不會壞掉）。
 *
 * layout 可以是：
 *   - 切法名稱（dev 下拉用來現場比較）
 *   - 一組比例矩形 [[x0,y0,x1,y1], ...]（同上，會套接縫讓開）
 *   - { exact: [[minX,maxX,minY,maxY], ...] } —— **dot 絕對座標，原樣採用**
 *   - null → 該隻數的預設切法
 *
 * ⚠️ 編輯器存的是 exact。理由是「比例 + 接縫讓開」在場地邊界有分支
 * （貼邊的邊不讓、內側的邊要讓 gap），那個換算**不可逆** —— 把一塊區域平移到
 * 貼邊時，其中一條邊會跨過分支，尺寸就跟著變（回報：「移動區到邊緣會變動區塊大小」）。
 * 直接操作的工具不能有這種行為，所以它存絕對座標；比例那套留給內建表當簡寫。
 */
function yardZones(n, field = YARD_FIELD, margin = ZONE_MARGIN, layout = null) {
    const F = field;
    // 絕對座標：原樣採用，只夾進場地。不套接縫讓開 —— 那是比例簡寫才需要的。
    if (layout && !Array.isArray(layout) && Array.isArray(layout.exact) && layout.exact.length === n) {
        return layout.exact.map(([minX, maxX, minY, maxY]) => {
            const z = { ...F,
                minX: clamp(Math.round(minX), F.minX, F.maxX), maxX: clamp(Math.round(maxX), F.minX, F.maxX),
                minY: clamp(Math.round(minY), F.minY, F.maxY), maxY: clamp(Math.round(maxY), F.minY, F.maxY) };
            if (z.maxX < z.minX) z.maxX = z.minX;
            if (z.maxY < z.minY) z.maxY = z.minY;
            return z;
        });
    }
    const table = YARD_LAYOUTS[n];
    const rects = Array.isArray(layout) && layout.length === n
        ? layout
        : (table && (table[layout] || table[YARD_LAYOUT_DEFAULT[n]]));
    if (!rects) return new Array(Math.max(1, n || 1)).fill(F);
    const gap = SPRITE / 2 - margin;            // 接縫往兩邊各讓開多少
    const spanX = F.maxX - F.minX, spanY = F.maxY - F.minY;
    return rects.map(([x0, y0, x1, y1]) => {
        const z = {
            ...F,
            minX: x0 <= 0 ? F.minX : Math.min(F.maxX, F.minX + Math.round(spanX * x0) + gap),
            maxX: x1 >= 1 ? F.maxX : Math.max(F.minX, F.minX + Math.round(spanX * x1) - gap),
            minY: y0 <= 0 ? F.minY : Math.min(F.maxY, F.minY + Math.round(spanY * y0) + gap),
            maxY: y1 >= 1 ? F.maxY : Math.max(F.minY, F.minY + Math.round(spanY * y1) - gap),
        };
        // 自訂切法可能存出反向或退化的矩形（畫太小、拖過頭）。這裡收斂成合法值 ——
        // 反向的 min/max 會讓 legAt 永遠找不到路可走，症狀是那一隻整個定住不動。
        if (z.maxX < z.minX) z.maxX = z.minX;
        if (z.maxY < z.minY) z.maxY = z.minY;
        return z;
    });
}

// 這個 n 有哪些切法可選（dev 下拉用）
const yardLayoutNames = (n) => Object.keys(YARD_LAYOUTS[n] || {});

// 區域中心。放下時若落在區域外，這是「走回去」的目標。
const zoneAnchor = (z) => ({ x: Math.round((z.minX + z.maxX) / 2),
                             y: Math.round((z.minY + z.maxY) / 2) });
const inZone = (p, z) => p.x >= z.minX && p.x <= z.maxX && p.y >= z.minY && p.y <= z.maxY;

/**
 * 回程：從落點到定位點的一條直線。
 *
 * 關鍵性質是**它也是算出來的**：長度 = max(|dx|,|dy|)（主軸每拍 1 dot，跟平常走路
 * 同速），路徑交給既有的 offsetAt 走 Bresenham。整段只由 (origin, anchor) 決定，
 * 所以 posAt 仍然是純函數 —— 不必存任何位置，快取的 epoch 已經含 origin 與 field。
 *
 * 走 t = len 拍剛好落在 anchor 上（offsetAt 在主軸走滿時副軸也剛好到位），
 * 不會差一格，也不會需要在終點做修正。
 */
function returnLeg(origin, anchor) {
    const vx = anchor.x - origin.x, vy = anchor.y - origin.y;
    return { vx, vy, len: Math.max(Math.abs(vx), Math.abs(vy)) };
}

// 向後相容：既有呼叫端仍在用這幾個常數（＝廣場的場地）
const MIN_X = PLAZA_FIELD.minX, MAX_X = PLAZA_FIELD.maxX;
const MIN_Y = PLAZA_FIELD.minY, MAX_Y = PLAZA_FIELD.maxY;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

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
//
// occ.origin（營地把 vpet 拿起來又放下時用）會取代這個起點，見 posAt。
// ⚠️ 「放下」不能寫成「把算出來的 x,y 塞回去」—— 位置是**算**出來的不是存的，
//    快取一失效就會彈回 startPos。所以放下＝換一個起點 + 把 joinStep 設成當下，
//    那隻從落點開始走一條全新的鏈。origin 是輸入，決定性不受影響。
function startPos(seed, field = PLAZA_FIELD) {
    const { minX, maxX, minY, maxY } = field;
    return {
        x: minX + Math.min(maxX - minX, Math.floor(rand01(seed, -1) * (maxX - minX + 1))),
        y: minY + Math.min(maxY - minY, Math.floor(rand01(seed, -2) * (maxY - minY + 1))),
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
function legAt(seed, k, x, y, field = PLAZA_FIELD) {
    const { minX, maxX, minY, maxY } = field;

    // 貼在哪幾面牆上。撞到牆的那一拍，下一段一定要「離開那面牆」——
    // 不然可以沿著牆邊一直滑，看起來就是黏在邊界。
    const wL = x <= minX, wR = x >= maxX, wT = y <= minY, wB = y >= maxY;
    const onWall = wL || wR || wT || wB;
    // 注意 y 向下為正：離開上緣是 vy > 0，離開下緣是 vy < 0。
    const leaves = (vx, vy) => (!wL || vx > 0) && (!wR || vx < 0)
                            && (!wT || vy > 0) && (!wB || vy < 0);

    // 貼牆時不抽「停」。停在牆邊 4~8 拍是「卡在邊界」體感最大的來源 ——
    // 一般位置照舊有 STAY_CHANCE 的機率停下來發呆。
    if (!onWall && rand01(seed, k * 3) < STAY_CHANCE) {
        const len = STAY_MIN + Math.floor(rand01(seed, k * 3 + 1) * (STAY_MAX - STAY_MIN + 1));
        return { vx: 0, vy: 0, len: Math.min(len, STAY_MAX), stay: true };
    }
    const idx  = Math.floor(rand01(seed, k * 3 + 1) * DIR_VECTORS.length) % DIR_VECTORS.length;
    const want = RUN_MIN + Math.floor(rand01(seed, k * 3 + 2) * (RUN_MAX - RUN_MIN + 1));

    // 截短到剛好停在牆邊。位移在兩軸都單調，往回找第一個界內的 t 即可；
    // want 最多 RUN_MAX，成本可忽略。
    const fit = (vx, vy) => {
        let n = Math.min(want, RUN_MAX);
        while (n > 0) {
            const [ox, oy] = offsetAt(vx, vy, n);
            if (x + ox >= minX && x + ox <= maxX && y + oy >= minY && y + oy <= maxY) return n;
            n--;
        }
        return 0;
    };

    // 抽到的方向被牆截得太短就換一個，而不是硬走那一兩拍。
    //
    // 為什麼需要這一段：貼著牆的時候，「幾乎與牆平行、但帶一點朝外分量」的方向
    // 會被 fit 截成 1~2 拍，於是角色每一兩拍就重抽一次方向，在原地抖 —— 看起來
    // 就是卡在邊界。營地場地小（可走範圍只有 37x25），這件事特別明顯：
    // 實測貼邊時間 19.2%、角落 (0,24) 的出現率是平均值的 6 倍。
    //
    // 掃描順序從抽到的那個方向開始、以與 32 互質的步長跳，所以會走遍全部 32 個方向
    // 而不偏袒任何一邊；起點仍是亂數決定的，路線的多樣性不受影響。
    // 全程只用整數與 seed，決定性不變。
    //
    // 掃兩輪：第一輪額外要求「離開所貼的牆」（= 撞牆就往外走，不沿著牆滑）；
    // 沒有位置在牆上時 leaves() 恆真，兩輪等價。第二輪拿掉那個要求當退路 ——
    // 場地極小或縮在角落時可能真的沒有同時滿足兩者的方向，寧可走得動也不要卡死。
    const n = DIR_VECTORS.length;
    let bestLen = 0, bestV = null;
    for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < n; i++) {
            const c = DIR_VECTORS[(idx + i * DIR_SCAN_STRIDE) % n];
            if (pass === 0 && !leaves(c[0], c[1])) continue;
            const len = fit(c[0], c[1]);
            if (len >= MIN_LEG) return { vx: c[0], vy: c[1], len, stay: false };
            if (len > bestLen) { bestLen = len; bestV = c; }
        }
        if (!onWall) break;   // 沒貼牆 → 第一輪就是全掃，不需要再來一次
    }
    // 所有方向都走不滿 MIN_LEG（場地極小或縮在角落）→ 走能走的最長那個。
    if (bestLen > 0) return { vx: bestV[0], vy: bestV[1], len: bestLen, stay: false };

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
// 一次呼叫最多重播幾拍。超過就把起點往前拉，等同「這隻是那時候才進場的」。
//
// 這道保險是被實際咬過才加的：yard 那邊一開始把 joinStep 寫死成 0，但餵進來的 step
// 是牆鐘算出來的（約 24 億），於是 posAt 要跑一億六千萬次迴圈 —— 而它是同步的，
// **整個 daemon 的 event loop 就卡死了**，連無關的 /state 都一起停擺。
// 呼叫端傳錯參數不該讓伺服器當掉，所以這裡自己擋住。
//
// ⚠️ 這個上限限制的是**重播的距離**，不是**目標的拍數**。
// 第一版寫成 target = min(MAX_REPLAY, step - joinStep)，那是限制目標 ——
// 後果是超過上限之後 target 就不再成長，全場所有人**永遠定格**，而 tick 照跳。
// 院子的 joinStep 是「daemon 這次啟動的時間」，daemon 一開就是好幾天，
// 所以這條路徑不是理論上碰得到，是必然會碰到：實際在開機 63.7 小時後全員卡住。
// 現在改成把起點往前拉（見 posAt 的 from），也就是註解一開始就說要做的事。
const MAX_REPLAY = 200000;

function posAt(occ, step, cache, field = PLAZA_FIELD) {
    const { seed, joinStep } = occ;
    let target = Math.max(0, step - joinStep);
    const org = occ.origin;

    // 落點在自己的可走範圍外（營地分區後，放到別人的地盤或走道上就會這樣）：
    // 先走一條直線回定位點，再從那裡接回正常的鏈。
    //
    // ⚠️ 不要改成「把落點夾進範圍」—— 那等於還沒走就先瞬移，使用者放下的位置
    //    直接被抹掉。夾住是 occ.anchor 不存在時（廣場）的舊行為，保留。
    if (org && occ.anchor && !inZone(org, field)) {
        const leg = returnLeg(org, occ.anchor);
        if (target < leg.len) {
            const [ox, oy] = offsetAt(leg.vx, leg.vy, target);
            return { x: org.x + ox, y: org.y + oy,
                     facing: leg.vx < 0 ? 'left' : leg.vx > 0 ? 'right' : (org.facing || 'right'),
                     // 回程不建快取：它是短暫的、而且逐拍直接算得出來，
                     // 建了反而要處理「快取屬於回程還是正常鏈」的分支。
                     k: -1, moving: true, returning: true, cache: null };
        }
        target -= leg.len;                       // 走到了，時間扣掉回程
    }

    // 被放下過的那隻從落點起算；沒有就用 seed 決定的進場位置。
    // 走過回程的那隻改從定位點起算（它現在就站在那裡）。
    const from0 = org
        ? (occ.anchor && !inZone(org, field)
            ? { x: occ.anchor.x, y: occ.anchor.y, facing: org.facing || 'right' }
            : { x: clamp(org.x, field.minX, field.maxX),
                y: clamp(org.y, field.minY, field.maxY),
                facing: org.facing || 'right' })
        : startPos(seed, field);

    // 快取屬於「哪一條時間軸」。joinStep 或落點一變（＝被拿起來放到別的地方），
    // 之前那份備忘就是另一條軸上的位置，必須整份作廢。
    // ⚠️ 少了這個判斷會出現：放下之後那隻回到被抓起來前的位置，而 anchor 明明記對了。
    //    因為剛放下時 target 是 0，而快取的 at 也可能是 0（還在第一段路裡），
    //    `cache.at <= target` 就成立了 —— 舊位置被當成有效答案。
    // ⚠️ field 一定要進 epoch：營地按隻數分區之後，keep / release 會讓每隻的可走
    //    範圍整組換掉，而快取裡的 x,y 是用**舊的牆**算出來的。少了這一段，舊快取
    //    會被當成有效，角色就在新區域外面繼續走既有的鏈。
    const epoch = joinStep + '|' + (occ.origin
        ? occ.origin.x + ',' + occ.origin.y + ',' + (occ.origin.facing || '')
        : '')
        + '|' + field.minX + ',' + field.maxX + ',' + field.minY + ',' + field.maxY;

    // 快取只在「沒有倒退」時可用（倒退＝時鐘校正把 step 拉回來了）。
    // 有快取就完全不受 MAX_REPLAY 影響 —— 每次輪詢只往前推幾拍，
    // 所以 daemon 跑再久都照走。上限真正管的是**沒有快取**的那一次冷啟動。
    const usable = cache && cache.epoch === epoch && cache.at <= target && target - cache.at <= MAX_REPLAY;
    // 冷啟動又離得太遠 → 當作「這隻現在才進場」：從 startPos 起算、完全不重播。
    // 不要改成「從 target - MAX_REPLAY 起算」：那等於每次都重播剛好 MAX_REPLAY 拍
    // 的同一條鏈（鏈只由 seed 與 k 決定），算出來的位置是常數，一樣定格，
    // 還白花 6ms。距離在上限內時照舊從 0 重播，既有行為與決定性都不變。
    let st = usable
        ? { ...cache }
        : { ...from0, k: 0, at: target > MAX_REPLAY ? target : 0, epoch };

    // 推進完整的段
    let leg = legAt(seed, st.k, st.x, st.y, field);
    while (st.at + leg.len <= target) {
        const [ox, oy] = offsetAt(leg.vx, leg.vy, leg.len);
        st.x += ox; st.y += oy;
        if (leg.vx < 0) st.facing = 'left';
        else if (leg.vx > 0) st.facing = 'right';
        // 純垂直 / 停 → 維持前一個面向（只有左右兩種幀，美術限制）
        st.at += leg.len;
        st.k  += 1;
        leg = legAt(seed, st.k, st.x, st.y, field);
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
    makeField, PLAZA_FIELD, YARD_FIELD,
    ZONE_MARGIN, YARD_LAYOUTS, YARD_LAYOUT_DEFAULT, yardZones, yardLayoutNames,
    zoneAnchor, inZone, returnLeg,
    DIR_VECTORS, DIR_SCAN_STRIDE, RUN_MIN, RUN_MAX, MIN_LEG, STAY_MIN, STAY_MAX, STAY_CHANCE, MAX_REPLAY,
    hash2, rand01, clamp, startPos, offsetAt, legAt, posAt, stepAt,
};
