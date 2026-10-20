'use strict';
/**
 * stairs-sim.js — 廣場小遊戲「下樓梯」的純邏輯（docs/plaza-stairs-spec.md）
 *
 * 只有廣場伺服器跑它（每個房間一個 50ms 的迴圈）：玩家之間會推擠、踩頭，
 * 各台各算一定會分岔，所以位置一律由伺服器算，daemon 只負責轉送與畫。
 * 測試也直接測這支（固定 seed 重播），不用起伺服器。
 *
 * 座標：點（dot），跟廣場畫布同一套（69 × 54），y 向下為正。角色是 S × S 的方塊，
 * 碰撞用比畫面窄一點的身體（左右各留 HIT_PAD），站在邊緣不會懸空太多。
 * 時間：一拍 DT 秒。數值都是草稿，實作後依手感調（規格 4.2）。
 */

const W = 69, H = 54;          // 場地（同廣場畫布）
const S = 12;                  // 角色大小（點）：16 點的話 4 隻並排就 64 點，幾乎動不了（規格 4.1）
const HIT_PAD = 2;             // 碰撞身體左右各縮幾點
const DT = 0.05;               // 一拍 50ms（規格 2.1）
const TICK_MS = DT * 1000;
const GRAV = 150;              // 重力（點/秒²）
const FALL_MAX = 45;           // 最快落速
const RUN = 28;                // 左右走的速度
const CONVEY = 14;             // 輸送帶帶著走的速度
const SPRING_V = -62;          // 彈簧把人彈起來的速度
const SCROLL0 = 5;             // 一開始往上捲的速度（點/秒）
// 開局倒數：這幾秒不捲動（一出發就被推向天花板太趕，2026-10-20 實測一開局不到 1 秒就被刺）
const COUNTDOWN_S = 2;
const SCROLL_STEP = 0.7;       // 每 10 層加速多少
const SCROLL_MAX = 13;
const GAP = 10;                // 階梯上下間距
const PLAT_H = 2;              // 階梯厚度（只拿來畫，碰撞只看頂面）
const PLAT_W = [14, 20];       // 階梯寬度範圍
const CEIL = 4;                // 天花板尖刺的下緣
// 血量是三顆心（2026-10-20：10 格的血條看不出來是什麼，改成三顆點陣心比較單純）
const HP_MAX = 3;
const HEAL = 1;                // 回幾顆心
const HEAL_EVERY = 3;          // 踩幾次普通階梯回一顆心（每踩一次就回的話，扣一顆馬上補回來，太簡單）
const SPIKE_DMG = 1;           // 尖刺（階梯、天花板）扣幾顆心
const HURT_S = 1.0;            // 被天花板刺到之後的無敵時間
const FLIP_S = 0.6;            // 翻板站多久就翻掉（2026-10-20：0.35 → 0.6，給畫面時間閃爍、變透明，看得出要翻了）
const SAFE_FLOORS = 5;         // 前幾層只出普通階梯（剛開局不要一來就踩到刺）
const TYPES = [                // [種類, 權重]（規格 4.2）
    ['normal', 50], ['spike', 15], ['convL', 7.5], ['convR', 7.5], ['spring', 10], ['flip', 10],
];

// mulberry32：seed 決定整局的階梯，同一個 seed 重播結果一樣（測試靠它）
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function pickType(r, floor) {
    if (floor <= SAFE_FLOORS) return 'normal';
    const total = TYPES.reduce((a, t) => a + t[1], 0);
    let x = r() * total;
    for (const [t, w] of TYPES) { if ((x -= w) < 0) return t; }
    return 'normal';
}

function addPlatform(g, y, type) {
    const r = g.rand;
    const w = Math.round(PLAT_W[0] + r() * (PLAT_W[1] - PLAT_W[0]));
    const x = Math.round(r() * (W - w));
    const floor = ++g.floors;
    g.platforms.push({ id: floor, floor, x, y, w, type: type || pickType(r, floor), gone: false });
}

/**
 * 開一局。players：[{ id }]。mode：'endless'（各自玩到死）／'survival'（剩一人就結束）。
 * 開局：最上面那塊在畫面中間偏上，大家並排站在上面（同一塊放不下就往旁邊擺）。
 */
function createGame({ seed = 1, players = [], mode = 'endless' } = {}) {
    const g = { seed: seed >>> 0, rand: rng(seed), mode, tick: 0, t: 0, scroll: SCROLL0,
                floors: 0, platforms: [], players: [], over: false, started: players.length };
    // 第一塊：夠寬讓大家站
    const startW = Math.min(W, Math.max(PLAT_W[1], players.length * (S + 2)));
    const sx = Math.round((W - startW) / 2), sy = 34;   // 開局站得低一點：離天花板有幾秒的距離
    g.floors = 1;
    g.platforms.push({ id: 1, floor: 1, x: sx, y: sy, w: startW, type: 'normal', gone: false });
    for (let y = sy + GAP; y < H + GAP; y += GAP) addPlatform(g, y, 'normal');
    players.forEach((p, i) => {
        const x = sx + Math.round((startW - players.length * S) / 2) + i * S;
        g.players.push({ id: p.id, x, y: sy - S, vx: 0, vy: 0, dir: 0, hp: HP_MAX, healN: 0, alive: true,
                         floor: 1, on: 1, onAt: 0, hurtUntil: 0, pass: null, diedAt: null, rank: null });
    });
    return g;
}

