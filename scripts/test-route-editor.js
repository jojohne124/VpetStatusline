#!/usr/bin/env node
'use strict';
/**
 * test-route-editor.js — 進化路線編輯器的版面計算
 *
 * 這支只驗 computeLayout（純計算：誰排在哪一欄、上半區還是下半區），
 * 不驗畫出來長怎樣 —— 那要真的瀏覽器。
 *
 * 為什麼值得測：版面規則有兩個「錯了也不會報錯、只是畫面怪怪的」的陷阱，
 * 兩個都實際踩過：
 *   1. UnStage 是暫存區、整欄都是未實裝。把它算進「未實裝區高度」的話，
 *      那個區會被撐到 50 列高，所有實裝角色被推到兩千多 px 以下。
 *   2. 算版面與移動節點必須分開。reload() 只在有節點缺座標時才重排，
 *      所以存過一次檔之後就不會再排 —— 欄標題與分隔線若綁在排版裡，那時整組消失。
 *
 * 頁面 script 在假 DOM 裡跑（跟 test-daemon-page 同一招），透過尾巴掛的把手取用內部函式。
 */
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'editor', 'route_editor.html'), 'utf8');
const m = HTML.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.log('  ✗ 抓不到頁面 script'); process.exit(1); }

// 最小假 DOM：頁面在載入時就會 getElementById 幾個圖層
const el = () => ({
    style: {}, dataset: {}, innerHTML: '', textContent: '', value: '', checked: true,
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, addEventListener() {}, setAttribute() {}, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
});
const g = {
    document: {
        getElementById: () => el(), querySelectorAll: () => [], addEventListener() {},
        createElementNS: () => el(), createElement: () => el(), body: el(),
    },
    window: null, fetch: () => new Promise(() => {}), console,
    // 頁面會在 window 上掛 keydown / mouseup 等等；假環境少一個方法，
    // 整支 script 就載不起來 —— 那不是頁面壞了，是探針缺東西。
    addEventListener() {}, removeEventListener() {},
    setInterval: () => 0, setTimeout: () => 0, clearTimeout() {},
    requestAnimationFrame: () => 0, alert() {}, confirm: () => false,
};
g.window = g; g.globalThis = g;
vm.createContext(g);
const epilogue = ';globalThis.__t={computeLayout:()=>computeLayout(),autoLayout:(s)=>autoLayout(s),'
               + 'setG:(x)=>{G=x;},get:()=>G,K:{ROW_H,HEAD_H,BAND_GAP,MIN_UN_ROWS,COL_W,STAGE_ORDER}};';
try { vm.runInContext(m[1] + epilogue, g, { timeout: 5000 }); }
catch (e) { console.log('  ✗ 頁面 script 執行就爆了：' + e.message); process.exit(1); }
const T = g.__t;
const K = T.K;

// 造一份圖：stage / 是否實裝
const node = (id, stage, implanted, power) => ({ id, dir: id, name: id, stage, implanted, power: power || 1 });
const setG = (nodes) => T.setG({ nodes, edges: [] });

console.log('— 上下分區 —');
{
    setG([
        node('a1', 'Adult', true, 10), node('a2', 'Adult', true, 20),
        node('a3', 'Adult', false, 15),
        node('p1', 'Perfect', true, 30),
    ]);
    const L = T.computeLayout();
    const adult = L.cols.find(c => c.stage === 'Adult');
    ok(adult.un.length === 1 && adult.un[0].id === 'a3', '未實裝的沒被分到上半區');
    ok(adult.im.length === 2, '實裝的數量不對：' + adult.im.length);
    T.autoLayout(true);
    const y = (id) => T.get().nodes.find(n => n.id === id).y;
    ok(y('a3') < L.dividerY, '未實裝應該排在分隔線上面');
    ok(y('a1') > L.dividerY && y('p1') > L.dividerY, '實裝應該排在分隔線下面');
    // 同一階的實裝要照 power 由小到大
    ok(y('a1') < y('a2'), '實裝區沒有照 power 排序');
    // 不同欄的實裝要從同一個 y 起算（分隔線是一條橫線，跨欄對齊）
    ok(y('a1') === y('p1'), '不同欄的實裝起點沒對齊，分隔線會看起來歪掉');
}

