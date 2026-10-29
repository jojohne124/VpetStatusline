#!/usr/bin/env node
'use strict';
/**
 * test-release-build.js — release 樹「少一個檔就無聲壞掉」的那幾條
 *
 * build-release.js 是白名單式的：新加的檔案不會自動出貨。而漏掉的症狀全都不會
 * 在 main 上出現，只有拿 release 樹的人才踩到，而且幾乎都沒有錯誤訊息：
 *
 *   1. src/shared/ 漏掉 → daemon 是直接從 release 樹跑的，plaza.js 的
 *      require('../shared/plaza-walk.js') 直接 MODULE_NOT_FOUND，獨立介面開不起來。
 *      （踩過同型的一次：install 沒部署 shared → 圖鑑整個打不開。）
 *   2. characters/ 的資料 json 漏掉 → install.js 那幾行 fs.existsSync 直接跳過，
 *      特殊進化不會發生、營地分區退回內建切法，全程零錯誤訊息。
 *   3. 反向也要守：dev 資產（原圖 PNG、src/editor、evo-layout）不可以混進 release，
 *      不然「輕量」就沒了，作弊／編輯器也可能露給玩家。
 *
 * 做法是真的 build 一份到暫存目錄再檢查（不動 dist/release），結束後刪掉。
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };

const REPO = path.resolve(__dirname, '..');
const OUT  = path.join(os.tmpdir(), 'agumon-release-test-' + process.pid);
const has  = (rel) => fs.existsSync(path.join(OUT, rel));
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// 遞迴列出相對路徑（用 / 當分隔，比對好寫）
function walk(dir, base = '') {
    const out = [];
    for (const d of fs.readdirSync(path.join(OUT, dir), { withFileTypes: true })) {
        const rel = (base ? base + '/' : '') + d.name;
        if (d.isDirectory()) out.push(...walk(path.join(dir, d.name), rel));
        else out.push(rel);
    }
    return out;
}

try {
    execFileSync('node', [path.join(REPO, 'scripts', 'build-release.js'), OUT],
                 { cwd: REPO, stdio: 'pipe' });
} catch (e) {
    console.log('  ✗ build-release.js 跑不起來：' + (e.message || e));
    console.log('\n結果：0 passed, 1 failed');
    process.exit(1);
}

const all = walk('.');
ok(all.length > 300, `release 樹只有 ${all.length} 個檔案，看起來 build 壞了（掃不到東西的話下面每條都會假綠）`);

console.log('— 樹內的相對 require 都要解析得到 —');
{
    // 這條是替 daemon 守的：它從 release 樹直接跑，require 解析的是「樹裡的路徑」，
    // 不是部署樹。少一支就是一啟動就死。
    const MARK = "require('";
    let scanned = 0;
    const missing = [];
    for (const rel of all) {
        if (!rel.endsWith('.js')) continue;
        const src = fs.readFileSync(path.join(OUT, rel), 'utf8');
        let i = src.indexOf(MARK);
        while (i >= 0) {
            const rest = src.slice(i + MARK.length);
            const spec = rest.slice(0, rest.indexOf("'"));
            // 註解裡的 require 不算 —— install.js 的說明就原樣引了
            // require('../shared/xxx')，那不是真的相依。判準：這一行在 require
            // 之前出現過 // 或 *（含 /* 區塊註解的續行）。
            const lineHead = src.slice(0, i).split(String.fromCharCode(10)).pop();
            const inComment = lineHead.includes('//') || lineHead.trimStart().startsWith('*');
            if (spec && spec[0] === '.' && !inComment) {
                scanned++;
                const target = path.resolve(path.dirname(path.join(OUT, rel)), spec);
                const found = fs.existsSync(target) || fs.existsSync(target + '.js')
                              || fs.existsSync(path.join(target, 'index.js'));
                if (!found) missing.push(rel + ' -> ' + spec);
            }
            i = src.indexOf(MARK, i + 1);
        }
    }
    ok(scanned > 5, `只掃到 ${scanned} 個相對 require（掃描壞了會靜靜地全過）`);
    ok(missing.length === 0, 'release 樹裡這些 require 解析不到檔案：\n      ' + missing.join('\n      '));

    // 靜態掃描之外，真的 require 一次 daemon 的合成器 —— 它是踩過的那條路徑。
    let err = null;
    try { require(path.join(OUT, 'src', 'daemon', 'plaza.js')); } catch (e) { err = e; }
    ok(!err, 'release 樹的 src/daemon/plaza.js require 就爆了：' + (err && err.message));
}

console.log('— install.js 會部署的檔案都要出貨 —');
{
    // install.js 從 REPO_ROOT 讀、往部署樹寫。release 樹就是那個 REPO_ROOT，
    // 檔案不在的話 install 那幾行 fs.existsSync 只是安靜跳過。
    const inst = read('scripts/install.js');

    // (a) 玩家頁面 require 的 shared 模組（install.js 的 SHARED_MODULES）
    const m = inst.match(/SHARED_MODULES = \[([^\]]*)\]/);
    ok(!!m, 'install.js 找不到 SHARED_MODULES（改名了就要同步這支測試）');
    if (m) {
        const mods = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
        ok(mods.length >= 2, `SHARED_MODULES 只解析出 ${mods.length} 個（解析壞了會假綠）`);
        for (const f of mods) ok(has('src/shared/' + f), 'release 缺 src/shared/' + f);
    }

    // (b) characters/ 底下的資料 json（不屬於角色資料夾，build 的角色迴圈掃不到）
    const MARK = "path.join(REPO_ROOT, 'characters', '";
    const need = new Set();
    let i = inst.indexOf(MARK);
    while (i >= 0) {
        const rest = inst.slice(i + MARK.length);
        const f = rest.slice(0, rest.indexOf("'"));
        if (f && f.endsWith('.json')) need.add(f);
        i = inst.indexOf(MARK, i + 1);
    }
    ok(need.size >= 2, `只掃到 ${need.size} 個 characters/*.json（掃描壞了會假綠）`);
    for (const f of need) ok(has('characters/' + f), 'install.js 會部署 characters/' + f + '，但 release 沒出貨');
}

console.log('— dev 資產不可以混進 release —');
{
    ok(has('RELEASE'), 'release 樹少了 RELEASE 標記檔 → 裝完作弊／開發指令全開');
    ok(!all.some(f => f.startsWith('src/editor/')), 'src/editor 混進 release 了（點陣／路線／走動範圍編輯器是 dev-only）');
    ok(!all.some(f => /\.png$/i.test(f) && f.startsWith('characters/')), '角色原圖 PNG 混進 release 了（輕量化的重點就是這些）');
    ok(!all.includes('characters/evo-layout.json'), 'evo-layout.json 混進 release 了（進化路線編輯器的版面，玩家用不到）');
    ok(!all.some(f => /^(editor|route-editor|zone-editor|cutin-editor)\.(bat|sh|command)$/.test(f)),
       'dev 編輯器的啟動器混進 release 了');
    ok(!all.some(f => f.startsWith('scripts/') && !/^scripts\/(install|uninstall)\.js$/.test(f)),
       'scripts/ 只該留 install / uninstall，出現了別的：' + all.filter(f => f.startsWith('scripts/')).join(', '));
}

console.log('— 自動更新（docs/update-spec.md）—');
{
    for (const f of ['src/daemon/updater.js', 'src/daemon/supervisor.js', 'src/shared/update-bundle.js', 'src/shared/update-key.js'])
        ok(has(f), 'release 少了 ' + f + ' → 自動更新整個不會動（daemon 一起動就 MODULE_NOT_FOUND）');
    ok(!all.some(f => /\.pem$/i.test(f)), '簽章私鑰混進 release 了！');
    ok(!all.includes('scripts/gen-release-key.js'), '產金鑰的腳本混進 release 了');
}

console.log('— 根目錄乾淨、預設安裝是純 daemon —');
{
    // 一般使用者打開資料夾只該看到三件事：安裝、打開桌寵、解除安裝。
    const rootFiles = fs.readdirSync(OUT, { withFileTypes: true }).filter(d => d.isFile()).map(d => d.name);
    // VERSION：publish-release 才寫（自動更新比對版本用），build 本身不產生；出現也合法
    const allowed = /^(README\.md|RELEASE|VERSION|package\.json|changelog\.json|(install|uninstall)\.(bat|command|sh)|vpet-standalone\.(bat|command|sh|vbs))$/;
    const extra = rootFiles.filter(f => !allowed.test(f));
    ok(extra.length === 0, 'release 根目錄多了這些檔（不在「安裝／打開／解除安裝」裡）：' + extra.join(', '));

    // install.* 一定是純 daemon：不碰使用者的 statusline 是預設安裝的承諾
    for (const f of ['install.bat', 'install.command', 'install.sh']) {
        ok(has(f), 'release 少了 ' + f);
        if (has(f)) ok(/--daemon-only/.test(fs.readFileSync(path.join(OUT, f), 'utf8')),
                       f + ' 不是純 daemon 安裝（會接管使用者的 statusline）');
    }
    for (const f of ['install-daemon-only.bat', 'album.bat', 'bg-editor.bat'])
        ok(!has(f), f + ' 又出現在 release 根目錄了（已併入 install.* ／網頁按鈕）');

    // 指南裡叫人雙擊的檔，release 裡都要真的有。.app 是 mac 安裝時才編出來的，不在樹裡。
    const readme = has('README.md') ? fs.readFileSync(path.join(OUT, 'README.md'), 'utf8') : '';
    ok(readme.length > 1000, 'release 的 README.md 不見了或是空的');
    const named = [...new Set([...readme.matchAll(/`(?:\.\/)?([\w.-]+\.(?:bat|command|sh|vbs))`/g)].map(m => m[1]))];
    ok(named.length >= 6, `README 只提到 ${named.length} 個啟動檔（掃描壞了會假綠）`);
    const ghost = named.filter(f => !has(f) && !has('tools/agumon-doctor/' + f));
    ok(ghost.length === 0, 'README 叫人雙擊的這些檔 release 裡沒有：' + ghost.join(', '));
    ok(!/install-daemon-only|album\.bat|bg-editor/.test(readme), 'README 還提到已經不出貨的啟動檔');

    // .sh / .command 要是 LF（CRLF 會讓 shebang 在 mac / linux 壞掉）
    const crlf = rootFiles.filter(f => /\.(sh|command)$/.test(f))
                          .filter(f => fs.readFileSync(path.join(OUT, f), 'utf8').includes('\r\n'));
    ok(crlf.length === 0, '這些 shell 啟動檔是 CRLF：' + crlf.join(', '));
}

console.log('— vpet mini（桌面小視窗，tools/vpet-mini）—');
{
    const files = ['tools/vpet-mini/vpet-mini-web.ps1', 'tools/vpet-mini/vpet-mini.vbs', 'tools/vpet-mini/README.md',
                   'tools/vpet-mini/lib/Microsoft.Web.WebView2.Core.dll', 'tools/vpet-mini/lib/Microsoft.Web.WebView2.WinForms.dll',
                   'tools/vpet-mini/lib/WebView2Loader.dll', 'tools/vpet-mini/lib/LICENSE.txt'];
    const miss = files.filter(f => !has(f));
    ok(!miss.length, 'release 少了 vpet mini 的檔案：' + miss.join('、'));
    ok(!all.some(f => /^tools\/vpet-mini\/(mini-web\.json|webview-data\/|_)/.test(f)), 'vpet mini 自己產生的設定／瀏覽器資料／除錯檔跟著出貨了');
    // dll 是二進位：大小要一模一樣（打包時被當文字處理就會壞）
    for (const f of files.filter(f => f.endsWith('.dll')))
        ok(has(f) && fs.statSync(path.join(OUT, f)).size === fs.statSync(path.join(REPO, f)).size, f + ' 出貨後大小不一樣（被當文字處理了？）');
    const mini = read('tools/vpet-mini/vpet-mini-web.ps1'), tray = read('tools/vpet-tray.ps1');
    ok(mini.charCodeAt(0) === 0xFEFF && tray.charCodeAt(0) === 0xFEFF, 'PowerShell 腳本沒有 UTF-8 BOM（5.1 會把中文拆壞）');
    // 新視窗只放行 http／https（Start-Process 收到本機路徑會直接執行程式）
    ok(/if \(\$u\.Scheme -eq 'http' -or \$u\.Scheme -eq 'https'\) \{ Start-Process \$u\.AbsoluteUri \}/.test(mini) && !/try \{ Start-Process \$e2\.Uri \}/.test(mini),
       'vpet mini 的新視窗沒有限制只開 http／https');
    ok(/if\(e\.id==='chatlog'\) return true;/.test(mini), 'vpet mini 的聊天紀錄會被當成空白拖曳（字沒辦法反白複製）');
    // 系統匣只有一個（repo 自己的），選單開小視窗、結束時一起關；小視窗看同一個 Mutex
    ok(/New-Object System\.Threading\.Mutex\(\$false, 'Local\\vpet-tray'\)/.test(tray) && /foreach \(\$mn in 'Local\\vpet-mini-tray', 'Local\\vpet-tray'\) \{\s*try \{ \$mx = \$null; if \(\[System\.Threading\.Mutex\]::TryOpenExisting\(\$mn,/.test(mini),
       'tray 跟小視窗沒有用同一個 Mutex（自動更新空檔的判斷會錯）');
    ok(/\$menu\.Items\.Add\('開啟 vpet mini 視窗'\)/.test(tray) && /Close-Mini/.test(tray), 'tray 選單沒有「開啟 vpet mini 視窗」（或結束時沒關小視窗）');
    // 提醒（v13）：進化／戰鬥開始跳通知，選單可開關；靠 /state 的 kind（evo、battle）與 jogress.frontName
    ok(/New-Object System\.Windows\.Forms\.ToolStripMenuItem\('提醒'\)/.test(tray) && /if \(\$kind -eq 'evo'\)/.test(tray) && /elseif \(\$kind -eq 'battle'\)/.test(tray)
       && /if \(\$null -eq \$prev -or \$prev -eq \$kind\) \{ return \}/.test(tray), 'tray 沒有進化／戰鬥提醒（或啟動那一拍也會跳）');
    ok(/kind: 'evo',/.test(read('src/runtime/agumon-core.js')) && /frontName: name\(real\.characterId\)/.test(read('src/daemon/daemon.js')), '頁面／core 改到提醒依賴的 kind（evo）或 jogress.frontName 了 —— tray 要一起改');
    ok(!has('tools/vpet-mini/vpet-tray.ps1') && !has('tools/vpet-mini/vpet.vbs'), '同事版的另一個系統匣也出貨了（會變成兩個 tray）');
    // 熱更後 tray 自己換新版：看自己的檔案被換掉 → 起新的（接手同一個 daemon）、自己退場時不殺 daemon
    ok(/param\(\[int\]\$AdoptPid = 0\)/.test(tray) && /\(Get-Item \$selfPath\)\.LastWriteTimeUtc -eq \$selfStamp/.test(tray)
       && /'-AdoptPid', \[string\]\$proc\.Id/.test(tray) && /if \(-not \$script:handedOff\) \{ try \{ if \(-not \$proc\.HasExited\) \{ \$proc\.Kill\(\) \} \} catch \{\} \}/.test(tray)
       && /GetProcessById\(\$AdoptPid\)/.test(tray), '熱更後 tray 不會自己換新版（或交棒時把 daemon 殺了）');
    // param 一定要是第一句（註解不算）：放在 Add-Type 後面會被當成指令，-AdoptPid 收不到 → 交棒的新 tray 直接退出（2026-10-22 踩過）
    ok(/^param\(/.test(tray.replace(/^﻿/, '').replace(/^\s*(#[^\n]*)?\r?\n/gm, '')), 'tray 的 param 不是第一句（-AdoptPid 會收不到，熱更交棒失敗、tray 消失）');
    // 舊 tray 被強制結束時 Mutex 是「被遺棄」：要接住，不然新 tray 拿不到就掛
    ok(/catch \[System\.Threading\.AbandonedMutexException\] \{ \$gotMutex = \$true \}/.test(tray) && /'Local\\vpet-tray-selfupdate'/.test(tray),
       'tray 沒接住被遺棄的 Mutex（或沒掛「會自己換新版」的記號）');
    // 熱更後換掉不會自己換新版的舊 tray：daemon 子行程跑 tray-refresh.ps1，只動外殼的父行程（命令列是 vpet-tray.ps1）
    ok(has('tools/tray-refresh.ps1'), 'release 少了 tools/tray-refresh.ps1');
    // 更新紀錄（2026-10-27）：跟著出貨；發版前檢查最上面那筆是新的（忘了寫就不發）
    ok(has('changelog.json'), 'release 少了 changelog.json（玩家的更新紀錄）');
    const pub = read('scripts/publish-release.js');
    ok(/function main\(\) \{\s*checkChangelog\(\);/.test(pub) && /if \(shipped && shipped === mine\) \{/.test(pub) && /process\.argv\.includes\('--no-changelog'\)/.test(pub),
       'publish-release 沒有檢查更新紀錄（忘了寫也會發出去）');
    const refresh = read('tools/tray-refresh.ps1');
    ok(refresh.charCodeAt(0) === 0xFEFF && /^param\(\[int\]\$ShellPid = 0\)/m.test(refresh)
       && /TryOpenExisting\('Local\\vpet-tray-selfupdate', \[ref\]\$mark\)\) \{ \$mark\.Dispose\(\); exit 0 \}/.test(refresh)
       && /\$tray = Get-CimInstance Win32_Process -Filter "ProcessId=\$\(\$shell\.ParentProcessId\)"/.test(refresh)
       && /\$tray\.CommandLine -notlike '\*vpet-tray\.ps1\*'\) \{ exit 0 \}/.test(refresh)
       && /'-AdoptPid', \[string\]\$ShellPid/.test(refresh), 'tray-refresh.ps1 的保護條件不見了（可能誤殺別的 PowerShell 或新版 tray）');
    ok(/process\.env\.VPET_PARENT_PID && process\.platform === 'win32'\) \{\s*const trayRefresh = /.test(read('src/daemon/daemon.js')),
       'daemon 熱更起來後沒有跑 tray-refresh（舊 tray 換不掉）');
    // v15：系統匣雙擊照設定開（小視窗／網頁）、左鍵單擊出選單、第一次啟動跳常駐教學（熱更交棒不跳）
    ok(/function Open-Default/.test(tray) && /\$ni\.add_MouseDoubleClick\(\{ param\(\$s, \$e\) if \(\$e\.Button -eq 'Left'\) \{ \$script:clickTimer\.Stop\(\); Open-Default \} \}\)/.test(tray)
       && /ToolStripMenuItem\('雙擊圖示開啟'\)/.test(tray) && /\$menu\.Items\.Add\('怎麼讓圖示常駐顯示？'\)/.test(tray)
       && /if \(-not \$AdoptPid -and -not \$PREF\.hintShown\)/.test(tray) && !/ShowBalloonTip\(2500, 'vpet 已啟動'/.test(tray),
       'tray 沒有 v15 的雙擊設定／常駐教學（或熱更交棒時也會跳教學）');
    // 小寵物拿 /state 的 character 拼路徑讀 art.json：只收資料夾名會有的字
    ok(/\$charId -notmatch '\^\[A-Za-z0-9_-\]\+\$'/.test(mini), 'vpet mini 讀角色圖沒有檢查 id（可以拼出 characters 以外的路徑）');
    // v15 小寵物照抄 /state 的 petLines、用 character 找角色圖比面向
    ok(/petLines: out\.petLines,/.test(read('src/daemon/daemon.js')) && /character: st\.characterId,/.test(read('src/daemon/daemon.js'))
       && /\$st\.petLines/.test(mini) && /\$st\.character/.test(mini), '/state 的 petLines／character 改了 —— vpet mini 的小寵物要一起改');
    // 跟頁面的約定：/state 的 kind、整列 .form 的 data-cmd、#chatlog（改到要一起改小視窗）
    const page = read('src/daemon/daemon.js');
    ok(/id="chatlog"/.test(page) && /<div class="form\$\{f\.dev \? ' devonly' : ''\}" data-help=/.test(page) && /kind: result\.kind/.test(page),
       '頁面改到 vpet mini 依賴的東西了（#chatlog、.form 的 data-cmd、/state 的 kind）—— 小視窗要一起改');
    // 事件（2026-10-22）：/state 的 event = { id, kind, title }；現在是營地事件（page2Quest 還沒看過）
    {
        const m = page.match(/function currentEvent\(ranch\) \{[\s\S]*?\n\}/);
        const currentEvent = m ? new Function(m[0] + '; return currentEvent;')() : () => undefined;
        const e1 = currentEvent({ page2Quest: { at: 123, seen: false } });
        ok(e1 && e1.id === 'camp:123' && e1.kind === 'camp' && e1.title, '營地事件沒有變成 /state 的 event：' + JSON.stringify(e1));
        ok(currentEvent({ page2Quest: { at: 123, seen: true } }) === null && currentEvent({}) === null && currentEvent(null) === null, '沒有事件（或看過了）還是出 event');
        ok(/\n\s*event,\s+\/\/ 「事件」/.test(page) && /event = currentEvent\(ranchNow\);/.test(page), '/state 沒有帶 event');
    }
    // 小視窗收到新事件：小寵物沒跟隨 → 比照進化回小視窗；跟隨滑鼠 → 頭上冒「❗」停下來等點；事件沒了收掉「❗」
    ok(/if \(\$evId -and \$null -ne \$script:lastEventId -and \$evId -ne \$script:lastEventId\) \{\s*if \(\$script:petMode\) \{\s*if \(\$script:Cfg\.petFollow\) \{ \$script:petAlert = \$true; Refresh-Pet \$st \} else \{ Leave-Pet; \$script:eventPulled = \$true \}/.test(mini)
       && /if \(\$script:petAlert\) \{ return \}/.test(mini)
       && /function Leave-Pet \{\s*if \(-not \$script:petMode\) \{ return \}\s*if \(\$script:petAlert\) \{ \$script:eventPulled = \$true \}[^\n]*\n\s*\$script:petAlert = \$false/.test(mini)
       && /if \(\$script:petAlert\) \{ \$pbox\.Image = Add-PetAlert/.test(mini), '小視窗收到事件的反應不對（小寵物沒回來／跟隨時沒冒驚嘆號、沒停下）');
    // v16（2026-10-27）：事件看完自動縮回桌面 —— 只限「被事件從桌面叫回來」的（自己手動縮的會清掉記號）
    ok(/if \(-not \$evId -and \$script:eventPulled -and -not \$script:petMode\) \{ \$script:eventPulled = \$false; Enter-Pet \}/.test(mini)
       && /function Enter-Pet \{\s*if \(\$script:petMode\) \{ return \}\s*\$script:eventPulled = \$false/.test(mini), '事件看完沒有自動縮回桌面（或手動縮的也會被縮）');
    // 小視窗改提醒設定：只改那一格（不能把 tray 的其他設定洗回預設）；提醒選單有「事件：跳通知」
    ok(/function Set-TrayPref\(\[string\]\$k, \$v\) \{\s*try \{ \$j = \$null; if \(Test-Path \$script:TrayPrefPath\) \{ \$j = Get-Content/.test(mini)
       && !/\$p = Get-TrayPref; \$p\[\$k\] = \$v; \(\$p \| ConvertTo-Json/.test(mini) && /@\('notifyEvent','事件：跳通知'\)/.test(mini),
       '小視窗改提醒時會把整份 vpet-tray.json 重寫（洗掉 tray 的設定），或沒有「事件：跳通知」');
    // tray 選單（v16 結構）：網頁視窗同名、小視窗／小寵物子選單寫 mini-web.json、雙擊可設「桌面」、每 2 秒重讀小視窗改過的設定
    ok(/\$menu\.Items\.Add\('開啟 vpet 網頁視窗'\)/.test(tray) && /ToolStripMenuItem\('小視窗'\)/.test(tray) && /ToolStripMenuItem\('小寵物'\)/.test(tray)
       && /function Request-Pet \{\s*Set-MiniCfg 'request' 'pet'/.test(tray) && /elseif \(\$PREF\.dblClick -eq 'pet'\) \{ Request-Pet \}/.test(tray)
       && /\$script:prefTicks\+\+; if \(\$script:prefTicks -ge 2\) \{ \$script:prefTicks = 0; Reload-PrefIfChanged \}/.test(tray)
       && /DropDownItems\.Add\('事件：跳通知'\)/.test(tray), 'tray 選單沒有 v16 的結構（或小視窗改的設定 tray 讀不到）');
    // 事件欄位帶上 v16 提案的 name／active／wantsFront
    ok(/kind: 'camp', title: '牠跑到營地了！', name: '牠跑到營地了！', active: true, wantsFront: true \}/.test(page), '/state 的 event 沒帶 name／active／wantsFront');
    // 角色 id 檢查不能在合併時被拿掉（v16 沒有這行）
    ok((mini.match(/\$charId -notmatch '\^\[A-Za-z0-9_-\]\+\$'/g) || []).length === 1, '小視窗讀角色圖的 id 檢查不見了');
    // 驚嘆號：棋盤格的「半透明」黑底（色鍵視窗做不出真的半透明）＋紅色驚嘆號
    ok(/\(\(\$x \+ \$y\) % 2\) -eq 0\) \{ \$out\.SetPixel\(\(\$bx \+ \$x\), \$y, \[System\.Drawing\.Color\]::Black\)/.test(mini) && /FromArgb\(255, 255, 77, 79\)/.test(mini),
       '小寵物的驚嘆號不是棋盤格黑底＋紅色');
    // 劇情對話框：一律放舞台下方（2026-10-27 定，不再置中蓋住營地）；小視窗撐高 body 下內距讓視窗長高
    ok(/const fits=bot\+10\+ph<=H-8;/.test(page) && /bot=hl\?Math\.max\(st\.bottom, [^;]*\):st\.bottom;/.test(page) && !/Math\.round\(\(H-ph\)\/2\)/.test(page) && /document\.body\.style\.paddingBottom=\(IN_MINI\|\|!fits\)\?/.test(page),
       '對話框不是放在舞台下方（小視窗會蓋住營地）');
    // 系統匣：新事件跳「事件發生!!」，啟動那一拍不跳，選單可關
    ok(/function On-Event\(\$ev\)/.test(tray) && /if \(\$null -eq \$prev -or -not \$id -or \$id -eq \$prev\) \{ return \}/.test(tray)
       && /ShowBalloonTip\(5000, '事件發生!!'/.test(tray) && /On-Event \$st\.event/.test(tray) && /DropDownItems\.Add\('事件：跳通知'\)/.test(tray),
       '系統匣沒有「事件發生!!」通知（或啟動時也會跳）');
}

try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (_) {}

console.log('— 狀態列的 vpet 暫停：statusline 照常、右側桌寵只擋不刪 —');
{
    const { spawnSync } = require('child_process');
    const core = require('../src/runtime/agumon-core.js');
    ok(core.STATUSLINE_PET_PAUSED === true, '狀態列 vpet 的暫停開關沒開（agumon-core 的 STATUSLINE_PET_PAUSED）');
    // 只擋不刪：安裝照常（statusline 版的人照樣裝 statusLine），程式也都還在
    ok(!/STATUSLINE_PAUSED/.test(read('scripts/install.js')), 'install.js 不該擋 statusline 本身（要的是只擋右側桌寵）');
    ok(fs.existsSync(path.join(REPO, 'src/runtime/statusline-agumon-color.js')), 'statusline 的程式被刪了（說好只擋不刪）');

    // 暫停時不要每秒刷新：每個視窗每秒起一支 node，疊起來十幾支、1GB（2026-10-16）。
    // 熱更會重跑 install，所以舊設定靠 install 拿掉就能送到同事那邊。
    const { syncRefreshInterval } = require('./install.js');
    const sl = (ri) => ri === undefined ? { type: 'command', command: 'x' } : { type: 'command', command: 'x', refreshInterval: ri };
    let s = sl(1);
    ok(syncRefreshInterval(s, true) === true && !('refreshInterval' in s), '暫停中，舊設定的 refreshInterval: 1 沒拿掉（每秒起一支 node）');
    s = sl(5);
    ok(syncRefreshInterval(s, true) === false && s.refreshInterval === 5, '使用者自己調過的 refreshInterval 被拿掉了');
    s = sl(1);
    ok(syncRefreshInterval(s, false) === false && s.refreshInterval === 1, '沒暫停（桌寵要動）卻拿掉了每秒刷新');
    ok(syncRefreshInterval(sl(), true) === false, '本來就沒有 refreshInterval 還回報「有改」');
    ok(/if \(syncRefreshInterval\(cur\.statusLine, PET_PAUSED\)\)/.test(read('scripts/install.js')), 'updateSettings 沒呼叫 syncRefreshInterval（只有指令路徑變了才會修）');
    ok(/sample\.statusLine = PET_PAUSED \?/.test(read('scripts/install.js')), '沒有 settings.json 時印的範例還是帶每秒刷新');

    // 暫存的部署樹：cheat / statusline / core 三支，core 的開關可以改成 false 當對照組
    const sandbox = (paused) => {
        const T = fs.mkdtempSync(path.join(os.tmpdir(), 'vpet-sloff-'));
        for (const f of ['statusline-cheat.js', 'statusline-agumon-color.js', 'agumon-core.js'])
            fs.copyFileSync(path.join(REPO, 'src/runtime', f), path.join(T, f));
        if (!paused) {
            const cf = path.join(T, 'agumon-core.js');
            fs.writeFileSync(cf, fs.readFileSync(cf, 'utf8').replace('const STATUSLINE_PET_PAUSED = true;', 'const STATUSLINE_PET_PAUSED = false;'));
        }
        fs.mkdirSync(path.join(T, 'assets'));
        fs.writeFileSync(path.join(T, 'assets', 'roster.json'), JSON.stringify({ roster: ['agumon'] }));   // cheat 開頭就會讀
        return { T, env: { ...process.env, AGUMON_STATE_DIR: path.join(T, 'state') } };
    };
    const cleanup = (T) => { try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) {} };

    // statusline：只輸出狀態文字，桌寵的 state 一個檔都不碰
    {
        const { T, env } = sandbox(true);
        const input = { model: { display_name: 'Opus' }, session_id: 's', cost: { total_cost_usd: 1.5 },
                        context_window: { used_percentage: 12 }, cwd: T, render_width_chars: 200 };
        // 先放一份有角色的 state（空 state 的話 saveState 本來就不寫，測不出來）＋一則新的 hook
        const SF = path.join(T, 'state', 'color-state.json');
        fs.mkdirSync(path.dirname(SF), { recursive: true });
        const seed = JSON.stringify({ characterId: 'agumon', lastHookTs: 1, trainingBonus: 3 });
        fs.writeFileSync(SF, seed);
        fs.writeFileSync(path.join(T, 'state', 'hook.json'), JSON.stringify({ ts: Date.now() }));
        const r = spawnSync(process.execPath, [path.join(T, 'statusline-agumon-color.js')],
                            { env, input: JSON.stringify(input), encoding: 'utf8' });
        ok(r.stdout === core.buildStatusLines(input).join('\n'),
           '暫停時狀態列不是只有狀態文字：' + JSON.stringify((r.stdout || '').slice(0, 80)));
        ok(fs.readFileSync(SF, 'utf8') === seed && !fs.existsSync(SF + '.bak'),
           '暫停時 statusline 還在寫桌寵的 state（會跟 daemon 搶）');
        cleanup(T);
    }

    // vpet hide / show：暫停時擋、help 不列；開關關掉照舊能用
    const hideRun = (paused) => {
        const { T, env } = sandbox(paused);
        const hide = spawnSync(process.execPath, [path.join(T, 'statusline-cheat.js'), '--hide'], { env, encoding: 'utf8' });
        const help = spawnSync(process.execPath, [path.join(T, 'statusline-cheat.js'), '--help'], { env, encoding: 'utf8' });
        const forced = fs.existsSync(path.join(T, 'state', 'force-char.json'));
        cleanup(T);
        return { code: hide.status, forced, helpHasHide: /vpet hide/.test(help.stdout || '') };
    };
    const off = hideRun(true), on = hideRun(false);
    ok(off.code !== 0 && !off.forced, '暫停時 vpet hide 沒擋（還是寫了 petHidden）');
    ok(!off.helpHasHide, '暫停時 vpet help 還在列 hide / show');
    ok(on.code === 0 && on.forced, '開關關掉後 vpet hide 壞了（恢復時要能直接用）');
    ok(on.helpHasHide, '開關關掉後 vpet help 沒列 hide / show');

    // GUIDE 的「讓桌寵住進狀態列」附錄藏在註解裡（出貨成 README 時不會顯示）
    const g = read('GUIDE.md');
    const at = g.indexOf('## 附錄：讓桌寵也住進 Claude Code 狀態列');
    ok(at > 0 && g.lastIndexOf('<!--', at) > g.lastIndexOf('-->', at),
       'GUIDE 的狀態列附錄沒有藏起來（照做也看不到桌寵）');
}

console.log(`\n結果：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