function setInput(g, id, dir) {
    const p = g.players.find(q => q.id === id);
    if (p) p.dir = dir < 0 ? -1 : dir > 0 ? 1 : 0;
}

const hitL = (p) => p.x + HIT_PAD, hitR = (p) => p.x + S - HIT_PAD;
const overX = (p, x0, x1) => hitR(p) > x0 && hitL(p) < x1;

function kill(g, p, why) {
    if (!p.alive) return;
    p.alive = false; p.diedAt = g.tick; p.why = why; p.vx = 0; p.vy = 0;
}

/** 推進一拍。回傳這一拍發生的事（給畫面演：受傷、回血、彈簧、出局）。 */
function step(g) {
    if (g.over) return [];
    const ev = [];
    g.tick++; g.t += DT;
    // 1. 捲動：階梯往上，越深越快
    const deepest = Math.max(1, ...g.players.map(p => p.floor));
    g.scroll = g.t < COUNTDOWN_S ? 0 : Math.min(SCROLL_MAX, SCROLL0 + Math.floor(deepest / 10) * SCROLL_STEP);
    const d = g.scroll * DT;
    for (const pl of g.platforms) pl.y -= d;
    g.platforms = g.platforms.filter(pl => pl.y + PLAT_H > 0);
    // g.noSpawn：測試用（手動擺好的場地，不要自己長出新階梯）
    if (!g.noSpawn) {
        let low = g.platforms.length ? Math.max(...g.platforms.map(pl => pl.y)) : H - GAP;
        while (low < H + GAP) { addPlatform(g, low + GAP); low += GAP; }
    }
    const byId = new Map(g.platforms.map(pl => [pl.id, pl]));

    // 2. 每個人：站著的跟著階梯走；沒站著的受重力；左右移動
    for (const p of g.players) {
        if (!p.alive) continue;
        const b0 = p.y + S;
        let stand = p.on != null ? (typeof p.on === 'number' ? byId.get(p.on) : null) : null;
        if (stand && (stand.gone || !overX(p, stand.x, stand.x + stand.w))) { p.on = null; stand = null; }
        // 翻板：站超過 FLIP_S 就翻掉
        if (stand && stand.type === 'flip' && g.t - p.onAt >= FLIP_S) { stand.gone = true; p.on = null; stand = null; ev.push({ type: 'flip', id: p.id }); }
        let vx = p.dir * RUN;
        if (stand && stand.type === 'convL') vx -= CONVEY;
        if (stand && stand.type === 'convR') vx += CONVEY;
        p.vx = vx;
        p.x = Math.max(0, Math.min(W - S, p.x + vx * DT));
        if (stand) {
            p.y = stand.y - S; p.vy = 0;
            if (!overX(p, stand.x, stand.x + stand.w)) p.on = null;   // 走出邊緣
        } else if (typeof p.on === 'string') {
            // 站在別人頭上：跟著那個人
            const q = g.players.find(o => o.id === p.on);
            if (!q || !q.alive || !overX(p, q.x + HIT_PAD, q.x + S - HIT_PAD)) p.on = null;
            else { p.y = q.y - S; p.vy = 0; }
        }
        if (p.on == null) {
            p.vy = Math.min(FALL_MAX, p.vy + GRAV * DT);
            p.y += p.vy * DT;
            // 落地：這一拍從階梯頂面上方穿到下方（階梯本身也往上移了 d）
            if (p.vy >= 0) {
                const b1 = p.y + S;
                for (const pl of g.platforms) {
                    if (pl.gone || pl.id === p.pass) continue;
                    if (b0 <= pl.y + d + 0.01 && b1 >= pl.y && overX(p, pl.x, pl.x + pl.w)) {
                        p.y = pl.y - S; p.vy = 0; p.on = pl.id; p.onAt = g.t; p.pass = null;
                        if (pl.type === 'flip' && pl.touchAt == null) pl.touchAt = g.t;   // 畫面用：從第一次被踩開始閃、變透明
                        p.floor = Math.max(p.floor, pl.floor);
                        if (pl.type === 'normal' && p.hp < HP_MAX && ++p.healN >= HEAL_EVERY) {
                            p.healN = 0; p.hp = Math.min(HP_MAX, p.hp + HEAL); ev.push({ type: 'heal', id: p.id });
                        }
                        if (pl.type === 'spike') { p.hp -= SPIKE_DMG; ev.push({ type: 'hurt', id: p.id }); }
                        if (pl.type === 'spring') { p.vy = SPRING_V; p.on = null; ev.push({ type: 'spring', id: p.id }); }
                        break;
                    }
                }
            }
        }
    }

    // 3. 玩家之間：踩頭、左右推擠（伺服器統一判定，規格 4.4）
    const live = g.players.filter(p => p.alive);
    for (const p of live) {
        if (p.on != null || p.vy < 0) continue;
        for (const q of live) {
            if (q === p || q.on === p.id) continue;
            const pb = p.y + S, qt = q.y;
            if (pb >= qt && pb - p.vy * DT - 0.01 <= qt + 1 && overX(p, q.x + HIT_PAD, q.x + S - HIT_PAD)) {
                q.y += 1;   // 被踩的人往下壓一點（下一拍站回階梯上，等於被踩那一下沉一格）
                p.y = q.y - S; p.vy = 0; p.on = q.id;
                ev.push({ type: 'stomp', id: p.id, on: q.id });
                break;
            }
        }
    }
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
        const a = live[i], b = live[j];
        if (a.on === b.id || b.on === a.id) continue;
        const ox = Math.min(hitR(a), hitR(b)) - Math.max(hitL(a), hitL(b));
        const oy = Math.min(a.y + S, b.y + S) - Math.max(a.y, b.y);
        if (ox > 0 && oy > S / 2) {
            const sgn = a.x <= b.x ? -1 : 1;
            a.x = Math.max(0, Math.min(W - S, a.x + sgn * ox / 2));
            b.x = Math.max(0, Math.min(W - S, b.x - sgn * ox / 2));
        }
    }

    // 4. 天花板尖刺：扣血、從站著的階梯掉下去（穿過那一塊）
    for (const p of live) {
        if (p.y < CEIL) {
            if (g.t >= p.hurtUntil) {
                p.hp -= SPIKE_DMG; p.hurtUntil = g.t + HURT_S;
                ev.push({ type: 'ceil', id: p.id });
            }
            if (typeof p.on === 'number') p.pass = p.on;
            p.on = null; p.y = CEIL; p.vy = Math.max(p.vy, 10);
        }
    }

    // 5. 出局：掉出底部、血量歸零
    for (const p of live) {
        if (p.y > H) { kill(g, p, 'fall'); ev.push({ type: 'dead', id: p.id }); }
        else if (p.hp <= 0) { p.hp = 0; kill(g, p, 'hp'); ev.push({ type: 'dead', id: p.id }); }
    }
    // 站在出局的人頭上 → 掉下來
    for (const p of g.players) if (typeof p.on === 'string' && !g.players.find(q => q.id === p.on && q.alive)) p.on = null;

    // 6. 結束
    const alive = g.players.filter(p => p.alive);
    if (g.mode === 'survival' ? alive.length <= 1 : alive.length === 0) {
        g.over = true;
        // 名次：活著的第一；其餘依出局先後（晚死的名次前面），同一拍出局比層數
        const order = [...g.players].sort((a, b) => (b.alive - a.alive)
            || ((b.diedAt || 0) - (a.diedAt || 0)) || (b.floor - a.floor));
        order.forEach((p, i) => { p.rank = i + 1; });
        ev.push({ type: 'over' });
    }
    return ev;
}

