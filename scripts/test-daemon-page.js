#!/usr/bin/env node
'use strict';
/**
 * 驗證 daemon 送出的網頁本身是好的。
 *
 * 存在的理由：daemon.js 把整個前端塞在一個**伺服器端的 template literal** 裡，
 * 所以字串裡的反斜線會被吃掉一層。寫一個換行跳脫字元，組字串時就變成真正的換行，
 * 送到瀏覽器就成了「字串字面值中間有換行」→ 整個 <script> SyntaxError →
 * 頁面所有功能一起死（按鈕沒反應、畫面不更新），而**伺服器端一切正常**：
 * node --check 過、daemon 啟動成功、/state 正常回應。
 *
 * 這種壞法在伺服器端測不到，只能真的把頁面拉下來、對裡面的 script 做語法檢查。
 * 已經踩過一次（右鍵選單的名片），所以釘住。
 *
 * 用法：node scripts/test-daemon-page.js
 */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3099;
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };

const getOn = (port, p) => new Promise((res, rej) => {
    const r = http.get({ host: '127.0.0.1', port, path: p }, (s) => {
        let d = ''; s.on('data', c => d += c); s.on('end', () => res(d));
    });
    r.on('error', rej);
    r.setTimeout(8000, () => { r.destroy(); rej(new Error('timeout')); });
});
const get = (p) => getOn(PORT, p);

// /cmd 是 POST + JSON（前端的 sendCmd 就是這樣送的）——「留空的指定戰鬥」要驗的是
// 伺服器端寫進 force 檔的內容，所以必須走真的端點，不能只檢查原始碼。
const post = (port, p, body) => new Promise((res, rej) => {
    const data = Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST',
                             headers: { 'Content-Type': 'application/json',
                                        'Content-Length': data.length } }, (s) => {
        let d = ''; s.on('data', c => d += c); s.on('end', () => res(d));
    });
    r.on('error', rej);
    r.setTimeout(8000, () => { r.destroy(); rej(new Error('timeout')); });
    r.end(data);
});

// --isolated：只寫 daemon-state.json，不碰正式 color-state.json，也不寫 heartbeat
const child = spawn(process.execPath,
    [path.join(__dirname, '..', 'src', 'daemon', 'daemon.js'), '--isolated'],
    { env: { ...process.env, AGUMON_DAEMON_PORT: String(PORT) }, stdio: 'ignore' });

const done = (code) => { try { child.kill(); } catch (e) {} process.exit(code); };


