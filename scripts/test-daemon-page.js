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

const get = (p) => new Promise((res, rej) => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: p }, (s) => {
        let d = ''; s.on('data', c => d += c); s.on('end', () => res(d));
    });
    r.on('error', rej);
    r.setTimeout(8000, () => { r.destroy(); rej(new Error('timeout')); });
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
function renderProbe(js) {
    const vm = require('vm');
    const calls = [];
    const ctx2d = () => new Proxy({}, {
        get(t, k) {
            if (k === 'canvas') return { width: 416, height: 320 };
            if (k === 'measureText') return () => ({ width: 8 });
            if (k === 'createLinearGradient') return () => ({ addColorStop() {} });
            if (typeof k === 'string' &&
                /^(fill|stroke|clear|begin|move|line|arc|ellipse|close|save|restore|translate|scale|rect|drawImage|fillText)/.test(k))
                return (...a) => calls.push(k);
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
        addEventListener() {}, appendChild() {}, querySelectorAll: () => [],
    });
    let raf = null;
    const g = {
        document: { getElementById: () => el(), querySelectorAll: () => [], addEventListener() {}, body: el() },
        requestAnimationFrame: (f) => { raf = f; return 1; },
        setInterval: () => 0, setTimeout: () => 0, clearTimeout() {},
        fetch: () => new Promise(() => {}),
        innerWidth: 1200, innerHeight: 800, confirm: () => false, console,
    };
    g.window = g; g.globalThis = g;
    vm.createContext(g);
    // 頂層的 let/const 不會變成 context 的屬性 → 補一段尾巴把要用的東西露出來
    const epilogue = ';globalThis.__p={sky:(s,c)=>{wxState.sky=s;wxState.cold=!!c;wxParts=null;},'
                   + 'view:(v)=>{view=v;}};';
    try { vm.runInContext(js + epilogue, g, { timeout: 5000 }); }
    catch (e) { ok(false, '頁面 script 執行就爆了：' + e.message); return; }
    ok(!!g.__p, '抓不到前端的內部狀態（探針壞了，不是頁面壞了）');
    if (!g.__p) return;
    g.__p.view('yard');

    // 每種天氣都要能畫完一整幀而不丟例外
    const run = (sky, cold, t0, frames = 4) => {
        g.__p.sky(sky, cold);
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

        // 常見成因：字串字面值裡混進真正的換行。單獨檢出來，訊息才看得懂在說什麼。
        const bad = js.split('\n').filter(l => (l.match(/'/g) || []).length % 2 === 1
                                            && !l.trim().startsWith('//'));
        ok(bad.length === 0,
           `有 ${bad.length} 行的單引號沒有成對（多半是跳脫字元被 template literal 吃掉）：\n      ${bad[0]}`);

        console.log('— 前端實跑（天氣）—');
        renderProbe(js);

        console.log('— 端點 —');
        const st = JSON.parse(await get('/state'));
        ok(typeof st.tick === 'number', '/state 沒有回傳 tick');

        const y = JSON.parse(await get('/yard'));
        ok(y.ok === true, '/yard 回應失敗');
        ok(typeof y.cols === 'number' && typeof y.rows === 'number',
           '/yard 沒有回傳場地尺寸（空牧場時畫布會塌成家裡的大小）');

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
    } catch (e) {
        fail++; console.log('  ✗ 例外：' + e.message);
    }
    console.log(`\n結果：${pass} passed, ${fail} failed`);
    done(fail ? 1 : 0);
}, 100);
