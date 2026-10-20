#!/usr/bin/env node
'use strict';
/**
 * test-volley.js — 廣場小遊戲「打排球」（docs/plaza-volley-spec.md）
 *
 *   1. 模擬（src/shared/volley-sim.js）：完全決定性（整數）、能原樣內嵌頁面、走位與跳、網子、
 *      擊球（攻擊幀）、殺球、得分與發球、先拿 7 分贏
 *   2. 輸入同步：兩台各自跑、按鍵延後幾格交換、網路亂序 → 兩台每一格的狀態都一樣
 *   3. 伺服器：房間只能 2 人、要 2 人才能開打、按鍵轉給對手、結果、有人中途離開／斷線 → 對手贏
 */
const fs = require('fs'), path = require('path');
const VB = require('../src/shared/volley-sim.js');
const S  = require('../src/daemon/plaza-server.js');
const C  = require('../src/daemon/plaza-client.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(cond, ms = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(15); }
    return cond();
}
// 自動駕駛：跑到球底下、球低了就跳、在空中就殺球
function bot(g, i, lazy) {
    const p = g.players[i], b = g.ball, c = p.x + VB.S / 2;
    const mine = i === 0 ? b.x < VB.NET_X : b.x > VB.NET_X;
    let k = 0;
    if (mine) {
        if (b.x < c - 10) k |= VB.K_LEFT; else if (b.x > c + 10) k |= VB.K_RIGHT;
        if (!lazy && b.y > VB.GROUND - VB.S * 3 && Math.abs(b.x - c) < VB.S) k |= VB.K_JUMP;
        if (p.y < VB.GROUND - VB.S) k |= VB.K_SPIKE;
    }
    return k;
}

