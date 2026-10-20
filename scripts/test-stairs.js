#!/usr/bin/env node
'use strict';
/**
 * test-stairs.js — 廣場小遊戲「下樓梯」（docs/plaza-stairs-spec.md）
 *
 *   1. 模擬（src/shared/stairs-sim.js）：決定性、各種階梯、天花板、出局、推擠、踩頭、結束與名次
 *   2. 伺服器＋daemon 端連線（plaza-server / plaza-client）：開房、出發、方向、每拍推送、結束、
 *      排行榜（寫到暫存檔，不碰主機的 ~/.vpet）、離開、房主交接、房間裡的人不能被邀對戰
 *
 * 不起 daemon、不開瀏覽器：畫面的部分在 test-daemon-page 做靜態與語法檢查。
 */
const fs = require('fs'), os = require('os'), path = require('path');
const ST = require('../src/shared/stairs-sim.js');
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

// 給一局手動擺好的場地：清掉亂數階梯，只留指定的幾塊（測單一規則用）
function stage(players, plats, mode = 'endless') {
    const g = ST.createGame({ seed: 7, players: players.map(id => ({ id })), mode });
    g.platforms = plats.map((p, i) => ({ id: 100 + i, floor: 100 + i, gone: false, type: 'normal', w: 20, ...p }));
    g.floors = 200; g.noSpawn = true; g.t = ST.COUNTDOWN_S;   // 跳過開局倒數
    return g;
}
const P = (g, id) => g.players.find(p => p.id === id);
// 把玩家放在某塊上面（站好）
function put(g, id, plat, dx = 4) {
    const p = P(g, id), pl = g.platforms.find(q => q.id === plat);
    p.x = pl.x + dx; p.y = pl.y - ST.S; p.on = pl.id; p.vy = 0; p.onAt = g.t;
}

console.log('— 模擬：基本 —');
{
    // 決定性：同一個 seed、同樣的輸入 → 一模一樣
    const run = (seed) => {
        const g = ST.createGame({ seed, players: [{ id: 'a' }] });
        const out = [];
        for (let i = 0; i < 400 && !g.over; i++) { ST.setInput(g, 'a', Math.sin(i / 9) > 0 ? 1 : -1); ST.step(g); out.push(JSON.stringify(ST.snapshot(g))); }
        return out.join('|');
    };
    ok(run(42) === run(42), '同一個 seed 重播結果不一樣（伺服器算的不是決定性的）');
    ok(run(42) !== run(43), '換 seed 階梯都一樣');
    const g = ST.createGame({ seed: 1, players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });
    const p0 = g.platforms[0];
    ok(g.players.every(p => p.on === p0.id && p.x >= p0.x - ST.HIT_PAD && p.x + ST.S <= p0.x + p0.w + ST.HIT_PAD), '開局四個人沒有都站在第一塊上');
    ok(g.players.every((p, i) => !i || p.x - g.players[i - 1].x >= ST.S - 0.01), '開局四個人疊在一起');
    // 開局倒數：這段時間不捲動（一出發就被推向天花板太趕）
    const yc = g.platforms[1].y; ST.step(g);
    ok(g.platforms[1].y === yc && ST.snapshot(g).cd > 0, '開局倒數的時候階梯就在捲了');
    while (g.t < ST.COUNTDOWN_S) ST.step(g);
    ok(ST.snapshot(g).cd === 0, '倒數完 cd 沒有歸零');
    ok((g.platforms[0].y - ST.S) - ST.CEIL >= 3 * ST.SCROLL0 - 1, '開局離天花板太近（倒數完不到 3 秒就被刺）');
    // 捲動：階梯往上、下面一直補
    const y0 = g.platforms[1].y; ST.step(g);
    ok(g.platforms[1].y < y0, '階梯沒有往上捲');
    for (let i = 0; i < 200; i++) ST.step(g);
    ok(Math.max(...g.platforms.map(p => p.y)) >= ST.H, '下面沒有補新的階梯');
    ok(g.platforms.every(p => p.y + ST.PLAT_H > 0), '捲出畫面的階梯沒有清掉');
    // 越深越快、有上限
    const gg = ST.createGame({ seed: 1, players: [{ id: 'a' }] }); gg.t = ST.COUNTDOWN_S; P(gg, 'a').floor = 35; ST.step(gg);
    ok(gg.scroll > ST.SCROLL0 && gg.scroll <= ST.SCROLL_MAX, '越深沒有捲得越快（或超過上限）');
    P(gg, 'a').floor = 999; ST.step(gg);
    ok(gg.scroll === ST.SCROLL_MAX, '捲動速度沒有上限');
    // 階梯種類的比例大致照規格（安全層之後；前幾層只出普通）
    const R = ST.rng(99), seen = new Map(), N = 4000;
    for (let i = 0; i < N; i++) { const t = ST.pickType(R, ST.SAFE_FLOORS + 1 + i); seen.set(t, (seen.get(t) || 0) + 1); }
    ok(ST.TYPES.every(([t]) => (seen.get(t) || 0) > 0), '有階梯種類從來沒出現過：' + JSON.stringify([...seen]));
    ok(Math.abs((seen.get('normal') || 0) / N - 0.5) < 0.05, '普通階梯的比例不是大約一半：' + ((seen.get('normal') || 0) / N).toFixed(2));
    ok([1, 2, ST.SAFE_FLOORS].every(f => ST.pickType(R, f) === 'normal'), '前幾層出現了危險階梯');
}

