#!/usr/bin/env node
'use strict';
/**
 * test-commute.js — 廣場小遊戲「上班快遲到」（docs/plaza-commute-spec.md）
 *
 *   1. 模擬（src/shared/commute-sim.js）：決定性、難度、操作（油門、煞車／急煞、畫面裡移動）、紅燈／黃燈、
 *      撞車、圓環、施工、互撞、遲到、到公司、車子讓玩家、新聞、時鐘、一週排名
 *   2. 伺服器＋daemon 端連線（plaza-server / plaza-client）：開房、五天流程、輸入、繃帶、排行榜、離開
 */
const fs = require('fs'), os = require('os'), path = require('path');
const CM = require('../src/shared/commute-sim.js');
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

// 空場地：清掉車流、紅綠燈、圓環、施工，跳過倒數（測單一規則用）
function lab(n = 1) {
    const g = CM.createDay({ seed: 7, day: 0, players: Array.from({ length: n }, (_, i) => ({ id: 'p' + i })) });
    g.cars = []; g.map.lights = []; g.map.islands = []; g.map.works = []; g.mergeNext = []; g.t = 0;
    return g;
}
const P = (g, i = 0) => g.players[i];
const K = CM.KEY;
const pe0 = (g) => g.events.filter(e => e.type === 'out');
const run = (g, n) => { const ev = []; for (let i = 0; i < n && !g.over; i++) ev.push(...CM.step(g)); return ev; };
// 把玩家放到 x（x = cam + o，改 cam）、給車速
const put = (p, x, v = p.v) => { p.x = x; p.v = v; };
// 紅綠燈週期裡的某個時間點（off = 0 的那盞）
const G_AT = 1, Y_AT = CM.LIGHT.G + 0.5;
const R_AT = (g) => CM.LIGHT.G + CM.LIGHT.Y + g.map.red / 2;

console.log('— 模擬：基本 —');
{
    const replay = (seed, day) => {
        const g = CM.createDay({ seed, day, players: [{ id: 'a' }, { id: 'b' }] });
        const out = [];
        for (let i = 0; i < 900 && !g.over; i++) {
            CM.setInput(g, 'a', (i % 40 < 30 ? K.thr : K.brk) | (i % 97 < 5 ? K.down : 0));
            CM.setInput(g, 'b', (i % 31 < 9 ? K.brk : K.thr) | (i % 53 < 5 ? K.up : 0));
            CM.step(g); out.push(JSON.stringify(CM.snapshot(g)));
        }
        return out.join('|');
    };
    ok(replay(42, 0) === replay(42, 0), '同一個 seed 重播結果不一樣（伺服器算的不是決定性的）');
    ok(replay(42, 0) !== replay(43, 0), '換 seed 路況都一樣');
    ok(replay(42, 0) !== replay(42, 1), '週一跟週二路況一樣');
    const a = CM.difficulty(0), e = CM.difficulty(4);
    ok(e.red > a.red && e.gap[1] < a.gap[1] && e.gap[0] < a.gap[0] && e.truck > a.truck, '越後面沒有越塞（車距、紅燈、卡車比例）');
    // 每一天都有紅綠燈；五天裡至少有圓環；週一沒有施工、之後有
    let isl = 0;
    for (let d = 0; d < CM.DAYS; d++) {
        const g = CM.createDay({ seed: 5, day: d, players: [{ id: 'a' }] });
        ok(g.map.lights.length >= 2, `第 ${d + 1} 天沒有紅綠燈`);
        isl += g.map.islands.length;
        ok(d === 0 ? g.map.works.length === 0 : g.map.works.length >= 1, `第 ${d + 1} 天施工數不對：` + g.map.works.length);
        ok(g.players[0].x === 0 && g.players[0].v === 0, '開局不是停在起點');
        // 中間兩道的車開局不會放在圓環島上；最下面那道不會放在施工上
        ok(!g.cars.some(c => c.lane === 3 && g.map.works.some(w => c.x + c.len > w.x0 && c.x < w.x1)), '最下面那道開局就有車停在施工上');
        // 施工不跟紅綠燈、圓環擠在一起
        ok(g.map.works.every(w => !g.map.lights.some(L => L.x > w.x0 - 60 && L.x < w.x1 + 60)), '施工擺在紅綠燈旁邊');
    }
    ok(isl > 0, '五天都沒有圓環');
    // 四個人排在四道
    const g4 = CM.createDay({ seed: 1, players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });
    ok(g4.players.map(p => p.ly).join() === '0,1,2,3', '四個人沒有各占一道');
    // 倒數中不能動
    CM.setInput(g4, 'a', K.thr | K.down);
    run(g4, Math.floor(CM.COUNTDOWN_S / CM.DT) - 1);
    ok(g4.players[0].x === 0, '倒數中就能往前騎');
    // 封包大小：四個人、最塞的週五也不要太大（每秒 20 包）
    let maxB = 0;
    for (let seed = 1; seed <= 6; seed++) {
        const g = CM.createDay({ seed, day: 4, players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });
        for (let i = 0; i < 600; i++) { for (const p of g.players) CM.setInput(g, p.id, K.thr); CM.step(g); maxB = Math.max(maxB, JSON.stringify(CM.snapshot(g)).length); }
    }
    ok(maxB < 2500, '每拍的狀態太大：' + maxB + ' bytes');
}

