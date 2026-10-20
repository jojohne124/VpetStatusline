#!/usr/bin/env node
'use strict';
/**
 * test-duel.js — 廣場「手動戰鬥」（docs/plaza-duel-spec.md）
 *
 *   1. 判定（duel-sim.js）：血量／攻擊／力度倍率、移動限制、預設值、打中／沒中、對波（強的贏、一樣強兩顆都消）、
 *      歸零勝負、打滿 20 回合比剩餘血量、隨機對手只選合法的
 *   2. 伺服器：邀請選手動戰鬥 → 開 2 人房直接開打、選擇不公開、兩邊選好就結算、時限到用預設、
 *      演出中不收、一回合只收一次、不合法的不收、分出勝負 → 結算解散、認輸、中途離開、斷線
 */
const S  = require('../src/daemon/plaza-server.js');
const C  = require('../src/daemon/plaza-client.js');
const DS = require('../src/shared/duel-sim.js');

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
    ok(DS.hpOf(120) === 120 && DS.hpOf(0) === 1, '血量不是戰力（或戰力 0 時血量是 0）');
    ok(DS.atkOf(120) === 30 && DS.atkOf(41) === 11 && DS.atkOf(8) === 2 && DS.atkOf(0) === 1, '攻擊不是戰力／4 向上取整數');
    ok(DS.multOf(0) === 1 && DS.multOf(0.79) === 1 && DS.multOf(0.8) === 1.5 && DS.multOf(0.94) === 1.5 && DS.multOf(0.95) === 2 && DS.multOf(1) === 2,
       '力度分區不對（0～80% 1 倍、80～95% 1.5 倍、95% 以上 2 倍）');
    const d0 = DS.createDuel([100, 60], 'ring');
    ok(d0.row.join() === '1,1' && d0.hp.join() === '100,60' && d0.round === 1, '開局不是兩邊都在中間、滿血、第 1 回合');
    d0.row = [0, 2];
    ok(!DS.okMove(d0, 0, -1) && DS.okMove(d0, 0, 1) && DS.okMove(d0, 0, 0) && !DS.okMove(d0, 1, 1) && !DS.okMove(d0, 0, 2), '移動限制不對（在邊上只能不動或往中間）');
    const np = DS.normPick(d0, 0, { mv: -1, aim: 5, p: 3 });
    ok(np.mv === 0 && np.aim === 0 && np.p === 0, '不合法的選擇沒有換成預設（不動、打正前方、1 倍）：' + JSON.stringify(np));
    ok(DS.normPick(d0, 1, null).aim === 2, '沒選的時候預設不是打正前方');

    // 打中：A 猜中 B 移動後的位置，B 沒猜中
    let d = DS.createDuel([100, 60]);
    let L = DS.resolve(d, [{ mv: 0, aim: 0, p: 0 }, { mv: -1, aim: 2, p: 0 }]);
    ok(!L.clash && L.hit[1] && !L.hit[0] && d.hp[1] === 60 - 25 && d.hp[0] === 100, '猜中移動後的位置沒打中（或扣錯血）：' + d.hp);
    ok(L.from.join() === '1,1' && L.to.join() === '1,0' && d.row.join() === '1,0' && d.round === 2, '移動沒照選的走');
    // 兩邊都沒中
    L = DS.resolve(d, [{ mv: 0, aim: 2, p: 1 }, { mv: 0, aim: 0, p: 1 }]);
    ok(!L.clash && !L.hit[0] && !L.hit[1] && d.hp.join() === '100,35', '都沒猜中還扣血');
    // 對波：雙方都猜中（子彈走同一條線）→ 傷害高的贏，只有輸的被打
    d = DS.createDuel([100, 100]);
    L = DS.resolve(d, [{ mv: 1, aim: 2, p: 0.96 }, { mv: 1, aim: 2, p: 0.5 }]);
    ok(L.clash && L.cw === 0 && L.hit[1] && !L.hit[0] && d.hp[1] === 100 - 50 && d.hp[0] === 100, '對波：力度強的沒贏（或兩邊都扣血）：' + JSON.stringify(L));
    d = DS.createDuel([100, 100]);
    L = DS.resolve(d, [{ mv: -1, aim: 1, p: 0.85 }, { mv: 0, aim: 0, p: 0.9 }]);
    ok(L.clash && L.cw === -1 && !L.hit[0] && !L.hit[1] && d.hp.join() === '100,100', '對波一樣強：兩顆沒有一起消掉（不同列也是對波）');
    // 強的角色 1 倍也能贏弱角色的 1.5 倍（比的是實際傷害）
    d = DS.createDuel([200, 60]);
    L = DS.resolve(d, [{ mv: 0, aim: 1, p: 0 }, { mv: 0, aim: 1, p: 0.85 }]);
    ok(L.clash && L.cw === 0 && d.hp[1] === 10, '對波比的不是實際傷害（攻擊 × 倍率）');
    // 歸零 → 勝負；同一回合只有一方會扣血，所以不會同時歸零
    d = DS.createDuel([40, 40]); d.hp = [5, 40];
    DS.resolve(d, [{ mv: 0, aim: 0 }, { mv: 0, aim: 1, p: 0 }].map((p, i) => DS.normPick(d, i, p)));
    ok(d.winner === 1 && d.hp[0] === 0, '血歸零沒判輸');
    // 打滿 20 回合：比剩餘血量；一樣就平手
    d = DS.createDuel([50, 50]); d.round = DS.MAX_ROUNDS; d.hp = [30, 20];
    DS.resolve(d, [DS.normPick(d, 0, { aim: 0 }), DS.normPick(d, 1, { aim: 0 })]);
    ok(d.winner === 0, '打滿 20 回合沒有比剩餘血量');
    d = DS.createDuel([50, 50]); d.round = DS.MAX_ROUNDS;
    DS.resolve(d, [DS.normPick(d, 0, { aim: 0 }), DS.normPick(d, 1, { aim: 0 })]);
    ok(d.winner === -1, '打滿 20 回合血量一樣沒判平手');
    // dev 測試對戰的隨機對手：只選合法的
    d = DS.createDuel([50, 50]); d.row = [0, 2];
    let bad = 0;
    for (let i = 0; i < 300; i++) { const p = DS.randomPick(d, 1); if (!DS.okMove(d, 1, p.mv) || ![0, 1, 2].includes(p.aim) || !(p.p >= 0 && p.p <= 1)) bad++; }
    ok(bad === 0, '隨機對手選了不合法的（' + bad + ' 次）');
}

