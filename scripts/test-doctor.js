#!/usr/bin/env node
'use strict';
/**
 * test-doctor.js — 孤兒收屍的接線
 *
 * 這支不驗「殺得掉嗎」（那要真的有孤兒才測得到，而且會動到當下的機器），
 * 驗的是**接線斷掉時會無聲失效**的那幾條：
 *
 *   1. daemon 是用「路徑」去叫 doctor 的（spawn INSTALL_ROOT/doctor.js）。
 *      install.js 漏掉部署 doctor.js → 那行 fs.existsSync 直接 return → 永遠不收屍，
 *      而且不會有任何錯誤訊息。
 *   2. 那個 spawn 必須是非同步、detached 的。doctor 的掃描是同步 PowerShell CIM 查詢
 *      （實測 2.4 秒），有人把它「簡化」成 execFileSync 就會卡掉主迴圈兩三拍 →
 *      走路跳幀，而症狀跟收屍完全沾不上邊，幾乎不可能聯想回來。
 *   3. 兩套判定的年齡門檻要一致（doctor 的 OS 掃描 vs core 的 pids/ 掃描）。
 *
 * 全部是靜態檢查，不啟動 daemon、不碰 ~/.claude。
 */
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };

const REPO   = path.resolve(__dirname, '..');
const read   = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const doctor = require('../src/runtime/doctor.js');
const core   = require('../src/runtime/agumon-core.js');

console.log('— doctor 的對外介面 —');
{
    ok(typeof doctor.run === 'function', 'doctor 應該導出 run()');
    ok(typeof doctor.scanAgumonNodes === 'function',
       'doctor 應該導出 scanAgumonNodes()（daemon 的說明有指向它）');
    ok(typeof doctor.ORPHAN_AGE_SEC === 'number', 'doctor 應該導出 ORPHAN_AGE_SEC');
    // 兩套收屍（doctor 掃 OS 行程表 / core 掃 pids/ 登記表）必須用同一個門檻，
    // 不然同一隻行程在一邊算孤兒、另一邊算健康。
    ok(doctor.ORPHAN_AGE_SEC * 1000 === core.REAP_AGE_MS,
       `年齡門檻不一致：doctor ${doctor.ORPHAN_AGE_SEC}s vs core ${core.REAP_AGE_MS / 1000}s`);
}

console.log('— 預設就是收屍，--check 才是只看不動 —');
{
    const src = read('src/runtime/doctor.js');
    ok(/--check/.test(src), 'doctor 應該支援 --check');
    ok(/fix:\s*!check/.test(src),
       '預設應該是收屍（fix = !check）—— 反過來的話 daemon 那輪排程就只會印字不做事');
}

console.log('— install 必須部署 doctor.js —');
{
    // 漏掉的話 daemon 的 sweepOrphans 會靜靜地什麼都不做
    const inst = read('scripts/install.js');
    // ⚠️ 要求它自成一行的清單項目。第一版只找字串本身，結果連被註解掉的
    //    `// 'doctor.js',` 都算數 —— 把那行註解掉照樣全綠，等於沒測到。
    ok(/^\s*['"]doctor\.js['"]\s*,/m.test(inst),
       "install.js 的部署清單沒有 doctor.js（或被註解掉了）—— daemon 的孤兒收屍會無聲失效");
}

console.log('— 背景執行不可以跳視窗 —');
{
    // 使用者回報「PowerShell 偶爾跳出小黑窗、不到一秒就關閉」。
    // 真因是 daemon 每 10 分鐘在背景叫 doctor，而 doctor 內部用 execFileSync 叫 powershell。
    // 只要少了 windowsHide，那一下就會在畫面上閃。
    const dsrc = read('src/runtime/doctor.js');
    const ps = dsrc.slice(dsrc.indexOf("execFileSync('powershell'")).replace(/\/\/.*$/gm, '');
    ok(ps.length > 0, '找不到 doctor 呼叫 powershell 的地方，這節等於沒測到');
    ok(/windowsHide:\s*true/.test(ps.slice(0, 300)),
       'doctor 叫 powershell 時少了 windowsHide:true —— 背景掃描會跳出小黑窗');
}

console.log('— daemon 的排程 —');
{
    const d = read('src/daemon/daemon.js');
    ok(/sweepOrphans/.test(d), 'daemon 應該有 sweepOrphans');
    ok(/doctor\.js/.test(d), 'daemon 應該指向 doctor.js');
    ok(/INSTALL_ROOT[^\n]*doctor\.js|doctor\.js[^\n]*INSTALL_ROOT/.test(d)
       || /path\.join\(core\.INSTALL_ROOT, 'doctor\.js'\)/.test(d),
       'doctor 的路徑應該從 INSTALL_ROOT 組出來（不是相對於 repo）');

    // 這條是重點：同步呼叫會卡住主迴圈 2.4 秒 → 走路跳幀
    // ⚠️ 一定要先把註解剝掉再比對。這幾條斷言找的是 `detached: true` / `windowsHide`
    //    這種字串，而**說明它們的註解裡也會出現同樣的字** ——
    //    實際踩到：修好之後測試照樣紅，因為它比到的是我寫來解釋的那行註解。
    const strip = (t) => t.replace(/\/\/.*$/gm, '');
    const sweep = strip(d.slice(d.indexOf('function sweepOrphans'), d.indexOf('setInterval(sweepOrphans')));
    ok(sweep.length > 0, '找不到 sweepOrphans 的內容，這節等於沒測到');
    ok(!/execFileSync|execSync|spawnSync/.test(sweep),
       'sweepOrphans 用了同步呼叫：doctor 掃描要 2.4 秒，會卡掉主迴圈好幾拍（走路跳幀）');
    ok(/\.unref\(\)/.test(sweep), 'spawn 出來的子行程要 unref，否則會擋住 daemon 退出');
    ok(/existsSync/.test(sweep), '沒裝 doctor 時應該安靜跳過，不是丟例外');
    // ⚠️ Windows 上這兩件事都會讓使用者看到「每隔一陣子跳出小黑窗、不到一秒就關掉」：
    //    detached:true 會開一個新的 console；沒有 windowsHide 則子行程自己會開。
    //    背景家務事不該在畫面上閃 —— 實際回報過。
    ok(!/detached:\s*true/.test(sweep),
       'sweepOrphans 用了 detached:true —— Windows 上會開新的 console 視窗（每 10 分鐘閃一次）。'
       + ' unref() 就足夠讓它不擋住 daemon 退出了');
    ok(/windowsHide:\s*true/.test(sweep),
       'sweepOrphans 少了 windowsHide:true —— 背景收屍會跳出小黑窗');

    ok(/setInterval\(sweepOrphans/.test(d), '應該有定期排程');
    // 啟動時要有獨立的一輪（不能只有每 10 分鐘那個 —— 剛起來時往往正是累積了一堆的時候）。
    // 不規定寫法：直接呼叫或 setTimeout 延後都行，延後反而比較好（見 daemon 那邊的說明）。
    ok(/^\s*sweepOrphans\(\);/m.test(d) || /setTimeout\(sweepOrphans/.test(d),
       '啟動時應該先掃一輪（只有 setInterval 的話要等 10 分鐘才會清）');
    // 但那一輪不可以擋在 server.listen 前面同步做
    const startIdx = d.search(/^\s*sweepOrphans\(\);/m);
    ok(startIdx === -1 || startIdx > d.indexOf('server.listen'),
       '啟動時那一輪是同步呼叫且排在 server.listen 之前，會拖慢 daemon 開始服務的時間');
}

console.log(`\n結果：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