console.log('— 模擬：階梯的效果 —');
{
    // 普通：落地回 1 血；尖刺：扣 3 血；落地才算一次（站著不會一直扣）
    let g = stage(['a'], [{ x: 20, y: 30, type: 'normal' }, { x: 20, y: 45, type: 'spike' }]);
    let a = P(g, 'a'); a.x = 24; a.y = 10; a.on = null; a.hp = 1; a.healN = ST.HEAL_EVERY - 1;
    let ev = []; for (let i = 0; i < 40 && a.on == null; i++) ev.push(...ST.step(g));
    ok(a.on === 100 && a.hp === 2 && ev.some(e => e.type === 'heal'), '踩滿幾次普通階梯沒有回一顆心');
    // 三顆心；不是每踩一次就回（扣一顆馬上補回來太簡單）
    ok(ST.HP_MAX === 3 && ST.SPIKE_DMG === 1 && ST.HEAL_EVERY >= 2, '血量不是三顆心（或每踩一次就回）');
    g = stage(['a'], [{ x: 20, y: 30, type: 'normal' }]);
    a = P(g, 'a'); a.x = 24; a.y = 10; a.on = null; a.hp = 1; a.healN = 0;
    for (let i = 0; i < 40 && a.on == null; i++) ST.step(g);
    ok(a.on === 100 && a.hp === 1 && a.healN === 1, '踩一次普通階梯就回心了（應該要踩滿幾次）');
    g = stage(['a'], [{ x: 20, y: 30, type: 'normal' }]);
    a = P(g, 'a'); a.x = 24; a.y = 10; a.on = null; a.hp = ST.HP_MAX; a.healN = ST.HEAL_EVERY - 1;
    ev = []; for (let i = 0; i < 40 && a.on == null; i++) ev.push(...ST.step(g));
    ok(a.hp === ST.HP_MAX && !ev.some(e => e.type === 'heal'), '滿血還在回心'); 
    g = stage(['a'], [{ x: 20, y: 30, type: 'spike' }]);
    a = P(g, 'a'); a.x = 24; a.y = 10; a.on = null; a.hp = ST.HP_MAX;
    for (let i = 0; i < 40 && a.on == null; i++) ST.step(g);
    ok(a.on === 100 && a.hp === ST.HP_MAX - ST.SPIKE_DMG, '踩到尖刺沒有扣血');
    for (let i = 0; i < 10; i++) ST.step(g);
    ok(a.hp === ST.HP_MAX - ST.SPIKE_DMG, '站在尖刺上一直扣血（應該只在落地那一下）');
    // 彈簧：彈起來
    g = stage(['a'], [{ x: 20, y: 30, type: 'spring' }]);
    a = P(g, 'a'); a.x = 24; a.y = 10; a.on = null;
    ev = []; for (let i = 0; i < 40 && !ev.some(e => e.type === 'spring'); i++) ev.push(...ST.step(g));
    ok(ev.some(e => e.type === 'spring') && a.vy < 0 && a.on == null, '彈簧沒有把人彈起來');
    // 翻板：站一下就翻掉、人往下掉
    g = stage(['a'], [{ x: 20, y: 30, type: 'flip' }]); put(g, 'a', 100);
    ev = []; for (let i = 0; i < Math.ceil(ST.FLIP_S / ST.DT) + 2; i++) ev.push(...ST.step(g));
    ok(g.platforms[0].gone && P(g, 'a').on == null && ev.some(e => e.type === 'flip'), '翻板站久了沒有翻掉');
    // 輸送帶：不按方向也會被帶著走
    g = stage(['a'], [{ x: 10, y: 30, w: 40, type: 'convR' }]); put(g, 'a', 100, 4);
    let x0 = P(g, 'a').x; for (let i = 0; i < 10; i++) ST.step(g);
    ok(P(g, 'a').x > x0 + 3, '往右的輸送帶沒有把人帶走');
    g = stage(['a'], [{ x: 10, y: 30, w: 40, type: 'convL' }]); put(g, 'a', 100, 20);
    x0 = P(g, 'a').x; for (let i = 0; i < 10; i++) ST.step(g);
    ok(P(g, 'a').x < x0 - 3, '往左的輸送帶沒有把人帶走');
    // 走出邊緣就掉下去
    g = stage(['a'], [{ x: 20, y: 30, w: 14 }]); put(g, 'a', 100, 2);
    ST.setInput(g, 'a', -1); for (let i = 0; i < 12; i++) ST.step(g);
    ok(P(g, 'a').on == null && P(g, 'a').vy > 0, '走出階梯邊緣沒有掉下去');
    // 空中也能左右控制
    g = stage(['a'], []); a = P(g, 'a'); a.x = 30; a.y = 10; a.on = null;
    ST.setInput(g, 'a', 1); x0 = a.x; ST.step(g); ST.step(g);
    ok(a.x > x0, '空中不能左右移動');
    // 牆：不會走出場地
    g = stage(['a'], [{ x: 0, y: 30, w: 69 }]); put(g, 'a', 100, 50);
    ST.setInput(g, 'a', 1); for (let i = 0; i < 60; i++) ST.step(g);
    ok(P(g, 'a').x <= ST.W - ST.S, '走出場地右邊');
}

