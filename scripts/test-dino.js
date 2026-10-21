#!/usr/bin/env node
'use strict';
/**
 * test-dino.js — 廣場小遊戲「小恐龍」（docs/plaza-dino-spec.md）
 *
 *   1. 模擬（src/shared/dino-sim.js）：決定性、跳、碰撞、賽道保證跳得過、飛鳥高度、加速，
 *      以及「能不能原樣內嵌進頁面」（頁面是 template literal）
 *   2. 伺服器＋daemon 端：開小恐龍的房、出發（seed＋起跑時間）、回報轉成影子、
 *      全部撞到才結束、名次、排行榜（暫存檔）、沒回報當作撞到、跟下樓梯的房間互不干擾
 */
const fs = require('fs'), os = require('os'), path = require('path');
const DN = require('../src/shared/dino-sim.js');
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
// 簡單的自動駕駛：前面有要跳的障礙物、而且快到了就按住跳
function bot(g) {
    const o = g.obstacles.find(q => q.x - g.dist + q.w > DN.RX && q.kind !== 'birdHigh');
    const dx = o ? o.x - g.dist - DN.RX - DN.S : 999;
    DN.press(g, !!o && dx < g.v * 0.12 && dx > -o.w);
}

console.log('— 模擬 —');
{
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'dino-sim.js'), 'utf8');
    ok(!/[`\\]|\$\{|<\/script/i.test(src), 'dino-sim.js 有不能內嵌進頁面的字元（反引號、反斜線、錢字號接大括號、</script>）—— daemon 會停用小恐龍');
    // 決定性：同一個 seed、同樣的按鍵 → 一模一樣（大家跑同一條賽道、之後要防作弊也靠它）
    const run = (seed) => { const g = DN.createGame(seed); const out = [];
        for (let i = 0; i < 3000 && g.alive; i++) { bot(g); DN.step(g); if (i % 50 === 0) out.push(g.dist.toFixed(3) + ',' + g.y.toFixed(3)); }
        return out.join('|') + '|' + g.obstacles.map(o => o.kind + o.x).join(','); };
    ok(run(7) === run(7), '同一個 seed 重播結果不一樣');
    ok(DN.createGame(7).obstacles.map(o => o.x).join() !== DN.createGame(8).obstacles.map(o => o.x).join(), '換 seed 賽道都一樣');
    // 跳：在地上才能跳；按住跳得比較高
    let g = DN.createGame(1);
    DN.press(g, true); ok(g.vy > 0, '在地上按跳沒有起跳');
    let top = 0; for (let i = 0; i < 120; i++) { DN.step(g); top = Math.max(top, g.y); }
    const g2 = DN.createGame(1); DN.press(g2, true); DN.press(g2, false);
    let top2 = 0; for (let i = 0; i < 120; i++) { DN.step(g2); top2 = Math.max(top2, g2.y); }
    ok(top > top2 + 2, `按住沒有跳比較高（按住 ${top.toFixed(1)}、點一下 ${top2.toFixed(1)}）`);
    ok(top2 > DN.CACTUS.big[1], '點一下跳不過大仙人掌的高度');
    g = DN.createGame(1); DN.press(g, true); DN.step(g); const vy = g.vy; DN.press(g, false); DN.press(g, true);
    ok(g.vy === vy, '空中可以再跳一次（二段跳）');
    for (let i = 0; i < 200; i++) DN.step(g);
    ok(g.y === 0 && g.vy === 0, '跳完沒有落回地面');
    // 碰撞：站著不動一定會撞到第一個要跳的障礙物；擦邊（身體縮 PAD）不算
    g = DN.createGame(3); let dead = null;
    for (let i = 0; i < 2000 && g.alive; i++) dead = DN.step(g) || dead;
    ok(!g.alive && dead === 'dead', '站著不跳一直沒撞到東西');
    // 賽道保證跳得過：每個障礙物在那一段的速度下都 clearable，間距夠落地再跳
    let bad = 0, close = 0, mid = 0;
    for (let seed = 1; seed <= 30; seed++) {
        const q = DN.createGame(seed); q.dist = 0;
        for (let i = 0; i < 60 * 60 && q.alive; i++) { q.dist += 2; DN.step(q); q.alive = true; }
        const all = q.obstacles;
        for (let i = 0; i < all.length; i++) {
            const o = all[i];
            if (o.kind !== 'birdHigh' && !DN.clearable(o, DN.speedAt(o.x))) bad++;
            if (i && o.x - (all[i - 1].x + all[i - 1].w) < DN.minGap(all[i - 1].x) - 1) close++;
            if (o.kind.startsWith('bird') && o.y > DN.BIRD.low && o.y < DN.S - DN.PAD) mid++;
        }
    }
    ok(bad === 0, `有 ${bad} 個障礙物物理上跳不過`);
    // 安全網真的有作用：把仙人掌改寬到一叢跳不過，產生器要自動少放幾株
    ok(!DN.clearable({ w: 60, h: 8, y: 0 }, DN.V0), 'clearable 判斷不了太寬的障礙物');
    const keep = DN.CACTUS.small.slice(); DN.CACTUS.small[0] = 14;
    try {
        let wide = 0;
        for (let seed = 1; seed <= 20; seed++) { const q = DN.createGame(seed);
            for (const o of q.obstacles) if (o.kind === 'cactusSmall' && !DN.clearable(o, DN.speedAt(o.x))) wide++; }
        ok(wide === 0, `仙人掌太寬時產生器沒有少放（${wide} 叢跳不過）`);
    } finally { DN.CACTUS.small[0] = keep[0]; }
    ok(close === 0, `有 ${close} 處障礙物太近（落地來不及再跳）`);
    ok(mid === 0, `有 ${mid} 隻飛鳥在「只有蹲才閃得過」的高度（沒有蹲）`);
    // 高的鳥：站著不跳會從頭上飛過；低的鳥要跳
    const hi = { kind: 'birdHigh', x: 0, w: DN.BIRD.w, h: DN.BIRD.h, y: DN.BIRD.high };
    const st = { dist: -DN.RX, y: 0, obstacles: [hi] };
    ok(!DN.hit(st), '高的飛鳥站著也會撞到（應該從頭上飛過）');
    st.obstacles = [{ ...hi, kind: 'birdLow', y: DN.BIRD.low }];
    ok(!!DN.hit(st), '低的飛鳥站著撞不到（應該要跳）');
    // 自動駕駛跑得下去（不會一開局就躲不掉）、越跑越快、有上限
    let far = 0;
    for (const seed of [1, 2, 3]) { const q = DN.createGame(seed); for (let i = 0; i < 60 * 90 && q.alive; i++) { bot(q); DN.step(q); } far += q.alive ? 1 : 0; }
    ok(far === 3, '簡單的自動駕駛跑不完 90 秒（賽道太難、或有躲不掉的組合）');
    ok(DN.speedAt(0) === DN.V0 && DN.speedAt(1e6) === DN.VMAX && DN.speedAt(DN.ACCEL_DIST * 3) > DN.V0, '速度沒有越跑越快／沒有上限');
    ok(DN.score(400) === 100, '分數換算不對');
}

(async () => {
    console.log('— 伺服器：開房、出發、回報、影子、結束、排行榜 —');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vpet-dino-'));
    const dinoFile = path.join(tmp, 'dino-board.json'), stairsFile = path.join(tmp, 'stairs-board.json');
    const ps = S.createPlazaServer({ dinoBoardFile: dinoFile, stairsBoardFile: stairsFile, dinoCountdownMs: 50, dinoStaleMs: 400 });
    await new Promise(r => ps.server.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + ps.server.address().port;
    const seen = { a: [], b: [] };
    const mk = (tag) => C.create({ url, retryMs: 2000, onStairs: (k, d) => seen[tag].push([k, d]) });
    const prof = (name, char = 'agumon') => ({ name, char, stage: 'Child', card: { power: 10, train: 3 } });
    const a = mk('a'), b = mk('b');
    try {
        await a.join(prof('阿張')); await b.join(prof('阿明', 'gabumon'));
        await until(() => a.me() && b.me());
        const op = await a.stairs('open', { mode: 'endless', kind: 'dino' });
        ok(op.ok && op.room.kind === 'dino', '開小恐龍的房失敗：' + JSON.stringify(op));
        ok(await until(() => (b.stairsRooms()[0] || {}).kind === 'dino'), '別人看到的房間不是小恐龍');
        const room = [...ps.rooms.values()][0];
        ok((await b.stairs('join', { room: room.id })).ok && room.ids.length === 2, '加入小恐龍的房間失敗');
        const st = await a.stairs('start');
        ok(st.ok && typeof st.seed === 'number' && st.startAt > Date.now() - 1000, '出發沒有給 seed／起跑時間');
        ok(!room.timer || room.kind === 'dino', '小恐龍開了伺服器的 50ms 迴圈');
        ok(await until(() => seen.a.some(([k, d]) => k === 'start' && d.seed === st.seed)), '出發的 seed 沒有推給房裡的人');
        ok(await until(() => (a.stairsMine() || {}).dino && a.stairsMine().dino.seed === st.seed), '房間資料裡沒有 seed／起跑時間（重新整理會接不上）');
        // 回報 → 別人收到影子；數字不合理就擋
        ok((await a.stairs('report', { dist: 120, y: 3, alive: true })).ok, '回報失敗');
        ok(await until(() => seen.b.some(([k, d]) => k === 'ghost' && d.id === a.me().id && d.dist === 120)), '回報的位置沒有轉給同房的人（影子）');
        ok(!(await a.stairs('report', { dist: -5, y: 0, alive: true })).ok, '負的距離也收');
        ok(!(await a.stairs('report', { dist: 'x', y: 0, alive: true })).ok, '亂七八糟的距離也收');
        await a.stairs('report', { dist: 50, y: 0, alive: true });
        ok(room.dino.players.get(a.me().id).dist === 120, '距離往回跑了（應該只增不減）');
        // a 撞到（400 → 分數 100），b 還在跑 → 還沒結束
        await a.stairs('report', { dist: 400, y: 0, alive: false });
        ok(room.state === 'play', '還有人在跑就結束了');
        ok(!(await a.stairs('report', { dist: 9000, y: 0, alive: true })).ok || room.dino.players.get(a.me().id).dist === 400, '撞到之後還能改距離');
        // b 跑更遠才撞到 → 結束：b 第一、a 第二，寫排行榜（分數）
        await b.stairs('report', { dist: 800, y: 0, alive: false });
        ok(await until(() => seen.a.some(([k]) => k === 'end')), '大家都撞到了還沒結束');
        const end = seen.a.find(([k]) => k === 'end')[1];
        const ra = end.result.find(r => r.id === a.me().id), rb = end.result.find(r => r.id === b.me().id);
        ok(ra && rb && ra.score === 100 && rb.score === 200 && rb.rank === 1 && ra.rank === 2, '名次／分數不對：' + JSON.stringify(end.result));
        const board = JSON.parse(fs.readFileSync(dinoFile, 'utf8')).board;
        ok(board.length === 2 && board[0].name === '阿明' && board[0].score === 200, '小恐龍的排行榜沒寫對：' + JSON.stringify(board));
        ok(!fs.existsSync(stairsFile), '小恐龍的成績寫進了下樓梯的排行榜');
        ok((await a.stairsBoard('dino'))[0].name === '阿明' && (await a.stairsBoard()).length === 0, '/stairs/board 沒有分遊戲');
        // 一局結束就解散房間、大家回廣場（不再開房，2026-10-20）
        ok(await until(() => !a.stairsMine() && !b.stairsMine() && ps.rooms.size === 0), '結束之後房間沒解散（應該回廣場）');
        ok(a.stairsEnd() && a.stairsEnd().kind === 'dino', '結果沒記住是小恐龍（結果面板要顯示分數）');
        // 沒回報的人：等不到就當作撞到（關分頁、當掉）
        await a.stairs('open', { mode: 'endless', kind: 'dino' });
        const room2 = [...ps.rooms.values()][0]; await b.stairs('join', { room: room2.id });
        await a.stairs('start');
        await sleep(100);
        await a.stairs('report', { dist: 40, y: 0, alive: false });   // a 撞到了，b 從頭到尾沒回報
        ok(await until(() => ps.rooms.size === 0, 3000), '有人一直沒回報，整局結束不了');
        void room;
        // 撞到了先走（不用等別人跑完）：成績照記進排行榜，別人繼續跑
        await a.stairs('open', { mode: 'endless', kind: 'dino' });
        const room3 = [...ps.rooms.values()][0]; await b.stairs('join', { room: room3.id });
        await a.stairs('start'); await sleep(100);
        await a.stairs('report', { dist: 3000, y: 0, alive: false });
        await b.stairs('report', { dist: 10, y: 0, alive: true });
        ok((await a.stairs('leave')).ok, '撞到了不能先離開');
        const brd = JSON.parse(fs.readFileSync(dinoFile, 'utf8')).board;
        ok(brd.some(x => x.name === '阿張' && x.score === DN.score(3000)), '撞到先走的人，成績沒有記進排行榜');
        ok(ps.rooms.size === 1 && [...ps.rooms.values()][0].state === 'play', '有人先走，別人的這一局也被結束了');
        await b.stairs('report', { dist: 20, y: 0, alive: false });
        await until(() => ps.rooms.size === 0);
        const s2 = await a.stairs('open', { mode: 'endless' });
        ok(s2.ok && s2.room.kind === 'stairs', '沒帶 kind 開的不是下樓梯（舊版 daemon 會開錯）');
        await a.stairs('leave');
        ok(S.DINO_BOARD_FILE === path.join(os.homedir(), '.vpet', 'dino-board.json') || !!process.env.VPET_DINO_BOARD, '小恐龍排行榜的預設位置不對');
    } finally {
        try { await a.leave(); } catch (e) {}
        try { await b.leave(); } catch (e) {}
        await ps.close();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    }

    console.log('— 排行榜認人：玩家代號（改名會同步）—');
    {
        const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vpet-dino-pid-'));
        const df = path.join(tmp2, 'dino.json'), sf = path.join(tmp2, 'stairs.json');
        // 舊紀錄沒有代號：同名的人第一次帶代號進來就綁給他
        fs.writeFileSync(df, JSON.stringify({ v: 1, board: [{ name: '老王', char: 'agumon', score: 50, at: 1 }, { name: '路人', score: 10, at: 2 }] }));
        const ps2 = S.createPlazaServer({ dinoBoardFile: df, stairsBoardFile: sf, dinoCountdownMs: 10, dinoStaleMs: 2000 });
        await new Promise(r => ps2.server.listen(0, '127.0.0.1', r));
        const u2 = 'http://127.0.0.1:' + ps2.server.address().port;
        const PID = 'aa'.repeat(12), PID2 = 'bb'.repeat(12);
        const w = C.create({ url: u2, retryMs: 2000 });
        try {
            await w.join({ ...prof('老王'), pid: PID }); await until(() => w.me());
            const rd = () => JSON.parse(fs.readFileSync(df, 'utf8')).board;
            ok(rd().find(b => b.name === '老王').pid === PID, '舊紀錄（沒有代號）名字對得上沒有綁給他');
            ok(!rd().find(b => b.name === '路人').pid, '別人的舊紀錄也被綁走了');
            // 改名 → 排行榜跟著換
            ok((await w.rename('小王')).ok, '改名失敗');
            ok(rd().some(b => b.name === '小王' && b.pid === PID) && !rd().some(b => b.name === '老王'), '改名之後排行榜的名字沒跟著換');
            // 改名之後破紀錄：同一筆更新，不會多一筆
            await w.stairs('open', { mode: 'endless', kind: 'dino' }); await w.stairs('start');
            await w.stairs('report', { dist: 800, y: 0, alive: false });
            ok(await until(() => ps2.rooms.size === 0), '這一局沒結束');
            ok(rd().filter(b => b.pid === PID).length === 1 && rd().find(b => b.pid === PID).score === 200, '改名後破紀錄變成兩筆（或沒更新）：' + JSON.stringify(rd()));
            // 對外的排行榜不帶代號（代號等於身分，拿到就能冒名）
            const pub = await w.stairsBoard('dino');
            ok(pub.length && pub.every(b => !('pid' in b)), '對外的排行榜帶出了玩家代號');
            const endBoard = (w.stairsEnd() || {}).board || [];
            ok(endBoard.length && endBoard.every(b => !('pid' in b)), '結束畫面的排行榜帶出了玩家代號');
            // 在廣場外改名（vpet code）：下次進廣場時同步
            await w.leave();
            await w.join({ ...prof('王大'), pid: PID }); await until(() => w.me());
            ok(rd().some(b => b.name === '王大' && b.pid === PID), '在廣場外改名，下次進來排行榜沒跟上');
            // 別人改名不影響我的紀錄
            const x = C.create({ url: u2, retryMs: 2000 });
            await x.join({ ...prof('路人甲'), pid: PID2 }); await until(() => x.me());
            await x.rename('王大x');
            ok(rd().find(b => b.pid === PID).name === '王大', '別人改名影響到我的紀錄');
            await x.leave();
        } finally { try { await w.leave(); } catch (e) {} await ps2.close(); try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch (e) {} }
    }
    const dsrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'daemon', 'daemon.js'), 'utf8');
    ok(/pid: plazaPlayerId\(\)/.test(dsrc) && /const PLAYER_ID_FILE = path\.join\(STATE_DIR, 'plaza-player\.json'\);/.test(dsrc), 'daemon 進廣場沒有帶固定的玩家代號');
    console.log(`\n結果：${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERR', e.stack); process.exit(1); });
