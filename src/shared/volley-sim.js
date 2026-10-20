'use strict';
/**
 * volley-sim.js — 廣場小遊戲「打排球」的純邏輯（docs/plaza-volley-spec.md）
 *
 * 1 對 1，**輸入同步（鎖步）**：兩邊的瀏覽器各算同一套模擬，只交換「這一格按了什麼鍵」。
 * 所以這支必須**完全決定性**：全部用整數（座標是 1/8 點），不用 Math.random、不用浮點、不看時間。
 * 同樣的輸入序列，兩台算出來一模一樣 —— 一點點不同就會分岔（兩邊看到的比分不一樣）。
 *
 * ⚠️ 這支會被塞進 daemon.js 的 template literal（頁面）：不能有反引號、錢字號接大括號、反斜線。
 *
 * 座標：1/8 點（SUB），跟廣場畫布同一套（69 × 54 點）。y 向下為正。一格 = 1/25 秒（同原版皮卡丘排球）。
 * 按鍵：位元 1 = 左、2 = 右、4 = 跳、8 = 殺球（在空中碰到球時用力往下打）。
 */

const SUB = 8;                       // 1 點 = 8 單位
const W = 69 * SUB, H = 54 * SUB;
const GROUND = 46 * SUB;             // 地面（腳底）
const S = 12 * SUB;                  // 角色大小
const NET_X = Math.floor(W / 2), NET_W = 2 * SUB, NET_TOP = GROUND - 14 * SUB;
const BALL_R = 3 * SUB;
const FPS = 25, FRAME_MS = 40;
const RUN = 13;                      // 每格走幾單位（約 1.6 點）
const JUMP = 58;                     // 起跳速度（每格往上幾單位）
const GRAV = 6;                      // 角色的重力（每格加速）
const BALL_GRAV = 2;                 // 球的重力
const BALL_VMAX = 70;                // 球最快（每格）
const HIT_UP = 50;                   // 一般碰到球：往上彈
const SPIKE_X = 60, SPIKE_Y = 40;    // 空中殺球：往對面斜斜往下打
const SMASH_X = 52, SMASH_Y = -34;   // 地上用力擊球：往對面又快又平的高球（比一般碰到快很多）
const ATTACK_FRAMES = 6;             // 擊球之後幾格顯示攻擊幀
const WIN = 7;                       // 先拿幾分贏
const PAUSE = 25;                    // 得分後停幾格（1 秒）再發球
const K_LEFT = 1, K_RIGHT = 2, K_JUMP = 4, K_SPIKE = 8;

function player(side) {
    const x = side === 0 ? Math.floor(NET_X / 2) - S / 2 : NET_X + Math.floor((W - NET_X) / 2) - S / 2;
    return { side, x, y: GROUND - S, vy: 0, atk: 0, hitCd: 0 };
}

function createGame() {
    const g = { f: 0, score: [0, 0], players: [player(0), player(1)], ball: null, serve: 0, pause: 0, over: false, winner: null };
    serve(g, 0);
    return g;
}

