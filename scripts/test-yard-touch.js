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

console.log('\n結果：' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