(async () => {
    console.log('— 伺服器 —');
    const T = { duelOpenMs: 60, duelPickMs: 500, duelAnimMs: 60, duelEndMs: 60 };
    const ps = S.createPlazaServer({ ...T, stairsLostMs: 200, graceMs: 3000, rand: () => 0.4 });
    await new Promise(r => ps.server.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + ps.server.address().port;
    const seen = { a: [], b: [], c: [] };
    const mk = (tag) => C.create({ url, retryMs: 2000, onStairs: (k, d) => seen[tag].push([k, d]) });
    const prof = (name, str, char = 'agumon') => ({ name, char, stage: 'Child', card: { power: str, train: 0, str } });
    const a = mk('a'), b = mk('b'), c = mk('c');
    const room = () => [...ps.rooms.values()][0];
    const duelOf = (cl) => (cl.stairsMine() || {}).duel;
    const start = async () => {
        await a.invite(b.me().id, 'duel');
        await until(() => b.incoming());
        ok(b.incoming().kind === 'duel', '收到的邀請不是手動戰鬥');
        ok((await b.answer(b.incoming().inviteId, true)).ok, '接受手動戰鬥失敗');
        await until(() => duelOf(a) && duelOf(b));
        await sleep(T.duelOpenMs + 20);
    };
    try {
        await a.join(prof('阿張', 100)); await b.join(prof('阿明', 60, 'gabumon')); await c.join(prof('阿丙', 30, 'palmon'));
        await until(() => a.me() && b.me() && c.me());

        // 原本的對戰邀請照舊（不帶種類 = 自動）
        await a.invite(b.me().id); await until(() => b.incoming());
        ok(b.incoming().kind === 'auto', '原本的對戰邀請被當成手動戰鬥');
        await b.answer(b.incoming().inviteId, false);
        await sleep(50);

        await start();
        const r = room();
        ok(r && r.kind === 'duel' && r.state === 'play' && r.ids.length === 2, '接受後沒有開手動戰鬥的房（或沒直接開打）');
        const d0 = duelOf(b);
        ok(d0.hp.join() === '100,60' && d0.max.join() === '100,60' && d0.row.join() === '1,1' && DS.BGS.includes(d0.bg), '開局資料不對：' + JSON.stringify(d0));
        ok(ps.members.get(a.me().id).battle && ps.members.get(b.me().id).battle, '手動戰鬥中兩隻沒有停在原地（頭上沒 ⚔）');
        ok(!(await c.invite(a.me().id)).ok, '手動戰鬥中還能被邀請');
        ok(!(await c.stairs('join', { room: r.id })).ok, '別人能加入手動戰鬥的房');

        // 選擇不公開：只看得到「選好了沒」
        ok((await a.stairs('dpick', { mv: 1, aim: 0, p: 0 })).ok, '選擇送不出去');
        ok(!(await a.stairs('dpick', { mv: 0, aim: 1, p: 0 })).ok, '一回合可以選兩次');
        ok(await until(() => duelOf(b) && duelOf(b).picked[0] === true), '對手看不到「已選好」');
        ok(!('picks' in duelOf(b)) && JSON.stringify(duelOf(b)).indexOf('"mv"') < 0, '選擇內容在結算前就公開了');
        ok(!(await b.stairs('dpick', { mv: 2 })).ok && !(await b.stairs('dpick', { aim: 3 })).ok && !(await b.stairs('dpick', { p: 1.5 })).ok,
           '不合法的選擇也收');
        ok(!(await c.stairs('dpick', { mv: 0 })).ok, '不在對戰裡的人也能選');
        // 兩邊都選好 → 馬上結算：A 往下打 0 列、B 往上移到 0 列 → A 打中 B（25）
        ok((await b.stairs('dpick', { mv: -1, aim: 2, p: 0 })).ok, '第二個人選不了');
        ok(await until(() => seen.a.some(([k, d]) => k === 'duel' && d.last && d.last.round === 1)), '結算沒有推 duel:round');
        const L1 = seen.a.find(([k]) => k === 'duel')[1].last;
        ok(L1.to.join() === '2,0' && L1.hit[1] && !L1.hit[0] && L1.hp.join() === '100,35', '第 1 回合結果不對：' + JSON.stringify(L1));
        ok(await until(() => duelOf(b).round === 2 && duelOf(b).hp[1] === 35), '房間資料沒跟上結算');
        // 演出中不收
        ok(!(await a.stairs('dpick', { mv: 0 })).ok, '演出中還能選');
        // 時限到：沒選的用預設（不動、打正前方、1 倍）。A 只選了移動
        await sleep(T.duelAnimMs + 20);
        ok((await a.stairs('dpick', { mv: -1 })).ok, '只選一部分送不出去');
        ok(await until(() => seen.a.some(([k, d]) => k === 'duel' && d.last && d.last.round === 2), 2000), '時限到沒有自動結算');
        const L2 = seen.a.filter(([k]) => k === 'duel')[1][1].last;
        ok(L2.to.join() === '1,0' && L2.aim.join() === '1,0' && L2.mult.join() === '1,1', '時限到的預設不對：' + JSON.stringify(L2));
        // B 打正前方（0 列），A 在 1 列 → 沒中；A 打正前方（1 列），B 在 0 列 → 沒中
        ok(!L2.hit[0] && !L2.hit[1], '預設的結果不對');

        // 認輸 → 對手贏、結算、解散房間、兩隻恢復走路
        ok((await b.stairs('dresign')).ok, '認輸失敗');
        ok(await until(() => !room()), '認輸後房間沒解散');
        await until(() => b.stairsEnd() && a.stairsEnd());
        const end = b.stairsEnd();
        ok(end && end.kind === 'duel' && end.result.find(x => x.id === a.me().id).rank === 1 && end.result.find(x => x.id === b.me().id).why === 'resign',
           '認輸的結果不對：' + JSON.stringify(end && end.result));
        ok(!ps.members.get(a.me().id).battle && !ps.members.get(b.me().id).battle, '打完沒有解除原地不動');

        // 打到有人歸零 → 結算（A 每回合都打中 B；B 60 血、A 打一下 25×2）
        await start();
        for (let k = 0; k < 3 && room(); k++) {
            const d = room().duel; if (!d || d.winner != null) break;
            await a.stairs('dpick', { mv: 0, aim: d.row[1], p: 1 });
            await b.stairs('dpick', { mv: 0, aim: (d.row[0] + 1) % 3, p: 0 });   // B 故意打不中
            await sleep(T.duelAnimMs + 30);
        }
        ok(await until(() => !room()), '有人歸零沒有結算');
        await until(() => a.stairsEnd());
        const e2 = a.stairsEnd();
        ok(e2 && e2.result.find(x => x.id === a.me().id).rank === 1 && e2.result.find(x => x.id === b.me().id).hp === 0, '歸零的勝負不對：' + JSON.stringify(e2 && e2.result));

        // 中途離開 → 留下來的贏
        await start();
        await b.stairs('leave');
        ok(await until(() => !room()), '有人離開沒結束');
        await until(() => a.stairsEnd());
        ok(a.stairsEnd().result.find(x => x.id === a.me().id).rank === 1, '離開的人沒判輸');

        // 斷線太久 → 對手贏
        await start();
        const mb = ps.members.get(b.me().id); mb.stream = null; mb.lostAt = Date.now() - 1000;   // 伺服器那邊當作 b 斷線一陣子了
        ok(await until(() => !room(), 3000), '斷線太久沒結束');
        await until(() => a.stairsEnd());
        ok(a.stairsEnd() && a.stairsEnd().result.find(x => x.id === b.me().id).why === 'lost', '斷線的人沒判輸');
    } catch (e) { fail++; console.log('  ✗ 例外：' + (e && e.stack)); }
    finally {
        for (const x of [a, b, c]) { try { await x.leave(); } catch (e) {} }
        await ps.close();
    }
    console.log(`\n結果：${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