console.log('— 模擬：天花板與出局 —');
{
    // 天花板：扣血、從那塊掉下去（穿過它）、短時間內不重複扣
    let g = stage(['a'], [{ x: 20, y: ST.CEIL + ST.S + 0.5 }]); put(g, 'a', 100);
    let ev = []; for (let i = 0; i < 6; i++) ev.push(...ST.step(g));
    const a = P(g, 'a');
    ok(ev.filter(e => e.type === 'ceil').length === 1 && a.hp === ST.HP_MAX - ST.SPIKE_DMG, '碰到天花板沒有扣血（或一直扣）');
    ok(a.on == null && a.pass === 100, '碰到天花板沒有從那塊掉下去');
    for (let i = 0; i < 10; i++) ST.step(g);
    ok(a.y > g.platforms[0].y, '碰到天花板之後又站回同一塊（應該穿過去）');
    // 掉出底部 → 出局；無限制一個人死了就結束
    g = stage(['a'], []); P(g, 'a').on = null; P(g, 'a').y = 40;
    ev = []; for (let i = 0; i < 60 && !g.over; i++) ev.push(...ST.step(g));
    ok(!P(g, 'a').alive && P(g, 'a').why === 'fall' && g.over && ev.some(e => e.type === 'over'), '掉出底部沒有出局／遊戲沒結束');
    // 血量歸零 → 出局
    g = stage(['a'], [{ x: 20, y: 30, type: 'spike' }]);
    P(g, 'a').x = 24; P(g, 'a').y = 10; P(g, 'a').on = null; P(g, 'a').hp = 1;
    for (let i = 0; i < 40 && !g.over; i++) ST.step(g);
    ok(!P(g, 'a').alive && P(g, 'a').why === 'hp' && P(g, 'a').hp === 0, '血量歸零沒有出局');
}