console.log('— 模擬 —');
{
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'volley-sim.js'), 'utf8');
    ok(!/[`\\]|\$\{|<\/script/i.test(src), 'volley-sim.js 有不能內嵌進頁面的字元 —— daemon 會停用打排球');
    ok(!/Math\.random|Date\.now|performance/.test(src.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')), 'volley-sim.js 用了亂數或時間（兩台會算出不一樣的結果）');
    // 整數：整局所有座標、速度都是整數（浮點在不同機器上可能差一點點 → 分岔）
    const g = VB.createGame(); let allInt = true, hits = 0, atkSeen = false;
    for (let i = 0; i < 25 * 120 && !g.over; i++) {
        const ev = VB.step(g, [bot(g, 0), bot(g, 1)]);
        hits += ev.filter(e => e.startsWith('hit')).length;
        if (g.players.some(p => p.atk > 0)) atkSeen = true;
        const nums = [g.ball.x, g.ball.y, g.ball.vx, g.ball.vy, ...g.players.flatMap(p => [p.x, p.y, p.vy])];
        if (!nums.every(Number.isInteger)) allInt = false;
    }
    ok(allInt, '模擬裡出現了非整數（會讓兩台分岔）');
    ok(g.over && Math.max(...g.score) === VB.WIN && g.winner === (g.score[0] > g.score[1] ? 0 : 1), '比賽沒有在先拿 ' + VB.WIN + ' 分時結束：' + g.score);
    ok(hits > 10, '自動駕駛幾乎沒有擊到球（' + hits + ' 次）');
    ok(atkSeen, '擊球之後沒有記攻擊幀（畫面要用 ATTACK）');
    // 球速（2026-10-20 調慢：原本殺球 0.2 秒就過半場，人來不及反應）：最快的球過半場至少要 0.3 秒
    const half = (VB.W - VB.NET_X) / VB.SUB, vmaxX = Math.max(VB.SPIKE_X, VB.SMASH_X, 22) / VB.SUB * VB.FPS;
    ok(half / vmaxX >= 0.3, `球太快：最快 ${vmaxX.toFixed(0)} 點／秒，${(half / vmaxX).toFixed(2)} 秒就過半場`);
    // 同樣的輸入 → 同樣的結果
    const run = () => { const q = VB.createGame(); const out = [];
        for (let i = 0; i < 2000 && !q.over; i++) { VB.step(q, [bot(q, 0), bot(q, 1, true)]); if (i % 25 === 0) out.push(VB.hash(q)); } return out.join('|'); };
    ok(run() === run(), '同樣的輸入算出不一樣的結果');
    // 走位：不能越過網子、不能走出場地
    const q = VB.createGame();
    for (let i = 0; i < 100; i++) VB.step(q, [VB.K_RIGHT, VB.K_LEFT]);
    ok(q.players[0].x + VB.S <= VB.NET_X && q.players[1].x >= VB.NET_X + VB.NET_W, '可以走過網子到對面');
    for (let i = 0; i < 100; i++) VB.step(q, [VB.K_LEFT, VB.K_RIGHT]);
    ok(q.players[0].x === 0 && q.players[1].x === VB.W - VB.S, '可以走出場地');
    // 跳：在地上才能跳、會落地
    const j = VB.createGame(); VB.step(j, [VB.K_JUMP, 0]);
    ok(j.players[0].y < VB.GROUND - VB.S, '按跳沒有跳起來');
    for (let i = 0; i < 60; i++) VB.step(j, [0, 0]);
    ok(j.players[0].y === VB.GROUND - VB.S, '跳完沒有落地');
    // 得分：球落在左邊 → 右邊得分，換右邊發球
    const s = VB.createGame(); s.ball = { x: 10 * VB.SUB, y: VB.GROUND - VB.BALL_R - 1, vx: 0, vy: 5 };
    s.players[0].x = 40 * VB.SUB;   // 人不在球底下
    const ev = VB.step(s, [0, 0]);
    ok(ev.includes('point1') && s.score[1] === 1 && s.serve === 1 && s.pause > 0, '球落在左邊，右邊沒得分（或沒換發球）');
    for (let i = 0; i < VB.PAUSE; i++) VB.step(s, [0, 0]);
    ok(s.pause === 0 && s.ball.x > VB.NET_X, '得分後沒有由得分的那邊發球');
    // 網子：球從側面撞到網會彈回來
    const n = VB.createGame(); n.ball = { x: VB.NET_X - VB.BALL_R - 20, y: VB.GROUND - 6 * VB.SUB, vx: 30, vy: 0 };
    n.players[0].x = 0; n.players[1].x = VB.W - VB.S;
    VB.step(n, [0, 0]);
    ok(n.ball.vx < 0 && n.ball.x < VB.NET_X, '球從側面撞到網子沒有彈回來');
    // 殺球：在空中按殺球碰到球 → 往對面、往下快速
    const k = VB.createGame(); const p0 = k.players[0];
    p0.y = VB.GROUND - VB.S - 10 * VB.SUB; p0.vy = -5;
    k.ball = { x: p0.x + VB.S / 2, y: p0.y - 1, vx: 0, vy: 0 };
    const ek = VB.step(k, [VB.K_SPIKE, 0]);
    ok(ek.includes('hit0') && k.ball.vx >= VB.SPIKE_X && k.ball.vy > 0 && k.players[0].atk > 0, '在空中殺球沒有往對面往下打');
    // 地上碰到球的那一刻按殺球鍵：往對面用力打，比一般碰到快很多
    const sm = VB.createGame(), q0 = sm.players[0];
    sm.ball = { x: q0.x + VB.S / 2, y: q0.y - 1, vx: 0, vy: 2 };
    const es = VB.step(sm, [VB.K_SPIKE, 0]);
    const nm = VB.createGame(), n0 = nm.players[0];
    nm.ball = { x: n0.x + VB.S / 2, y: n0.y - 1, vx: 0, vy: 2 };
    VB.step(nm, [0, 0]);
    const sp = (b) => Math.abs(b.vx) + Math.abs(b.vy);
    ok(es.includes('hit0') && sm.ball.vx > 0 && sp(sm.ball) > sp(nm.ball) * 1.3, '地上碰到球時按殺球沒有用力打（球速跟一般碰到差不多）');
}

console.log('— 輸入同步（鎖步）—');
{
    // 兩台各自跑：自己的按鍵延後 DELAY 格才生效；收到對手按鍵的時間亂七八糟（亂序、慢幾格）
    const DELAY = 3, N = 25 * 60;
    const A = VB.createGame(), B = VB.createGame();
    const inA = [new Map(), new Map()], inB = [new Map(), new Map()];   // [左, 右] 每格的按鍵
    const net = [];   // 傳輸中的訊息：{ to, side, f, k, at }
    let t = 0, divergeAt = -1, stallA = 0, stallB = 0;
    const lcg = (() => { let s = 12345; return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296); })();
    for (let f = 0; f < DELAY; f++) for (const m of [inA, inB]) { m[0].set(f, 0); m[1].set(f, 0); }
    while ((A.f < N || B.f < N) && t < N * 4) {
        t++;
        // 送：每台在處理第 f 格時決定 f+DELAY 格的按鍵
        for (const [G, mine, side, to] of [[A, inA, 0, 'B'], [B, inB, 1, 'A']]) {
            const fs = G.f + DELAY;
            if (!mine[side].has(fs)) { const k = bot(G, side); mine[side].set(fs, k); net.push({ to, side, f: fs, k, at: t + 1 + Math.floor(lcg() * 4) }); }
        }
        // 收（亂序、延遲 1～4 拍）
        for (let i = net.length - 1; i >= 0; i--) if (net[i].at <= t) { const m = net[i]; (m.to === 'A' ? inA : inB)[m.side].set(m.f, m.k); net.splice(i, 1); }
        // 算：兩邊的按鍵都到了才往下
        for (const [G, m, tag] of [[A, inA, 'A'], [B, inB, 'B']]) {
            if (G.f >= N || G.over) continue;
            const k0 = m[0].get(G.f), k1 = m[1].get(G.f);
            if (k0 === undefined || k1 === undefined) { if (tag === 'A') stallA++; else stallB++; continue; }
            VB.step(G, [k0, k1]);
        }
        if (A.f === B.f && divergeAt < 0 && VB.hash(A) !== VB.hash(B)) divergeAt = A.f;
    }
    ok(divergeAt < 0, '兩台在第 ' + divergeAt + ' 格分岔了（輸入同步失敗）');
    ok(A.f === B.f && VB.hash(A) === VB.hash(B), '兩台最後的狀態不一樣');
    ok(A.over || A.f > N / 2, '幾乎一直卡住（延遲處理有問題）：只跑了 ' + A.f + ' 格');
    ok(stallA + stallB > 0, '前提不成立：模擬的網路沒有延遲（測不到等待）');
}

(async () => {
    console.log('— 伺服器：房間、開打、轉送按鍵、結果、中途離開 —');
    const ps = S.createPlazaServer({ volleyCountdownMs: 30, stairsLostMs: 200, graceMs: 3000 });
    await new Promise(r => ps.server.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + ps.server.address().port;
    const seen = { a: [], b: [], c: [] };
    const mk = (tag) => C.create({ url, retryMs: 2000, onStairs: (k, d) => seen[tag].push([k, d]) });
    const prof = (name, char = 'agumon') => ({ name, char, stage: 'Child', card: { power: 10, train: 3 } });
    const a = mk('a'), b = mk('b'), c = mk('c');
    try {
        await a.join(prof('阿張')); await b.join(prof('阿明', 'gabumon')); await c.join(prof('阿丙', 'palmon'));
        await until(() => a.me() && b.me() && c.me());
        const op = await a.stairs('open', { mode: 'endless', kind: 'volley' });
        ok(op.ok && op.room.kind === 'volley' && op.room.cap === 2, '開排球房失敗（或人數上限不是 2）：' + JSON.stringify(op));
        ok(await until(() => c.chat().some(m => m.sys && /打排球/.test(m.text) && m.stairsRoom)), '開房的系統訊息沒寫打排球');
        ok(!(await a.stairs('start')).ok, '只有 1 個人也能開打');
        const room = [...ps.rooms.values()][0];
        ok((await b.stairs('join', { room: room.id })).ok, '第二個人加入失敗');
        ok(!(await c.stairs('join', { room: room.id })).ok, '排球房滿 2 人還能加入');
        const st = await a.stairs('start');
        ok(st.ok && st.startAt, '2 個人開打失敗');
        ok(await until(() => (b.stairsMine() || {}).volley && b.stairsMine().volley.sides.length === 2), '房間資料沒有左右邊（兩台不知道誰在左邊）');
        ok(b.stairsMine().volley.sides[0] === a.me().id, '左邊不是房主');
        // 按鍵：轉給對手、不轉給自己；格式不對擋掉
        ok((await a.stairs('vin', { f: 3, k: VB.K_JUMP })).ok, '送按鍵失敗');
        ok(await until(() => seen.b.some(([k, d]) => k === 'vin' && d.f === 3 && d.k === VB.K_JUMP && d.id === a.me().id)), '按鍵沒有轉給對手');
        ok(!seen.a.some(([k]) => k === 'vin'), '按鍵也轉回給自己');
        ok(!(await a.stairs('vin', { f: 3, k: 99 })).ok && !(await a.stairs('vin', { f: -1, k: 0 })).ok, '亂送的按鍵也收');
        ok(!(await c.stairs('vin', { f: 3, k: 0 })).ok, '不在比賽中的人也能送按鍵');
        // 結果：贏家要是房裡的人；報了就結束、解散房間
        ok(!(await a.stairs('vend', { winner: c.me().id, score: [7, 1] })).ok, '贏家不是房裡的人也收');
        ok((await b.stairs('vend', { winner: b.me().id, score: [3, 7] })).ok, '報結果失敗');
        ok(await until(() => seen.a.some(([k]) => k === 'end') && ps.rooms.size === 0), '報了結果沒結束／房間沒解散');
        const end = seen.a.find(([k]) => k === 'end')[1];
        const rb = end.result.find(r => r.id === b.me().id), ra = end.result.find(r => r.id === a.me().id);
        ok(rb.rank === 1 && ra.rank === 2 && ra.score === 3 && rb.score === 7, '結果不對：' + JSON.stringify(end.result));
        ok(a.stairsEnd().kind === 'volley', '結果沒記住是打排球');
        // 打到一半有人離開 → 留下來的贏
        await a.stairs('open', { mode: 'endless', kind: 'volley' });
        const r2 = [...ps.rooms.values()][0];
        await b.stairs('join', { room: r2.id }); await a.stairs('start');
        seen.a.length = 0;
        await b.stairs('leave');
        ok(await until(() => seen.a.some(([k]) => k === 'end')), '對手中途離開，比賽沒結束');
        const e2 = seen.a.find(([k]) => k === 'end')[1];
        ok(e2.result.find(r => r.id === a.me().id).rank === 1 && e2.result.find(r => r.id === b.me().id).why === 'left', '對手離開，留下來的沒贏');
        // 斷線太久 → 對手贏
        await a.stairs('open', { mode: 'endless', kind: 'volley' });
        const r3 = [...ps.rooms.values()][0];
        await b.stairs('join', { room: r3.id }); await a.stairs('start');
        seen.a.length = 0;
        const mb = ps.members.get(b.me().id); mb.stream.destroy(); mb.stream = null; mb.lostAt = Date.now();
        ok(await until(() => seen.a.some(([k]) => k === 'end'), 3000), '對手斷線，比賽卡住沒結束');
        ok(seen.a.find(([k]) => k === 'end')[1].result.find(r => r.id === a.me().id).rank === 1, '對手斷線，留下來的沒贏');
    } finally {
        for (const x of [a, b, c]) { try { await x.leave(); } catch (e) {} }
        await ps.close();
    }
    console.log(`\n結果：${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERR', e.stack); process.exit(1); });