console.log('— 模擬：人多車少 —');
{
    // 每多一個人，車距、圓環匯入間隔各多 CROWD；一個人照舊
    const d1 = CM.difficulty(2, 1), d4 = CM.difficulty(2, 4);
    ok(CM.difficulty(2).gap.join() === d1.gap.join() && Math.abs(d4.gap[0] / d1.gap[0] - (1 + 3 * CM.CROWD)) < 1e-9
       && Math.abs(d4.merge / d1.merge - (1 + 3 * CM.CROWD)) < 1e-9, '車距／匯入間隔沒有照人數放寬');
    ok(d4.red === d1.red && d4.len === d1.len && d4.works === d1.works, '人數改到地形（紅燈、路長、施工）');
    // 同一個 seed：四個人的車比一個人的少，地圖一樣
    let c1 = 0, c4 = 0, same = true;
    for (let seed = 1; seed <= 10; seed++) {
        const g1 = CM.createDay({ seed, day: 3, players: [{ id: 'a' }] });
        const g4 = CM.createDay({ seed, day: 3, players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });
        c1 += g1.cars.length; c4 += g4.cars.length;
        if (JSON.stringify(CM.mapPub(g1)) !== JSON.stringify(CM.mapPub(g4))) same = false;
    }
    ok(c4 < c1 * 0.8, `四個人的車沒有變少（1 人 ${c1} 台、4 人 ${c4} 台）`);
    ok(same, '人數不同，地圖（紅綠燈、圓環、施工）也跟著變了');
}

