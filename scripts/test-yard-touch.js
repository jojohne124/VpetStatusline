#!/usr/bin/env node
'use strict';
/**
 * test-yard-touch.js — 牧場摸摸：反應幀、原地跳、停走的拍數
 *
 * 這支存在的理由就是它測得到的東西以前測不到 —— 狀態機本來寫在 daemon.js 裡，
 * 而 daemon.js 一 require 就 server.listen，測試載不進來。抽成 yard-touch.js
 * 之後才有辦法把「跳了幾拍、扣了幾拍」算清楚。
 *
 * 時間全部自己餵（now / stepAt），不真的等 1.8 秒。
 */
const YT = require('../src/daemon/yard-touch.js');
const W  = require('../src/shared/plaza-walk.js');
const P  = require('../src/daemon/plaza.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };
// 取某一隻的狀態。缺項回空物件而不是 undefined —— 直接 .get(id).x 的話，
// 只要程式漏回報一隻，測試就會先炸掉、連結果都印不出來，看起來像測試壞了。
const at = (m, id) => m.get(id) || {};

const CFG = { windowMs: 3000, limit: 5, sulkMs: 3000, stepAt: W.stepAt };
const mk  = (over) => YT.create({ ...CFG, ...over });
const T0  = 1700000000000;   // 固定基準時間，測試不看真實時鐘

console.log('— 心情判定 —');
{
    const y = mk();
    ok(y.pet('a', T0) === 'happy', '第一下應該是開心');
    let mood;
    for (let i = 1; i < 5; i++) mood = y.pet('a', T0 + i * 100);
    ok(mood === 'refuse', '窗口內第 5 下應該生氣（得到 ' + mood + '）');
    ok(y.pet('a', T0 + 600) === 'sulking', '生氣後應該鬧脾氣不理人');
    // 每隻各自獨立：戳 a 到生氣不該波及 b
    ok(y.pet('b', T0 + 600) === 'happy', '戳 A 到生氣，B 也跟著生氣了');
}

console.log('— 開心才跳，不爽不跳 —');
{
    const y = mk();
    y.pet('a', T0);
    const r = y.react(null, T0);
    ok(at(r, 'a').frame === 'HAPPY', '開心時應該用 HAPPY 幀');
    ok(at(r, 'a').jump > 0, '開心時第一幀就該是騰空的（點下去要立刻有反應）');

    const z = mk();
    for (let i = 0; i < 5; i++) z.pet('c', T0 + i * 100);   // 直接戳到生氣
    const rz = z.react(null, T0 + 500);
    ok(at(rz, 'c').frame === 'REFUSE', '生氣時應該用 REFUSE 幀');
    ok(at(rz, 'c').jump === 0, '不爽不該原地跳');
    // 不爽的那隻要照常走掉。注意第一下一定是開心（所以停過一小段是正常的）——
    // 要驗的是「翻臉之後不再繼續停」，不是 holdSteps 為 0。
    ok(at(z.react(null, T0 + 3000), 'c').holdSteps === at(rz, 'c').holdSteps,
       '不爽卻還停住不走（應該走開）');
}

console.log('— 跳躍相位 —');
{
    // 院子畫面只有 2fps，半週期若短於一次輪詢就會被取樣漏掉，看起來像浮在空中。
    // JUMP_MS 等於輪詢間隔 → 上、下各正好落在一次取樣上。
    const y = mk();
    y.pet('a', T0);
    const seen = [];
    for (let t = 0; t < YT.REACT_MS; t += YT.POLL_MS) seen.push(at(y.react(null, T0 + t), 'a').jump);
    ok(seen[0] > 0, '按下去的第一幀就該騰空（點了要立刻有反應），得到 ' + JSON.stringify(seen));
    ok(seen[1] === 0, '第二幀就該落地，得到 ' + JSON.stringify(seen));
    // 跳幾下是講好的：多跳的話反應期間會一直蹦
    const hops = seen.filter(v => v > 0).length;
    ok(hops === YT.JUMP_HOPS, '應該只跳 ' + YT.JUMP_HOPS + ' 下，實際跳了 ' + hops
                              + ' 下：' + JSON.stringify(seen));
    ok(seen.slice(YT.JUMP_HOPS * 2).every(v => v === 0),
       '跳完之後應該站著把反應演完，得到 ' + JSON.stringify(seen));

    // 騰空時間不可以短於輪詢間隔，否則那一下會整個被取樣漏掉（有時候看得到、
    // 有時候看不到，最難查的那種）。縮短騰空一定要連前端的輪詢一起調 ——
    // 兩個數字綁在同一個檔案就是為了不會只改一邊。
    ok(YT.JUMP_MS >= YT.POLL_MS,
       '騰空 ' + YT.JUMP_MS + 'ms 短於輪詢 ' + YT.POLL_MS + 'ms，那一下會被取樣漏掉');

    // 點下去會強制刷一次（daemon.js 的 sendCmd），所以第一次取樣落在 t≈0；
    // 之後的節奏跟著既有的輪詢走，跟點擊不對齊。掃一輪偏移確認那一下都在。
    for (const off of [0, 1, 90, YT.POLL_MS - 1]) {
        const q = mk(); q.pet('a', T0);
        const v = [];
        for (let t = off; t < YT.REACT_MS; t += YT.POLL_MS) v.push(at(q.react(null, T0 + t), 'a').jump > 0);
        ok(v.filter(Boolean).length === YT.JUMP_HOPS,
           '輪詢偏移 ' + off + 'ms 時跳躍被取樣漏掉或多算：' + JSON.stringify(v));
    }
}

console.log('— 反應結束就停 —');
{
    const y = mk();
    y.pet('a', T0);
    ok(at(y.react(null, T0 + YT.REACT_MS - 1), 'a').frame === 'HAPPY', '時間內反應就消失了');
    const after = y.react(null, T0 + YT.REACT_MS + 1).get('a');
    ok(!after || after.frame === null, '反應演完了還在演');
    ok(!after || after.jump === 0, '反應演完了還在跳');
}

console.log('— 停走的拍數（原地＝真的不動）—');
{
    const y = mk();
    y.pet('a', T0);
    // 反應期間 holdSteps 要跟著時間長，這樣 joinStep 才會同步往前，target 維持不變
    const h0 = at(y.react(null, T0), 'a').holdSteps;
    const h1 = at(y.react(null, T0 + 1500), 'a').holdSteps;
    ok(h1 > h0, '反應期間 holdSteps 沒有跟著長 → 角色會照走，不是原地');
    ok(h1 - h0 === W.stepAt(T0 + 1500) - W.stepAt(T0),
       'holdSteps 的增量應等於經過的拍數（得到 ' + (h1 - h0) + '）');

    // ⚠️ 反應結束後 holdSteps 必須繼續回報。丟掉的話等於把停走那幾拍還回去，
    //    畫面上就是落地瞬移 —— 那正是加這一整套要避免的事。
    // 缺項時不能讓測試自己炸掉 —— 那會連結果都印不出來，看起來像測試壞了而不是程式壞了
    const after = y.react(null, T0 + 5000).get('a');
    ok(!!after, '反應結束就把 holdSteps 丟掉了（落地會瞬移）');
    ok(after && after.holdSteps >= h1, 'holdSteps 結算後變小了');
    // 而且結算完就不該再長（時間已經恢復流動）
    const later = y.react(null, T0 + 9000).get('a');
    ok(!!after && !!later && later.holdSteps === after.holdSteps,
       '反應結束後 holdSteps 還在長 → 角色會永遠停著');
}

console.log('— 連摸不要重複計時 —');
{
    // 同一段停走裡再摸一下，holdFrom 若被重設，中間那幾拍就白扣了
    const y = mk();
    y.pet('a', T0);
    y.pet('a', T0 + 1200);
    const h = at(y.react(null, T0 + 1200), 'a').holdSteps;
    ok(h === W.stepAt(T0 + 1200) - W.stepAt(T0),
       '連摸時停走的拍數要從第一下起算（得到 ' + h + '）');
}

console.log('— 從開心翻臉成不爽 —');
{
    const y = mk();
    for (let i = 0; i < 4; i++) y.pet('a', T0 + i * 100);   // 前四下開心，停走中
    y.pet('a', T0 + 400);                                    // 第五下生氣
    const r = y.react(null, T0 + 2000);
    ok(at(r, 'a').jump === 0, '翻臉之後不該還在跳');
    ok(at(r, 'a').holdSteps === W.stepAt(T0 + 400) - W.stepAt(T0),
       '翻臉時停走的拍數應該就地結清（得到 ' + at(r, 'a').holdSteps + '）');
    ok(at(y.react(null, T0 + 8000), 'a').holdSteps === at(r, 'a').holdSteps,
       '翻臉之後 holdSteps 還在長');
}

console.log('— 回收 —');
{
    const y = mk();
    y.pet('a', T0);
    // 還在牧場：即使反應結束，帶著 holdSteps 的那筆不能被回收
    y.react(new Set(['a']), T0 + 9000);
    ok(y.touches.has('a'), '還在牧場的成員被回收了（holdSteps 會連帶消失）');
    // 已經離開牧場 → 收掉，不然 daemon 開整天會一直長
    y.react(new Set(), T0 + 9000);
    ok(!y.touches.has('a'), '已離開牧場的成員沒有被回收');
}

console.log('— 畫面：跳躍只改畫在哪 —');
{
    // composeYard 那一側：jump 只影響 blit 的位置，不影響 y 排序與名牌，
    // 而且貼著上緣時要夾住，不能把角色頂出畫面。
    // 合成需要真實美術 → 優先用已安裝的那份，沒有再退回 repo（跟 test-plaza 同一套）
    const os = require('os'), path = require('path');
    let core = null;
    try { core = require(path.join(os.homedir(), '.claude', 'agumon-statusline', 'agumon-core.js')); }
    catch (e) { try { core = require('../src/runtime/agumon-core.js'); } catch (e2) {} }
    const hasArt = !!(core && (() => { try { return P.loadArt(core, 'agumon'); } catch (e) { return null; } })());
    if (!hasArt) { console.log('  – 讀不到角色美術，跳過'); }
    else {
        const ranch = { pets: [{ id: 'p1', keptAt: 0, state: { characterId: 'agumon' } }] };
        // ⚠️ step 一定要從院子的起拍算起。直接餵小數字的話 step - joinStep 是負的、
        //    夾成 0，每一拍都是同一個起點，下面每條斷言都會變成拿同一張圖跟自己比。
        const base  = P.yardJoinStep();
        const step  = base + 400;
        const flat  = P.composeYard(core, ranch, null, step, { caches: new Map() }).placed[0];
        const up    = P.composeYard(core, ranch, null, step, {
            caches: new Map(),
            react: new Map([['p1', { frame: 'HAPPY', jump: 4, holdSteps: 0 }]]),
        }).placed[0];
        ok(up.y === flat.y, 'y（地面位置）不該被跳躍改掉 —— 排序與名牌都靠它');
        ok(up.jumpDy === Math.min(4, flat.y - W.YARD_FIELD.minY),
           '畫的位移不對（jumpDy=' + up.jumpDy + ', y=' + flat.y + '）');

        // holdSteps 會把 joinStep 往後推 → 同一個 step 算出來的位置要往回退
        const held = P.composeYard(core, ranch, null, step, {
            caches: new Map(),
            react: new Map([['p1', { frame: null, jump: 0, holdSteps: 10 }]]),
        }).placed[0];
        const back = P.composeYard(core, ranch, null, step - 10, { caches: new Map() }).placed[0];
        ok(held.x === back.x && held.y === back.y,
           'holdSteps 沒有正確地把時間往回撥（落地會瞬移）');

        // 貼著上緣時夾住：不管跳多高都不能超出場地。
        // ⚠️ 一定要掃到「真的貼近上緣」的那幾拍，否則這條是空的斷言 ——
        //    第一版只掃 300 拍，那隻根本沒走到 y < 9，拿掉夾住也照樣綠。
        const H = 9;
        let over = 0, near = 0;
        for (let s = 0; s < 4000; s++) {
            const q = P.composeYard(core, ranch, null, base + s, {
                caches: new Map(),
                react: new Map([['p1', { frame: 'HAPPY', jump: H, holdSteps: 0 }]]),
            }).placed[0];
            if (q.y - W.YARD_FIELD.minY < H) near++;
            if (q.y - q.jumpDy < W.YARD_FIELD.minY) over++;
        }
        ok(near > 0, '掃描範圍內沒有任何一拍貼近上緣，這條夾住的斷言等於沒測到');
        ok(over === 0, '跳躍把角色頂出畫面上緣 ' + over + ' 次');
    }
}

console.log('— 拿起來 / 放下 —');
{
    const y = mk();
    ok(y.grab('a', T0) === true, '第一次拿起來應該成功');
    ok(y.grab('a', T0) === false, '重複拿起來應該被擋（不然放開時會對不上）');
    const r = at(y.react(null, T0), 'a');
    ok(r.held === true, '拿在手上要標成 held（合成時才會略過牠）');
    ok(r.frame === null && r.jump === 0, '拿在手上不該同時演反應幀');
    // 拿著的時候時間要停，不然放開時位置會跳
    const h1 = at(y.react(null, T0 + 3000), 'a').holdSteps;
    ok(h1 === W.stepAt(T0 + 3000) - W.stepAt(T0), '拿著時停走的拍數不對：' + h1);

    ok(y.drop('a', 5, 20, 'left', T0 + 3000) === true, '放下應該成功');
    ok(y.drop('a', 1, 1, 'left', T0 + 3000) === false, '沒拿著卻能放下');
    const d = at(y.react(null, T0 + 3000), 'a');
    ok(d.held === false, '放下之後不該還是 held');
    ok(d.anchor && d.anchor.origin.x === 5 && d.anchor.origin.y === 20, '落點沒記對');
    ok(d.anchor.step === W.stepAt(T0 + 3000), '落下那一拍沒記對');
    // 時間軸整個換掉了，之前累計的停走位移沒有意義

    // 摸摸演到一半被拿起來 -> 反應中斷。
    // 要驗的是**放下之後**：react() 看到 held 會先短路回傳，所以「拿著時不跳」
    // 就算沒中斷也會通過（第一版就是這樣假綠的）。真正的後果是放開之後那隻
    // 會把剩下的反應演完 —— 在新的落點莫名其妙跳一下。
    const z = mk();
    z.pet('b', T0);
    ok(at(z.react(null, T0), 'b').jump > 0, '前置條件不成立（應該正在跳）');
    z.grab('b', T0);
    const zh = at(z.react(null, T0), 'b');
    ok(zh.jump === 0 && zh.frame === null, '拿在手上不該同時演反應');
    z.drop('b', 9, 9, 'right', T0 + 200);
    const zd = at(z.react(null, T0 + 300), 'b');
    ok(zd.jump === 0 && zd.frame === null,
       '放下之後把被打斷的反應接著演完了（會在落點莫名跳一下）');
    // 上面那條從外面看不出 until 有沒有被清掉（frame 已經是 null，輸出一模一樣），
    // 所以直接驗狀態：待演的反應要整個作廢，不能只是「剛好畫不出來」。
    ok(z.touches.get('b').until === 0,
       '拿起來沒有把待演的反應作廢 —— 目前靠 frame=null 遮住，哪天 frame 改成保留就會冒出來');

    // 放下要把停走的帳歸零。
    // 這條也不能只看「放下當下 holdSteps 是 0」—— 沒摸過的話它本來就是 0。
    // 要先讓它累積起來（摸一下、等反應結束結清），再拿起來放下。
    const q = mk();
    q.pet('d', T0);
    q.react(null, T0 + 9000);                       // 反應結束 -> holdSteps 結清成正值
    const acc = at(q.react(null, T0 + 9000), 'd').holdSteps;
    ok(acc > 0, '前置條件不成立（holdSteps 應該已經累積）');
    q.grab('d', T0 + 9000);
    q.drop('d', 4, 4, 'right', T0 + 9000);
    const qd = at(q.react(null, T0 + 9000), 'd');
    ok(qd.holdSteps === 0,
       '放下之後 holdSteps 沒歸零（' + qd.holdSteps + '）—— joinStep 會被往後推，' +
       '那隻會在落點站著不動好一陣子才開始走');

    // 帶著落點的那筆不能被當成「沒事了」而回收
    const w = mk();
    w.grab('c', T0); w.drop('c', 3, 3, 'right', T0);
    w.react(new Set(['c']), T0 + 60000);
    ok(w.touches.has('c'), '還在牧場卻把落點回收了（那隻會彈回原本的起點）');
    w.react(new Set(), T0 + 60000);
    ok(!w.touches.has('c'), '已離開牧場的落點沒有被回收');
}

console.log('— 拿太久要自動放回去 —');
{
    // 回報過「有的被拎起來就消失了」。其中一條路是拖到一半把分頁關掉／重新整理／斷線 ——
    // 前端根本沒機會送 yardDrop，伺服器會一直以為牠在你手上，而被拿著的那隻不進合成，
    // 於是牠從畫面上整個消失，重開 daemon 才回得來。前端怎麼寫都救不了這條，
    // 只能由伺服器設一個租約。
    const y = mk();
    y.grab('a', T0);
    ok(at(y.react(null, T0 + YT.HELD_MAX_MS - 1000), 'a').held === true,
       '還在租約內就被放掉了（正常拖曳會被打斷）');
    const back = at(y.react(null, T0 + YT.HELD_MAX_MS + 1000), 'a');
    ok(back.held !== true, '拿超過租約還是 held —— 那隻永遠回不到畫面上');
    // 放回去之後要能繼續走：停走的拍數要結清，而不是無限累加
    const h1 = at(y.react(null, T0 + YT.HELD_MAX_MS + 1000), 'a').holdSteps;
    const h2 = at(y.react(null, T0 + YT.HELD_MAX_MS + 9000), 'a').holdSteps;
    ok(h1 > 0, '自動放回後 holdSteps 應該已結清成正值，得到 ' + h1);
    ok(h1 === h2, '自動放回後 holdSteps 還在長 —— 那隻會站著不動');
    // 沒有落點就不該憑空指定一個
    ok(!back.anchor, '自動放回不該亂給落點');
    // 租約到期後再放下 = 沒拿著，要拒絕（前端這時清掉 drag 就好，不會有幽靈）
    ok(y.drop('a', 1, 1, 'right', T0 + YT.HELD_MAX_MS + 1000) === false,
       '租約到期後 drop 應該回 false');
}

console.log('— 放下要蓋過走路快取 —');
{
    // 這條是實際踩過的：落點明明記對了，畫面上那隻卻回到被抓起來前的位置。
    // 快取是「舊時間軸上的位置備忘」，而放下等於換掉時間軸；剛放下時 target 是 0，
    // 而快取的 at 也可能是 0（還在第一段路裡），cache.at <= target 就成立 ——
    // 舊位置被當成有效答案。所以快取要記住自己屬於哪一條時間軸。
    const os = require('os'), path = require('path');
    let core = null;
    try { core = require(path.join(os.homedir(), '.claude', 'agumon-statusline', 'agumon-core.js')); }
    catch (e) { try { core = require('../src/runtime/agumon-core.js'); } catch (e2) {} }
    const hasArt = !!(core && (() => { try { return P.loadArt(core, 'agumon'); } catch (e) { return null; } })());
    if (!hasArt) { console.log('  – 讀不到角色美術，跳過'); }
    else {
        const y = mk();
        const ranch = { pets: [{ id: 'p1', keptAt: 0, state: { characterId: 'agumon' } }] };
        const caches = new Map();                 // daemon 用的是長駐快取，這裡要一樣
        const base = P.yardJoinStep();
        const now = T0;
        // 先養熱：快取裡會留下「舊時間軸」的位置
        for (let k = 0; k < 8; k++) P.composeYard(core, ranch, null, base + k, { caches, react: y.react(null, now) });
        const before = P.composeYard(core, ranch, null, base + 8, { caches, react: y.react(null, now) }).placed[0];

        y.grab('p1', now);
        y.drop('p1', 5, 20, 'left', now);
        const m = y.react(null, now), step = W.stepAt(now);
        const after = P.composeYard(core, ranch, null, step, { caches, react: m }).placed[0];
        ok(after.x === 5 && after.y === 20,
           `放下之後應該在 5,20，卻在 ${after.x},${after.y}` +
           (after.x === before.x && after.y === before.y ? '（＝抓起來前的位置，舊快取沒作廢）' : ''));

        // 而且要從落點繼續走，不是釘在那裡
        let prev = null, moves = 0;
        for (let t = 1; t <= 40; t++) {
            const o = P.composeYard(core, ranch, null, step + t, { caches, react: m }).placed[0];
            if (prev && (o.x !== prev.x || o.y !== prev.y)) moves++;
            prev = o;
        }
        ok(moves > 25, `放下之後應該繼續走，40 拍只動了 ${moves} 拍`);

        // 拿在手上的那隻不進合成（否則畫面上會有兩個分身）
        const y2 = mk();
        y2.grab('p1', now);
        const heldOut = P.composeYard(core, ranch, null, step, { caches: new Map(), react: y2.react(null, now) });
        ok(heldOut === null, '牧場只有一隻且被拿著時，合成應該回 null（沒有人留在場上）');

        // 交給前端的是**兩張**待機幀：拿在手上也要繼續呼吸，不是定格。
        const sp = P.yardSpriteFor(core, ranch, 'p1', step, {});
        ok(sp && Array.isArray(sp.frames) && sp.frames.length === 2,
           '抓起來時應該給兩張待機幀（前端靠它輪替）');
        ok(sp && JSON.stringify(sp.frames[0]) !== JSON.stringify(sp.frames[1]),
           '兩張待機幀一模一樣 —— 拿在手上會看起來像定格');
        ok(sp && sp.frames[0].length === 16 && sp.frames[0][0].length === 16,
           '待機幀的尺寸不對');
        ok(P.yardSpriteFor(core, { pets: [] }, 'nobody', step, {}) === null,
           '不在牧場裡的 id 應該回 null，不是丟例外');
    }
}

console.log('\n結果：' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
