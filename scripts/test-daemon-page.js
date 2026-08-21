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

setTimeout(async () => {
    try {
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

        console.log('— 端點 —');
        const st = JSON.parse(await get('/state'));
        ok(typeof st.tick === 'number', '/state 沒有回傳 tick');

        const y = JSON.parse(await get('/yard'));
        ok(y.ok === true, '/yard 回應失敗');
        ok(typeof y.cols === 'number' && typeof y.rows === 'number',
           '/yard 沒有回傳場地尺寸（空牧場時畫布會塌成家裡的大小）');
    } catch (e) {
        fail++; console.log('  ✗ 例外：' + e.message);
    }
    console.log(`\n結果：${pass} passed, ${fail} failed`);
    done(fail ? 1 : 0);
}, 2000);