console.log('— 模擬：油門、煞車、上下移動 —');
{
    // X 油門：加到最快；放掉：引擎煞車慢慢掉
    let g = lab();
    CM.setInput(g, 'p0', K.thr);
    run(g, 200);
    ok(P(g).v === CM.VMAX, '一直催油門沒有到最快');
    CM.setInput(g, 'p0', 0);
    run(g, 20);
    ok(P(g).v < CM.VMAX && P(g).v > CM.VMAX - 10, '放掉油門沒有「慢慢」減速：' + P(g).v);
    // 只按 Z、車速快 → 急煞（火花），一路急煞到停
    g = lab(); put(P(g), 0, CM.VMAX);
    CM.setInput(g, 'p0', K.brk);
    run(g, 1);
    ok(P(g).sk === 1 && CM.snapshot(g).p[0][7] === 1, '快的時候只按 ← 沒有急煞（火花）');
    const vHard = CM.VMAX - P(g).v;
    run(g, 40);
    ok(P(g).v === 0 && P(g).sk === 0, '急煞停不下來（或停了還在冒火花）');
    // 只按 Z、車速不快 → 一般煞車煞到停，沒有火花
    g = lab(); put(P(g), 0, CM.HARD_V - 5);
    CM.setInput(g, 'p0', K.brk);
    run(g, 1);
    ok(P(g).sk === 0 && P(g).v < CM.HARD_V - 5, '不快的時候按 Z 也急煞了（或沒有減速）');
    const vNorm = CM.HARD_V - 5 - P(g).v;
    run(g, 60);
    ok(P(g).v === 0, '不快的時候按 Z 沒有煞到停');
    // Z＋X 一起：輕煞（比只按 Z 慢）
    g = lab(); put(P(g), 0, CM.VMAX);
    CM.setInput(g, 'p0', K.brk | K.thr);
    run(g, 1);
    const vSoft = CM.VMAX - P(g).v;
    ok(P(g).sk === 0 && vSoft > 0 && vSoft < vNorm && vNorm < vHard, `減速快慢不對（輕煞 ${vSoft}、煞車 ${vNorm}、急煞 ${vHard}）`);
    // 煞車途中才鬆開 X（Z 一直按著）：按下去那一刻不是只按 Z → 不算急煞
    CM.setInput(g, 'p0', K.brk);
    run(g, 1);
    ok(P(g).sk === 0, '從輕煞放掉油門變成急煞（急煞看「按下 Z 那一刻」）');
    // 前後只看車速（角色釘在畫面 30%）：保留的 4、8 位元不會讓人前後挪
    g = lab(); put(P(g), 100, 20);
    CM.setInput(g, 'p0', 4 | 8);
    const x0 = P(g).x, v0 = P(g).v; run(g, 1);
    ok(Math.abs(P(g).x - (x0 + P(g).v * CM.DT)) < 1e-9 && P(g).v < v0, '前後不是只靠車速（4／8 位元還在動位置）');
    // 上下：自由移動，可以停在兩道中間
    CM.setInput(g, 'p0', K.thr | K.down);
    run(g, 3);
    ok(P(g).ly > 0 && P(g).ly < 1, '上下不是平順移動（一按就跳一道）');
    run(g, 100);
    ok(P(g).ly === CM.LANES - 1, '往下沒有停在最下面那道');
    CM.setInput(g, 'p0', K.thr | K.up | K.down);
    const ly0 = P(g).ly; run(g, 5);
    ok(P(g).ly === ly0, '↑ ↓ 一起按還在動');
    // 輸入只吃 6 個位元
    CM.setInput(g, 'p0', 255);
    ok(P(g).k === 63, '輸入沒有限制在 6 個位元');
}

console.log('— 模擬：紅綠燈 —');
{
    // 紅燈闖過停止線 → 出局
    let g = lab(); g.map.lights = [{ x: 50, off: 0 }]; g.t = R_AT(g);
    put(P(g), 50 - CM.BIKE_LEN - 0.5, 30);
    let ev = run(g, 3);
    ok(P(g).state === 'out' && P(g).why === 'red' && ev.some(e => e.type === 'out' && e.why === 'red'), '紅燈闖過去沒有出局');
    // 黃燈過去沒事
    g = lab(); g.map.lights = [{ x: 50, off: 0 }]; g.t = Y_AT;
    put(P(g), 50 - CM.BIKE_LEN - 0.5, 30);
    run(g, 3);
    ok(P(g).state === 'ride', '黃燈過去也出局了');
    // 綠燈沒事；已經過了停止線之後轉紅也沒事
    g = lab(); g.map.lights = [{ x: 50, off: 0 }]; g.t = G_AT;
    put(P(g), 50 - CM.BIKE_LEN - 0.5, 30);
    run(g, 3); g.t = R_AT(g); run(g, 3);
    ok(P(g).state === 'ride', '綠燈過了停止線、之後轉紅還是出局');
    // 紅燈：最快速度在 20 點外按 Z，停得在線前
    g = lab(); g.map.lights = [{ x: 200, off: 0 }]; g.t = R_AT(g);
    put(P(g), 200 - CM.BIKE_LEN - 20, CM.VMAX);
    CM.setInput(g, 'p0', K.brk);
    run(g, 30);
    ok(P(g).state === 'ride' && P(g).v === 0, '最快速度提前 20 點急煞，還是停不住');
    // 車子紅燈會停在線前
    g = lab(); g.map.lights = [{ x: 200, off: 0 }]; g.t = R_AT(g);
    g.cars.push({ id: 900, type: 'car', len: 9, lane: 3, ly: 3, x: 150, v0: 20, v: 20 });
    put(P(g), -999);   // 玩家離很遠
    run(g, 40);
    const c = g.cars.find(c => c.id === 900);
    ok(c.x + c.len <= 200 && c.x + c.len > 195, '車子紅燈沒有停在停止線前：' + (c.x + c.len));
}

