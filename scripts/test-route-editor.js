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
// 頁面前面還有一小段墊 module 的 script（給 /evo-rules.js 用）→ 取最長的那段才是主程式。
const blocks = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]);
const m = blocks.length ? [null, blocks.reduce((a, b) => (b.length > a.length ? b : a))] : null;
if (!m) { console.log('  ✗ 抓不到頁面 script'); process.exit(1); }
ok(HTML.includes('<script src="/evo-rules.js"></script>'),
   '頁面沒載入共用的 evo-rules.js（可取得的判定會退回 fail-open，整片都算可取得）');

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
// 跟瀏覽器一樣：先墊 module、跑 evo-rules.js，主程式才拿得到 reachableFrom。
vm.runInContext('var module = { exports: {} };' +
    fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'evo-rules.js'), 'utf8'), g);
const epilogue = ';globalThis.__t={computeLayout:()=>computeLayout(),autoLayout:(s)=>autoLayout(s),'
               + 'setG:(x)=>{G=x;},get:()=>G,obtainableSet:()=>obtainableSet(),K:{ROW_H,HEAD_H,BAND_GAP,MIN_UN_ROWS,MIN_NA_ROWS,COL_W,STAGE_ORDER}};';
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

console.log('— 實裝再分：可取得／不可取得 —');
{
    // 可取得 = 從實裝的 starter 沿進化邊走得到。實裝了卻走不到的（純敵人、線接到一半的）
    // 以前跟可取得的混在同一區，要拉線時得一隻隻點開看有沒有人連到它。
    const N = (id, stage, implanted, extra) => ({ ...node(id, stage, implanted, 10), ...extra });
    const E = (from, to) => ({ from, to });
    T.setG({
        nodes: [
            N('s',  'Child', true, { starter: true }),
            N('a',  'Adult', true),            // s → a：可取得
            N('lone', 'Adult', true),          // 實裝了但沒有任何線進來：不可取得
            N('viaUn', 'Adult', true),         // 只有未實裝的 u 連到它：遊戲裡等於沒有線
            N('u',  'Child', false),           // 未實裝
            N('poop', 'Adult', true),          // 只靠特殊進化取得
            N('ghostStarter', 'Child', false, { starter: true }),  // 未實裝的 starter
            N('g1', 'Adult', true),            // 只有未實裝 starter 連到它
        ],
        // s → u 一定要有：真實情況是「可取得的角色 → 未實裝的 → 實裝的」。
        // 少了它，u 本身就沒人連到，viaUn 那條斷言不管過濾在不在都會過（驗過，是假綠）。
        edges: [E('s', 'a'), E('s', 'u'), E('u', 'viaUn'), E('ghostStarter', 'g1')],
        specialRules: [{ to: 'poop', fromStage: 'Child' }],
    });
    const L = T.computeLayout();
    const col = (st) => L.cols.find(c => c.stage === st);
    const ids = (arr) => arr.map(n => n.id).sort().join(',');
    ok(L.reachKnown === true, '有實裝的 starter 卻判成「無法判定」');
    ok(ids(col('Adult').im) === 'a,poop', '可取得的分錯了：' + ids(col('Adult').im));
    ok(ids(col('Adult').na) === 'g1,lone,viaUn', '不可取得的分錯了：' + ids(col('Adult').na));
    ok(ids(col('Child').im) === 's', 'starter 本身應該算可取得');
    ok(ids(col('Child').un) === 'ghostStarter,u', '未實裝的不該跑進實裝區');
    // 個別的理由各釘一條 —— 合在一起驗的話，修壞其中一種情況訊息看不出是哪個
    ok(col('Adult').im.some(n => n.id === 'poop'),
       '只靠特殊進化取得的角色被判成不可取得（大便獸是玩家養得出來的）');
    ok(col('Adult').na.some(n => n.id === 'viaUn'),
       '從未實裝角色連過來的邊被算進去了 —— runtime 會跳過非 roster 目標，那條線不存在');
    ok(col('Adult').na.some(n => n.id === 'g1'),
       '未實裝的 starter 被當成起點了 —— 玩家抽不到牠，牠的後代也就到不了');

    // 位置：未實裝 → 不可取得 → 可取得，由上而下，跨欄對齊
    T.autoLayout(true);
    const y = (id) => T.get().nodes.find(n => n.id === id).y;
    ok(y('u') < L.dividerY, '未實裝應該在第一條分隔線上面');
    ok(y('lone') > L.dividerY && y('lone') < L.divider2Y, '不可取得應該夾在兩條分隔線中間');
    ok(y('a') > L.divider2Y, '可取得應該在第二條分隔線下面');
    ok(y('s') === y('a'), '不同欄的可取得起點沒對齊');
    ok(L.divider2Y - L.dividerY >= 3 * K.ROW_H,
       `不可取得區的高度沒有撐到最多的那欄（Adult 有 3 隻，區高只有 ${L.divider2Y - L.dividerY}px）`);
}
{
    // 一隻不可取得的都沒有時，區域仍要留一列：兩條分隔線疊在一起就分不出誰是誰了
    T.setG({ nodes: [node('s', 'Child', true), node('a', 'Adult', true)], edges: [{ from: 's', to: 'a' }] });
    T.get().nodes[0].starter = true;
    const L = T.computeLayout();
    ok(L.cols.every(c => c.na.length === 0), '這張圖不該有不可取得的');
    // ⚠️ 期望值不能寫成 K.MIN_NA_ROWS * ROW_H —— K 是從被測的頁面讀出來的，
    //    有人把那個常數改成 0，期望值也跟著變 0，這條就永遠會過。寫死「至少一列」。
    ok(L.divider2Y - L.dividerY >= K.ROW_H, '不可取得區是空的時候被壓扁了，兩條線疊在一起');
}
{
    // 沒有任何實裝的 starter → 不知道誰可取得 → 全部當可取得（同圖鑑的 fail-open）。
    // 反過來的話，資料缺一角就讓整個實裝區一起掉進「不可取得」，看起來像全部壞掉。
    T.setG({ nodes: [node('a', 'Adult', true), node('b', 'Adult', true)], edges: [] });
    const L = T.computeLayout();
    ok(L.reachKnown === false, '沒有 starter 時應該標成「無法判定」');
    ok(L.cols.find(c => c.stage === 'Adult').im.length === 2, '沒有 starter 時應該全部當可取得（fail-open）');
    ok(T.obtainableSet() === null, '沒有 starter 時 obtainableSet 應該回 null（＝不知道），不是空集合');
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