// 發球：球在發球方的人頭上，靜止往下掉
function serve(g, side) {
    g.serve = side;
    g.players = [player(0), player(1)];
    const p = g.players[side];
    g.ball = { x: p.x + S / 2, y: GROUND - S - 22 * SUB, vx: 0, vy: 0 };
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function stepPlayer(p, k) {
    const minX = p.side === 0 ? 0 : NET_X + NET_W, maxX = p.side === 0 ? NET_X - S : W - S;
    let dx = 0;
    if (k & K_LEFT) dx -= RUN;
    if (k & K_RIGHT) dx += RUN;
    p.x = clamp(p.x + dx, minX, maxX);
    const onGround = p.y >= GROUND - S;
    if (onGround && (k & K_JUMP)) p.vy = -JUMP;
    if (!onGround || p.vy < 0) {
        p.vy += GRAV;
        p.y += p.vy;
        if (p.y >= GROUND - S) { p.y = GROUND - S; p.vy = 0; }
    }
    if (p.atk > 0) p.atk--;
    if (p.hitCd > 0) p.hitCd--;
}

// 球碰到人：一般是往上彈（左右看碰到身體哪一邊），在空中按殺球就用力往對面往下打
function hitBall(g, p, k) {
    const b = g.ball;
    if (p.hitCd > 0) return false;
    const cx = p.x + S / 2, cy = p.y + S / 2;
    const dx = b.x - clamp(b.x, p.x, p.x + S), dy = b.y - clamp(b.y, p.y, p.y + S);
    if (dx * dx + dy * dy > BALL_R * BALL_R) return false;
    const toward = p.side === 0 ? 1 : -1;
    // 碰到球的那一刻有按殺球鍵（空白鍵／Enter／點畫面）→ 用力打，球速快很多（2026-10-20：同皮卡丘排球）
    //   空中：往對面斜斜往下殺；地上：往對面又快又平
    if ((k & K_SPIKE) && p.y < GROUND - S) {
        b.vx = SPIKE_X * toward; b.vy = SPIKE_Y;
    } else if (k & K_SPIKE) {
        b.vx = SMASH_X * toward; b.vy = SMASH_Y;
    } else {
        b.vx = clamp(Math.trunc((b.x - cx) / 2), -40, 40);
        b.vy = -HIT_UP - (p.vy < 0 ? Math.trunc(-p.vy / 3) : 0);
        if (b.y > cy) b.vy = -HIT_UP;   // 從下面碰到也往上
    }
    p.atk = ATTACK_FRAMES; p.hitCd = 4;
    return true;
}

function stepBall(g) {
    const b = g.ball;
    b.vy = clamp(b.vy + BALL_GRAV, -BALL_VMAX, BALL_VMAX);
    b.x += b.vx; b.y += b.vy;
    // 牆、天花板：反彈
    if (b.x < BALL_R) { b.x = BALL_R; b.vx = -b.vx; }
    if (b.x > W - BALL_R) { b.x = W - BALL_R; b.vx = -b.vx; }
    if (b.y < BALL_R) { b.y = BALL_R; b.vy = -b.vy; }
    // 網子：從側面撞到 → 左右反彈；從上面掉到網頂 → 往上彈
    const nx0 = NET_X - BALL_R, nx1 = NET_X + NET_W + BALL_R;
    if (b.x > nx0 && b.x < nx1 && b.y > NET_TOP - BALL_R) {
        if (b.y - b.vy <= NET_TOP - BALL_R) { b.y = NET_TOP - BALL_R; b.vy = -Math.abs(b.vy); }
        else if (b.x < NET_X + NET_W / 2) { b.x = nx0; b.vx = -Math.abs(b.vx) || -4; }
        else { b.x = nx1; b.vx = Math.abs(b.vx) || 4; }
    }
}

/**
 * 推進一格。keys = [左邊那個人的按鍵, 右邊那個人的按鍵]。
 * 回傳這一格發生的事：'hit0'／'hit1'（誰擊球）、'point0'／'point1'（誰得分）、'over'。
 */
function step(g, keys) {
    if (g.over) return [];
    const ev = [];
    g.f++;
    if (g.pause > 0) {
        g.pause--;
        if (g.pause === 0) serve(g, g.serve);
        return ev;
    }
    for (let i = 0; i < 2; i++) stepPlayer(g.players[i], keys[i] | 0);
    stepBall(g);
    for (let i = 0; i < 2; i++) if (hitBall(g, g.players[i], keys[i] | 0)) ev.push('hit' + i);
    // 落地：落在哪一邊，另一邊得分；得分的人發下一球
    if (g.ball.y >= GROUND - BALL_R) {
        g.ball.y = GROUND - BALL_R;
        const scorer = g.ball.x < NET_X + NET_W / 2 ? 1 : 0;
        g.score[scorer]++;
        ev.push('point' + scorer);
        if (g.score[scorer] >= WIN) { g.over = true; g.winner = scorer; ev.push('over'); }
        else { g.serve = scorer; g.pause = PAUSE; }
    }
    return ev;
}

/** 兩台比對用（測試、偵錯）：整局狀態壓成一串數字 */
function hash(g) {
    const b = g.ball, p = g.players;
    return [g.f, g.score[0], g.score[1], b.x, b.y, b.vx, b.vy, p[0].x, p[0].y, p[0].vy, p[1].x, p[1].y, p[1].vy, g.pause].join(',');
}

module.exports = {
    SUB, W, H, GROUND, S, NET_X, NET_W, NET_TOP, BALL_R, FPS, FRAME_MS, RUN, JUMP, GRAV, BALL_GRAV, BALL_VMAX,
    HIT_UP, SPIKE_X, SPIKE_Y, SMASH_X, SMASH_Y, ATTACK_FRAMES, WIN, PAUSE, K_LEFT, K_RIGHT, K_JUMP, K_SPIKE,
    createGame, step, hash,
};