console.log('— 模擬：撞車、圓環、施工、互撞 —');
{
    let g = lab();
    g.cars.push({ id: 900, type: 'truck', len: 18, lane: 0, ly: 0, x: 20, v0: 0, v: 0 });
    CM.setInput(g, 'p0', K.thr);
    let ev = run(g, 80);
    ok(P(g).state === 'out' && P(g).why === 'crash' && P(g).hit === 'truck', '撞上停著的卡車沒有出局');
    ok(ev.some(e => e.type === 'out' && e.hit === 'truck'), '撞車沒有事件');
    // 隔壁道的車不會撞到
    g = lab();
    g.cars.push({ id: 900, type: 'car', len: 9, lane: 1, ly: 1, x: 20, v0: 0, v: 0 });
    CM.setInput(g, 'p0', K.thr);
    run(g, 80);
    ok(P(g).state === 'ride', '隔壁道的車也撞到了');
    // 往下移到車子旁邊 → 撞到
    g = lab();
    g.cars.push({ id: 900, type: 'van', len: 12, lane: 1, ly: 1, x: -2, v0: 0, v: 0 });
    CM.setInput(g, 'p0', K.down);
    run(g, 10);
    ok(P(g).state === 'out' && P(g).hit === 'van', '移到旁邊的車那道沒有撞到');
    // 車子不會從後面撞上停著的玩家（撞車一定是玩家自己騎上去的）
    g = lab();
    put(P(g), 100, 0);
    g.cars.push({ id: 900, type: 'car', len: 9, lane: 0, ly: 0, x: 40, v0: 26, v: 26 });
    run(g, 200);
    ok(P(g).state === 'ride' && g.cars[0].x + g.cars[0].len < 100, '車子從後面撞上停著的玩家');
    // 圓環（2026-10-27 改版：上兩道往上繞、下兩道往下繞）：四道照車道騎都過得去；壓著中線騎才撞島
    g = lab(4);
    g.map.islands = [{ x0: 60, x1: 150, mergeX: 100 }]; g.mergeNext = [[999, 999]];
    for (const p of g.players) CM.setInput(g, p.id, K.thr);
    run(g, 120);
    ok(g.players.every(p => p.state === 'ride' && p.x > 150), '照車道騎繞圓環也出局（四道都該過得去）：' + g.players.map(p => p.state + '/' + p.hit));
    g = lab(2);
    g.map.islands = [{ x0: 60, x1: 150, mergeX: 100 }]; g.mergeNext = [[999, 999]];
    P(g, 0).ly = 1.5; P(g, 1).ly = 3;
    for (const p of g.players) CM.setInput(g, p.id, K.thr);
    run(g, 120);
    ok(P(g, 0).hit === 'island' && P(g, 1).state === 'ride', '壓著中線騎進圓環沒有撞島');
    ok(pe0(g).every(e => typeof e.x === 'number' && typeof e.ly === 'number' && typeof e.t === 'number'), '出局事件沒有帶位置（伺服器 log 查不了在哪撞的）');
    // 島是中線上的扁橢圓：島頭、島尾的邊邊不算撞；正中間、靠中線才撞
    const I = { x0: 100, x1: 190 };
    const isl = { islands: [I] };
    ok(!CM.hitIsland(isl, I.x0 - 2, I.x0 + 6, 0.9) && !CM.hitIsland(isl, I.x1 - 6, I.x1 + 2, 2.1), '島頭島尾的邊邊（畫面上是空的）也算撞到');
    ok(CM.hitIsland(isl, 141, 149, 1.5) && CM.hitIsland(isl, 141, 149, 1.3) && CM.hitIsland(isl, 141, 149, 1.7), '島的正中間（中線附近）騎上去沒撞到');
    ok(!CM.hitIsland(isl, 141, 149, 1) && !CM.hitIsland(isl, 141, 149, 2), '騎在第 1、2 道（繞圓環）也算撞島');
    // 試玩 log 那兩次（島 613～703）：ly 0.75 擦島頭、ly 1.05 擦島尾，畫面上幾乎沒碰到 → 不算
    const isl2 = { islands: [{ x0: 613, x1: 703 }] }, isl3 = { islands: [{ x0: 703, x1: 793 }] };
    ok(!CM.hitIsland(isl2, 626, 632, 0.75) && !CM.hitIsland(isl3, 787, 793, 1.05), '試玩時擦到島頭／島尾那兩次還是算撞到（太敏感）');
    ok(!CM.hitIsland(isl, 141, 149, 0.5) && !CM.hitIsland(isl, 141, 149, 2.5), '騎在兩道中間（離中線 1 道）就算撞到島（太嚴）');
    // 碰撞放寬：跟車子差 0.6 道（兩道中間偏一點）不算撞；前後擦到 1 點以內不算撞
    g = lab();
    g.cars.push({ id: 900, type: 'car', len: 12, lane: 1, ly: 1, x: 30, v0: 0, v: 0 });
    put(P(g), 27, 0); P(g).ly = 0.4;   // 前後重疊，只差上下
    run(g, 2);
    ok(P(g).state === 'ride', '跟車子上下差 0.6 道也算撞到（太嚴）');
    g = lab();
    g.cars.push({ id: 900, type: 'car', len: 12, lane: 0, ly: 0, x: 20, v0: 0, v: 0 });
    put(P(g), 20 - CM.BIKE_LEN + 0.8, 0);
    run(g, 2);
    ok(P(g).state === 'ride', '車頭跟前車只差不到 1 點（擦到邊）也算撞到');
    // 中間兩道的車照常繞圓環（不用換到外側）
    g = lab();
    g.map.islands = [{ x0: 300, x1: 390, mergeX: 340 }]; g.mergeNext = [[999, 999]];
    put(P(g), -999);
    g.cars.push({ id: 900, type: 'car', len: 9, lane: 1, ly: 1, x: 200, v0: 20, v: 20 });
    g.cars.push({ id: 901, type: 'car', len: 9, lane: 2, ly: 2, x: 200, v0: 20, v: 20 });
    run(g, 200);
    ok(g.cars[0].ly === 1 && g.cars[1].ly === 2 && g.cars.every(c => c.x > 390), '中間兩道的車繞圓環時換道或卡住了：' + g.cars.map(c => c.ly + '@' + Math.round(c.x)));
    // 施工：最下面那道騎進去 → 撞到工程車；上一道沒事；最下面那道的車會提前往上換
    g = lab(2);
    P(g, 0).ly = 3; P(g, 1).ly = 2;
    g.map.works = [{ x0: 60, x1: 60 + CM.WORK_LEN }];
    for (const p of g.players) CM.setInput(g, p.id, K.thr);
    ev = run(g, 100);
    ok(P(g, 0).hit === 'works' && P(g, 1).state === 'ride', '最下面那道騎進施工沒有撞到（或上一道也撞到）');
    ok(CM.news(ev).some(s => /與工程車發生撞擊/.test(s)), '撞到施工沒有上新聞');
    g = lab(); put(P(g), -999);
    g.map.works = [{ x0: 300, x1: 300 + CM.WORK_LEN }];
    g.cars.push({ id: 900, type: 'car', len: 9, lane: 3, ly: 3, x: 200, v0: 20, v: 20 });
    run(g, 200);
    ok(g.cars[0].ly === 2 && g.cars[0].x > 300, '最下面那道的車沒有繞過施工：' + JSON.stringify(g.cars[0]));
    // 支線匯入：時間到就有車從外面擠進外側車道
    g = lab();
    g.map.islands = [{ x0: 300, x1: 390, mergeX: 340 }]; g.mergeNext = [[0.1, 0.1]];
    put(P(g), -999);
    run(g, 4);
    ok(g.cars.filter(c => c.merge).length === 2 && g.cars.some(c => c.merge && c.ly < 0) && g.cars.some(c => c.merge && c.ly > 3), '圓環支線沒有車匯入（上下各一）');
    // 匯入口有玩家 → 晚一點再進來，不會擠到玩家身上
    g = lab();
    g.map.islands = [{ x0: 300, x1: 390, mergeX: 340 }]; g.mergeNext = [[0.1, 999]];
    put(P(g), 336, 0);
    run(g, 4);
    ok(!g.cars.some(c => c.merge), '匯入口有玩家還硬擠進來');
    // 互撞：雙方都出局（規格 A）
    g = lab(2);
    CM.setInput(g, 'p0', K.down);
    ev = run(g, 10);
    ok(P(g, 0).why === 'crash' && P(g, 1).why === 'crash' && P(g, 0).hit === 'bike' && P(g, 1).hit === 'bike', '互撞沒有雙方都出局');
    const pe = ev.filter(e => e.type === 'out');
    ok(pe.length === 2 && pe.every(e => e.pair && e.pair.length === 2), '互撞事件沒有帶是哪兩個人');
    ok(g.over && ev.some(e => e.type === 'over'), '全部出局沒有結束這一天');
}