console.log('— 模擬：玩家碰撞（推擠、踩頭）—');
{
    // 左右推擠：兩隻並排硬擠，不會疊在一起
    let g = stage(['a', 'b'], [{ x: 5, y: 30, w: 60 }]);
    put(g, 'a', 100, 10); put(g, 'b', 100, 24);
    ST.setInput(g, 'a', 1); ST.setInput(g, 'b', -1);
    for (let i = 0; i < 30; i++) ST.step(g);
    const A = P(g, 'a'), B = P(g, 'b');
    const ov = Math.min(A.x + ST.S - ST.HIT_PAD, B.x + ST.S - ST.HIT_PAD) - Math.max(A.x + ST.HIT_PAD, B.x + ST.HIT_PAD);
    ok(ov <= 0.5 && A.x < B.x, '兩隻硬擠會穿過去或疊在一起（重疊 ' + ov.toFixed(1) + '）');
    // 踩頭：從上面落到別人頭上就站著，被踩的往下壓一點；被踩的走開就掉下來
    g = stage(['a', 'b'], [{ x: 5, y: 40, w: 60 }]);
    put(g, 'b', 100, 20);
    const a = P(g, 'a'); a.x = P(g, 'b').x; a.y = 5; a.on = null;
    const ev = []; for (let i = 0; i < 30 && a.on !== 'b'; i++) ev.push(...ST.step(g));
    ok(a.on === 'b' && ev.some(e => e.type === 'stomp' && e.on === 'b'), '落到別人頭上沒有站住（踩頭）');
    ok(Math.abs(a.y + ST.S - P(g, 'b').y) < 0.01, '站在頭上的位置不對');
    ST.setInput(g, 'b', 1); for (let i = 0; i < 20; i++) ST.step(g);
    ok(a.on !== 'b', '被踩的人走開了，上面的人沒掉下來');
}

console.log('— 模擬：結束與名次 —');
{
    // 生存制：剩一人就結束，活著的第一名；晚出局的名次在前
    const g = stage(['a', 'b', 'c'], [{ x: 0, y: 30, w: 69 }], 'survival');
    put(g, 'a', 100, 2); put(g, 'b', 100, 20); put(g, 'c', 100, 40);
    P(g, 'b').hp = 0; ST.step(g);
    ok(!g.over && !P(g, 'b').alive, '生存制還有兩人就結束了');
    for (let i = 0; i < 3; i++) ST.step(g);
    P(g, 'c').hp = 0; ST.step(g);
    ok(g.over && P(g, 'a').rank === 1 && P(g, 'c').rank === 2 && P(g, 'b').rank === 3, '生存制名次不對：' + g.players.map(p => p.id + p.rank).join(','));
    // 無限制：還有人活著就繼續
    const e = stage(['a', 'b'], [{ x: 0, y: 30, w: 69 }]); put(e, 'a', 100, 2); put(e, 'b', 100, 30);
    P(e, 'a').hp = 0; ST.step(e);
    ok(!e.over, '無限制一個人出局就整局結束了（應該各自玩到死）');
    // 每拍一包要小（規格：四人約 300 bytes）
    const g4 = ST.createGame({ seed: 9, players: ['a', 'b', 'c', 'd'].map(id => ({ id: 'id' + id + '0123456789abcdef'.slice(0, 12) })) });
    for (let i = 0; i < 50; i++) ST.step(g4);
    const n = Buffer.byteLength(JSON.stringify(ST.snapshot(g4)));
    ok(n < 600, '每拍的狀態太大：' + n + ' bytes');
    ok(ST.TICK_MS === 50, '一拍不是 50ms（規格 2.1）');
}