console.log('— 畫布寬度不變 —');
{
    // 這是「放上面」而不是「放旁邊」的主要理由：左右並排的話欄寬要加倍。
    setG([node('x', 'Adult', false, 1)]);
    const L = T.computeLayout();
    ok(L.width === K.STAGE_ORDER.length * K.COL_W,
       '畫布寬度變了（應該還是一階一欄）：' + L.width);
    const xs = L.cols.map(c => c.x);
    ok(new Set(xs).size === xs.length, '有兩欄疊在同一個 x');
    for (let i = 1; i < xs.length; i++)
        ok(xs[i] - xs[i-1] === K.COL_W, '欄距不是 COL_W');
}

console.log('— UnStage 是暫存區，不算進未實裝區高度 —');
{
    // ⚠️ 實際會發生的情境：暫存區塞了 50 隻待設定的新角色。
    //    把它算進去的話，未實裝區會變 50 列高、所有實裝角色被推到兩千多 px 以下。
    const nodes = [node('a1', 'Adult', true, 10)];
    for (let i = 0; i < 50; i++) nodes.push(node('u' + i, 'UnStage', false, i));
    setG(nodes);
    const L = T.computeLayout();
    const expected = 40 + K.HEAD_H + K.MIN_UN_ROWS * K.ROW_H + K.BAND_GAP;
    ok(L.dividerY === expected,
       `暫存區把未實裝區撐高了（分隔線 y=${L.dividerY}，應為 ${expected}）`);
    const un = L.cols.find(c => c.stage === 'UnStage');
    ok(un.single === true, 'UnStage 欄不該再分上下（整欄都是未實裝）');
    ok(un.un.length === 50 && un.im.length === 0, 'UnStage 欄的內容不對');
    // 暫存區自己還是從標題底下一路往下排
    T.autoLayout(true);
    const ys = T.get().nodes.filter(n => n.stage === 'UnStage').map(n => n.y).sort((a,b)=>a-b);
    ok(ys[0] === L.unTop, '暫存區沒有從標題下面開始排');
    ok(ys[ys.length-1] === L.unTop + 49 * K.ROW_H, '暫存區的列距不對');
}

console.log('— 未實裝區不會塌成 0 —');
{
    // 全部實裝完之後高度若塌成 0，整張圖會往上位移，剛建立的空間記憶就沒了
    setG([node('a1', 'Adult', true, 10), node('p1', 'Perfect', true, 20)]);
    const none = T.computeLayout();
    setG([node('a1', 'Adult', true, 10), node('a2', 'Adult', false, 5)]);
    const one = T.computeLayout();
    ok(none.dividerY === one.dividerY,
       `未實裝從 0 變 1 就讓整張圖位移了（${none.dividerY} vs ${one.dividerY}）`);
    ok(none.dividerY >= 40 + K.HEAD_H + K.MIN_UN_ROWS * K.ROW_H,
       '未實裝區沒有保留最小高度');
}

console.log('— 未實裝多的時候要撐開 —');
{
    const nodes = [node('a1', 'Adult', true, 99)];
    for (let i = 0; i < 8; i++) nodes.push(node('n' + i, 'Adult', false, i));
    setG(nodes);
    const L = T.computeLayout();
    ok(L.dividerY === 40 + K.HEAD_H + 8 * K.ROW_H + K.BAND_GAP,
       '未實裝超過最小列數時沒有撐開，會疊在一起：' + L.dividerY);
    T.autoLayout(true);
    const ys = T.get().nodes.filter(n => !n.implanted).map(n => n.y);
    ok(new Set(ys).size === ys.length, '未實裝的節點疊在同一個 y 上');
}

console.log('— 算版面與移動節點是分開的 —');
{
    // reload() 只在有節點缺座標時才重排。computeLayout 若會動到座標，
    // 就等於每次 render 都把使用者拖過的位置沖掉。
    setG([node('a1', 'Adult', true, 10), node('a2', 'Adult', false, 5)]);
    T.autoLayout(true);
    const moved = T.get().nodes.find(n => n.id === 'a1');
    moved.x = 777; moved.y = 888;
    T.computeLayout();
    ok(moved.x === 777 && moved.y === 888,
       'computeLayout 動到了節點座標 —— 每次 render 都會沖掉手動排的版面');
    T.autoLayout(true);
    ok(moved.x !== 777 || moved.y !== 888, 'autoLayout 應該要真的重排');
}