// ── 前端實跑 ─────────────────────────────────────────────────────────
// 語法檢查擋不住**執行期**的錯。天氣層跑在 requestAnimationFrame 裡，而 rAF 是在
// wxDraw 開頭就先排好下一幀的 —— 所以中途丟例外不會停、也不會有任何徵兆，
// 畫面只是少畫了後半段。實際踩到的：雨滴池寫死 120 個，雷雨要 150 →
// 讀到 undefined 丟例外，而例外發生在雲畫完之後，「雷雨」看起來就跟陰天一模一樣。
//
// 所以這裡把頁面的 script 真的跑起來，用假的 canvas 記錄畫了什麼。
function renderProbe(js, html, daemonSrc) {
    const vm = require('vm');
    const calls = [];
    const args = [];
    const ctx2d = () => new Proxy({}, {
        get(t, k) {
            if (k === 'canvas') return { width: 416, height: 320 };
            if (k === 'measureText') return () => ({ width: 8 });
            if (k === 'createLinearGradient') return () => ({ addColorStop() {} });
            if (typeof k === 'string' &&
                /^(fill|stroke|clear|begin|move|line|arc|ellipse|close|save|restore|translate|scale|rect|drawImage|fillText|setLineDash)/.test(k))
                // 參數也留著：拎起／放下的上下位移只能從「畫在哪個 y」看出來，
                // 只記方法名的話「有沒有動」完全測不到。
                return (...a) => { calls.push(k); args.push([k, a]); };
            return undefined;
        },
        set() { return true; },
    });
    const el = () => ({
        style: {}, dataset: {}, classList: { toggle() {}, add() {}, remove() {} },
        width: 416, height: 320, offsetWidth: 416, offsetHeight: 320, offsetLeft: 0, offsetTop: 0,
        value: '', textContent: '', innerHTML: '',
        getContext: () => ctx2d(),
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 416, height: 320 }),
        addEventListener() {}, appendChild() {}, append() {}, contains: () => false, querySelectorAll: () => [],
    });
    let raf = null;
    const g = {
        // createElement：天氣層用暫存畫布（光柱／雲加濃蓋在角色身上），畫的東西一樣記進 calls
        document: { getElementById: () => el(), createElement: () => el(), querySelectorAll: () => [], addEventListener() {}, body: el() },
        requestAnimationFrame: (f) => { raf = f; return 1; },
        setInterval: () => 0, setTimeout: () => 0, clearTimeout() {},
        fetch: () => new Promise(() => {}),
        innerWidth: 1200, innerHeight: 800, confirm: () => false, console,
        // 頁面會在 window 上掛 mousemove / mouseup（長壓拖曳要追到畫布外面）。
        // 假環境少一個方法，頁面 script 就整支載不起來 —— 而那不是頁面壞了，是探針缺東西。
        addEventListener() {}, removeEventListener() {},
    };
    g.window = g; g.globalThis = g;
    vm.createContext(g);
    // 頂層的 let/const 不會變成 context 的屬性 → 補一段尾巴把要用的東西露出來
    const epilogue = ';globalThis.__p={sky:(s,c,n)=>{wxState.sky=s;wxState.cold=!!c;wxState.night=!!n;wxParts=null;},'
                   + 'view:(v)=>{view=v;},'
                   // 拎起／放下的上下位移在 drag 這個模組層變數裡，從外面碰不到 -> 開個把手
                   + 'hold:(d)=>{drag=d;},lift:()=>liftNow(),handoff:(y)=>dragHandoff(y),getDrag:()=>drag,'
                   + 'failMsg:(r,a)=>failMsg(r,a),'
                   + 'ranchFull:()=>ranchFull(),yardBlocked:()=>yardBlocked(),'
                   + 'dot:{sv:(v)=>setView(v),cw:()=>CW,ch:()=>CH},'
                   + 'jg:{sync:(j)=>syncJogress(j),opts:()=>jgOptions(),picked:()=>jgPicked(),'
                   +     'text:(o)=>jogressConfirmText(o),when:WHEN,apply:()=>applyWhen()},'
                   + 'setYard:(y)=>{lastYard=y;},setState:(x)=>{lastState=x;},'
                   // dev 走動範圍：把框真的畫一次，才驗得到幾何（框畫在哪、多大）
                   + 'drawZones:(z,ctx)=>{zoneBoxes=z;showZones=true;drawZones(ctx);},'
                   + 'yardSprite:(s)=>{yardSprite=s;},'
                   + 'K:{LIFT_DOTS,LIFT_MS,FALL_MS,CW,CH,LONGPRESS_MS}};';
    try { vm.runInContext(js + epilogue, g, { timeout: 5000 }); }
    catch (e) { ok(false, '頁面 script 執行就爆了：' + e.message); return; }
    ok(!!g.__p, '抓不到前端的內部狀態（探針壞了，不是頁面壞了）');
    if (!g.__p) return;
    g.__p.view('yard');

    // 每種天氣都要能畫完一整幀而不丟例外
    const run = (sky, cold, t0, frames = 4, night = false) => {
        g.__p.sky(sky, cold, night);
        calls.length = 0;
        for (let i = 0; i < frames; i++) {
            try { raf(t0 + i * 17); }
            catch (e) { return { err: e.message, n: {} }; }
        }
        const n = {};
        for (const c of calls) n[c] = (n[c] || 0) + 1;
        return { err: null, n };
    };

    const SKIES = ['clear', 'cloudy', 'rain', 'storm', 'thunder'];
    let t = 1000;
    const got = {};
    for (const sky of SKIES) for (const cold of [false, true]) {
        const r = run(sky, cold, t); t += 500;
        ok(!r.err, `天氣 ${sky}${cold ? '+寒流' : ''} 畫到一半丟例外：${r.err}`);
        if (!cold) got[sky] = r.n;
    }

    // 雨量要隨嚴重度遞增。只驗「有沒有丟例外」的話，把 n 打成 0 也會過。
    const rainOf = (s) => (got[s] && got[s].lineTo) || 0;
    ok(rainOf('cloudy') === 0, '陰天不該下雨');
    ok(rainOf('rain') > 0, '雨天沒有畫出任何雨絲');
    ok(rainOf('storm') > rainOf('rain'), `大雨的雨量沒有比雨天多（${rainOf('storm')} vs ${rainOf('rain')}）`);
    ok(rainOf('thunder') > rainOf('storm'), `雷雨的雨量沒有比大雨多（${rainOf('thunder')} vs ${rainOf('storm')}）`);
    // 晴天不畫方塊；寒流的風是點陣（fillRect）→ 拿來確認寒流真的疊上去了
    ok(!(got.clear && got.clear.fillRect), '晴天不該有點陣粒子');
    const coldRun = run('clear', true, t); t += 500;
    ok((coldRun.n.fillRect || 0) > 0, '寒流沒有畫出冷風');
    // 閃電：整片 fillRect。時間往後跳一大段，確保排到下一次閃。
    const bolt = run('thunder', false, t + 60000, 6);
    ok((bolt.n.fillRect || 0) > 0, '雷雨沒有閃電');

    // ── 夜裡不該有陽光 ──────────────────────────────────────────────
    // 晴天的光柱是**陽光**。天黑了還有幾道斜射的亮帶，看起來不是「晚上的晴天」，
    // 是畫面壞了。這一條是這次改動的主詞，所以連「白天還在畫」一起釘住 ——
    // 只驗夜裡沒有的話，把光柱整個刪掉也會過。
    console.log('— 夜裡不該有陽光 —');
    t += 2000;
    const clearDay   = run('clear', false, t, 4, false); t += 500;
    const clearNight = run('clear', false, t, 4, true);  t += 500;
    ok((clearDay.n.fill || 0) > 0, '白天的晴天沒有畫出光柱（這條顧的是別把功能整個砍掉）');
    ok((clearNight.n.fill || 0) === 0,
       `夜裡的晴天還在畫光柱（${clearNight.n.fill} 次 fill）`);
    ok((clearNight.n.lineTo || 0) === 0, '夜裡的晴天還在畫光柱的邊');

    // 入夜只關掉陽光，其它表演照舊 —— 雨會下到半夜，寒流也不會因為天黑就停。
    const rainNight = run('rain', false, t, 4, true); t += 500;
    ok((rainNight.n.lineTo || 0) > 0, '入夜之後雨就不下了');
    const coldNight = run('clear', true, t, 4, true); t += 500;
    ok((coldNight.n.fillRect || 0) > 0, '入夜之後寒流的冷風就不吹了');
    // 閃電的下一次時間是模組層變數，前面那次雷雨已經把它排到未來了 ——
    // 時間要跳得夠遠才保證排到下一次閃，不然這條會偶爾紅在「時機沒對上」而不是功能壞了。
    const boltNight = run('thunder', false, t + 600000, 6, true);
    ok((boltNight.n.fillRect || 0) > 0, '入夜之後就不打雷了');

    // ── 拎起來的判定時間 ────────────────────────────────────────────
    // 數字本身是手感，不該由測試決定；但有上下界：太長會像介面在卡，
    // 太短會把「摸摸」（有意識地點一下大約 60–120ms）判成「拎起來」。
    ok(g.__p.K.LONGPRESS_MS <= 150,
       `長壓判定 ${g.__p.K.LONGPRESS_MS}ms 太久，拎起來會有等待感`);
    ok(g.__p.K.LONGPRESS_MS >= 100,
       `長壓判定 ${g.__p.K.LONGPRESS_MS}ms 太短，點一下摸摸會被判成拎起來`);

    // ── 拎起／放下的上下位移 ────────────────────────────────────────
    // 這段只在前端跑（伺服器合成的那張圖裡根本沒有被拿著的那隻），除了這裡沒別的地方測得到。
    // 要驗的是「身體上浮、影子留在地上」—— 兩個一起浮只是整隻平移，看不出被拿起來。
    console.log('— 前端實跑（拎起／放下）—');
    g.__p.sky('clear', false);        // 天氣關掉，畫面上只剩被拿著的那隻
    const K = g.__p.K;
    const dot = (v) => [[v]];         // 1x1 的假精靈，身體只會有一個 fillRect
    const mkDrag = (phase, ageMs, liftFrom) => ({
        id: 'x', frames: [dot([255, 0, 0]), dot([0, 255, 0])],
        ox: 0, oy: 0, x: 10, y: 10,
        phase, t0: Date.now() - ageMs, liftFrom: liftFrom || 0,
    });
    const frameAt = (d) => {
        g.__p.hold(d);
        args.length = 0;
        try { raf(t + 90000); } catch (e) { return { err: e.message }; }
        const body = args.filter(a => a[0] === 'fillRect').map(a => a[1][1]);
        const shad = args.filter(a => a[0] === 'ellipse').map(a => a[1][1]);
        return { body: body.length ? body[body.length - 1] : null,
                 shadow: shad.length ? shad[0] : null };
    };

    const start = frameAt(mkDrag('lift', 0));
    ok(!start.err, '拿起來的第一幀就丟例外：' + start.err);
    ok(start.body !== null, '拿在手上卻沒有把牠畫出來');
    const top = frameAt(mkDrag('lift', K.LIFT_MS + 50));
    ok(top.body !== null && top.body < start.body,
       `抬起來之後身體應該往上（y 變小），得到 ${start.body} -> ${top.body}`);
    // 幅度也要對，不然「有動一點點」也會過
    ok(Math.abs((start.body - top.body) - K.LIFT_DOTS * (K.CH / 2)) < 1,
       `抬起的高度不對：${start.body - top.body}px，應為 ${K.LIFT_DOTS * (K.CH / 2)}px`);
    // 關鍵：影子不能跟著浮起來
    ok(start.shadow !== null && top.shadow !== null, '沒有畫影子（離地感全靠它）');
    ok(Math.abs(top.shadow - start.shadow) < 0.001,
       `影子跟著身體一起浮起來了（${start.shadow} -> ${top.shadow}）—— 那只是整隻平移`);

    // ── 交接：同一隻在畫面上永遠只畫一份（回報過「拎起／放下會閃爍」）──────
    // 伺服器那張會略過拿著的那隻；前端手上另外畫一份。兩份都有 = 一瞬間兩隻，
    // 兩份都沒有 = 一瞬間消失。換手要等伺服器的新畫面。
    {
        const HO = g.__p.handoff, GD = g.__p.getDrag;
        ok(typeof HO === 'function' && typeof GD === 'function', 'dragHandoff 沒有露出來，這節等於沒測到');
        if (typeof HO === 'function') {
            // 拿起：伺服器那張裡牠還在地上 → 手上那份先別畫
            const w = frameAt({ ...mkDrag('lift', 0), wait: true });
            ok(w.body === null && w.shadow === null,
               '伺服器的畫面裡牠還在地上，手上卻又畫了一份（一瞬間兩隻）');
            // 起點故意給 5 秒前：等交接的期間時間照走，沒重設的話第一幀就已經浮到頂了
            g.__p.hold({ ...mkDrag('lift', 5000), wait: true });
            HO({ pets: [{ id: 'x' }] });
            ok(GD() && GD().wait === true, '伺服器那張還有牠，就開始畫手上那份了');
            HO({ pets: [{ id: 'other' }] });
            ok(GD() && GD().wait === false, '伺服器那張已經沒有牠了，手上那份還不畫（會消失一下）');
            ok(GD() && Date.now() - GD().t0 < 1000,
               '開始畫的時候沒有重設浮起動畫的起點（第一幀就已經浮到半空，看起來像瞬移）');

            // 放下：落地之後要繼續停在地上畫，直到伺服器那張把牠畫回來
            const landed = { ...mkDrag('landed', 99999, 2.5) };
            const lf = frameAt(landed);
            ok(lf.body !== null, '落地之後就不畫了 —— 伺服器的畫面還沒畫回來，這段期間牠會消失');
            // start = 剛拿起的第一幀（還沒開始浮）= 地面高度
            ok(lf.body === start.body, `落地等交接的那份不在地面上（${lf.body} vs 地面 ${start.body}）`);
            g.__p.hold(landed);
            HO({ pets: [{ id: 'other' }] });
            ok(GD() === landed, '伺服器那張還沒畫回來就收掉手上那份了（會消失一下）');
            HO({ pets: [{ id: 'x' }] });
            ok(GD() === null, '伺服器那張已經畫回來了，手上那份還沒收（一瞬間兩隻）');
        }
        // 換手要跟新畫面的 draw() 在同一個 task：dragHandoff 之後、draw(y.lines) 之前不能有 await
        const py = (js.match(/async function pollYard\(\)\{[\s\S]*?\n\}/) || [''])[0];
        // 找的是**呼叫**（帶大括號那句）—— dragHandoff 那行的註解裡就寫著 draw(y.lines)，
        // 只找字串的話會找到註解，中間插什麼都測不到（驗過，是假綠）
        const ih = py.indexOf('dragHandoff(y);'), idr = py.indexOf('{ draw(y.lines); }', ih);
        // 去掉註解再看（那行的註解本身就寫著「中間不能有 await」）
        ok(ih > 0 && idr > ih && !/\bawait\b/.test(py.slice(ih, idr).replace(/\/\/[^\n]*/g, '')),
           'pollYard 的換手跟畫新畫面不在同一個 task 裡 —— 中間會有一幀兩邊對不上');
        // 落地時不能直接收掉（舊版就是這樣閃的）
        // 看「dropAt 之後、保險計時器之前」這一段：舊版就是在這裡 drag=null
        const mu = (js.match(/d\.phase='landed';[\s\S]*?\}, FALL_MS\);/) || [''])[0];
        const iDrop = mu.indexOf('dropAt(d.id,d.x,d.y)'), iSafe = mu.indexOf('setTimeout(', iDrop);
        ok(iDrop > 0 && iSafe > iDrop && !/drag\s*=\s*null/.test(mu.slice(iDrop, iSafe)),
           '落地的那一刻就把手上那份收掉了 —— 伺服器的畫面要兩趟來回才畫回來，中間會消失');
        g.__p.hold(null);
    }

    // ── dev 走動範圍：框要框住**身體**，不是只框左上角 ──────────────
    // 可走範圍講的是左上角能站到哪，框只畫那個範圍的話會縮在該區左上角，
    // 跟角色實際走的地方對不起來（回報過「實線都在左上，應是 bug」）。
    {
        const SPR = 16;
        g.__p.yardSprite(SPR);
        const zone = { minX: 0, maxX: 14, minY: 0, maxY: 8, anchor: { x: 7, y: 4 } };
        args.length = 0;
        g.__p.drawZones([zone], ctx2d());
        const rects = args.filter(a => a[0] === 'strokeRect').map(a => a[1]);
        ok(rects.length === 1, `一塊區域畫了 ${rects.length} 個框（應只有一個：身體範圍）`);
        if (rects.length) {
            const [x, y, w, h] = rects[0];
            ok(Math.abs(w - (zone.maxX - zone.minX + SPR) * K.CW) < 1,
               `框的寬度是 ${w}px，應為 (可走範圍 + 一個角色) = ${(zone.maxX - zone.minX + SPR) * K.CW}px`);
            ok(Math.abs(h - (zone.maxY - zone.minY + SPR) * (K.CH / 2)) < 1,
               `框的高度是 ${h}px，應為 ${(zone.maxY - zone.minY + SPR) * (K.CH / 2)}px`);
            ok(x < 1 && y < 1, `框的左上角應貼齊區域原點，得到 (${x},${y})`);
        }
        // 定位點的十字要落在框的正中央
        const arcs = args.filter(a => a[0] === 'arc').map(a => a[1]);
        ok(arcs.length === 1, '定位點沒有畫出來');
        if (arcs.length && rects.length) {
            const [ax, ay] = arcs[0];
            const [x, y, w, h] = rects[0];
            ok(Math.abs(ax - (x + w / 2)) < 1.5 && Math.abs(ay - (y + h / 2)) < 1.5,
               `定位點 (${ax},${ay}) 不在框的中心 (${x + w / 2},${y + h / 2})`);
        }
    }

    // 放下：從離地高度掉回地面
    const falling = frameAt(mkDrag('fall', 0, -K.LIFT_DOTS));
    const landed  = frameAt(mkDrag('fall', K.FALL_MS + 50, -K.LIFT_DOTS));
    ok(falling.body !== null && landed.body !== null && landed.body > falling.body,
       `落下時身體應該往下，得到 ${falling.body} -> ${landed.body}`);
    ok(Math.abs(landed.body - start.body) < 1,
       `落地位置沒有回到地面：${landed.body}，應為 ${start.body}`);

    g.__p.hold(null);                 // 收乾淨，別留給後面的斷言

    // ── 營地滿了要在按下去之前就知道 ────────────────────────────────
    // 回報過「按收進營地先被問『確定嗎？』，按了確定才說營地已滿」。
    // 人數前端本來就有（院子分頁的 /yard、家裡分頁的 /state），只是以前沒拿來用。
    // ── 進化表演中不能切去營地 ──────────────────────────────────────
    console.log('— 進化中不能去營地 —');
    {
        const YB = g.__p.yardBlocked;
        ok(typeof YB === 'function', 'yardBlocked 沒有露出來，這節等於沒測到');
        if (typeof YB === 'function') {
            g.__p.setState({ kind: 'evo' });
            const why = YB();
            ok(typeof why === 'string' && why.length > 0, '進化表演中切去營地沒有被擋下');
            ok(/進化/.test(why || ''), '擋下來卻沒講是因為進化（使用者會以為按鈕壞了）：' + why);
            // 其它時候不能誤擋 —— 走路、睡覺、戰鬥都照常能去
            for (const k of ['single', 'sleep', 'battle', 'card', 'drop'])  {
                g.__p.setState({ kind: k });
                ok(YB() === null, `${k} 的時候也被擋了（只有進化該擋）`);
            }
            // 剛開頁面還沒拿到 /state：不知道就別擋
            g.__p.setState(null);
            ok(YB() === null, '還沒拿到 /state 就擋了 —— 剛開頁面會切不過去');
        }
        // 只擋「去營地」，不擋「回前線」：人在營地時才開始進化的話要能回來看
        const toggle = (js.match(/if\(b\.dataset\.cmd==='yard'\)\{[\s\S]*?setView\(view==='yard'\?'home':'yard'\);/) || [''])[0];
        ok(/if\(view!=='yard'\)\{[\s\S]*yardBlocked\(\)/.test(toggle),
           '營地鈕的防呆沒有限定在「從前線出發」—— 人在營地時會被困住回不來');
    }

    // ── 合體進化的按鈕（第 2 期）──────────────────────────────────
    console.log('— 合體進化按鈕 —');
    {
        const J = g.__p.jg;
        ok(J && typeof J.sync === 'function', '合體的前端函式沒有露出來，這節等於沒測到');
        if (J) {
            const one = { id: 'lady1', num: 2, camp: 'ladydevimon', campName: 'LadyDevimon',
                          to: 'mastemon', toName: 'Mastemon' };
            const two = { ...one, id: 'lady2', num: 4 };
            J.sync(null);
            ok(J.when.jogress() === false, '沒有候選時按鈕卻要露臉');
            J.sync({ frontName: 'Angewomon', options: [] });
            ok(J.when.jogress() === false, '候選是空的時按鈕卻要露臉（應該整顆不出現，不是灰掉）');
            J.sync({ frontName: 'Angewomon', options: [one] });
            ok(J.when.jogress() === true, '有候選時按鈕沒有露臉');
            ok(J.when.jogressMulti() === false, '只有一組時不需要下拉');
            ok(J.picked() && J.picked().id === 'lady1', '只有一組時應該直接用它');
            // 確認文案（規格決策 3）：哪一隻、救不回來、前線會變成誰
            const t = J.text(one);
            for (const [k, why] of [['#2', '營地編號'], ['LadyDevimon', '營地那隻是誰'], ['永久', '永久'],
                                    ['救不回來', '救不回來'], ['Angewomon', '前線那隻是誰'], ['Mastemon', '會變成誰']])
                ok(t.includes(k), `確認文案沒講${why}：${t}`);
            ok(/前線/.test(t), '確認文案沒講清楚影響的是**前線**那隻（在營地畫面按的人會搞混）');
            J.sync({ frontName: 'Angewomon', options: [one, two] });
            ok(J.when.jogressMulti() === true, '營地有兩隻能合體時沒有下拉可選（只做第一組＝擲骰子）');

            // applyWhen 真的有去藏／露（探針預設的 querySelectorAll 回空陣列，不換掉的話這裡永遠測不到）
            const els = [
                { dataset: { when: 'jogress', scope: 'both' }, style: {} },
                { dataset: { when: 'jogressMulti', scope: 'both' }, style: {} },
                { dataset: { when: 'jogress', scope: 'home' }, style: {} },   // 探針現在在 yard 畫面
            ];
            const qsa = g.document.querySelectorAll;
            g.document.querySelectorAll = (sel) => sel === '[data-when]' ? els : [];
            try {
                J.sync({ frontName: 'Angewomon', options: [one] });
                ok(els[0].style.display === '', '有候選時合體鈕沒有被露出來');
                ok(els[1].style.display === 'none', '只有一組時下拉沒有被藏起來');
                ok(els[2].style.display === 'none', '不屬於這個畫面的鈕被 data-when 露出來了（scope 被蓋掉）');
                J.sync(null);
                ok(els[0].style.display === 'none' && els[1].style.display === 'none', '沒有候選時沒有藏起來');
            } finally { g.document.querySelectorAll = qsa; }
            J.sync(null);
        }
        // setView 會把所有 [data-scope] 重設顯示 —— applyWhen 必須在它**之後**，不然切畫面時合體鈕會冒出來
        {
            const sv = (js.match(/function setView\(v\)\{[\s\S]*?\n\}/) || [''])[0];
            const iScope = sv.indexOf("querySelectorAll('[data-scope]')"), iWhen = sv.indexOf('applyWhen()');
            ok(iScope > 0 && iWhen > iScope, 'setView 沒有在重設 data-scope 之後套 applyWhen（切畫面時沒候選的合體鈕會冒出來）');
        }
        {
        }
        // 按鈕的定義與白名單
        const btnDef = (daemonSrc.match(/\['jogress',[^\]]*\]/) || [''])[0];
        ok(/when: 'jogress'/.test(btnDef) && /accent: true/.test(btnDef),
           '合體鈕的定義不對（要 when/accent）：' + btnDef);
        // 只在前線：進化演出在前線，在營地按只會看到營地少一隻，變身那一刻看不到
        ok(/scope: 'home'/.test(btnDef), '合體鈕不是只在前線出現：' + btnDef);
        ok(/id="jgsel"[^>]*data-scope="home"/.test(html), '選合體對象的下拉不是只在前線出現');
        ok(!/dev: true/.test(btnDef), '合體鈕被標成 dev —— 它是玩家功能，release 會看不到');
        const devOnly = (daemonSrc.match(/const DEV_ONLY\s*=\s*new Set\(\[([^\]]*)\]/) || [])[1] || '';
        ok(devOnly && !/jogress/.test(devOnly), '合體被放進 DEV_ONLY —— release 版網頁按了會被伺服器擋掉');
        ok(/jogress:\s*\(a\) => a\.which \? \['jogress', a\.which, 'yes'\] : null/.test(daemonSrc),
           '/cmd 的白名單沒有合體（或沒補 yes —— CLI 會吊在等確認）');
        const ib = html.indexOf('data-cmd="jogress"'), ic = html.indexOf('data-cmd="card"');
        ok(ib > 0 && ic > 0 && ib < ic, '合體鈕沒有放在按鈕列最前面');
        ok(/data-cmd="jogress"[^>]*data-when="jogress"/.test(html), '送出的頁面上合體鈕沒有 data-when（會一直露臉）');
        ok(/id="jgsel"[^>]*data-when="jogressMulti"/.test(html), '頁面上沒有選合體對象的下拉');
    }

    console.log('— 營地滿了先擋 —');
    const RF = g.__p.ranchFull;
    ok(typeof RF === 'function', 'ranchFull 沒有露出來，這節等於沒測到');
    if (typeof RF === 'function') {
        g.__p.setYard(null); g.__p.setState(null);
        ok(RF() === null, '什麼資料都還沒有時應該回 null（別擋，讓 CLI 那道去判）');

        // 家裡分頁：只有 /state
        g.__p.setState({ ranch: { kept: 5, cap: 5 } });
        ok(RF() && RF().full === true, '家裡分頁沒認出營地已滿');
        g.__p.setState({ ranch: { kept: 4, cap: 5 } });
        ok(RF() && RF().full === false, '沒滿卻被當成滿的（正常的收進營地會被擋掉）');

        // 院子分頁：/yard 比較新，要優先
        g.__p.setYard({ kept: 5, cap: 5 });
        g.__p.setState({ ranch: { kept: 1, cap: 5 } });
        ok(RF().kept === 5, '/yard 比 /state 新，應該優先採用它');

        // 舊版的 /state 沒有 ranch 欄位 → 當成不知道，不要擋
        g.__p.setYard(null); g.__p.setState({ tick: 1 });
        ok(RF() === null, '舊版 /state 沒有 ranch 欄位時應該回 null，不是當成 0/0 亂擋');
        g.__p.setYard(null); g.__p.setState(null);
    }

    // ── 指令失敗時訊息列要說出理由 ──────────────────────────────────
    // 回報過「daemon 執行收進營地的提示沒變」。後端其實是對的（回 ok:false 加
    // 「營地已滿（5/5）…」），但前端只把動作名放進訊息列、真正的理由塞到畫布下方的
    // 輸出區 —— 按了鈕只看到一句沒資訊的紅字。
    console.log('— 失敗訊息 —');
    const F = g.__p.failMsg;
    ok(typeof F === 'function', 'failMsg 沒有露出來，這節等於沒測到');
    if (typeof F === 'function') {
        ok(F({ ok: false, output: '營地已滿（5/5）。先 vpet release <編號> 騰出位置。' }, 'keep')
             .includes('營地已滿'),
           '失敗訊息沒有把 CLI 的理由帶上來（使用者只會看到「失敗：keep」）');
        // CLI 第一行是結論，後面常是清單或細節 —— 訊息列只要第一行
        const multi = F({ ok: false, output: '第一行結論\n第二行細節\n第三行' }, 'x');
        ok(multi === '第一行結論', '多行輸出應該只取第一行，得到 ' + JSON.stringify(multi));
        // 前面的空行不能讓它變成空訊息
        ok(F({ ok: false, output: '\n   \n實際內容' }, 'x') === '實際內容',
           '開頭的空白行讓訊息變空了');
        // error 優先（不是走 CLI 的那些指令用這個）
        ok(F({ ok: false, error: '要指定是哪一隻', output: '別的' }, 'x') === '要指定是哪一隻',
           'r.error 應該優先於 output');
        // 兩個都沒有才退回動作名 —— 這是舊版**唯一**會走到的分支
        ok(F({ ok: false }, 'keep') === '失敗：keep', '什麼都沒有時應該退回動作名');
        ok(F({ ok: false, output: '   ' }, 'keep') === '失敗：keep', '全空白的輸出應該視同沒有');
    }

    // ── 營地畫小一號 ────────────────────────────────────────────────
    // ⚠️ 放在最後：setView 會改 view，前面那些測試依賴探針一開始設的 yard 畫面。
    console.log('— 營地 dot 畫小一號 —');
    {
        const D = g.__p.dot;
        ok(D && typeof D.sv === 'function', 'setView／CW 沒有露出來，這節等於沒測到');
        if (D) {
            D.sv('yard');
            ok(D.cw() === 6 && D.ch() === 12, `營地的 dot 大小不對（要 6x12，得到 ${D.cw()}x${D.ch()}）`);
            ok(D.ch() === 2 * D.cw(), '營地的 dot 不是正方形（CH 必須是 2×CW）');
            D.sv('home');
            ok(D.cw() === 8 && D.ch() === 16, `回前線之後 dot 大小沒換回來（得到 ${D.cw()}x${D.ch()}）—— 前線會跟著縮小`);
        }
    }
}