// ── 2. 伺服器 + daemon 端 ─────────────────────────────────────────────
(async () => {
    console.log('— 伺服器：開房、出發、每拍推送、結束、排行榜 —');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vpet-stairs-'));
    const boardFile = path.join(tmp, 'stairs-board.json');
    const ps = S.createPlazaServer({ stairsBoardFile: boardFile, dinoBoardFile: path.join(tmp, 'dino-board.json'), stairsTickMs: 5, stairsLostMs: 200, graceMs: 2000 });
    await new Promise(r => ps.server.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + ps.server.address().port;
    const seen = { a: [], b: [] };
    const mk = (tag) => C.create({ url, retryMs: 2000, onStairs: (k, d) => seen[tag].push([k, d]) });
    const prof = (name, char = 'agumon') => ({ name, char, stage: 'Child', card: { power: 10, train: 3 } });
    const a = mk('a'), b = mk('b');
    try {
        ok((await a.join(prof('阿張'))).ok && (await b.join(prof('阿明', 'gabumon'))).ok, '進廣場失敗');
        await until(() => a.me() && b.me());
        const sv = await a.stairs('open', { mode: 'survival' });
        ok(!sv.ok && /第二期/.test(sv.error || ''), '生存制應該還沒開放（第一期只有無限制）');
        const op = await a.stairs('open', { mode: 'endless' });
        ok(op.ok && op.room && op.room.mode === 'endless' && op.room.host === a.me().id, '開房失敗：' + JSON.stringify(op));
        ok(await until(() => b.stairsRooms().length === 1), '別人看不到新開的房間');
        ok(a.stairsMine() && !b.stairsMine(), 'stairsMine() 不對');
        ok(!(await a.stairs('open', { mode: 'endless' })).ok, '已經在房間裡還能再開一間');
        // 房間裡的人不能被邀對戰（也不能邀別人）
        const inv = await b.invite(a.me().id);
        ok(!inv.ok && /下樓梯/.test(inv.error || ''), '可以邀正在玩下樓梯的人對戰');
        ok(!(await b.stairs('start')).ok, '不在房間的人能按出發');
        ok(!(await a.stairs('input', { dir: 1 })).ok, '還沒出發就能送方向');
        // 出發：每拍推 tick
        ok((await a.stairs('start')).ok, '房主出發失敗');
        ok(await until(() => seen.a.filter(([k]) => k === 'tick').length >= 5), '出發之後沒有收到每拍的狀態');
        ok(!seen.b.some(([k]) => k === 'tick'), '不在房間的人也收到遊戲每拍的狀態');
        ok(await until(() => (b.stairsRooms()[0] || {}).state === 'play'), '房間清單沒有變成「遊戲中」');
        const t1 = seen.a.filter(([k]) => k === 'tick').pop()[1];
        ok(t1.s && Array.isArray(t1.s.pl) && t1.s.p.length === 1 && t1.s.p[0][0] === a.me().id, '每拍的狀態格式不對');
        ok((await a.stairs('input', { dir: 1 })).ok, '送方向失敗');
        ok(!(await a.stairs('input', { dir: 5 })).ok, '方向亂送（5）也收');
        ok(await until(() => { const l = seen.a.filter(([k]) => k === 'tick').pop()[1]; return l.s.p[0][5] === 1; }), '送了方向，狀態裡的方向沒變');
        // 一路往右撞牆、不管它 → 遲早出局 → 結束、寫排行榜
        ok(await until(() => seen.a.some(([k]) => k === 'end'), 20000), '一直沒結束（出局之後沒有 end）');
        const end = seen.a.find(([k]) => k === 'end')[1];
        const meRes = end.result && end.result.find(r => r.id === a.me().id);
        ok(meRes && meRes.floor >= 1 && meRes.rank === 1, '結果沒有我的層數／名次');
        ok(a.stairsEnd() && a.stairsEnd().result, 'stairsEnd() 沒記住最近一局');
        const board = JSON.parse(fs.readFileSync(boardFile, 'utf8')).board;
        ok(board.length === 1 && board[0].name === '阿張' && board[0].floor === meRes.floor, '排行榜沒寫進檔案：' + JSON.stringify(board));
        ok(end.records && end.records.some(r => r.id === a.me().id && r.top1), '第一次玩就是全服第一，結果沒說');
        // 一局結束就解散房間、大家回廣場（不再開房，2026-10-20）
        ok(await until(() => !a.stairsMine() && ps.rooms.size === 0), '結束之後房間沒解散（應該回廣場）');
        ok(a.stairsEnd() && a.stairsEnd().kind === 'stairs', '結果沒記住是哪個遊戲（結果面板要分層數／分數）');
        // 排行榜：同一個人只留最好的一筆
        ps.rooms.clear();
        const rec = (name, floor) => { const bd = JSON.parse(fs.readFileSync(boardFile, 'utf8')); bd.board.push({ name, floor, at: 1 }); fs.writeFileSync(boardFile, JSON.stringify(bd)); };
        rec('路人', 99);
        ok((await a.stairsBoard())[0].name === '路人', '/stairs/board 讀不到排行榜');
        // 離開房間：沒人就解散；房主交接
        const o2 = await a.stairs('open', { mode: 'endless' });
        ok(o2.ok, '再開一間失敗');
        const room = [...ps.rooms.values()][0];
        // 加入：聊天室有開房的系統訊息（帶房號）；等待中、沒滿才能加入
        ok(await until(() => b.chat().some(c => c.sys && c.stairsRoom === room.id && /下樓梯/.test(c.text))), '開房之後聊天室沒有系統訊息（廣場上的人不知道有人開房）');
        const jn = await b.stairs('join', { room: room.id });
        ok(jn.ok && room.ids.includes(b.me().id) && jn.room.n === 2, '加入房間失敗：' + JSON.stringify(jn));
        ok(!(await b.stairs('join', { room: room.id })).ok, '已經在房間裡還能再加入');
        ok(!(await b.stairs('open', { mode: 'endless' })).ok, '加入了房間還能自己再開一間');
        ok(!(await b.stairs('start')).ok, '不是房主也能按出發');
        ok(!(await b.stairs('join', { room: 'nope' })).ok, '加入不存在的房間沒擋');
        ok(await until(() => (a.stairsMine() || {}).n === 2 && (b.stairsMine() || {}).id === room.id), '加入之後雙方的房間資料沒更新');
        // 滿了不能加入；開始了不能加入
        room.ids.push('x1', 'x2');
        const c = C.create({ url, retryMs: 2000 }); await c.join(prof('阿丙', 'palmon')); await until(() => c.me());
        ok(!(await c.stairs('join', { room: room.id })).ok, '房間滿了還能加入');
        room.ids = room.ids.filter(i => i !== 'x1' && i !== 'x2');
        room.state = 'play';
        const jp = await c.stairs('join', { room: room.id });
        ok(!jp.ok && /開始/.test(jp.error || ''), '已經開始的房間還能加入');
        room.state = 'lobby';
        await c.leave();
        ok((await a.stairs('leave')).ok, '離開房間失敗');
        ok(ps.rooms.size === 1 && room.host === b.me().id, '房主離開沒有交給下一個人');
        ok((await b.stairs('leave')).ok && ps.rooms.size === 0, '最後一個人離開，房間沒解散');
        ok(await until(() => b.stairsRooms().length === 0), '房間解散了，清單沒更新');
        // 離開廣場 = 離開房間
        ok((await a.stairs('open', { mode: 'endless' })).ok, '開房失敗');
        await a.leave();
        ok(await until(() => ps.rooms.size === 0), '離開廣場之後房間還在');
        // 協定版本：伺服器跟 daemon 端要一致（對不上的房間 daemon 不顯示）
        ok(S.STAIRS_VER === 1, '協定版本號變了，記得更新 plaza-client 的 STAIRS_VER');
        ps.rooms.clear();
        // 主機的排行榜預設在 ~/.vpet（跟管理金鑰同一個資料夾），不在 repo
        ok(S.STAIRS_BOARD_FILE === path.join(os.homedir(), '.vpet', 'stairs-board.json') || !!process.env.VPET_STAIRS_BOARD, '排行榜預設位置不對');
    } finally {
        try { await a.leave(); } catch (e) {}
        try { await b.leave(); } catch (e) {}
        await ps.close();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    }

    console.log('— 伺服器：遊戲中斷線 —');
    {
        const ps2 = S.createPlazaServer({ stairsBoardFile: path.join(os.tmpdir(), 'vpet-stairs-x.json'), dinoBoardFile: path.join(os.tmpdir(), 'vpet-dino-x.json'), stairsTickMs: 20, stairsLostMs: 150, graceMs: 5000 });
        await new Promise(r => ps2.server.listen(0, '127.0.0.1', r));
        const c = C.create({ url: 'http://127.0.0.1:' + ps2.server.address().port, retryMs: 5000 });
        try {
            await c.join(prof('斷線仔'));
            await until(() => c.me());
            await c.stairs('open', { mode: 'endless' });
            await c.stairs('start');
            await sleep(60);
            const room = [...ps2.rooms.values()][0];
            const m = ps2.members.get(c.me().id);
            m.stream.destroy(); m.stream = null; m.lostAt = Date.now();   // 模擬斷線（不送 leave）
            ok(await until(() => room.state === 'lobby', 3000), '遊戲中斷線太久沒有算出局（整局卡住）');
        } finally { try { await c.leave(); } catch (e) {} await ps2.close(); try { fs.rmSync(path.join(os.tmpdir(), 'vpet-stairs-x.json')); } catch (e) {} }
    }

    console.log(`\n結果：${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERR', e.stack); process.exit(1); });
