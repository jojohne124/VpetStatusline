#!/usr/bin/env node
'use strict';
/**
 * 驗證廣場的連線部分（docs/plaza-spec.md 第二版、第 1 期）：
 *   1. 進場路線：從畫面外的某一邊走進來，走完剛好接回場內的一般走路
 *   2. 伺服器 + daemon 端：進場、離場、名單同步、人滿、同名取代、斷線清理、重連、
 *      主機關掉 → 回前線、連不上 → 給人看得懂的原因
 *
 * 伺服器與 client 都在這個行程裡起（port 0 = 隨機），不碰真的主機。
 *
 * 用法：node scripts/test-plaza-net.js
 */
const W  = require('../src/shared/plaza-walk.js');
const S  = require('../src/daemon/plaza-server.js');
const C  = require('../src/daemon/plaza-client.js');
const P  = require('../src/daemon/plaza.js');
const os = require('os'), path = require('path');
let core = null;
try { core = require(path.join(os.homedir(), '.claude', 'agumon-statusline', 'agumon-core.js')); } catch (e) {}
const hasArt = (() => { try { return !!P.loadArt(core, 'agumon'); } catch (e) { return false; } })();

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(cond, ms = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(20); }
    return cond();
}

// ── 1. 進場路線 ─────────────────────────────────────────────────────
console.log('— 進場路線 —');
{
    const F = W.PLAZA_LIVE_FIELD, SP = W.SPRITE;   // 廣場的場地
    const edges = [0, 0, 0, 0];
    let notHidden = 0, anchorOut = 0, notArrived = 0, backwards = 0, leftField = 0, tooShort = 0;
    for (let seed = 1; seed <= 400; seed++) {
        const e = W.entryWalk(seed * 7919, F);
        edges[e.edge]++;
        const o = e.origin, a = e.anchor;
        // 起點要**完全**在畫面外（一點身體都看不到），不然看起來是「憑空出現在邊上」
        const hidden = o.x + SP <= 0 || o.x >= F.w || o.y + SP <= 0 || o.y >= F.h;
        if (!hidden) notHidden++;
        if (!W.inZone(a, F)) anchorOut++;
        const occ = { seed: seed * 7919, joinStep: 1000, origin: o, anchor: a };
        const len = W.returnLeg(o, a).len;
        if (len < SP) tooShort++;
        // 進場那一段：每一步都離定位點更近（不會先往外走、不會原地踏步）
        let prevD = Infinity;
        for (let t = 0; t <= len; t++) {
            const p = W.posAt(occ, 1000 + t, null, F);
            const d = Math.abs(p.x - a.x) + Math.abs(p.y - a.y);
            if (d >= prevD) backwards++;
            prevD = d;
        }
        const end = W.posAt(occ, 1000 + len, null, F);
        if (end.x !== a.x || end.y !== a.y) notArrived++;
        // 進場之後就是一般的走路，不能再跑出場外
        let cache = null;
        for (let t = len; t <= len + 600; t++) {
            const p = W.posAt(occ, 1000 + t, cache, F); cache = p.cache;
            if (!W.inZone(p, F)) { leftField++; break; }
        }
    }
    ok(notHidden === 0, `進場起點有 ${notHidden} 個露在畫面裡`);
    ok(anchorOut === 0, `定位點有 ${anchorOut} 個在場外`);
    ok(tooShort === 0, `進場那段有 ${tooShort} 個短於一隻角色（等於瞬間出現）`);
    ok(backwards === 0, `進場時有 ${backwards} 步沒有往場內走`);
    ok(notArrived === 0, `進場走完沒停在定位點：${notArrived} 個`);
    ok(leftField === 0, `進場之後又走出場外：${leftField} 個`);
    ok(edges.every(n => n > 40), '四個邊沒有都用到：' + edges.join('/'));
    // 決定性：同一個 seed 每次算都一樣（每個 client 才會看到同一條進場路線）
    ok(JSON.stringify(W.entryWalk(42, F)) === JSON.stringify(W.entryWalk(42, F)), '同一個 seed 的進場路線不一樣');
    // 在畫面上也要完全看不到：畫布是細格（倍率 > 1），走路座標在外面，畫出來一定也在外面
    const R = P.PLAZA_RENDER;
    let shown = 0;
    for (let seed = 1; seed <= 400; seed++) {
        const o = W.entryWalk(seed * 7919, F).origin, d = P.plazaToDraw(o.x, o.y);
        if (!(d.x + SP <= 0 || d.x >= R.w || d.y + SP <= 0 || d.y >= R.h)) shown++;
    }
    ok(shown === 0, `進場起點畫出來有 ${shown} 個露在畫布裡`);
}