console.log('— 可達性：走不到 starter 的算純敵人 —');
{
    // 圖鑑的「已收錄 X / Y」以前用 roster 當母體，但 roster 只擋掉一半：
    // 在 roster 裡卻沒有任何角色進化到它的（biollante / xiquemon / shishimamon /
    // destoroyah）玩家永遠拿不到，卻算在分母裡 —— 永遠停在 129/133，四個 ??? 解不開。
    // 規則改成算的：走不到 starter 就是純敵人。名單會過期，可達性不會。
    const RULES = require('../src/shared/evo-rules.js');
    const G = (nodes, edges) => ({
        nodes: nodes.map(n => typeof n === 'string' ? { id: n, stage: 'Adult' } : n),
        edges: edges.map(([f, t]) => ({ from: f, to: t })),
    });

    let r = RULES.reachableFrom(G(['s', 'a', 'b', 'lone'], [['s', 'a'], ['a', 'b']]), ['s']);
    ok(r.has('s') && r.has('a') && r.has('b'), '沿 evolvesTo 走得到的沒被算進來');
    ok(!r.has('lone'), '沒有任何入口的角色應該被判成純敵人');

    // 環不能讓它轉不停
    r = RULES.reachableFrom(G(['s', 'a', 'b'], [['s', 'a'], ['a', 'b'], ['b', 'a']]), ['s']);
    ok(r.size === 3, '有環時走訪結果不對：' + r.size);

    // starter 讀不到 -> 回 null（別過濾）。跟 roster 讀不到時 fail-open 同一個理由：
    // 資料缺一角不該讓整本圖鑑變空的。
    ok(RULES.reachableFrom(G(['a'], []), []) === null, 'starter 是空的應該回 null');
    ok(RULES.reachableFrom(G(['a'], []), null) === null, 'starter 沒傳應該回 null');
    // starter 本身不在圖上（被 roster 濾掉了）也不能爆
    r = RULES.reachableFrom(G(['a'], []), ['nobody']);
    ok(r && r.size === 0, 'starter 不在圖上時應該回空集合，不是丟例外');

    // ⚠️ 特殊進化不在 evolvesTo 裡（大便獸走 special-evolutions.json）。
    //    純看 evolvesTo 會把牠判成敵人而從圖鑑消失 —— 而牠明明是玩家養出來的。
    const nodes = [{ id: 's', stage: 'Child' }, { id: 'poop', stage: 'Adult' }];
    r = RULES.reachableFrom(G(nodes, []), ['s'], [{ to: 'poop', fromStage: 'Child' }]);
    ok(r.has('poop'), '特殊進化的目標被當成敵人排除了');
    // 條件湊不到就不算可達
    r = RULES.reachableFrom(G(nodes, []), ['s'], [{ to: 'poop', fromStage: 'Ultimate' }]);
    ok(!r.has('poop'), 'fromStage 根本沒有符合的角色，不該算可達');
    // 沒寫 fromStage = 無條件
    r = RULES.reachableFrom(G(nodes, []), ['s'], [{ to: 'poop' }]);
    ok(r.has('poop'), '沒有 fromStage 的規則應該無條件成立');

    // 特殊進化帶出來的那隻，牠自己的後續進化也要跟著算 ——
    // 這就是走訪要跑到不動點（while grew）而不是走一輪的理由。
    r = RULES.reachableFrom(
        G([{ id: 's', stage: 'Child' }, { id: 'poop', stage: 'Adult' }, { id: 'poop2', stage: 'Perfect' }],
          [['poop', 'poop2']]),
        ['s'], [{ to: 'poop', fromStage: 'Child' }]);
    ok(r.has('poop2'), '特殊進化之後的鏈沒有跟著算進來（走訪只跑了一輪）');
}

