#!/usr/bin/env node
'use strict';
/**
 * test-gomoku.js — 廣場小遊戲「五子棋」（docs/plaza-gomoku-spec.md）
 *
 *   1. 判定：連幾顆（橫、直、兩條斜線）、表情規則
 *   2. 伺服器：房間 2 人、黑子（房主）先下、輪流、不能下在有子的地方、連成五子 → 勝負表情 → 結算、
 *      認輸、中途離開、斷線
 */
const S = require('../src/daemon/plaza-server.js');
const C = require('../src/daemon/plaza-client.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(cond, ms = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(15); }
    return cond();
}

console.log('— 判定 —');
{
    const N = S.GOMOKU_N, B = () => new Array(N * N).fill(0);
    const put = (b, pts, c = 1) => { for (const [x, y] of pts) b[y * N + x] = c; return b; };
    ok(N === 15, '棋盤不是 15 路');
    ok(S.gomokuLine(put(B(), [[3, 3], [4, 3], [5, 3], [6, 3], [7, 3]]), 5, 3) === 5, '橫的五子沒算到');
    ok(S.gomokuLine(put(B(), [[2, 1], [2, 2], [2, 3], [2, 4]]), 2, 4) === 4, '直的四子沒算到');
    ok(S.gomokuLine(put(B(), [[0, 0], [1, 1], [2, 2]]), 1, 1) === 3, '斜的三子（從中間那顆算）沒算到');
    ok(S.gomokuLine(put(B(), [[14, 0], [13, 1], [12, 2], [11, 3], [10, 4]]), 12, 2) === 5, '反斜的五子沒算到（棋盤邊緣）');
    const mixed = put(put(B(), [[3, 3], [4, 3], [6, 3]], 1), [[5, 3]], 2);
    ok(S.gomokuLine(mixed, 4, 3) === 2, '被對方的子隔開還算成一條');
    const e5 = S.gomokuExpr(5), e4 = S.gomokuExpr(4), e3 = S.gomokuExpr(3), e1 = S.gomokuExpr(1);
    ok(e5[0] === 'HAPPY' && e5[1] === 'SAD', '連成五子：下的人不是開心、對手不是難過');
    ok(e4[0] === 'ATTACK' && e4[1] === 'HURT', '連成四子：下的人不是攻擊、對手不是受傷');
    ok(e3[0] === 'HAPPY' && e3[1] === 'ANGRY', '連成三子：下的人不是開心、對手不是生氣');
    ok(e1[0] === 'IDLE' && e1[1] === 'IDLE', '普通一手也在做表情');
}

