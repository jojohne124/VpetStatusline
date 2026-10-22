'use strict';
/**
 * duel-sim.js — 廣場「手動戰鬥」的判定（docs/plaza-duel-spec.md）
 *
 * 場地是九宮格：A 欄我、B 欄中間（子彈飛過）、C 欄對手；0 上、1 中、2 下。
 * 回合制：雙方同時選「移動（上／不動／下）＋攻擊位置（對手那欄的上中下）＋力度（來回彈的條）」，
 * 移動完才發射，猜中對方移動後的位置就打中。雙方都猜中 = 子彈走同一條線、相撞 → 對波，傷害高的贏。
 *
 * 伺服器（plaza-server）跟頁面（dev 測試對戰）共用這一份。
 * 這個檔會原樣內嵌進頁面：不能有反引號、反斜線、錢號接大括號。
 */
const ROWS       = 3;
const MAX_ROUNDS = 20;
const PICK_MS    = 10000;   // 每回合選擇的時限（三步加起來）
const OPEN_MS    = 2600;    // 開場 cutin 多長
const ANIM_MS    = 3200;    // 一回合的演出（移動、發射、對波、爆炸）
const END_MS     = 1500;    // 最後一回合演完後，停多久才結算
// 力度條分區：0～80% 是 1 倍、80～95% 是 1.5 倍、95% 以上算「最滿」2 倍
const ZONE_15 = 0.8, ZONE_2 = 0.95;
const BGS = ['colosseum', 'ring', 'studio'];

// 數值（2026-10-20 定）：血量 = 戰力，攻擊 = 戰力／4 向上取整數（不取到 10 的倍數：低戰力會一下就死、跨門檻會跳一級）
function hpOf(str)  { return Math.max(1, Math.round(Number(str) || 0)); }
function atkOf(str) { return Math.max(1, Math.ceil((Number(str) || 0) / 4)); }
function multOf(p)  { return p >= ZONE_2 ? 2 : p >= ZONE_15 ? 1.5 : 1; }

function createDuel(strs, bg) {
    return { str: strs.slice(), hp: strs.map(hpOf), max: strs.map(hpOf), row: [1, 1], round: 1,
             winner: null, last: null, bg: BGS.includes(bg) ? bg : BGS[0] };
}
const okMove = (d, i, mv) => (mv === -1 || mv === 0 || mv === 1) && d.row[i] + mv >= 0 && d.row[i] + mv < ROWS;
const okAim  = (a) => a === 0 || a === 1 || a === 2;
// 收到的選擇整理成合法的：哪一項沒選或不合法就用預設 —— 不動、打正前方、1 倍（時限到了也是這樣）
function normPick(d, i, pk) {
    pk = pk || {};
    const mv  = okMove(d, i, pk.mv) ? pk.mv : 0;
    const aim = okAim(pk.aim) ? pk.aim : d.row[i] + mv;
    const p   = typeof pk.p === 'number' && pk.p >= 0 && pk.p <= 1 ? pk.p : 0;
    return { mv, aim, p };
}
// 一回合：picks[i] = { mv, aim, p }（先過 normPick）。回傳這回合發生什麼（演出用），並推進 d
function resolve(d, picks) {
    const from = d.row.slice();
    const to   = from.map((r, i) => r + picks[i].mv);
    const mult = picks.map(pk => multOf(pk.p));
    const dmg  = [0, 1].map(i => Math.ceil(atkOf(d.str[i]) * mult[i]));
    const aimed = [0, 1].map(i => picks[i].aim === to[1 - i]);   // i 猜中對手移動後的位置
    const hit = [false, false];                                   // hit[i] = i 被打中
    let clash = false, cw = -1;                                   // cw = 對波贏的一方（-1 = 一樣強，兩顆都消掉）
    if (aimed[0] && aimed[1]) {
        clash = true;
        cw = dmg[0] > dmg[1] ? 0 : dmg[1] > dmg[0] ? 1 : -1;
        if (cw >= 0) hit[1 - cw] = true;
    } else { hit[1] = aimed[0]; hit[0] = aimed[1]; }
    const hpBefore = d.hp.slice();
    for (const i of [0, 1]) if (hit[i]) d.hp[i] = Math.max(0, d.hp[i] - dmg[1 - i]);
    d.row = to;
    d.last = { round: d.round, from, to, aim: picks.map(pk => pk.aim), mult, dmg, clash, cw, hit, hpBefore, hp: d.hp.slice() };
    if (d.hp[0] <= 0 || d.hp[1] <= 0) d.winner = d.hp[0] <= 0 && d.hp[1] <= 0 ? -1 : d.hp[0] <= 0 ? 1 : 0;
    else if (d.round >= MAX_ROUNDS) d.winner = d.hp[0] === d.hp[1] ? -1 : d.hp[0] > d.hp[1] ? 0 : 1;   // 打滿回合比剩餘血量
    d.round++;
    return d.last;
}
// 電腦對手（跟電腦打、dev 測試）：隨機移動＋隨機力度；攻擊只挑**對手下回合到得了**的列
//（對手一次最多走一格：站在 2 列的人下回合不可能在 0 列，打那裡等於白打，2026-10-22）
function randomPick(d, i, rand) {
    rand = rand || Math.random;
    const mvs = [-1, 0, 1].filter(mv => okMove(d, i, mv));
    const o = d.row[1 - i], aims = [o - 1, o, o + 1].filter(r => r >= 0 && r < ROWS);
    return { mv: mvs[Math.floor(rand() * mvs.length)], aim: aims[Math.floor(rand() * aims.length)], p: rand() };
}

module.exports = { ROWS, MAX_ROUNDS, PICK_MS, OPEN_MS, ANIM_MS, END_MS, ZONE_15, ZONE_2, BGS,
                   hpOf, atkOf, multOf, createDuel, normPick, resolve, randomPick, okMove };
