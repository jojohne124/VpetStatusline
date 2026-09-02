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

try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (_) {}

console.log(`\n結果：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