console.log('— 跟電腦玩：五子棋的電腦（盡可能強）—');
{
    const AI = require('../src/shared/gomoku-ai.js');
    const fs = require('fs'), path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'gomoku-ai.js'), 'utf8');
    ok(!/[`\\]|\$\{|<\/script/i.test(src), 'gomoku-ai.js 有不能內嵌進頁面的字元 —— daemon 會退回簡單版電腦');
    const N = AI.N;
    const board = (black, white) => { const b = new Array(N * N).fill(0); for (const [x, y] of black) b[y * N + x] = 1; for (const [x, y] of white) b[y * N + x] = 2; return b; };
    const eq = (a, b) => a[0] === b[0] && a[1] === b[1];
    const oneOf = (m, list) => list.some(p => eq(m, p));
    // 能連五就連五（不去擋對方的四）
    let m = AI.choose(board([[3, 3], [4, 3], [5, 3], [6, 3]], [[3, 8], [4, 8], [5, 8], [6, 8]]), 2, { timeMs: 300 });
    ok(oneOf(m, [[2, 8], [7, 8]]), '自己能連五卻沒連：' + m);
    // 對方能連五一定擋
    m = AI.choose(board([[3, 3], [4, 3], [5, 3], [6, 3], [10, 10]], [[2, 3], [9, 9], [12, 12]]), 2, { timeMs: 300 });
    ok(eq(m, [7, 3]), '對方下一手連五沒擋：' + m);
    // 對方活三一定擋（擋在兩頭或中間的空點）
    m = AI.choose(board([[5, 7], [6, 7], [7, 7]], [[6, 6], [9, 12]]), 2, { timeMs: 600 });
    ok(oneOf(m, [[4, 7], [8, 7], [3, 7], [9, 7]]), '對方活三沒擋：' + m);
    // 連續衝四找殺（VCF）：白有兩條衝四可以連著衝，最後成活四／雙四
    const why = [];
    m = AI.choose(board([[2, 2], [12, 2], [2, 12], [12, 12], [7, 1]], [[5, 5], [6, 5], [7, 5], [5, 6], [5, 7], [5, 8]]), 2, { timeMs: 800, why });
    ok(why[0] === 'open4' || why[0] === 'vcf' || why[0] === 'five', '有殺法卻沒找到（' + why[0] + '）：' + m);
    // 對局：跟「只看一層」的簡單電腦各執黑白下 6 局，一局都不能輸
    const simple = (b, c) => {
        const sc = (x, y, cc) => { let t = 0; for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) { let n = 1, open = 0;
            for (const s of [1, -1]) { let i = x + dx * s, j = y + dy * s; while (i >= 0 && j >= 0 && i < N && j < N && b[j * N + i] === cc) { n++; i += dx * s; j += dy * s; } if (i >= 0 && j >= 0 && i < N && j < N && b[j * N + i] === 0) open++; }
            t += n >= 5 ? 100000 : n === 4 ? (open === 2 ? 10000 : open === 1 ? 1200 : 0) : n === 3 ? (open === 2 ? 1000 : open === 1 ? 120 : 0) : n === 2 ? (open === 2 ? 100 : open === 1 ? 12 : 0) : (open === 2 ? 6 : 1); } return t; };
        let best = -1, cs = []; for (const p of AI.candidates(b)) { const x = p % N, y = Math.floor(p / N); const s = sc(x, y, c) * 1.1 + sc(x, y, 3 - c); if (s > best) { best = s; cs = [p]; } else if (s === best) cs.push(p); }
        const p = cs[0]; return [p % N, Math.floor(p / N)];
    };
    let lost = 0, won = 0, slow = 0;
    for (let g = 0; g < 6; g++) {
        const aiC = g % 2 ? 1 : 2, b = new Array(N * N).fill(0);
        let t = 1, n = 0;
        if (g >= 2) { b[7 * N + 7] = 1; b[6 * N + (5 + g)] = 2; t = 1; n = 2; }   // 換幾種開局
        while (n < N * N) {
            const t0 = Date.now();
            const [x, y] = t === aiC ? AI.choose(b, aiC, { timeMs: 700 }) : simple(b, t);
            if (t === aiC && Date.now() - t0 > 2000) slow++;
            b[y * N + x] = t; n++;
            if (AI.makesFive(b, x, y, t)) { if (t === aiC) won++; else lost++; break; }
            t = 3 - t;
        }
    }
    ok(lost === 0, `跟只看一層的簡單電腦下 6 局輸了 ${lost} 局（不夠強）`);
    ok(won >= 5, `6 局只贏了 ${won} 局`);
    ok(slow === 0, '電腦想太久（超過 2 秒）');
}

(async () => {
    console.log('— 伺服器 —');
    const ps = S.createPlazaServer({ gomokuEndMs: 120, stairsLostMs: 200, graceMs: 3000, gomokuTurnMs: 1200 });
    await new Promise(r => ps.server.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + ps.server.address().port;
    const seen = { a: [], b: [], c: [] };
    const mk = (tag) => C.create({ url, retryMs: 2000, onStairs: (k, d) => seen[tag].push([k, d]) });
    const prof = (name, char = 'agumon') => ({ name, char, stage: 'Child', card: { power: 10, train: 3 } });
    const a = mk('a'), b = mk('b'), c = mk('c');
    const room = () => [...ps.rooms.values()][0];
    const newGame = async () => {
        await a.stairs('open', { mode: 'endless', kind: 'gomoku' });
        await b.stairs('join', { room: room().id });
        await a.stairs('start');
        seen.a.length = 0; seen.b.length = 0;
    };
    try {
        await a.join(prof('阿張')); await b.join(prof('阿明', 'gabumon')); await c.join(prof('阿丙', 'palmon'));
        await until(() => a.me() && b.me() && c.me());
        const op = await a.stairs('open', { mode: 'endless', kind: 'gomoku' });
        ok(op.ok && op.room.kind === 'gomoku' && op.room.cap === 2, '開五子棋房失敗（或上限不是 2）');
        ok(!(await a.stairs('start')).ok, '1 個人也能開始');
        await b.stairs('join', { room: room().id });
        ok(!(await c.stairs('join', { room: room().id })).ok, '五子棋房滿 2 人還能加入');
        ok((await a.stairs('start')).ok, '2 個人開始失敗');
        ok(await until(() => (b.stairsMine() || {}).gomoku), '房間資料裡沒有棋盤');
        const gm0 = b.stairsMine().gomoku;
        ok(gm0.board.length === 225 && /^0+$/.test(gm0.board) && gm0.turn === 0 && gm0.sides[0] === a.me().id, '開局棋盤不是空的、或不是房主（黑）先下');
        // 輪流、不能下在有子的地方、位置要合法
        ok(!(await b.stairs('gmove', { x: 7, y: 7 })).ok, '還沒輪到也能下（白子先下了）');
        ok((await a.stairs('gmove', { x: 7, y: 7 })).ok, '黑子第一手下不了');
        ok(await until(() => seen.b.some(([k, d]) => k === 'gmove' && d.x === 7 && d.y === 7)), '下了一手沒有推給對手（要等輪詢才看得到）');
        ok(!(await a.stairs('gmove', { x: 8, y: 7 })).ok, '同一個人可以連下兩手');
        ok(!(await b.stairs('gmove', { x: 7, y: 7 })).ok, '可以下在已經有子的地方');
        ok(!(await b.stairs('gmove', { x: 15, y: 0 })).ok && !(await b.stairs('gmove', { x: 1.5, y: 0 })).ok, '棋盤外／不是整數的位置也收');
        ok(!(await c.stairs('gmove', { x: 0, y: 0 })).ok, '不在棋局裡的人也能下');
        ok((await b.stairs('gmove', { x: 0, y: 0 })).ok, '白子下不了');
        ok(await until(() => (a.stairsMine() || {}).gomoku && a.stairsMine().gomoku.board[0] === '2' && a.stairsMine().gomoku.board[7 * 15 + 7] === '1'), '棋盤資料沒更新');
        // 黑連成三 → 黑開心、白生氣；連成四 → 黑攻擊、白受傷
        await a.stairs('gmove', { x: 8, y: 7 }); await b.stairs('gmove', { x: 14, y: 0 });
        await a.stairs('gmove', { x: 9, y: 7 });
        ok(room().gomoku.expr[0] === 'HAPPY' && room().gomoku.expr[1] === 'ANGRY', '連成三：表情不對 ' + room().gomoku.expr);
        await b.stairs('gmove', { x: 0, y: 14 });
        ok(room().gomoku.expr.join() === 'IDLE,IDLE', '普通一手表情沒回到待機');
        await a.stairs('gmove', { x: 10, y: 7 });
        ok(room().gomoku.expr[0] === 'ATTACK' && room().gomoku.expr[1] === 'HURT', '連成四：表情不對 ' + room().gomoku.expr);
        await b.stairs('gmove', { x: 14, y: 14 });
        // 黑連成五 → 黑贏：先停一下（看清楚最後一手），再結算、解散房間
        ok((await a.stairs('gmove', { x: 11, y: 7 })).ok, '第五子下不了');
        ok(room() && room().gomoku.winner === 0 && room().gomoku.expr.join() === 'HAPPY,SAD', '連成五子沒有判黑贏（或表情不是開心／難過）');
        ok(!(await b.stairs('gmove', { x: 0, y: 4 })).ok, '分出勝負之後還能下');
        ok(await until(() => seen.a.some(([k]) => k === 'end') && ps.rooms.size === 0), '連成五子之後沒結算／房間沒解散');
        const end = seen.a.find(([k]) => k === 'end')[1];
        ok(end.result.find(r => r.id === a.me().id).rank === 1 && end.result.find(r => r.id === b.me().id).rank === 2 && end.result[0].moves === 9, '結果不對：' + JSON.stringify(end.result));
        ok(a.stairsEnd().kind === 'gomoku', '結果沒記住是五子棋');
        // 認輸
        await newGame();
        await a.stairs('gmove', { x: 7, y: 7 });
        ok((await b.stairs('gresign')).ok, '認輸失敗');
        ok(await until(() => seen.a.some(([k]) => k === 'end')), '認輸之後沒結算');
        const e2 = seen.a.find(([k]) => k === 'end')[1];
        ok(e2.result.find(r => r.id === a.me().id).rank === 1 && e2.result.find(r => r.id === b.me().id).why === 'resign', '認輸的不是輸家');
        // 中途離開 → 留下來的贏
        await newGame();
        await b.stairs('leave');
        ok(await until(() => seen.a.some(([k]) => k === 'end')), '對手中途離開，棋局沒結束');
        ok(seen.a.find(([k]) => k === 'end')[1].result.find(r => r.id === a.me().id).rank === 1, '對手離開，留下來的沒贏');
        // 每手倒數：房間資料帶時限；超時由電腦代下一手、輪到對手（2026-10-21）
        await newGame();
        ok(await until(() => { const gt = a.stairsMine() && a.stairsMine().gomoku; return gt && gt.turnMs === 1200 && typeof gt.turnAt === 'number'; }),
           '房間資料沒有每手的時限（頁面沒辦法倒數）');
        ok(await until(() => room() && room().gomoku && room().gomoku.moves === 1 && room().gomoku.turn === 1, 3000), '黑子超時，電腦沒有代下一手');
        ok(await until(() => seen.b.some(([k, d]) => k === 'gmove' && d.auto === true)), '超時代下的那一手沒有推給對手（或沒標記是電腦代下）');
        await b.stairs('gresign');
        await until(() => !room());
        // 斷線太久 → 對手贏
        await newGame();
        const mb = ps.members.get(b.me().id); mb.stream.destroy(); mb.stream = null; mb.lostAt = Date.now();
        ok(await until(() => seen.a.some(([k]) => k === 'end'), 3000), '對手斷線，棋局卡住沒結束');
    } finally {
        for (const x of [a, b, c]) { try { await x.leave(); } catch (e) {} }
        await ps.close();
    }
    console.log(`\n結果：${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERR', e.stack); process.exit(1); });