console.log('— 圖鑑真的用了可達性 —');
{
    // album_server.js 一 require 就 listen，載不進來 -> 只能靜態檢查接線。
    // 漏接的話分母會默默回到 133，而畫面上看起來一切正常。
    const fs2 = require('fs'), path2 = require('path');
    const src = fs2.readFileSync(path2.join(__dirname, '..', 'src', 'album', 'album_server.js'), 'utf8');
    ok(/pruneUnreachable/.test(src), 'album 沒有排除走不到的角色');
    ok(/return pruneUnreachable\(/.test(src), 'loadAll 沒有把結果過濾過再回傳');
    ok(/reachableFrom/.test(src), 'album 沒有用共用的可達性判定（自己另寫一份會分叉）');
    ok(/loadSpecialRules/.test(src), 'album 沒有把特殊進化算進可達性（大便獸會從圖鑑消失）');
}

console.log('— 圖鑑的蒐集程度 —');
{
    // 百分比是那種「算錯也不會報錯、只是數字怪」的東西，而且有兩個一定要守住的邊界：
    //   157/158 不可以顯示 100%（看到滿了卻還有一隻沒收，最惱人）
    //   total=0 不可以變成 NaN%（看起來像壞掉）
    // album.html 的 script 在假 DOM 裡跑，透過尾巴掛的把手取用 countLabel。
    const fs3 = require('fs'), path3 = require('path'), vm3 = require('vm');
    const H = fs3.readFileSync(path3.join(__dirname, '..', 'src', 'album', 'album.html'), 'utf8');
    const mm = H.match(/<script>([\s\S]*?)<\/script>/);
    ok(!!mm, '抓不到圖鑑頁面的 script');
    if (mm) {
        const el2 = () => ({
            style: {}, classList: { add() {}, remove() {}, toggle() {} },
            innerHTML: '', textContent: '', width: 0, height: 0,
            getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }),
            addEventListener() {}, appendChild() {}, querySelectorAll: () => [],
        });
        const g2 = {
            document: { getElementById: () => el2(), createElement: () => el2(),
                        querySelectorAll: () => [], addEventListener() {}, body: el2() },
            addEventListener() {}, removeEventListener() {},
            requestAnimationFrame: () => 1, setInterval: () => 0, setTimeout: () => 0,
            fetch: () => new Promise(() => {}),   // /data 永不回來 -> 只評估模組，不跑 IIFE 後半
            console, Math, JSON,
        };
        g2.window = g2; g2.globalThis = g2;
        vm3.createContext(g2);
        let err2 = null;
        try { vm3.runInContext(mm[1] + ';globalThis.__a={label:(o,t)=>countLabel(o,t)};', g2, { timeout: 5000 }); }
        catch (e) { err2 = e; }
        ok(!err2, '圖鑑頁面 script 執行就爆了：' + (err2 && err2.message));
        if (!err2 && g2.__a) {
            const L = g2.__a.label;
            const pctOf = (s) => { const m2 = String(s).match(/(\d+)%/); return m2 ? Number(m2[1]) : null; };
            ok(pctOf(L(0, 158)) === 0, '0/158 應該是 0%，得到 ' + L(0, 158));
            ok(pctOf(L(158, 158)) === 100, '收滿應該是 100%，得到 ' + L(158, 158));
            // 分母要挑到會讓四捨五入真的翻成 100% 的：199/200 = 99.5%。
            // 原本寫 157/158（99.37%）—— round 也是 99，那條等於沒在測 floor。
            ok(pctOf(L(199, 200)) === 99,
               '199/200 不可以顯示 100%（四捨五入的話就會）—— 得到 ' + L(199, 200));
            ok(pctOf(L(1, 158)) === 0, '1/158 應該向下取整成 0%，得到 ' + L(1, 158));
            ok(pctOf(L(79, 158)) === 50, '一半應該是 50%，得到 ' + L(79, 158));
            // total=0 不會 NaN（owned>=total 那條擋住了），但**不可以謊報 100%** ——
            // 一隻都沒有卻說收滿了，比 NaN 更難發現是壞的。
            ok(!/NaN|Infinity/.test(L(0, 0)), 'total=0 時出現 NaN/Infinity：' + L(0, 0));
            ok(pctOf(L(0, 0)) !== 100, 'total=0 卻顯示 100%（一隻都沒有不該算收滿）：' + L(0, 0));
            // 分子分母與百分比**都要在**（只留一邊都被要求改過，兩個都釘住）
            ok(/\b42\b/.test(L(42, 158)) && /\b158\b/.test(L(42, 158)),
               '缺了分子分母：' + L(42, 158));
            // 標籤要先去掉再比 —— 42 與 158 之間夾著 </b>，直接對正則會永遠不match
            const plain = (s) => String(s).replace(/<[^>]*>/g, '');
            ok(/\d+\s*\/\s*\d+/.test(plain(L(42, 158))),
               '分子分母之間缺了斜線：' + plain(L(42, 158)));
            ok(pctOf(L(42, 158)) === 26, '42/158 無條件捨去應該是 26%，得到 ' + L(42, 158));
        } else if (!err2) { ok(false, '抓不到 countLabel'); }
    }
}

console.log(`\n結果：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