/** 傳給 daemon 的精簡狀態（每拍一包，四人約 300 bytes）。數字只留一位小數。 */
const r1 = (v) => Math.round(v * 10) / 10;
function snapshot(g) {
    return {
        k: g.tick, sc: r1(g.scroll), over: g.over,
        cd: g.t < COUNTDOWN_S ? Math.ceil(COUNTDOWN_S - g.t) : 0,   // 開局倒數（秒），前端顯示 2、1
        // 第 7 欄：翻板「快翻了」的進度 0～1（第一次被踩之後，畫面閃爍＋逐漸透明）
        pl: g.platforms.map(p => [p.id, r1(p.x), r1(p.y), p.w, p.type, p.gone ? 1 : 0,
                                  p.touchAt != null ? Math.min(1, Math.round((g.t - p.touchAt) / FLIP_S * 100) / 100) : 0]),
        p: g.players.map(p => [p.id, r1(p.x), r1(p.y), p.hp, p.alive ? 1 : 0, p.dir, p.floor,
                                 p.hurtUntil > g.t ? 1 : 0, p.rank || 0]),
    };
}

module.exports = {
    W, H, S, HIT_PAD, DT, TICK_MS, GRAV, FALL_MAX, RUN, CONVEY, SPRING_V, SCROLL0, SCROLL_STEP, SCROLL_MAX,
    COUNTDOWN_S, GAP, PLAT_H, PLAT_W, CEIL, HP_MAX, HEAL, HEAL_EVERY, SPIKE_DMG, HURT_S, FLIP_S, SAFE_FLOORS, TYPES,
    rng, pickType, createGame, setInput, step, snapshot,
};