console.log('— 模擬：遲到、到公司 —');
{
    let g = lab(2);
    put(P(g, 1), g.map.len - CM.BIKE_LEN - 1, 30);
    let ev = run(g, 2);
    ok(P(g, 1).state === 'done' && P(g, 1).at > 0 && ev.some(e => e.type === 'arrive'), '騎到終點沒有算到公司');
    g.t = CM.DAY_S - CM.DT / 2;
    ev = run(g, 2);
    ok(P(g, 0).state === 'out' && P(g, 0).why === 'late', '09:00 還沒到沒有算遲到');
    ok(P(g, 1).state === 'done', '已經到公司的人也算遲到');
    ok(g.over, '遲到之後這一天沒有結束');
}

console.log('— 頁面的本地預測 —');
{
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'daemon', 'daemon.js'), 'utf8');
    const m = src.match(/const CM_PHYS=(\{[^}]*\});/);
    const ph = m ? new Function('return ' + m[1])() : null;
    ok(ph && ['VMAX', 'ACC', 'DRAG', 'SOFT', 'BRAKE', 'HARD', 'HARD_V', 'VMOVE', 'LANES'].every(k => ph[k] === CM[k]),
       '頁面本地預測的物理常數跟 commute-sim 不一樣（自己的車會先動到別的地方再被拉回來）：' + (m ? m[1] : '找不到 CM_PHYS'));
    // 中途離開再開一間：等待面板要重畫（不然留著上一場停用的「出發」鈕，2026-10-27 試玩）
    ok(/else \{ box\.style\.display='none'; document\.getElementById\('stairspanel'\)\.dataset\.h=''; \}/.test(src), '離開房間時沒清掉面板的快取（再開一間按出發沒反應）');
    // 結算畫面（2026-10-27 改版）：每日結算是出勤卡（cmDayCard），一週結算有五天出勤點與獎項（cmWeekHtml，廣場、前線共用）
    ok(/if\(cmDayEnd\) cmDayCard\(/.test(src) && /if\(commute\) h\+=cmWeekHtml\(end\.result, stairs\.meId\);/.test(src)
       && /comEndPanel\(null,cmWeekHtml\(/.test(src) && /'全勤獎'/.test(src) && /'最常掛彩'/.test(src), '上班快遲到的每日／一週結算不是新版（出勤卡、獎項）');
    const mi = src.match(/const CM_ISL=\{ RY:([\d.]+), RX:([\d.]+) \};/);
    ok(mi && Number(mi[1]) === CM.ISLAND_RY && Number(mi[2]) === CM.ISLAND_RX, '畫面上圓環島的大小跟判定不一樣（看起來沒碰到卻撞了）');
    const ml = src.match(/CM_LEN=\[(\d+),(\d+),(\d+)\]/);
    ok(ml && [CM.VEH.car.len, CM.VEH.van.len, CM.VEH.truck.len].join() === ml.slice(1).join(), '頁面畫的車長跟判定的車長不一樣（看起來沒碰到卻撞了）');
}

console.log('— 新聞、時鐘、排名 —');
{
    const ev = [{ type: 'out', why: 'crash', hit: 'truck' }, { type: 'out', why: 'crash', hit: 'truck' },
                { type: 'out', why: 'crash', hit: 'car' }, { type: 'out', why: 'red' }, { type: 'out', why: 'late' },
                { type: 'out', why: 'crash', hit: 'bike' }, { type: 'out', why: 'crash', hit: 'bike' }];
    const n = CM.news(ev);
    ok(n.length === 3, '新聞則數不對：' + JSON.stringify(n));
    ok(n.some(s => /兩名上班族於通勤途中與卡車發生撞擊，不幸/.test(s)) && n.some(s => /一名上班族於通勤途中與汽車/.test(s)), '撞車新聞沒有寫人數、車種');
    ok(n.some(s => /兩名上班族於通勤途中互撞/.test(s)), '互撞沒有上新聞');
    ok(!n.some(s => /紅燈|遲到/.test(s)), '闖紅燈、遲到不該上新聞');
    ok(CM.news([]).length === 0, '沒事也有新聞');
    ok(CM.clock(0) === '08:58:00' && CM.clock(61.9) === '08:59:01' && CM.clock(CM.DAY_S) === '09:00:00' && CM.clock(-2) === '08:58:00', '時鐘不對');
    const r = CM.rankWeek([{ id: 'a', days: 3, total: 300 }, { id: 'b', days: 4, total: 500 }, { id: 'c', days: 3, total: 280 }]);
    ok(r.map(x => x.id + x.rank).join() === 'b1,c2,a3', '一週排名不是先比天數再比時間：' + JSON.stringify(r));
}

// ── 2. 伺服器 + daemon 端 ─────────────────────────────────────────────
(async () => {
    console.log('— 伺服器：開房、五天、繃帶、排行榜 —');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vpet-commute-'));
    const boardFile = path.join(tmp, 'commute-board.json');
    const ps = S.createPlazaServer({ stairsBoardFile: path.join(tmp, 's.json'), dinoBoardFile: path.join(tmp, 'd.json'), commuteBoardFile: boardFile,
                                     stairsTickMs: 1, stairsLostMs: 300, graceMs: 2000, commuteBreakMs: 30 });
    await new Promise(r => ps.server.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + ps.server.address().port;
    const seen = { a: [], b: [] };
    const mk = (tag) => C.create({ url, retryMs: 2000, onStairs: (k, d) => seen[tag].push([k, d]) });
    const prof = (name, char = 'agumon') => ({ name, char, stage: 'Child', card: { power: 10, train: 3 } });
    const a = mk('a'), b = mk('b');
    try {
        ok((await a.join(prof('阿張'))).ok && (await b.join(prof('阿明', 'gabumon'))).ok, '進廣場失敗');
        await until(() => a.me() && b.me());
        const op = await a.stairs('open', { kind: 'commute' });
        ok(op.ok && op.room.kind === 'commute' && op.room.cap === 4, '開房失敗：' + JSON.stringify(op));
        ok(await until(() => b.chat().some(c => c.sys && /上班快遲到/.test(c.text))), '開房之後聊天室沒有系統訊息');
        ok((await b.stairs('join', { room: op.room.id })).ok, '加入失敗');
        ok(!(await a.stairs('cin', { k: 1 })).ok, '還沒出發就能送油門');
        const room = ps.rooms.get(op.room.id);
        ok((await a.stairs('start')).ok, '房主出發失敗');
        ok(await until(() => seen.a.some(([k]) => k === 'cday') && seen.b.some(([k]) => k === 'cday')), '出發之後沒有收到第一天的地圖');
        const day0 = seen.a.find(([k]) => k === 'cday')[1];
        ok(day0.day === 0 && day0.map && day0.map.len > 0 && Array.isArray(day0.map.lights), '一天開始的資料格式不對：' + JSON.stringify(day0).slice(0, 200));
        ok(!(await a.stairs('cin', { k: 64 })).ok && !(await a.stairs('cin', { k: -1 })).ok && !(await a.stairs('cin', { k: 1.5 })).ok, '按鍵亂送（64／-1／1.5）也收');
        // 每一天：阿張往下移撞阿明（互撞 → 兩個都受傷）；第三天讓阿張直接到公司
        const ids = [a.me().id, b.me().id];
        for (let d = 0; d < CM.DAYS; d++) {
            ok(await until(() => room.cm && room.cm.day === d && room.cm.game, 5000), `第 ${d + 1} 天沒有開始`);
            const g = room.cm.game;
            if (d === 2) { const p = g.players.find(q => q.id === ids[0]); p.x = g.map.len - CM.BIKE_LEN - 0.5; p.v = 30; g.t = 0; g.cars = []; }
            else { await until(() => g.t > 0, 5000); ok((await a.stairs('cin', { k: CM.KEY.down })).ok, '送按鍵失敗'); }
            if (d === 2) { const q = g.players.find(x => x.id === ids[1]); q.state = 'out'; q.why = 'red'; }
            ok(await until(() => seen.a.filter(([k]) => k === 'cdayEnd').length === d + 1, 8000), `第 ${d + 1} 天沒有結束`);
        }
        const ends = seen.a.filter(([k]) => k === 'cdayEnd').map(x => x[1]);
        ok(ends[0].news.some(s => /互撞/.test(s)) && ends[0].res.length === 2, '第一天互撞沒有上新聞');
        ok(ends[2].res.find(x => x.id === ids[0]).ok && !ends[2].news.length, '第三天到公司沒有算');
        ok(ends[0].bandage[ids[0]] === 1 && ends[1].bandage[ids[0]] === 2 && ends[4].bandage[ids[0]] === 3, '繃帶沒有一天一天貼上去（最多 3 塊）：' + JSON.stringify(ends.map(e => e.bandage)));
        ok(ends[2].bandage[ids[1]] === 2, '闖紅燈也貼了繃帶');
        ok(await until(() => seen.a.some(([k]) => k === 'end')), '週五之後沒有結算');
        const end = seen.a.find(([k]) => k === 'end')[1];
        ok(end.result[0].id === ids[0] && end.result[0].days === 1 && end.result[1].days === 0, '一週結算不對：' + JSON.stringify(end.result));
        const board = JSON.parse(fs.readFileSync(boardFile, 'utf8')).board;
        ok(board.length === 1 && board[0].name === '阿張' && board[0].days === 1 && board[0].total > 0, '排行榜沒寫進檔案（一天都沒到的不上榜）：' + JSON.stringify(board));
        ok(end.board.length === 1 && !('pid' in end.board[0]), '結算的排行榜不對');
        ok((await a.stairsBoard('commute')).length === 1, '/stairs/board?kind=commute 讀不到排行榜');
        ok(await until(() => ps.rooms.size === 0), '結束之後房間沒解散');

        console.log('— 伺服器：不幹了 —');
        const o2 = await a.stairs('open', { kind: 'commute' });
        await b.stairs('join', { room: o2.room.id });
        const r2 = ps.rooms.get(o2.room.id);
        await a.stairs('start');
        ok(await until(() => r2.cm && r2.cm.game), '第二局沒開始');
        ok((await b.stairs('leave')).ok, '不幹了失敗');
        ok(!r2.ids.includes(b.me().id) && !r2.cm.rows[b.me().id], '不幹了的人還在房裡／還列在結算');
        ok(r2.cm.game.players.find(p => p.id === b.me().id).state === 'out', '不幹了的人還在路上騎');
        await a.stairs('leave');
        ok(await until(() => ps.rooms.size === 0) && !r2.timer, '大家都走了，房間沒解散（計時器還在跑）');
    } finally {
        try { await a.leave(); await b.leave(); } catch (e) {}
        await ps.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    console.log(`\n結果：${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERR', e.stack); process.exit(1); });
