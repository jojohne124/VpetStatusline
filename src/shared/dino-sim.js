'use strict';
/**
 * dino-sim.js — 廣場小遊戲「小恐龍跑酷」的純邏輯（docs/plaza-dino-spec.md）
 *
 * 跟下樓梯相反：位置由**各自的瀏覽器**算（很吃按跳的那一瞬間，伺服器算會黏）。
 * 伺服器只發 seed，大家跑同一條賽道；daemon 把這支原樣內嵌進頁面，測試也直接測它。
 *
 * ⚠️ 這支會被塞進 daemon.js 的 template literal（頁面）：不能有反引號、錢字號接大括號、反斜線。
 *    test-dino 會檢查。
 *
 * 座標：點（dot），跟廣場畫布同一套（69 × 54）。y 是「離地多高」（0 = 站在地上，往上為正）。
 * 時間：固定一步 DT 秒（60 步／秒）—— 同一個 seed、同樣的按鍵 → 同樣的結果。
 */

const W = 69, H = 54;
const GROUND = 42;             // 地平線在畫面上的 y（往下為正）：角色腳底踩在這裡
const S = 12;                  // 角色大小（點，同下樓梯）
const RX = 8;                  // 自己固定在畫面左邊這一格
const PAD = 2;                 // 碰撞身體比畫面縮幾點（擦邊不算撞，原版也是）
const DT = 1 / 60;
// 速度跟跳要搭：一秒跑大約 4 個身長，跳一次在空中跑得過「一叢仙人掌＋自己的身體」（太慢的話物理上跳不過）
const V0 = 50;                 // 起跑速度（點/秒）
const VMAX = 110;
const ACCEL_DIST = 1500;       // 每跑這麼遠加速 V_STEP
const V_STEP = 5;
const GRAV = 300;              // 重力（點/秒²）
const JUMP_V = 95;             // 起跳速度
const HOLD_GRAV = 0.5;         // 按住跳鍵、還在往上時，重力打幾折（跳得比較高）
const SCORE_DIV = 4;           // 分數 = 距離 / SCORE_DIV
const BIRD_FROM = 1200;        // 跑多遠之後才出現飛鳥
// 障礙物：寬、高（點）。仙人掌踩在地上；飛鳥有高度（離地多高 = 鳥的底部）
const CACTUS = { small: [4, 8], big: [6, 11] };
const BIRD = { w: 9, h: 6, low: 2, high: S + 3 };   // low 要跳；high 站著就從頭上飛過（不做蹲，沒有中間高度）

function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** 跑到 dist 時的速度（只跟距離有關 → 產生賽道時就知道那一段會多快） */
function speedAt(dist) {
    return Math.min(VMAX, V0 + Math.floor(dist / ACCEL_DIST) * V_STEP);
}
/** 滯空時間（不按住）與在空中跑的距離：產生障礙物時保證跳得過 */
const AIR = 2 * JUMP_V / GRAV;
function minGap(dist) { return Math.ceil(speedAt(dist) * AIR * 1.35) + S; }

/**
 * 這個障礙物在速度 v 下跳不跳得過（完美操作：剛好的時機起跳、按住到最高點）。
 * 算「身體高過障礙物頂端」的那段時間能跑多遠，夠不夠蓋過「障礙物＋自己的身體」。
 * 產生賽道時用它保證不會出現物理上躲不掉的組合（一叢太寬就少一株）。
 */
function clearable(o, v) {
    const top = o.y + o.h - 1, need = (o.w - 2) + (S - 2 * PAD);
    let y = 0, vy = JUMP_V, t = 0, above = 0;
    for (let i = 0; i < 400 && (y > 0 || i === 0); i++) {
        const k = vy > 0 ? HOLD_GRAV : 1;
        vy -= GRAV * k * DT; y += vy * DT; t += DT;
        if (y >= top) above += DT;
    }
    return above * v >= need;
}

function createGame(seed) {
    const g = { seed: seed >>> 0, rand: rng(seed), t: 0, dist: 0, v: V0, y: 0, vy: 0, hold: false,
                alive: true, obstacles: [], nextX: W + 30, frame: 0 };
    fill(g);
    return g;
}

// 往前補障礙物，補到畫面外兩個畫面寬
function fill(g) {
    while (g.nextX < g.dist + W * 3) {
        const x = g.nextX, r = g.rand;
        let o;
        if (x > BIRD_FROM && r() < 0.25) {
            const high = r() < 0.5;
            o = { kind: high ? 'birdHigh' : 'birdLow', x, w: BIRD.w, h: BIRD.h, y: high ? BIRD.high : BIRD.low };
        } else {
            const big = r() < 0.4;
            let n = 1 + Math.floor(r() * (big ? 2 : 3));   // 大的最多 2 株、小的最多 3 株
            const [cw, ch] = big ? CACTUS.big : CACTUS.small;
            const mk = (k) => ({ kind: big ? 'cactusBig' : 'cactusSmall', n: k, x, w: cw * k + (k - 1), h: ch, y: 0 });
            o = mk(n);
            while (n > 1 && !clearable(o, speedAt(x))) o = mk(--n);   // 太寬跳不過就少一株
        }
        g.obstacles.push(o);
        // 下一個：至少要跳得過（依那一段的速度），再加一點亂數
        g.nextX = x + o.w + minGap(x) + Math.floor(r() * 40);
    }
    g.obstacles = g.obstacles.filter(o => o.x + o.w > g.dist - RX - 4);
}

/** 按下／放開跳鍵。按下時在地上就起跳；按住的話往上時重力打折（跳得比較高） */
function press(g, down) {
    if (!g.alive) return;
    if (down && !g.hold && g.y <= 0) { g.vy = JUMP_V; g.y = 0.001; }
    g.hold = !!down;
}

/** 這一刻有沒有撞到：角色身體（縮 PAD）對障礙物（縮 1） */
function hit(g) {
    const ax0 = g.dist + PAD, ax1 = g.dist + S - PAD, ay0 = g.y, ay1 = g.y + S - PAD;
    for (const o of g.obstacles) {
        const bx0 = o.x - RX + 1, bx1 = o.x - RX + o.w - 1;
        if (bx1 < ax0 || bx0 > ax1) continue;
        const by0 = o.y + 1, by1 = o.y + o.h - 1;
        if (by1 > ay0 && by0 < ay1) return o;
    }
    return null;
}

/** 往前一步（DT 秒）。回傳 'dead' = 這一步撞到了 */
function step(g) {
    if (!g.alive) return null;
    g.t += DT; g.frame++;
    g.v = speedAt(g.dist);
    g.dist += g.v * DT;
    if (g.y > 0 || g.vy > 0) {
        const k = g.hold && g.vy > 0 ? HOLD_GRAV : 1;
        g.vy -= GRAV * k * DT;
        g.y += g.vy * DT;
        if (g.y <= 0) { g.y = 0; g.vy = 0; }
    }
    fill(g);
    if (hit(g)) { g.alive = false; return 'dead'; }
    return null;
}

const score = (dist) => Math.floor(dist / SCORE_DIV);

module.exports = {
    W, H, GROUND, S, RX, PAD, DT, V0, VMAX, ACCEL_DIST, V_STEP, GRAV, JUMP_V, HOLD_GRAV, SCORE_DIV,
    BIRD_FROM, CACTUS, BIRD, AIR,
    rng, speedAt, minGap, clearable, createGame, press, step, hit, score,
};