// 等 daemon 真的開始聽，而不是固定睡一段時間。
// 固定 2 秒撐了一陣子，但那是在賭機器當下的負載 —— 前一支測試在用 sharp 轉圖、
// 或 daemon 啟動路徑多做了一點事，就會連不上而紅一整支，症狀（ECONNREFUSED）
// 又完全指不到真正的原因。
async function waitReady(ms = 20000) {
    const deadline = Date.now() + ms;
    for (;;) {
        try { await get('/state'); return; }
        catch (e) {
            if (Date.now() > deadline) throw new Error('daemon 起不來（等了 ' + ms + 'ms）：' + e.message);
            await new Promise(r => setTimeout(r, 100));
        }
    }
}

setTimeout(async () => {
    try {
        await waitReady();
        console.log('— 網頁 —');
        const html = await get('/');
        ok(html.includes('<canvas id="pet"'), '網頁沒有畫布');

        const js = (html.match(/<script>([\s\S]*)<\/script>/) || [])[1] || '';
        ok(js.length > 500, '抓不到內嵌的 script');

        // 核心檢查：瀏覽器拿到的 JS 語法必須是好的
        let err = null;
        try { new Function(js); } catch (e) { err = e; }
        ok(!err, `前端 JS 語法錯誤：${err && err.message}（頁面所有功能都會死）`);

        // dev 介面 on/off：dev 限定的東西都要掛 devonly，關掉才藏得到；開關列不能被當成指令列送出
        {
            ok(/body\.nodev \.devonly\{display:none!important\}/.test(html), 'dev 介面關掉的 CSS 不在');
            ok(/id="devui"[\s\S]*?data-on="1">on<[\s\S]*?data-on="0">off</.test(html), '進階區沒有 dev介面 on/off');
            ok(/#adv \.form:not\(#devui\)/.test(js), 'dev介面列會被當成指令列（按了送出空指令）');
            const devRows = html.match(/<div class="form[^"]*"[^>]*>\s*<span class="lbl">[^<]*<span class="devtag">/g) || [];
            ok(devRows.length >= 5 && devRows.every(r => /devonly|id="devui"/.test(r)), '進階區有 dev 列沒掛 devonly：' + devRows.filter(r => !/devonly|id="devui"/.test(r)).join(' | '));
            const devBtns = html.match(/<button data-cmd="[^"]*"[^>]*>[^<]*<span class="devtag">/g) || [];
            ok(devBtns.length >= 2 && devBtns.every(b => /class="devonly"/.test(b)), '主列有 dev 鈕沒掛 devonly');
            ok(/<span class="devonly">\s*<label class="k">天氣預覽/.test(html) && /id="zonelayout"[\s\S]*?<\/label><\/span>/.test(html), '營地的預覽區沒包進 devonly');
            // 實跑 setDevUi：off → body 掛 nodev、預覽歸回自動並觸發 change；on → 拿掉
            const fnSrc = (js.match(/function setDevUi\(on\)\{[\s\S]*?\n\}/) || [''])[0];
            const els = { wxsel: { value: 'rain' }, festsel: { value: 'halloween' }, wxcold: { checked: true },
                          wxnight: { checked: false }, zonebox: { checked: true } };
            const fired = [];
            for (const [k, e] of Object.entries(els)) e.dispatchEvent = () => fired.push(k);
            let cls = null;
            const doc = { body: { classList: { toggle: (c, v) => { cls = v ? c : null; } } },
                          getElementById: (id) => els[id] || null, querySelectorAll: () => [] };
            const setDevUi = new Function('document', 'localStorage', 'Event', fnSrc + '\nreturn setDevUi;')(
                doc, { setItem() {} }, function () {});
            setDevUi(false);
            ok(cls === 'nodev', 'dev介面 off 沒有掛上 nodev');
            ok(els.wxsel.value === '' && els.festsel.value === '' && !els.wxcold.checked && !els.zonebox.checked
               && fired.sort().join() === 'festsel,wxcold,wxsel,zonebox', 'dev介面 off 沒把預覽歸回自動：' + fired.join());
            setDevUi(true);
            ok(cls === null, 'dev介面 on 沒有拿掉 nodev');
        }

        // 常見成因：字串字面值裡混進真正的換行。單獨檢出來，訊息才看得懂在說什麼。
        const bad = js.split('\n').filter(l => (l.match(/'/g) || []).length % 2 === 1
                                            && !l.trim().startsWith('//'));
        ok(bad.length === 0,
           `有 ${bad.length} 行的單引號沒有成對（多半是跳脫字元被 template literal 吃掉）：\n      ${bad[0]}`);

        console.log('— 營地 icon 與睡覺提示 —');
        // 觸碰睡著的角色只是叫醒，前端不該回「摸摸 ♥」。這一層測得到的是**送給瀏覽器的
        // 提示表**；「什麼時候算睡著」的行為在 test-mood.js 的「睡覺中觸碰」那節驗。
        const moodTable = (js.match(/MOOD\s*=\s*\{[^}]*\}/) || [''])[0];
        ok(/\bwake\s*:/.test(moodTable),
           `前端 MOOD 表缺 wake → 叫醒時會顯示「摸摸 ♥」（讀到：${moodTable.slice(0, 60)}）`);
        ok(html.includes('⛺ 營地'), '營地按鈕的 icon 不是帳篷');
        ok(!html.includes('🐮'), '頁面還留著牛 icon（營地已經不叫牧場了）');

        // 接線檢查：睡覺判定要向 core 借，daemon 不可以自己再寫一份 IDLE_MS ——
        // 兩份規則一旦漂移，就會出現「core 判睡著只叫醒、前端卻說摸摸」這種對不起來的狀況。
        const daemonSrc = require('fs').readFileSync(
            path.join(__dirname, '..', 'src', 'daemon', 'daemon.js'), 'utf8');
        ok(daemonSrc.includes('core.isIdleSleeping'), 'daemon 沒有用 core.isIdleSleeping 判睡覺');
        ok(!/IDLE_MS\s*=/.test(daemonSrc), 'daemon 自己定了一份 IDLE_MS（規則應該只有 core 一份）');

        console.log('— 前端實跑（天氣）—');
        renderProbe(js, html, daemonSrc);

        console.log('— 端點 —');
        const st = JSON.parse(await get('/state'));
        ok(typeof st.tick === 'number', '/state 沒有回傳 tick');

        const y = JSON.parse(await get('/yard'));
        ok(y.ok === true, '/yard 回應失敗');
        ok(typeof y.cols === 'number' && typeof y.rows === 'number',
           '/yard 沒有回傳場地尺寸（空營地時畫布會塌成家裡的大小）');
        // 營地畫小一號：前端 6px 一格，場地實際大小要跟原本（52x40 x 8px）差不多 ——
        // 要縮的是角色，不是場地
        ok(Math.abs(y.cols * 6 - 416) <= 6 && Math.abs(y.rows * 12 - 320) <= 6,
           `營地畫面的實際大小變了（${y.cols * 6}x${y.rows * 12}px，原本 416x320）`);

        console.log('— 日夜由伺服器說了算 —');
        {
            // 天色跟天氣一樣是場景狀態，不是各自看自己的時鐘 —— 之後長成廣場時，
            // 同一時刻所有人的天色必須一致。前端只讀這一份。
            ok(y.weather && typeof y.weather.night === 'boolean',
               '/yard 沒有回傳 night（前端不知道該不該畫陽光，只能自己猜）');
            // 沒有 ?w=night 的話，要等到天黑才驗得了「夜裡不該有陽光」。
            const n = JSON.parse(await get('/yard?w=night'));
            ok(n.weather.night === true, '?w=night 沒有強制入夜');
            const d = JSON.parse(await get('/yard?w=day'));
            ok(d.weather.night === false, '?w=day 沒有強制白天');
            // night 是獨立旗標，跟天空正交 —— 組合不該互相吃掉
            const nr = JSON.parse(await get('/yard?w=rain+night'));
            ok(nr.weather.night === true && nr.weather.sky === 'rain',
               '雨+夜晚組不起來（night 應該跟天空正交，就像寒流那樣）');
            const nc = JSON.parse(await get('/yard?w=night+cold'));
            ok(nc.weather.night === true && nc.weather.cold === true, '夜晚+寒流組不起來');
            // 夜裡的晴天在看板上也不該掛太陽
            const ns = JSON.parse(await get('/yard?w=clear+night'));
            ok(ns.weather.icon.indexOf('🌙') === 0,
               `夜裡的晴天看板圖示是 ${ns.weather.icon}，不是月亮`);
            // 看不懂的參數一律忽略，不要連真實天色都被打掉
            const junk = JSON.parse(await get('/yard?w=banana'));
            ok(junk.weather.night === y.weather.night, '看不懂的 ?w= 把日夜弄掉了');
        }

        console.log('— 營地分區 —');
        {
            const y = JSON.parse(await get('/yard'));
            ok(Array.isArray(y.zones), '/yard 沒有回傳 zones（dev 的走動範圍框畫不出來）');
            if (Array.isArray(y.zones)) {
                ok(y.zones.length === y.kept || y.kept === 0,
                   `zones 有 ${y.zones.length} 塊，但營地裡有 ${y.kept} 隻`);
                const shape = y.zones.filter(z => ['minX', 'maxX', 'minY', 'maxY'].every(k => Number.isFinite(z[k]))
                                                  && z.anchor && Number.isFinite(z.anchor.x));
                ok(shape.length === y.zones.length, 'zones 的欄位不完整（要 minX/maxX/minY/maxY/anchor）');
                // 每隻都待在自己那塊裡 —— 這是分區有沒有真的接上去的端對端檢查
                const stray = (y.pets || []).filter(p => {
                    const z = y.zones[p.zoneIdx];
                    return !z || p.x < z.minX || p.x > z.maxX || p.y < z.minY || p.y > z.maxY;
                });
                ok(stray.length === 0,
                   `有 ${stray.length} 隻不在自己的區域裡：${stray.map(p => p.name).join(',')}`);
                ok((y.pets || []).every(p => Number.isFinite(p.zoneIdx)),
                   'pets 沒有帶 zoneIdx（前端對不出哪個框是誰的）');
            }
            // 切法可以現場換（dev 下拉）
            ok(Array.isArray(y.layouts) && y.layouts.length > 0,
               '/yard 沒有回傳可選的切法清單');
            ok(typeof y.layout === 'string', '/yard 沒有回傳目前用的切法');
            if (Array.isArray(y.layouts) && y.layouts.length > 1) {
                const other = y.layouts.find(n => n !== y.layout);
                const y2 = JSON.parse(await get('/yard?zl=' + encodeURIComponent(other)));
                ok(y2.layout === other, `?zl=${other} 沒有換成那個切法（得到 ${y2.layout}）`);
                ok(JSON.stringify(y2.zones) !== JSON.stringify(y.zones),
                   `?zl=${other} 的區域跟預設一模一樣，等於沒換`);
                const y3 = JSON.parse(await get('/yard?zl=__nope__'));
                ok(JSON.stringify(y3.zones) === JSON.stringify(y.zones),
                   '指定不存在的切法時沒有退回預設');
            }
            ok(html.includes('id="zonelayout"'), '缺少 dev 的切法下拉');

            // 走動範圍編輯器的 dev 鈕。
            // ⚠️ 這裡**不真的按下去** —— 那會 spawn 一個 detached 的編輯器 server，
            //    npm test 跑完會留一個佔著 3005 的孤兒（doctor 那支正是在管這種東西）。
            //    spawn 本身只有幾行且手動驗過；這裡守的是「按鈕在、release 擋得住、
            //    回傳的網址會被開起來」，那三件才是漏了會靜靜壞掉的。
            ok(html.includes('zoneedit'), '缺少 dev 的走動範圍編輯器按鈕');
            ok(/zoneedit[\s\S]{0,220}devtag/.test(html), '走動範圍編輯器沒有標成 dev');
            ok(daemonSrc.includes("'zoneedit'") && /DEV_ONLY[^\n]*zoneedit/.test(daemonSrc),
               'zoneedit 沒進 DEV_ONLY —— release 版的網頁 POST 擋不住');
            ok(/r\.ok\s*&&\s*r\.url/.test(js), '前端沒有把回傳的網址開起來（按了會沒反應）');
            ok(daemonSrc.includes('fs.existsSync(ZONE_EDITOR_JS)'),
               '沒有檢查編輯器檔案在不在（release 樹沒有 src/editor，要給明確訊息而不是靜靜失敗）');

            // dev 開關本身
            ok(html.includes('id="zonebox"'), '缺少 dev 的「走動範圍」開關');
            ok(/zonebox[\s\S]{0,120}devtag/.test(html), '「走動範圍」沒有標成 dev');
            ok(js.includes('drawZones'), '前端沒有畫框的函式');
        }

        console.log('— 指定戰鬥要把參數送到 CLI —');
        {
            // 使用者回報「指定戰鬥填了 Greymon_Virus 卻照樣隨機開打」。真因：applyCommand
            // 先查 COMMANDS（快路徑），而 battle 那條只寫 battleTriggerTs、把 enemy/result
            // 整包丟掉，下面 CLI_ACTIONS.battle 變成永遠走不到的死碼 —— 而且回 ok:true，
            // 畫面照常演一場戰鬥，完全看不出參數被吃了。
            //
            // 另外起一台 daemon，state 指到暫存目錄：上面那台寫的是**真的**
            // force-char.json，測試不該替使用者排一場戰鬥（寫這條測試時就先踩過一次）。
            const fs2 = require('fs'), os2 = require('os');
            const SD = fs2.mkdtempSync(path.join(os2.tmpdir(), 'agumon-cmd-test-'));
            const P2 = 3097;
            const c2 = spawn(process.execPath,
                [path.join(__dirname, '..', 'src', 'daemon', 'daemon.js'), '--isolated'],
                { env: { ...process.env, AGUMON_DAEMON_PORT: String(P2), AGUMON_STATE_DIR: SD },
                  stdio: 'ignore' });
            const post = (action, a) => new Promise((res, rej) => {
                const b = JSON.stringify({ action, args: a });
                const rq = http.request({ host: '127.0.0.1', port: P2, path: '/cmd', method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } },
                    s => { let d = ''; s.on('data', c => d += c); s.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); });
                rq.on('error', rej);
                rq.setTimeout(8000, () => { rq.destroy(); rej(new Error('timeout')); });
                rq.end(b);
            });
            // 等它真的起來（以前固定等 900ms，機器忙的時候還沒 listen → ECONNREFUSED，
            // 而且例外會把後面所有段落一起跳過）
            for (let i = 0; i < 100; i++) {
                try { await getOn(P2, '/state'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); }
            }
            try {
                // 敵人不存在 → 必須是 CLI 回的拒絕。被快路徑吃掉的話會變成 ok:true，
                // 而且真的排了一場隨機戰鬥（＝回報的症狀）。用不存在的名字才不會留下副作用。
                const bad = await post('battle', { enemy: '__nosuchmon__', result: '' });
                ok(bad.ok === false && /找不到敵人/.test(bad.output || ''),
                   '指定的敵人沒有送進 CLI（回應：' + JSON.stringify(bad).slice(0, 120) + '）');
                // 勝負亂填要當場擋掉：送進 CLI 會被當成敵人名或默默忽略，兩種都是「按了沒事」
                // ⚠️ 只驗 ok===false 是**假綠**：沒有這道驗證時，'abc' 會被 CLI 的參數
                //    迴圈當成敵人名，一樣回 ok:false（找不到敵人：abc）。要釘的是
                //    「daemon 自己就擋掉了」＝沒有 CLI 的 output，訊息才不會答非所問。
                const junk = await post('battle', { enemy: '', result: 'abc' });
                ok(junk.ok === false && !junk.output,
                   'result 亂填應該在 daemon 就擋掉，不要送進 CLI（回應：' + JSON.stringify(junk).slice(0, 120) + '）');
                // 兩欄都留空 = 隨機戰鬥，這條要留在快路徑（不開子行程、不進 CLI）
                const rnd = await post('battle', { enemy: '', result: '' });
                ok(rnd.ok === true && !rnd.output,
                   '兩欄留空應該走快路徑（回應：' + JSON.stringify(rnd).slice(0, 120) + '）');
                const fc = JSON.parse(fs2.readFileSync(path.join(SD, 'force-char.json'), 'utf8'));
                ok(typeof fc.battleTriggerTs === 'number' && !fc.forceBattleEnemy,
                   '留空時 force 應該只有 battleTriggerTs：' + JSON.stringify(fc).slice(0, 120));
            } finally {
                try { c2.kill(); } catch (e) {}
                try { fs2.rmSync(SD, { recursive: true, force: true }); } catch (e) {}
            }
        }

        console.log('— 天氣 —');
        ok(y.weather && typeof y.weather.sky === 'string', '/yard 沒有回傳天氣');
        ok(y.weather && typeof y.weather.label === 'string', '/yard 的天氣缺少顯示文字');
        // ⚠️ 查詢字串裡的 + 會被解碼成空白：前端忘了 encodeURIComponent 就會送出
        //    "clear cold"，伺服器比對不到 → 整個退回真實天氣。症狀是「選了寒流卻
        //    什麼都沒發生」，而且畫面完全正常，很難聯想到是網址編碼。踩過一次。
        const enc = JSON.parse(await get('/yard?w=' + encodeURIComponent('clear+cold')));
        ok(enc.weather && enc.weather.cold === true && enc.weather.sky === 'clear',
           '?w=clear+cold（已編碼）應回傳晴天＋寒流');
        const raw = JSON.parse(await get('/yard?w=clear+cold'));
        ok(raw.weather && raw.weather.cold === true,
           '?w=clear+cold（未編碼，伺服器收到空白）也要吃得下來');
        const junk = JSON.parse(await get('/yard?w=%3Cscript%3E'));
        ok(junk.weather && junk.weather.preview !== true, '看不懂的天氣參數應忽略');
        // 寒流是**獨立旗標**，跟任何天空都能組 —— 現實中「陰・寒流」「雨・寒流」
        // 才是台灣冬天的常態。預覽若只給幾個寫死的組合，就是把資料模型講錯了。
        for (const sky of ['cloudy', 'rain', 'storm', 'thunder']) {
            const r = JSON.parse(await get('/yard?w=' + encodeURIComponent(sky + '+cold')));
            ok(r.weather && r.weather.sky === sky && r.weather.cold === true,
               `?w=${sky}+cold 沒有同時成立（得到 sky=${r.weather && r.weather.sky} cold=${r.weather && r.weather.cold}）`);
        }
        // 只給 cold → 真實天空 + 強制寒流；順序也不該有影響
        const onlyCold = JSON.parse(await get('/yard?w=cold'));
        ok(onlyCold.weather && onlyCold.weather.cold === true, '?w=cold 應保留真實天空並加上寒流');
        const rev = JSON.parse(await get('/yard?w=' + encodeURIComponent('cold+rain')));
        ok(rev.weather && rev.weather.sky === 'rain' && rev.weather.cold === true, '參數順序不該有影響');
        console.log('— 合體候選（真的 daemon，暫存 state）—');
        {
            // 當家模式 + AGUMON_STATE_DIR：/state 的候選清單是從真的 core 算出來的，
            // 拿在手上、凍結這兩條 gate 要在這裡才驗得到（只有 daemon 知道誰被拿著）。
            // ⚠️ 這裡**絕對不送** /cmd jogress：那會 spawn CLI，而 CLI 的 state／force 路徑
            //    寫死在安裝目錄，不吃 AGUMON_STATE_DIR —— 會去讀寫使用者真正的存檔。
            const os = require('os'), fs2 = require('fs');
            const dir = fs2.mkdtempSync(path.join(os.tmpdir(), 'vpet-jgui-'));
            const W = (f, o) => fs2.writeFileSync(path.join(dir, f), JSON.stringify(o));
            W('color-state.json', { characterId: 'angewomon', evoHistory: ['gatomon', 'angewomon'] });
            W('ranch.json', { v: 1, pets: [
                { id: 'other', keptAt: Date.now(), state: { characterId: 'agumon' } },
                { id: 'lady1', keptAt: Date.now(), state: { characterId: 'ladydevimon' } }] });
            const PORT3 = PORT + 2;
            const kid = spawn(process.execPath,
                [path.join(__dirname, '..', 'src', 'daemon', 'daemon.js'), '--authoritative'],
                { env: { ...process.env, AGUMON_DAEMON_PORT: String(PORT3), AGUMON_STATE_DIR: dir },
                  stdio: 'ignore' });
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const jg = async () => (JSON.parse(await getOn(PORT3, '/state')).jogress) || null;
            try {
                let up = false;
                for (let i = 0; i < 100 && !up; i++) {
                    try { await getOn(PORT3, '/state'); up = true; } catch (e) { await sleep(100); }
                }
                ok(up, '第三個 daemon 起不來，這節等於沒測到');
                if (up) {
                    await sleep(1200);   // 等一拍：候選是 doTick 算的
                    let j = await jg();
                    // 安裝版 core 若還是舊的（沒有 jogressCandidates）會回 null —— 那是要先 install，不是頁面壞了
                    ok(j && Array.isArray(j.options), '/state 沒有帶合體候選（安裝版 core 是舊的？先 npm run install-runtime）');
                    if (j && Array.isArray(j.options)) {
                        ok(j.options.length === 1 && j.options[0].id === 'lady1' && j.options[0].to === 'mastemon',
                           '候選不對：' + JSON.stringify(j.options));
                        const o = j.options[0] || {};
                        ok(o.num === 2, `營地編號要跟 vpet camp 一致（第 2 隻），得到 ${o.num}`);
                        ok(o.campName && o.toName && j.frontName, '候選缺顯示名（確認文案要用）：' + JSON.stringify(j));

                        // 拿在手上 → 那隻不能是候選（否則畫面上被抓著的寵物會突然消失）
                        const before = ((JSON.parse(await getOn(PORT3, '/yard')).pets) || []).find(q => q.id === 'lady1');
                        const g = JSON.parse(await post(PORT3, '/cmd', { action: 'yardGrab', args: { which: 'lady1' } }));
                        ok(g.ok === true, '抓不起來：' + (g.error || ''));
                        // 拿起來的起點要是**畫出來**的位置 —— 前端從這裡開始跟著游標畫，
                        // 給成走路格子的座標的話，一抓起來牠就往左上跳一截
                        ok(before && Math.abs(g.x - before.x) <= 2 && Math.abs(g.y - before.y) <= 2,
                           '拿起來的起點跟畫面上的位置對不上：grab ' + JSON.stringify({ x: g.x, y: g.y })
                           + ' vs 畫面 ' + JSON.stringify(before && { x: before.x, y: before.y }));
                        await sleep(1200);
                        j = await jg();
                        ok(j && j.options.length === 0, '正被拿在手上的那隻還在候選裡');
                        await post(PORT3, '/cmd', { action: 'yardDrop', args: { which: 'lady1', x: '20', y: '10', facing: 'right' } });
                        // 放在哪就要出現在哪（前端送的是畫出來的細格座標，伺服器要換回走路的格子）。
                        // 換算錯的話放下去會「跳」到別處 —— 縮放比 4/3，差一點就是好幾格。
                        {
                            const yy = JSON.parse(await getOn(PORT3, '/yard'));
                            const p = (yy.pets || []).find(q => q.id === 'lady1');
                            ok(p && Math.abs(p.x - 20) <= 2 && Math.abs(p.y - 10) <= 2,
                               '放下的位置跟畫出來的位置對不上：' + JSON.stringify(p && { x: p.x, y: p.y }) + '（放在 20,10）');
                        }
                        await sleep(1200);
                        j = await jg();
                        ok(j && j.options.length === 1, '放下之後沒有回到候選');

                        // 凍結 → 沒有候選
                        W('force-char.json', { freezeEvolve: true });
                        await sleep(1200);
                        j = await jg();
                        ok(j && j.options.length === 0, '進化凍結中還列出合體候選');
                    }
                }
            } finally {
                try { kid.kill(); } catch (e) {}
                try { fs2.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
            }
        }

        console.log('— 留空的指定戰鬥不該沿用上次 —');
        {
            // force.json 是**累積**的。指定過一次敵人之後，「留空＝隨機」若只寫
            // battleTriggerTs，上次那隻還躺在檔案裡 → 下一場照著牠打。回報過。
            // CLI 那條路徑（--battle）本來就把這幾個欄位刪乾淨，快路徑漏掉就是分叉。
            //
            // 另外起一個 daemon，AGUMON_STATE_DIR 指到暫存目錄：驗得到 force 檔的
            // 前後內容，又不會去動使用者真正的 force-char.json。
            const os = require('os'), fs2 = require('fs');
            const dir = fs2.mkdtempSync(path.join(os.tmpdir(), 'vpet-force-'));
            const ff = path.join(dir, 'force-char.json');
            const STALE = { forceBattleEnemy: 'greymon', forceBattleWin: true,
                            pvpOppLabel: 'opp', pvpMeLabel: 'me', battleNoCount: true };
            // freezeEvolve 不相干，用來擋「清過頭」—— 整個檔案砍掉重寫也會讓上面那些消失。
            fs2.writeFileSync(ff, JSON.stringify({ ...STALE, freezeEvolve: true }));
            const PORT2 = PORT + 1;
            const kid = spawn(process.execPath,
                [path.join(__dirname, '..', 'src', 'daemon', 'daemon.js'), '--isolated'],
                { env: { ...process.env, AGUMON_DAEMON_PORT: String(PORT2),
                         AGUMON_STATE_DIR: dir }, stdio: 'ignore' });
            try {
                let up = false;
                for (let i = 0; i < 100 && !up; i++) {
                    try { await getOn(PORT2, '/state'); up = true; }
                    catch (e) { await new Promise(r => setTimeout(r, 100)); }
                }
                ok(up, '第二個 daemon 起不來，這節等於沒測到');
                if (up) {
                    const r = JSON.parse(await post(PORT2, '/cmd', { action: 'battle', args: {} }));
                    ok(r.ok === true, '留空的指定戰鬥送不出去：' + (r.error || ''));
                    const f = JSON.parse(fs2.readFileSync(ff, 'utf8'));
                    ok(typeof f.battleTriggerTs === 'number',
                       '沒有寫 battleTriggerTs —— 戰鬥根本不會觸發');
                    for (const k of Object.keys(STALE))
                        ok(!(k in f), `留空的指定戰鬥沒清掉上次的 ${k}（還是 ${JSON.stringify(f[k])}）`);
                    ok(f.freezeEvolve === true, '清過頭了，不相干的 force 欄位被一起砍掉');
                    // 有指定時要走 CLI，快路徑必須讓路（回 null）。這裡只驗「沒有被快路徑
                    // 吃掉」—— 真的跑 CLI 會 spawn 子行程、還會寫到真的 state，不在這裡做。
                    const src = fs2.readFileSync(
                        path.join(__dirname, '..', 'src', 'daemon', 'daemon.js'), 'utf8');
                    ok(/\(a\.enemy \|\| a\.result\) \? null/.test(src),
                       '指定了敵人／勝負時快路徑沒有讓路給 CLI（參數會被整包吃掉）');
                }
            } finally {
                try { kid.kill(); } catch (e) {}
                try { fs2.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
            }
        }
        console.log('— 廣場（第 1 期）—');
        {
            // 前端：入口只在前線，離開鈕一開始藏著；幽靈對戰的入口拿掉了，名牌留著
            ok(/data-cmd="plaza" data-scope="home"/.test(html), '前線沒有廣場按鈕');
            ok(/data-cmd="plazaLeave" data-scope="plaza"[^>]*style="display:none"/.test(html),
               '「離開廣場」一開頁就露出來了（應該只在廣場裡出現）');
            ok(!/data-cmd="pvp"|data-cmd="pvp-setup"/.test(html), '幽靈對戰的入口還在網頁上');
            ok(/data-cmd="code"/.test(html), '名牌設定被一起拿掉了（它現在是廣場的名牌）');

            // 真的起一個廣場伺服器 + 一個指向它的 daemon（隔離的 state 目錄）
            const fs2 = require('fs'), os2 = require('os');
            const PS = require('../src/daemon/plaza-server.js');
            const ps = PS.createPlazaServer({ graceMs: 500, battleMs: 4000 });
            await new Promise(r => ps.server.listen(0, '127.0.0.1', r));
            const SD = fs2.mkdtempSync(path.join(os2.tmpdir(), 'vpet-plaza-'));
            fs2.writeFileSync(path.join(SD, 'pvp.json'), JSON.stringify({ code: '測試員' }));
            fs2.writeFileSync(path.join(SD, 'hook.json'), JSON.stringify({ ts: 1 }));
            const P4 = PORT + 4;
            const kid = spawn(process.execPath,
                [path.join(__dirname, '..', 'src', 'daemon', 'daemon.js'), '--isolated'],
                { env: { ...process.env, AGUMON_DAEMON_PORT: String(P4), AGUMON_STATE_DIR: SD,
                         VPET_PLAZA_URL: 'http://127.0.0.1:' + ps.server.address().port,
                         VPET_FESTIVAL: 'halloween' },   // 節日固定，不看今天幾號
                  stdio: 'ignore' });
            const cmd = async (action, args = {}) => JSON.parse(await post(P4, '/cmd', { action, args }));
            const stateFile = () => { try { return JSON.parse(fs2.readFileSync(path.join(SD, 'daemon-state.json'), 'utf8')); } catch (e) { return {}; } };
            const wait = (ms) => new Promise(r => setTimeout(r, ms));
            try {
                for (let i = 0; i < 100; i++) { try { await getOn(P4, '/state'); break; } catch (e) { await wait(100); } }
                await wait(1600);   // 讓 daemon 先吃掉 hook ts=1（第一次讀到不加訓練值）
                const before = stateFile();
                const j = await cmd('plazaJoin');
                ok(j.ok, '進不了廣場：' + JSON.stringify(j).slice(0, 160));
                const s1 = JSON.parse(await getOn(P4, '/state'));
                ok(s1.plaza && s1.plaza.active === true, '/state 沒說在廣場（其他分頁不會跟著進去）');
                const p1 = JSON.parse(await getOn(P4, '/plaza'));
                ok(p1.ok && p1.active && Array.isArray(p1.lines) && p1.lines.length === p1.rows,
                   '/plaza 沒有畫出廣場：' + JSON.stringify(p1).slice(0, 160));
                ok(p1.names && p1.names.includes('測試員'), '廣場名單裡沒有自己');
                ok(p1.cols === y.cols && p1.rows === y.rows,
                   `廣場大小 ${p1.cols}x${p1.rows} 跟營地 ${y.cols}x${y.rows} 不一樣`);
                ok(/small\s*=\s*\(v==='yard'\s*\|\|\s*v==='plaza'\)/.test(js),
                   '廣場畫面沒有用營地那套小一號的格子（前端 CW/CH）');
                ok(p1.names.length === 1, '廣場上出現了不是玩家的東西：' + p1.names.join(','));
                // 名牌要跟角色有一樣的前後關係：/plaza 帶「每個 dot 是誰畫的」，名牌帶 z
                ok(Array.isArray(p1.owner) && p1.owner.length === p1.rows * 2 && p1.owner.every(r => r.length === p1.cols),
                   '/plaza 沒帶 owner（名牌不知道哪裡被前面的角色擋住）');
                ok(p1.tags.every(t => typeof t.z === 'number'), '名牌沒有 z（不知道誰在前面）');

                // 名牌隨時可改：網頁改（走 CLI 存檔再同步）、終端機 vpet code 改（daemon 自己發現）
                const rn = await cmd('plazaRename', { name: '改名員' });
                ok(rn.ok, '在廣場裡改名失敗：' + JSON.stringify(rn).slice(0, 160));
                ok(ps.roster().some(m => m.name === '改名員'), '改名之後伺服器上還是舊名字');
                fs2.writeFileSync(path.join(SD, 'pvp.json'), JSON.stringify({ code: '終端機改' }));
                let synced = false;
                for (let i = 0; i < 40 && !synced; i++) { synced = ps.roster().some(m => m.name === '終端機改'); if (!synced) await wait(100); }
                ok(synced, '用 vpet code 改的名牌沒有同步到廣場');
                const cc = await cmd('plazaColor', { color: '#12ab34' });
                ok(cc.ok && ps.roster().some(m => m.color === '#12ab34'), '名牌顏色沒送到廣場：' + JSON.stringify(cc).slice(0, 120));
                ok(JSON.parse(fs2.readFileSync(path.join(SD, 'pvp.json'), 'utf8')).code === '終端機改',
                   '存顏色時把名牌洗掉了');
                const p2 = JSON.parse(await getOn(P4, '/plaza'));
                ok(p2.myColor === '#12ab34', '/plaza 沒回自己的顏色（選色器會跳回預設）');
                // 名牌真的用那個顏色畫出來（進場那段可能還在畫面外、名牌不畫，所以等它走進來）
                let colored = false;
                for (let i = 0; i < 60 && !colored; i++) {
                    colored = (JSON.parse(await getOn(P4, '/plaza')).tags || []).some(t => t.color === '#12ab34');
                    if (!colored) await wait(400);
                }
                ok(/function drawNameTags/.test(js) && /drawNameTags\(p\.tags, p\.owner\)/.test(js), '前端沒有畫名牌');

                // 特殊節日（docs/festival-spec.md）：廣場背景固定出現、造型由本人決定給不給看
                ok(p2.festival && p2.festival.id === 'halloween' && p2.festival.acc === 'hat',
                   '/plaza 沒帶節日：' + JSON.stringify(p2.festival));
                ok(p2.festCostume === true && ps.roster()[0].costume === true, '節日造型預設應該是給看');
                const fc = await cmd('festCostume', { on: 'false' });
                ok(fc.ok, '關節日造型失敗：' + JSON.stringify(fc).slice(0, 120));
                ok(ps.roster()[0].costume === false, '關了節日造型，伺服器上還是給看（別人仍看得到）');
                ok(JSON.parse(await getOn(P4, '/plaza')).festCostume === false, '/plaza 的造型勾選框沒跟著關');
                ok(JSON.parse(fs2.readFileSync(path.join(SD, 'festival.json'), 'utf8')).costume === false, '節日造型的開關沒存起來');
                ok((await cmd('festCostume', { on: 'true' })).ok && ps.roster()[0].costume === true, '開回節日造型失敗');
                const fy = JSON.parse(await getOn(P4, '/yard?fest=doubleten'));
                ok(fy.festival && fy.festival.id === 'doubleten' && fy.festCostume === true, '/yard?fest= 預覽沒生效：' + JSON.stringify(fy.festival));
                ok(/<canvas id="fest"><\/canvas><canvas id="pet"/.test(html), '節日背景畫布不在角色畫布下面');
                ok(/id="festplaza"/.test(html) && /id="festcos"/.test(html), '頁面沒有節日開關');
                ok(/applyFestival\(p\.festival/.test(js) && /applyFestival\(y\.festival/.test(js), '前端沒有套用節日');
                ok(/view==='plaza' \|\| \(view==='yard' && festState\.bg\)/.test(js), '廣場的節日背景不該吃營地的開關');
                // 造型勾選框排在「離開廣場」那一列（#controls）的右邊，文案「顯示節慶造型」
                const ctl = (html.match(/<div id="controls">[\s\S]*?\n    <\/div>/) || [''])[0];
                ok(/id="festplaza"[^>]*margin-left:auto[\s\S]*?顯示節慶造型<\/label>/.test(ctl), '造型勾選框沒有排在離開廣場那一列的右邊');
                // 營地只有一顆：背景跟造型同一個開關
                ok(!/id="festbg"/.test(html) && /id="festcos">顯示節慶造型<\/label>/.test(html), '營地的節日開關沒合成一顆「顯示節慶造型」');
                ok(/opts\.costume!=null\) festState\.bg = !!opts\.costume/.test(js), '營地背景沒跟著造型開關走');
                ok(/const festNow = [^\n]*IS_RELEASE \? null/.test(require('fs').readFileSync(
                       path.join(__dirname, '..', 'src', 'daemon', 'daemon.js'), 'utf8')),'release 版還吃節日預覽 —— 開關會在活動期間外出現');

                // 開心鈕：按了之後 /plaza 上自己是開心狀態（大家依同一個時間戳演），演完就結束
                ok(/id="plazahappy"/.test(html), '廣場沒有開心鈕');
                ok((await cmd('plazaHappy')).ok, '按開心失敗');
                const meTag = (q) => (q.tags || []).find(t => t.me) || {};
                ok(meTag(JSON.parse(await getOn(P4, '/plaza'))).happy === true, '按了開心，畫面上沒有開心');
                await wait(PS.EMOTE_MS + 200);
                ok(meTag(JSON.parse(await getOn(P4, '/plaza'))).happy === false, '開心演完了還一直在開心');
                // 自動／手動（WASD）
                ok((await cmd('plazaMode', { mode: 'manual' })).ok, '切手動失敗');
                ok(JSON.parse(await getOn(P4, '/plaza')).mode === 'manual', '/plaza 沒說現在是手動（按鈕文字跟 WASD 都會不對）');
                const mv = await cmd('plazaMove', { vx: '1', vy: '-1' });
                ok(mv.ok && ps.roster()[0].walk.vx === 1 && ps.roster()[0].walk.vy === -1, 'WASD 沒送到廣場：' + JSON.stringify(mv));
                await cmd('plazaMove', { vx: '0', vy: '0' });
                ok((await cmd('plazaMode', { mode: 'auto' })).ok && JSON.parse(await getOn(P4, '/plaza')).mode === 'auto', '切回自動失敗');
                ok(/typing\(\)\) return/.test(js), '打字時按 WASD 會被當成移動（名牌欄打不了 w/a/s/d）');
                ok(/addEventListener\('blur'/.test(js), '切走視窗時沒有停下（keyup 收不到，角色會一直走）');
                ok(/#plazabar button\{background:#21262d/.test(html), '廣場下方的按鈕是瀏覽器預設的白鈕');

                // 聊天：送出去、/plaza 帶回來（含伺服器時間，泡泡要用）、頁面有聊天框與泡泡
                const ch = await cmd('plazaChat', { text: '哈囉' });
                ok(ch.ok, '發言失敗：' + JSON.stringify(ch).slice(0, 120));
                let got = null;
                for (let i = 0; i < 30 && !got; i++) {
                    const q = JSON.parse(await getOn(P4, '/plaza'));
                    if ((q.chat || []).some(m => m.text === '哈囉')) got = q; else await wait(100);
                }
                ok(got, '/plaza 沒有帶回聊天');
                ok(got && typeof got.serverNow === 'number' && got.tags.every(t => typeof t.key === 'string'),
                   '/plaza 缺 serverNow 或名牌沒有 key（對話泡泡對不上是誰說的）');
                ok(/id="chatlog"/.test(html) && /id="chatin"/.test(html), '頁面沒有聊天框');
                ok(/id="chatemoji"/.test(html) && /id="emojipick"/.test(html) && js.includes('const EMOJIS=['), '聊天室沒有表情符號面板');
                ok(js.includes('ci.value.slice(0,a)+e+ci.value.slice(z)'), '表情符號不是插在游標位置');
                ok(/function drawBubbles/.test(js) && /drawBubbles\(p\.tags, p\.chat, p\.serverNow\)/.test(js), '沒有畫對話泡泡');
                ok(/document\.createTextNode\('：'\+m\.text\)/.test(js), '聊天內容不是用純文字放進頁面（別人打的字會被當成 HTML）');

                // 對戰：另一個玩家（這裡直接用 client）邀請 daemon 這邊 → 頁面看到邀請 → 接受 →
                // daemon 在前線開演、/plaza 帶出演出畫面 → 演完不留痕跡（不計戰績、心情不變）
                {
                    const PC = require('../src/daemon/plaza-client.js');
                    const rival = PC.create({ url: 'http://127.0.0.1:' + ps.server.address().port });
                    ok((await rival.join({ name: '對手', char: 'gabumon', stage: 'Child', card: { power: 10, train: 0, str: 10 } })).ok, '對手進不了廣場');
                    const meId = ps.roster().find(m => m.name !== '對手').id;
                    // 心情先設成非 0：打完心情會被歸 0，原本就是 0 的話「有沒有還原」測不出來（踩過，假綠）
                    { const st0 = stateFile(); st0.mood = 2; fs2.writeFileSync(path.join(SD, 'daemon-state.json'), JSON.stringify(st0)); }
                    await wait(1600);
                    const before2 = stateFile();
                    ok(before2.mood === 2, '測試前置：心情沒設成功（' + before2.mood + '）');
                    ok((await rival.invite(meId)).ok, '對手邀請失敗');
                    let inv = null;
                    for (let i = 0; i < 30 && !inv; i++) { inv = JSON.parse(await getOn(P4, '/plaza')).invite; if (!inv) await wait(100); }
                    ok(inv && inv.kind === 'in' && inv.name === '對手' && inv.inviteId, '頁面沒看到對戰邀請：' + JSON.stringify(inv));
                    ok((await cmd('plazaAnswer', { inviteId: inv.inviteId, accept: '1' })).ok, '接受邀請失敗');
                    let shown = null;
                    for (let i = 0; i < 60 && !shown; i++) { const q = JSON.parse(await getOn(P4, '/plaza')); if (q.battle) shown = q; else await wait(100); }
                    ok(shown && Array.isArray(shown.battle.lines) && shown.battle.lines.length > 0 && shown.battle.opp === '對手',
                       '接受之後沒有開演前線的戰鬥（/plaza 沒帶演出畫面）');
                    ok(shown && shown.tags.every(t => t.battling), '對戰中的兩隻頭上沒有 ⚔ 的資料');
                    // 名字不塞在 8px 的格子裡（細長、置中會偏）：演出畫面去掉 core 的名牌列，名字另外送、前端置中畫
                    ok(shown && shown.battle.lines.length === 8, '對戰演出還帶著 core 的名牌列（' + (shown && shown.battle.lines.length) + ' 列）');
                    const bn = shown && shown.battle.names;
                    ok(bn && bn.length === 2 && bn[0].col === 8 && bn[1].col === 44 && bn[1].text === '對手',
                       '對戰的名字沒有對準兩隻角色的中心：' + JSON.stringify(bn));
                    ok(/drawTagText\(g, n\.text, n\.col\*HOME_CW/.test(js), '對戰的名字沒有用正常字型畫');
                    ok(/function renderBattle/.test(js) && /id="battlebox"/.test(html), '頁面沒有對戰的疊層');
                    // 演完（約 15 秒）
                    let done = false;
                    for (let i = 0; i < 260 && !done; i++) { const q = JSON.parse(await getOn(P4, '/plaza')); if (shown && !q.battle) done = true; else await wait(100); }
                    ok(done, '對戰演出一直沒結束');
                    await wait(1600);
                    const after2 = stateFile();
                    ok((after2.battleTotalCount || 0) === (before2.battleTotalCount || 0), '廣場對戰被算進戰績了');
                    ok(after2.mood === before2.mood, `廣場對戰動到了心情（${before2.mood} → ${after2.mood}）`);
                    ok(after2.lastBattleEnemy === before2.lastBattleEnemy, '廣場對戰改了「上一場的敵人」');
                    await rival.leave();
                }

                // 名牌保留大小寫（以前一律轉大寫）
                const lc = await cmd('plazaRename', { name: 'kai' });
                ok(lc.ok && ps.roster().some(m => m.name === 'kai'), '小寫名牌被改成大寫了：' + JSON.stringify(ps.roster().map(m => m.name)));
                ok(colored, '選的名牌顏色沒有畫在廣場上');
                ok(p2.weather && typeof p2.weather.sky === 'string' && typeof p2.weather.night === 'boolean',
                   '廣場沒有天氣（應該比照營地）');
                ok(/view!=='yard'&&view!=='plaza'/.test(js), '天氣粒子層／看板在廣場不會動');
                ok(ps.roster().length === 1 && ps.roster()[0].char === (before.characterId || 'agumon'),   // 上面改過名，不看名字
                   '伺服器上的不是前線那隻：' + JSON.stringify(ps.roster()));

                // 場景鎖：伺服器端也要擋（/cmd 是公開端點，只藏按鈕不夠）
                for (const a of ['keep', 'pet', 'yardPet', 'battle', 'reset']) {
                    const r = await cmd(a, a === 'yardPet' ? { which: 'x' } : {});
                    ok(!r.ok && /廣場/.test(r.error || ''), `在廣場裡 ${a} 沒被擋下：` + JSON.stringify(r).slice(0, 120));
                }
                // 飼育暫停：在廣場時來了新訊息，訓練值不加、自動戰鬥不武裝
                fs2.writeFileSync(path.join(SD, 'hook.json'), JSON.stringify({ ts: 2 }));
                await wait(1700);
                const mid = stateFile();
                ok((mid.trainingBonus || 0) === (before.trainingBonus || 0),
                   `在廣場時訓練值還在加（${before.trainingBonus || 0} → ${mid.trainingBonus || 0}）`);
                ok(mid.lastHookTs === 2 && mid.battleFiredHookTs === mid.battleArmHookTs,
                   '在廣場時的訊息武裝了自動戰鬥（一回前線就會立刻開打）');
                ok(mid.plaza && typeof mid.plaza.at === 'number', 'state 沒有寫 plaza（CLI 擋不了指令）');

                const l = await cmd('plazaLeave');
                ok(l.ok, '離開廣場失敗');
                ok(await (async () => { for (let i = 0; i < 30; i++) { if (!ps.roster().length) return true; await wait(50); } return false; })(),
                   '離開之後伺服器上還有人');
                await wait(1600);
                ok(!stateFile().plaza, '離開之後 state 還留著 plaza（CLI 會一直被擋）');

                // 主機關掉：daemon 自己回前線，並留一句話給頁面
                ok((await cmd('plazaJoin')).ok, '第二次進場失敗');
                await ps.close();
                let back = null;
                for (let i = 0; i < 140 && !back; i++) {
                    const s = JSON.parse(await getOn(P4, '/state'));
                    if (s.plaza && !s.plaza.active) back = s.plaza; else await wait(100);
                }
                ok(back && back.notice && /前線/.test(back.notice.text),
                   '主機關掉後沒有回前線、或沒留下原因：' + JSON.stringify(back));
                // 連不上（主機沒開）→ 進場失敗並說出原因，人留在前線
                const r = await cmd('plazaJoin');
                ok(!r.ok && /連不上廣場/.test(r.error || ''), '主機沒開時的訊息不對：' + JSON.stringify(r).slice(0, 160));
            } finally {
                try { kid.kill(); } catch (e) {}
                try { await ps.close(); } catch (e) {}
                try { fs2.rmSync(SD, { recursive: true, force: true }); } catch (e) {}
            }
        }
    } catch (e) {
        fail++; console.log('  ✗ 例外：' + e.message);
    }
    console.log(`\n結果：${pass} passed, ${fail} failed`);
    done(fail ? 1 : 0);
}, 100);