// ── 1b. 廣場畫面比照營地 ─────────────────────────────────────────────
console.log('— 廣場畫面 —');
{
    const R = P.PLAZA_RENDER, Y = P.YARD_RENDER;
    ok(R.w === Y.w && R.h === Y.h, `廣場畫布 ${R.w}x${R.h} 跟營地 ${Y.w}x${Y.h} 不一樣大`);
    ok(P.PLAZA_LIVE_FIELD === W.PLAZA_LIVE_FIELD, 'daemon 跟伺服器用的廣場場地不是同一塊');
    // 步伐：一拍最多移動 1 個畫面細格（營地那套粗格放大，一步會跳 2 細格 —— 回報過「步伐很大」）
    {
        const F = W.PLAZA_LIVE_FIELD;
        let big = 0, cache = null, prev = null;
        for (let t = 0; t < 3000; t++) {
            const p = W.posAt({ seed: 99, joinStep: 0 }, t, cache, F); cache = p.cache;
            const d = P.plazaToDraw(p.x, p.y);
            if (prev && (Math.abs(d.x - prev.x) > 1 || Math.abs(d.y - prev.y) > 1)) big++;
            prev = d;
        }
        ok(big === 0, `廣場一拍跳超過 1 細格的有 ${big} 次`);
    }
    // 走到最右下，身體剛好貼到畫布右緣、腳下還留一列給名牌
    const F = W.PLAZA_LIVE_FIELD, d = P.plazaToDraw(F.maxX, F.maxY);
    ok(d.x + W.SPRITE === R.w, `走到最右邊沒貼到畫布右緣（${d.x + W.SPRITE} vs ${R.w}）`);
    ok(d.y + W.SPRITE + W.LABEL_RESERVE === R.h, `最下排腳下沒留名牌列（${d.y + W.SPRITE} + ${W.LABEL_RESERVE} vs ${R.h}）`);
    if (core && hasArt) {
        // 兩個人：一個站在最下排、一個在最上排。原住民不出現，兩個名牌都看得到
        const occ = [
            { key: 'a', code: 'AA', char: 'agumon', seed: 1, joinStep: 0, origin: { x: 5, y: F.maxY, facing: 'left' } },
            { key: 'b', code: 'BB', char: 'agumon', seed: 2, joinStep: 0, origin: { x: 30, y: 0, facing: 'left' } },
        ];
        occ[1].color = '#ff0000';
        const out = P.composePlazaLive(core, occ, 0, { me: 'AA' });
        // 自選顏色畫在名牌上；沒選的照舊（自己亮黃）
        const tag = (c) => (out.tags || []).find(t => t.text === c);
        ok(tag('BB') && tag('BB').color === '#ff0000', 'BB 選了紅色，名牌卻不是紅的');
        // 沒選顏色：不管是不是自己，大家看到的都是同一個預設色（不能「自己看是黃的、別人看是白的」）
        ok(tag('AA') && tag('AA').color === P.NAME_DEFAULT_COLOR, '沒選顏色的自己不是預設色：' + (tag('AA') || {}).color);
        const other = P.composePlazaLive(core, occ, 0, { me: 'BB' }).tags.find(t => t.text === 'AA');
        ok(other && other.color === tag('AA').color, '同一個人的名牌，自己看跟別人看顏色不一樣');
        // 名牌由前端用真的字型畫：格子裡不能再塞字（塞進 6px 的格子就是細長條、黏在一起）
        ok(!/[AB]/.test(out.lines.join('').replace(/\[[0-9;]*m/g, '')), '名牌還是被塞進格子裡');
        // 位置：角色中心、腳底（畫出來的座標）
        const pa = out.placed.find(p => p.code === 'AA');
        ok(tag('AA') && tag('AA').x === pa.gx + W.SPRITE / 2 && tag('AA').y === pa.gy + W.SPRITE,
           '名牌位置不是腳下置中：' + JSON.stringify(tag('AA')));
        // 被前排整個擋住的名牌不畫（遮擋規則跟以前一樣）
        const hide = P.composePlazaLive(core, [
            { key: 'a', code: 'AA', char: 'agumon', seed: 1, joinStep: 0, origin: { x: 10, y: 5, facing: 'left' } },
            { key: 'b', code: 'BB', char: 'agumon', seed: 2, joinStep: 0, origin: { x: 10, y: 9, facing: 'left' } },
        ], 0, {});
        ok(!hide.tags.some(t => t.text === 'AA'), '被前排擋住的名牌還是畫出來了');
        // 部分重疊：後排 AA 的名牌還在，但前排 BB 的身體蓋住的 dot，owner 記的是 BB（z 較大）——
        // 前端靠這個把 AA 名牌被蓋住的那段挖掉
        const part = P.composePlazaLive(core, [
            { key: 'a', code: 'AA', char: 'agumon', seed: 1, joinStep: 0, origin: { x: 10, y: 10, facing: 'left' } },
            { key: 'b', code: 'BB', char: 'agumon', seed: 2, joinStep: 0, origin: { x: 18, y: 14, facing: 'left' } },
        ], 0, {});
        const ta = part.tags.find(t => t.text === 'AA'), tb = part.tags.find(t => t.text === 'BB');
        ok(ta && tb && tb.z > ta.z, '前排（y 大）的 z 沒有比較大');
        const footRow = part.owner[ta.y] || [];
        ok(footRow.some((z, x) => z === tb.z && Math.abs(x - ta.x) < 10),
           'AA 名牌那一列，owner 沒記到 BB 的身體（前端挖不掉被擋的部分）');
        ok(out.lines.length === R.h / 2, `廣場列數 ${out.lines.length}，應為 ${R.h / 2}`);
        ok(out.placed.length === 2, `場上應該只有 2 隻（原住民要藏起來），實際 ${out.placed.length}`);
        const codes = new Set([...out.labels.values()].flat().map(l => l.code));
        ok(codes.has('AA') && codes.has('BB'), '有人的名牌沒畫出來：' + [...codes].join(','));
        const lastRow = Math.max(...out.labels.keys());
        ok(lastRow === R.h / 2 - 1, `最下排的名牌不在最後一列（${lastRow}）—— 名牌是用走路座標排的？`);
    } else {
        console.log('  ⚠ 沒有安裝版美術，合成那幾條跳過');
    }
}

// ── 1c. 手動模式（WASD）的位置公式 ──────────────────────────────────
console.log('— 手動模式 —');
{
    const F = W.PLAZA_LIVE_FIELD;
    // 一拍一動、對齊全域拍點：拍點之間按下，下一個拍點才動第一步
    const S = W.STEP_MS, at = 1000 * S + 100;
    const w = { mode: 'manual', x: 20, y: 20, vx: 1, vy: 0, facing: 'right', at };
    ok(W.walkPos(w, at).x === 20, '手動模式按下的那一刻就移動了');
    ok(W.walkPos(w, 1001 * S - 1).x === 20, '還沒到下一個拍點就動了（沒跟拍子同步）');
    ok(W.MANUAL_STRIDE === 2, `手動一拍的步伐不是 2 格（${W.MANUAL_STRIDE}）`);
    ok(W.walkPos(w, 1001 * S).x === 20 + W.MANUAL_STRIDE, '到了下一個拍點沒有走一步');
    ok(W.walkPos(w, 1005 * S + 10).x === 20 + 5 * W.MANUAL_STRIDE, `五拍應該走 ${5 * W.MANUAL_STRIDE} 格，走了 ${W.walkPos(w, 1005 * S + 10).x - 20}`);
    const far = W.walkPos(w, at + 600000);
    ok(far.x === F.maxX && far.y === 20, '一直往右走沒有停在右牆：' + JSON.stringify(far));
    ok(!far.moving, '貼牆之後還算在走（腳會一直踏）');
    const diag = W.walkPos({ ...w, vx: -1, vy: -1 }, at + 600000);
    ok(diag.x === F.minX && diag.y === F.minY, '往左上一直走沒有停在角落');
    // 停著不動太久才睡；在走的不會睡
    const stop = { ...w, vx: 0, vy: 0 };
    ok(!W.walkPos(stop, at + W.MANUAL_SLEEP_MS - 1).sleeping, '還沒到時間就睡了');
    ok(W.walkPos(stop, at + W.MANUAL_SLEEP_MS).sleeping, '停著不動太久沒有睡著');
    ok(!W.walkPos(w, at + W.MANUAL_SLEEP_MS * 3).sleeping, '一直按著方向鍵（貼牆）也睡著了');
    if (core && hasArt) {
        const out = P.composePlazaLive(core, [{ key: 's', code: 'ZZ', char: 'agumon', walk: stop }], 7,
                                       { nowMs: at + W.MANUAL_SLEEP_MS + 5 });
        ok(out.placed[0].sleeping && /^SLEEP_/.test(out.placed[0].react || ''), '睡著了卻沒換成睡覺幀');
        ok(out.tags[0] && out.tags[0].sleeping, '睡著了名牌資料沒帶 sleeping（頭上不會冒 z）');
    }
}

// ── 2. 伺服器 + client ──────────────────────────────────────────────
async function main() {
    console.log('— 伺服器與 daemon 端 —');
    const plaza = S.createPlazaServer({ cap: 3, graceMs: 300, pingMs: 200 });
    await new Promise(r => plaza.server.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + plaza.server.address().port;
    const lost = {};
    const mk = (tag, retryMs = 600) => C.create({ url, retryMs, onLost: (why) => { lost[tag] = why; } });
    const prof = (name, char = 'agumon') => ({ name, char, stage: 'Child', card: { power: 10, train: 3 } });

    const a = mk('a'), b = mk('b');
    const ra = await a.join(prof('阿張'));
    ok(ra.ok, '進場失敗：' + ra.error);
    ok(a.active(), '進場成功但 active() 是 false');
    const rb = await b.join(prof('阿明', 'gabumon'));
    ok(rb.ok, '第二個人進場失敗：' + rb.error);
    // 先進場的要透過推播看到後進場的
    ok(await until(() => a.roster().length === 2), `先進場的沒收到後進場的人（${a.roster().length} 人）`);
    ok(b.roster().length === 2, '後進場的名單裡沒有先進場的');
    // **兩邊看到的走路資料要一模一樣**：位置是各自算的，輸入不同畫面就分歧
    const key = (c) => JSON.stringify(c.roster().map(m => [m.id, m.walk]).sort());
    ok(key(a) === key(b), '兩個 client 拿到的走路資料不一樣');
    const stepA = a.step(), stepB = b.step();
    ok(Math.abs(stepA - stepB) <= 1, `兩個 client 的拍子差太多（${stepA} vs ${stepB}）`);
    // 新進場的人起點在畫面外（從邊界走進來），不是直接出現在場內
    const meB = b.roster().find(m => m.name === '阿明');
    const o = meB.walk.origin;
    const YF = W.PLAZA_LIVE_FIELD;
    ok(o && (o.x + W.SPRITE <= 0 || o.x >= YF.w || o.y + W.SPRITE <= 0 || o.y >= YF.h),
       '新進場的人不是從畫面外走進來：' + JSON.stringify(o));
    // 而且是營地那塊場地的進場路線（第一版是 96x48；只看「在畫面外」的話，96 也算在 52 外面）
    const exp = W.entryWalk(meB.walk.seed, YF);
    ok(JSON.stringify([meB.walk.origin, meB.walk.anchor]) === JSON.stringify([exp.origin, exp.anchor]),
       '伺服器發的進場路線不是用營地場地算的：' + JSON.stringify(meB.walk));

    // 回應要宣告 UTF-8：沒宣告的話 PowerShell 5.1（右下角 tray 的在場名單）會用 Latin-1 解，中文變亂碼
    const ct = await new Promise((res) => require('http').get(url + '/roster', (r) => { r.resume(); res(r.headers['content-type'] || ''); }));
    ok(/charset=utf-8/i.test(ct), '名單回應沒有宣告 charset=utf-8（tray 的中文會亂碼）：' + ct);

    // 輸入檢查（伺服器不信任 client）
    const bad = mk('bad');
    const r1 = await bad.join({ name: '有 空白', char: 'agumon', stage: 'Child' });
    ok(!r1.ok && /名牌/.test(r1.error), '名牌含空白應該被拒：' + JSON.stringify(r1));
    const r2 = await bad.join({ name: 'X', char: '../etc', stage: 'Child' });
    ok(!r2.ok, '角色 id 含路徑應該被拒');
    ok(!bad.active(), '被拒絕之後不該是 active');

    // 人滿（cap 3）：第 4 個進不來，而且要講出原因
    const c = mk('c'), d = mk('d');
    ok((await c.join(prof('C1'))).ok, '第三個人應該進得來');
    const rd = await d.join(prof('D1'));
    ok(!rd.ok && /人太多/.test(rd.error), '人滿時要拒絕並說明：' + JSON.stringify(rd));

    // 離場：其他人要收到
    await c.leave();
    ok(!c.active(), 'leave 之後還是 active');
    ok(await until(() => a.roster().length === 2), '有人離場，別人的名單沒更新');

    // 同名：後進的取代先進的，先進的被告知（回前線），而不是以為斷線一直重連
    const a2 = mk('a2');
    ok((await a2.join(prof('阿張', 'veemon'))).ok, '同名的第二個人應該進得來');
    ok(await until(() => lost.a !== undefined), '同名取代時，先進場的沒被通知');
    ok(/別處/.test(lost.a || ''), '同名取代的原因不對：' + lost.a);
    ok(!a.active(), '被取代的那個還是 active');
    ok(await until(() => b.roster().filter(m => m.name === '阿張').length === 1), '同名的出現兩個');

    // 場上改名：別人即時看到；撞名要拒絕（不能把對方踢掉）
    const rn = await b.rename('小明');
    ok(rn.ok, '改名失敗：' + rn.error);
    ok(b.me().name === '小明', '改名後自己的名字沒變');
    ok(await until(() => a2.roster().some(m => m.name === '小明')), '改名之後別人沒看到新名字');
    const dup = await b.rename('阿張');
    ok(!dup.ok && /已經有人/.test(dup.error || ''), '改成別人的名字應該被拒：' + JSON.stringify(dup));
    ok(a2.active() && lost.a2 === undefined, '撞名改名把原本那個人踢掉了');
    // 只差大小寫也算撞名（Kai 跟 KAI 在廣場上看起來是同一個人）
    ok((await a2.rename('Kai')).ok, 'a2 改名失敗');
    const caseDup = await b.rename('KAI');
    ok(!caseDup.ok, '只差大小寫的名牌應該算撞名');
    await a2.rename('阿張');
    const badn = await b.rename('有 空白');
    ok(!badn.ok, '不合法的名牌應該被拒');
    ok(b.me().name === '小明', '改名被拒之後名字還是被改掉了');
    // 名牌顏色：別人即時看到；格式不對要拒
    const col = await b.update({ color: '#33CCff' });
    ok(col.ok, '改顏色失敗：' + col.error);
    ok(await until(() => (a2.roster().find(m => m.id === b.me().id) || {}).color === '#33ccff'), '改了顏色別人沒看到');
    const badc = await b.update({ color: 'red;' });
    ok(!badc.ok, '不合法的顏色應該被拒');
    await b.rename('阿明');

    // 自動／手動：伺服器用「當下算出來的位置」當起點，別人收到同一份
    const before = W.walkPos(b.roster().find(m => m.id === b.me().id).walk, Date.now() + b.skew(), null, W.PLAZA_LIVE_FIELD);
    const nm = await b.move({ vx: 1, vy: 0 });
    ok(!nm.ok, '自動模式下按方向鍵應該被拒（要先切手動）');
    const mm = await b.move({ mode: 'manual' });
    ok(mm.ok && mm.walk.mode === 'manual' && mm.walk.vx === 0 && mm.walk.vy === 0, '切手動失敗：' + JSON.stringify(mm));
    ok(Math.abs(mm.walk.x - before.x) <= 1 && Math.abs(mm.walk.y - before.y) <= 1,
       `切手動時位置跳了（${before.x},${before.y} → ${mm.walk.x},${mm.walk.y}）`);
    ok(await until(() => (a2.roster().find(m => m.id === b.me().id) || {}).walk.mode === 'manual'), '別人沒收到切手動');
    // 往有空間的那一邊走（起點是隨機的，可能剛好貼在右牆上 —— 踩過，偶爾紅）
    const gx = mm.walk.x < W.PLAZA_LIVE_FIELD.maxX / 2 ? 1 : -1;
    const go = await b.move({ vx: gx, vy: 0 });
    ok(go.ok && go.walk.vx === gx && go.walk.facing === (gx > 0 ? 'right' : 'left'), '手動移動失敗：' + JSON.stringify(go));
    ok((await b.move({ vx: 2, vy: 0 })).ok === false, '不合法的方向應該被拒');
    await sleep(W.STEP_MS * 2 + 100);   // 至少跨過一個拍點
    const st = await b.move({ vx: 0, vy: 0 });
    ok((st.walk.x - go.walk.x) * gx > 0, `走了兩拍，位置卻沒變（${go.walk.x} → ${st.walk.x}）`);
    ok(await until(() => { const m = a2.roster().find(x => x.id === b.me().id); return m && m.walk.at === st.walk.at; }),
       '別人收到的手動起點跟本人不一樣（畫面會分歧）');
    const au = await b.move({ mode: 'auto' });
    ok(au.ok && !au.walk.mode && au.walk.origin && au.walk.origin.x === st.walk.x && au.walk.origin.y === st.walk.y,
       '切回自動沒有從停下的地方接著走：' + JSON.stringify(au));

    // ── 聊天 ──
    {
        const t0 = plaza.chat.length;
        const r = await b.say('  大家好   ');
        ok(r.ok, '發言失敗：' + r.error);
        ok(await until(() => a2.chat().some(m => m.text === '大家好' && m.name === b.me().name)),
           '別人沒收到發言（或空白沒收乾淨）');
        ok(await until(() => b.chat().some(m => m.text === '大家好')), '自己的發言沒有回到自己的聊天紀錄');
        const fast = await b.say('再一句');
        ok(!fast.ok && /太快/.test(fast.error || ''), '一秒內連發第二則應該被擋：' + JSON.stringify(fast));
        await sleep(S.CHAT_GAP_MS + 50);
        const long = await b.say('字'.repeat(S.CHAT_MAX + 1));
        ok(!long.ok && /最多/.test(long.error || ''), '超過字數上限應該被擋');
        ok((await b.say('字'.repeat(S.CHAT_MAX))).ok, '剛好字數上限應該可以送');
        ok(!(await b.say('   ')).ok, '空白訊息應該被擋');
        void t0;
        // 系統訊息：有人進場／離場／改名，聊天裡會說
        const e = mk('e');
        ok((await e.join(prof('路人'))).ok, '路人進不來');
        // 進場的回應就要帶舊聊天（馬上看得到），不能只靠之後串流的 hello 補 ——
        // 這裡緊接著 join 檢查，那時串流還沒連上
        const hist = e.chat();
        ok(await until(() => a2.chat().some(m => m.sys && /路人 進入廣場/.test(m.text))), '有人進場，聊天裡沒說');
        // 後進場的人拿得到之前的聊天（最近 CHAT_KEEP 則）
        ok(hist.some(m => m.text === '大家好'), '新進場的人看不到之前的聊天（進場回應沒帶）');
        await e.rename('路人甲');
        ok(await until(() => a2.chat().some(m => m.sys && /路人 改名為 路人甲/.test(m.text))), '改名沒有系統訊息');
        await e.leave();
        ok(await until(() => a2.chat().some(m => m.sys && /路人甲 離開了/.test(m.text))), '有人離場，聊天裡沒說');
        // 只留最近 CHAT_KEEP 則
        for (let i = 0; i < S.CHAT_KEEP + 5; i++) { plaza.members.get(b.me().id).chatAt = 0; await b.say('洗版' + i); }
        ok(plaza.chat.length === S.CHAT_KEEP, `伺服器留了 ${plaza.chat.length} 則，應該只留 ${S.CHAT_KEEP}`);
        ok(await until(() => a2.chat().length === S.CHAT_KEEP && a2.chat().at(-1).text === '洗版' + (S.CHAT_KEEP + 4)),
           `client 的聊天紀錄沒跟上或沒有截在 ${S.CHAT_KEEP} 則（${a2.chat().length}）`);
    }

    // 網路抖一下（串流斷掉）→ 自動重連，人還在場上
    b._dropStream();
    await sleep(400);
    ok(b.active() && lost.b === undefined, '短暫斷線就被踢回前線了（應該要重連）');
    ok(plaza.roster().some(m => m.name === '阿明'), '短暫斷線後，伺服器把人清掉了');
    ok(await until(() => b.roster().length === 2), '重連後名單不完整');

    // join 了卻沒接上串流（daemon 當場死掉）→ graceMs 後伺服器自己清掉，不留幽靈
    const ghost = await new Promise((res) => {
        const http = require('http');
        const body = JSON.stringify(prof('幽靈'));
        const req = http.request(url + '/join', { method: 'POST', headers: { 'Content-Type': 'application/json' } },
            (r) => { let s = ''; r.on('data', x => s += x); r.on('end', () => res(JSON.parse(s))); });
        req.end(body);
    });
    ok(ghost.ok, '直接打 /join 應該成功');
    ok(await until(() => !plaza.roster().some(m => m.name === '幽靈'), 2000), '沒接串流的人沒被清掉（幽靈殘留）');
    ok(await until(() => !b.roster().some(m => m.name === '幽靈')), '幽靈被清掉了，別人卻沒收到離場');

    // 主機關掉 → 重試 retryMs 後回前線，原因要看得懂
    await plaza.close();
    ok(await until(() => lost.b !== undefined, 3000), '主機關掉之後 client 沒有回前線');
    ok(/中斷|移出/.test(lost.b || ''), '主機關掉的原因不對：' + lost.b);
    ok(!b.active(), '主機關掉之後還是 active');

    // 主機沒開 → 進場失敗，原因是給人看的那句
    const e = C.create({ url, retryMs: 300 });
    const re = await e.join(prof('E1'));
    ok(!re.ok && re.error === C.UNREACHABLE, '主機沒開時的錯誤訊息不對：' + JSON.stringify(re));

    await battleTests();

    console.log(`\n結果：${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}

// ── 3. 對戰（規格 §八）──────────────────────────────────────────────
// 自己一台伺服器：邀請 300ms 逾時、對戰 500ms 結束，骰子固定（dice 可換）
async function battleTests() {
    console.log('— 對戰 —');
    let dice = 0;
    const ps = S.createPlazaServer({ inviteMs: 300, battleMs: 500, rand: () => dice });
    await new Promise(r => ps.server.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + ps.server.address().port;
    const got = {};   // tag -> { battles:[], closed:[] }
    const mk = (tag) => {
        got[tag] = { battles: [], closed: [] };
        return C.create({ url, retryMs: 600,
            onBattle: (b) => got[tag].battles.push(b), onInviteClose: (c) => got[tag].closed.push(c) });
    };
    const prof = (name, str) => ({ name, char: 'agumon', stage: 'Child', card: { power: 10, train: 0, str } });
    const A = mk('A'), B = mk('B'), Cc = mk('C');
    await A.join(prof('甲', 50)); await B.join(prof('乙', 50)); await Cc.join(prof('丙', 50));
    await until(() => A.roster().length === 3 && B.roster().length === 3 && Cc.roster().length === 3);
    const id = (c) => c.me().id;

    ok(!(await A.invite(id(A))).ok, '可以邀請自己');
    ok(!(await A.invite('nobody')).ok, '可以邀請不在場的人');

    // 拒絕
    const i1 = await A.invite(id(B));
    ok(i1.ok && A.outgoing() && A.outgoing().toName === '乙', '邀請失敗或發起方沒記住：' + JSON.stringify(i1));
    ok(await until(() => B.incoming() && B.incoming().fromName === '甲'), '對方沒收到邀請');
    ok(!(await Cc.invite(id(B))).ok, '對方已經有邀請，還能再邀他');
    ok(!(await A.invite(id(Cc))).ok, '自己已經有一個邀請，還能再邀別人');
    ok((await B.answer(B.incoming().inviteId, false)).ok, '拒絕失敗');
    ok(await until(() => got.A.closed.some(c => c.mine && c.reason === 'declined')), '發起方沒收到「被拒絕」');
    ok(!A.outgoing() && !B.incoming(), '拒絕之後邀請沒清掉');
    ok(await until(() => Cc.chat().some(m => m.sys && /乙 拒絕了 甲/.test(m.text))), '拒絕沒有系統訊息');

    // 逾時
    await A.invite(id(B));
    ok(await until(() => got.A.closed.some(c => c.reason === 'timeout'), 2000), '邀請沒有逾時');
    ok(!B.incoming(), '逾時之後被邀請的那邊還掛著邀請');

    // 邀請中對方離場
    const D = mk('D'); await D.join(prof('丁', 50));
    await until(() => A.roster().length === 4);
    await A.invite(id(D)); await D.leave();
    ok(await until(() => got.A.closed.some(c => c.reason === 'left')), '對方離場，邀請沒有作廢');

    // 接受 → 開打：勝負由伺服器擲，兩邊收到同一個結果；旁觀者不開演
    await B.move({ mode: 'manual' });       // 乙用手動，打完要回到手動
    dice = 0;                               // 戰力相同 → 甲勝率 50%，骰 0 → 甲贏
    await A.invite(id(B));
    await until(() => B.incoming());
    ok((await B.answer(B.incoming().inviteId, true)).ok, '接受失敗');
    ok(await until(() => got.A.battles.length === 1 && got.B.battles.length === 1), '雙方沒有都收到開打');
    ok(got.A.battles[0].win === true && got.B.battles[0].win === false, '勝負不一致（應該甲贏、乙輸）');
    ok(got.A.battles[0].opp.name === '乙' && got.B.battles[0].opp.name === '甲', '對手資料不對');
    ok(got.C.battles.length === 0, '旁觀的人也開演了');
    ok(await until(() => { const m = Cc.roster().find(x => x.id === id(A)); return m && m.battle; }), '旁觀的人不知道甲在對戰（不會有 ⚔）');
    const fa = Cc.roster().find(x => x.id === id(A)).walk;
    ok(fa.mode === 'manual' && fa.vx === 0 && fa.vy === 0, '對戰中沒有停在原地');
    ok(!(await B.move({ vx: 1, vy: 0 })).ok, '對戰中還能移動');
    ok(await until(() => Cc.chat().some(m => m.sys && /甲 對 乙 開打/.test(m.text))), '開打沒有系統訊息');
    // 打完：恢復原本的模式（甲自動、乙手動），旁觀者看到 ⚔ 消失，聊天說誰贏
    ok(await until(() => { const m = Cc.roster().find(x => x.id === id(A)); return m && !m.battle; }, 2000), '對戰沒有結束');
    const ma = Cc.roster().find(x => x.id === id(A)), mb = Cc.roster().find(x => x.id === id(B));
    ok(ma.mode === 'auto' && ma.walk.mode !== 'manual', '甲打完沒有回到自動散步');
    ok(mb.mode === 'manual' && mb.walk.mode === 'manual', '乙打完沒有回到手動');
    ok(await until(() => Cc.chat().some(m => m.sys && /甲 贏了/.test(m.text))), '沒有宣布誰贏');

    // 勝率：戰力差 40 → 甲 90%。骰 0.85 甲贏、0.95 乙贏（夾在 5~95%）
    const E = mk('E'), F2 = mk('F');
    await E.join(prof('戊', 90)); await F2.join(prof('己', 50));
    await until(() => E.roster().length >= 5 && F2.roster().length >= 5);
    for (const [d, eWins] of [[0.85, true], [0.95, false]]) {
        dice = d;
        await E.invite(id(F2)); await until(() => F2.incoming());
        await F2.answer(F2.incoming().inviteId, true);
        await until(() => got.E.battles.length && got.E.battles.at(-1).at && got.E.battles.length === (eWins ? 1 : 2));
        ok(got.E.battles.at(-1).win === eWins, `戰力 90 對 50、骰 ${d}：戊應該${eWins ? '贏' : '輸'}`);
        await until(() => { const m = E.roster().find(x => x.id === id(E)); return m && !m.battle; }, 2000);
    }
    await ps.close();
}
main().catch((e) => { console.log('  ✗ 例外：' + e.stack); process.exit(1); });
