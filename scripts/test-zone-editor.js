#!/usr/bin/env node
'use strict';
/**
 * test-zone-editor.js — 營地走動範圍編輯器
 *
 * 這支驗兩層：
 *   1. server 的純邏輯（measure / validate / save / delete）—— 直接 require 進來，
 *      不起 HTTP。zone_editor_server.js 用 require.main 守住 listen 就是為了這個。
 *   2. 前端的座標換算（rectToBody / bodyToRect）—— 頁面 script 在假 DOM 裡跑，
 *      跟 test-route-editor / test-daemon-page 同一招。
 *
 * 為什麼值得測：
 *   - **存檔會寫到 repo 與已安裝的 assets 兩個地方**。少寫一邊的症狀是「編輯器
 *     顯示存好了，營地卻沒變」（或反過來，重跑 install 就被打回原形）。
 *   - 座標有兩套：檔案裡是「角色左上角」的比例，畫面上編的是「身體覆蓋範圍」。
 *     換算錯一個角色寬（16 dot）不會報錯，只會讓框跟實際走的地方差一截 ——
 *     dev 的框就是這樣錯過一次。
 *   - measure 是拿來做決定的數字。它若默默回 0，畫面上一片綠、實際擠成一團。
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const vm   = require('vm');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };

const REPO = path.resolve(__dirname, '..');
const Z = require(path.join(REPO, 'src', 'editor', 'zone_editor_server.js'));
const W = require(path.join(REPO, 'src', 'shared', 'plaza-walk.js'));

// ── 1. 模擬指標 ──────────────────────────────────────────────────────
console.log('— 模擬指標 —');
{
    // 內建表是比例簡寫，編輯器一律用 exact —— 換算過再餵，否則等於在測另一種座標
    const good = Z.rectsToZones(Z.builtinToExact(3, 'quadFull'));
    const bad  = Z.rectsToZones(Z.builtinToExact(3, 'rows'));
    const flat = new Array(3).fill(W.YARD_FIELD);

    const sg = Z.measure(good), sb = Z.measure(bad), sf = Z.measure(flat);
    ok(sg.overlapPct < sf.overlapPct / 3,
       `分區沒有明顯壓低重疊：不分區 ${sf.overlapPct.toFixed(1)}% -> quadFull ${sg.overlapPct.toFixed(1)}%`);
    // 用平均重疊面積比，不用「嚴重重疊率」：模擬改成量營地畫面上的角色（16 細格，
    // 比走路格子的 16 格小一圈）之後，這兩種切法的嚴重重疊（蓋掉 >= 25% 身體）都是 0%，
    // 那個指標已經分不出好壞了。平均面積還分得出來（rows 約是 quadFull 的十幾倍）。
    ok(sb.avgOverlap > sg.avgOverlap * 3,
       `rows 應該明顯比 quadFull 差（平均重疊 ${sb.avgOverlap.toFixed(1)} vs ${sg.avgOverlap.toFixed(1)} dot²）`);
    ok(sg.coverPct > 99, `quadFull 應該蓋滿場地，得到 ${sg.coverPct.toFixed(0)}%`);
    ok(Z.measure(Z.rectsToZones(Z.builtinToExact(3, 'quad'))).coverPct < 90,
       'quad 有死區，場地利用不該接近 100%（這條若過了代表覆蓋率算錯）');
    // 指標不能默默回 0 —— 那會讓畫面上一片綠
    for (const [k, v] of Object.entries(sg))
        ok(Number.isFinite(v), `measure 的 ${k} 不是有限數字：${v}`);
    ok(sg.shortestLeg >= 1, 'shortestLeg 回 0 代表根本沒走過（模擬沒跑起來）');
}

// ── 2. 合法性檢查 ────────────────────────────────────────────────────
console.log('— 合法性檢查 —');
{
    ok(Z.validate(Z.rectsToZones(Z.builtinToExact(3, 'quadFull'))).length === 0, '正常切法不該有警告');
    const tiny = Z.validate([{ minX: 0, maxX: 1, minY: 0, maxY: 1 }]);
    ok(tiny.length === 1 && /MIN_LEG/.test(tiny[0]), '太小的區域要被指出來（那一隻會定住）');
    ok(Z.validate([{ minX: 10, maxX: 2, minY: 0, maxY: 5 }]).length === 1, '反向的區域要被指出來');
}

// ── 3. 存檔：repo 與 assets 都要寫到 ─────────────────────────────────
console.log('— 存檔 —');
{
    const backup = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
    const restore = (p, v) => { try { v === null ? fs.rmSync(p, { force: true }) : fs.writeFileSync(p, v); } catch (e) {} };
    const b1 = backup(Z.REPO_FILE), b2 = backup(Z.ASSETS_FILE);
    try {
        const NAME = 'zzTest' + process.pid % 1000;
        const rects = Z.builtinToExact(3, 'quadFull');

        // 內建名稱不可覆蓋 —— 內建的要留著當對照組
        ok(Z.save({ n: 3, name: 'quadFull', rects }).ok === false, '內建切法不該被覆蓋');
        // 名稱會進 dev 下拉與網址參數，只收英數
        ok(Z.save({ n: 3, name: 'a b', rects }).ok === false, '名稱有空白時應該擋下來');
        ok(Z.save({ n: 3, name: NAME, rects: rects.slice(0, 2) }).ok === false, '塊數不對應該擋下來');
        ok(Z.save({ n: 3, name: NAME, rects: [[0, 999, 0, 8], rects[1], rects[2]] }).ok === false,
           '座標超出場地應該擋下來');
        ok(Z.save({ n: 3, name: NAME, rects: [[0, 14.5, 0, 8], rects[1], rects[2]] }).ok === false,
           '非整數座標應該擋下來（存的是 dot，不是比例）');
        ok(Z.save({ n: 3, name: NAME, rects: [[14, 0, 0, 8], rects[1], rects[2]] }).ok === false,
           '反向座標應該擋下來');

        const r = Z.save({ n: 3, name: NAME, rects, setDefault: true });
        ok(r.ok, '存檔失敗：' + (r.error || (r.errors || []).join('；')));
        ok(r.written.length === 2, `只寫了 ${r.written.length} 個檔（要 repo + assets 兩邊）`);
        for (const p of [Z.REPO_FILE, Z.ASSETS_FILE]) {
            const j = JSON.parse(fs.readFileSync(p, 'utf8'));
            const entry = (j.layouts['3'] || {})[NAME];
            ok(!!entry, `${path.basename(path.dirname(p))} 那份沒有寫進切法`);
            ok(entry && Array.isArray(entry.exact) && entry.exact.every(r => r.every(Number.isInteger)),
               `${path.basename(path.dirname(p))} 存的不是 exact 整數座標`);
            ok(j.default['3'] === NAME, `${path.basename(path.dirname(p))} 那份沒有設成預設`);
        }

        // runtime 真的讀得到（這才是「存了會生效」的證明）
        let core = null;
        try { core = require(path.join(os.homedir(), '.claude', 'agumon-statusline', 'agumon-core.js')); } catch (e) {}
        if (!core) { console.log('  – 沒有已安裝的 core，跳過生效檢查'); }
        else {
            const plaza = require(path.join(REPO, 'src', 'daemon', 'plaza.js'));
            const info = plaza.yardLayoutsFor(core, 3);
            ok(info.names.includes(NAME), 'runtime 沒有看到新存的切法');
            ok(info.def === NAME, 'runtime 的預設沒有跟著換');
        }

        // 刪除：自訂的刪得掉、內建的刪不掉
        ok(Z.remove({ n: 3, name: 'quadFull' }).ok === false, '內建切法不該刪得掉');
        ok(Z.remove({ n: 3, name: NAME }).ok, '自訂切法應該刪得掉');
        ok(!(JSON.parse(fs.readFileSync(Z.REPO_FILE, 'utf8')).layouts['3'] || {})[NAME], '刪完檔案裡還在');
    } finally {
        restore(Z.REPO_FILE, b1); restore(Z.ASSETS_FILE, b2);
    }
}

// ── 3b. 存完之後 runtime 的三個出口要一致 ────────────────────────────
// 走路用的區域（composeYard）、畫框用的區域（/yard 的 payload）、dev 下拉的名單，
// 三者必須都看得到覆寫檔。少一個的症狀就是「存了沒生效」。
console.log('— 覆寫檔要三個出口都吃到 —');
{
    let core = null;
    try { core = require(path.join(os.homedir(), '.claude', 'agumon-statusline', 'agumon-core.js')); } catch (e) {}
    if (!core) { console.log('  – 沒有已安裝的 core，跳過'); }
    else {
        const plaza = require(path.join(REPO, 'src', 'daemon', 'plaza.js'));
        const backup = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
        const restore = (p, v) => { try { v === null ? fs.rmSync(p, { force: true }) : fs.writeFileSync(p, v); } catch (e) {} };
        const b1 = backup(Z.REPO_FILE), b2 = backup(Z.ASSETS_FILE);
        try {
            const NAME = 'zzOv' + process.pid % 1000;
            // 刻意跟任何內建切法都不一樣，這樣「有沒有吃到」一眼看得出來
            const rects = [[0, 9, 0, 11], [27, 36, 0, 11], [13, 22, 15, 24]];
            const r = Z.save({ n: 3, name: NAME, rects, setDefault: true, force: true });
            ok(r.ok, '前置存檔失敗：' + (r.error || ''));

            const custom = plaza.yardZonesFor(core, 3);
            const builtin = W.yardZones(3);
            ok(JSON.stringify(custom) !== JSON.stringify(builtin),
               'yardZonesFor 沒有吃到覆寫檔（跟內建表一模一樣）');

            // 走路用的區域
            const ranch = { pets: [1, 2, 3].map(i => ({ id: 'p' + i, state: { characterId: 'agumon' } })) };
            const occ = plaza.yardOccupants(core, ranch, {}, null, null, core);
            ok(JSON.stringify(occ.map(o => o.field)) === JSON.stringify(custom),
               'composeYard 用的區域不是覆寫檔那份');

            // dev 下拉的名單與預設
            const info = plaza.yardLayoutsFor(core, 3);
            ok(info.names.includes(NAME), 'dev 下拉的名單少了自訂切法');
            ok(info.def === NAME, 'dev 下拉的預設沒有跟著換');

            // 指名不存在的切法 → 退回**目前生效的**預設，不是內建預設
            ok(JSON.stringify(plaza.yardZonesFor(core, 3, '__nope__')) === JSON.stringify(custom),
               '指名不存在的切法時退回了內建預設（刪掉自訂切法後畫面會靜靜跳回出廠值）');
            // 指名內建的仍然拿得到內建的
            ok(JSON.stringify(plaza.yardZonesFor(core, 3, 'quad'))
               === JSON.stringify(W.yardZones(3, undefined, undefined, 'quad')),
               '指名內建切法時沒有拿到內建的那份');
        } finally { restore(Z.REPO_FILE, b1); restore(Z.ASSETS_FILE, b2); }
    }
}

// ── 4. 前端的座標換算 ────────────────────────────────────────────────
// 檔案存的是「角色左上角」的比例，畫面上編的是「身體覆蓋範圍」的 dot。
// 差一個角色寬（16 dot）不會報錯，只會讓框跟實際走的地方差一截。
console.log('— 前端座標換算 —');
{
    const HTML = fs.readFileSync(path.join(REPO, 'src', 'editor', 'zone_editor.html'), 'utf8');
    const m = HTML.match(/<script>([\s\S]*?)<\/script>/);
    ok(!!m, '抓不到頁面 script');
    if (m) {
        const el = () => ({
            style: {}, dataset: {}, width: 0, height: 0, value: '', textContent: '', innerHTML: '', disabled: false,
            getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }),
            getBoundingClientRect: () => ({ left: 0, top: 0 }),
            addEventListener() {}, focus() {}, select() {},
        });
        const g = {
            document: { getElementById: () => el(), addEventListener() {} },
            window: null, fetch: () => new Promise(() => {}),
            setTimeout: () => 0, clearTimeout() {}, confirm: () => false, console,
            addEventListener() {}, Math, JSON,
        };
        g.window = g; g.globalThis = g;
        vm.createContext(g);
        const epilogue = ';globalThis.__p={setST:(s)=>{ST=s;},r2b:(r)=>rectToBody(r),b2r:(b)=>bodyToRect(b),'
                       + 'mv:(r,dx,dy)=>moveRect(r,dx,dy),sz:(r,z)=>sameZone(r,z)};';
        let err = null;
        try { vm.runInContext(m[1] + epilogue, g, { timeout: 5000 }); } catch (e) { err = e; }
        ok(!err, '頁面 script 執行就爆了：' + (err && err.message));
        if (!err && g.__p) {
            const F = W.YARD_FIELD;
            // 營地畫面的座標：編輯器要跟營地用同一套（plaza.js 那份），從伺服器拿
            const PL = require(path.join(REPO, 'src', 'daemon', 'plaza.js'));
            const R = PL.YARD_RENDER;
            // ⚠️ margin 一定要給。少了它 zoneGap() 會是 NaN，而 NaN 一路傳下去
            //    畫出來只是「框沒出現」，不會報錯 —— 假 ST 漏欄位就是這樣騙過測試的。
            //    render 也一樣：少了它換算整個爆掉（改成畫面座標時踩過，整支測試當掉）。
            g.__p.setST({ field: { minX: F.minX, maxX: F.maxX, minY: F.minY, maxY: F.maxY },
                          sprite: W.SPRITE, margin: W.ZONE_MARGIN,
                          render: { w: R.w, h: R.h, kx: R.kx, ky: R.ky } });
            // 整場（左上角能站遍全場）→ 身體剛好鋪滿營地畫布（營地就是這樣畫的）
            const full = g.__p.r2b([F.minX, F.maxX, F.minY, F.maxY]);
            ok(full.x === 0 && full.y === 0, `整場的原點不對：(${full.x},${full.y})`);
            ok(full.w === R.w && full.h === R.h,
               `整場應該剛好鋪滿營地畫布 ${R.w}x${R.h}，得到 ${full.w}x${full.h}`);

            // **編輯器的框必須等於營地畫面上實際的區域**（回報過「走動範圍編輯器跟畫面
            // 不符」）。營地畫框用的是 plaza.yardToDraw，這裡逐區比對。
            for (const name of Object.keys(W.YARD_LAYOUTS[3])) {
                const exact = Z.builtinToExact(3, name);
                const zones = W.yardZones(3, undefined, undefined, { exact });
                exact.forEach((r, i) => {
                    const b = g.__p.r2b(r), z = zones[i];
                    const lo = PL.yardToDraw(z.minX, z.minY), hi = PL.yardToDraw(z.maxX, z.maxY);
                    const same = b.x === lo.x && b.y === lo.y
                              && b.w === hi.x + W.SPRITE - lo.x && b.h === hi.y + W.SPRITE - lo.y;
                    ok(same, `${name} #${i + 1} 編輯器的框與營地畫面不符：`
                        + `框 ${b.w}x${b.h}@(${b.x},${b.y}) vs 營地 `
                        + `${hi.x + W.SPRITE - lo.x}x${hi.y + W.SPRITE - lo.y}@(${lo.x},${lo.y})`);
                });
            }

            // 區域清單旁的「框與實際不符」：資料正確時一個都不能亮。換成畫面座標時漏改，
            // 拿細格的框去比走路格子，每一區都誤報過。
            {
                let falseAlarm = 0, checked = 0;
                for (const n of Object.keys(W.YARD_LAYOUTS).map(Number)) {
                    for (const name of Object.keys(W.YARD_LAYOUTS[n])) {
                        const exact = Z.builtinToExact(n, name);
                        const zones = W.yardZones(n, undefined, undefined, { exact });
                        exact.forEach((r, i) => { checked++; if (!g.__p.sz(r, zones[i])) falseAlarm++; });
                    }
                }
                ok(checked > 5, '檢查得太少');
                ok(falseAlarm === 0, `資料正確卻標了 ${falseAlarm} 次「框與實際不符」`);
                // 真的不一樣時要抓得到（不然這個檢查等於沒有）
                ok(!g.__p.sz([0, 14, 0, 8], { minX: 0, maxX: 13, minY: 0, maxY: 8 }), '範圍真的不同卻沒標出來');
            }

            // 來回換算要**完全**對得回去（倍率都大於 1，每個走路格子對到不同的畫面 dot）
            for (const r of Z.builtinToExact(3, 'quadFull')) {
                const back = g.__p.b2r(g.__p.r2b(r));
                ok(JSON.stringify(back) === JSON.stringify(r),
                   `exact -> body -> exact 對不回去：${JSON.stringify(r)} -> ${JSON.stringify(back)}`);
            }

            // **平移不可以改變尺寸** —— 這是「移動區到邊緣會變動區塊大小」那個 bug。
            // 存檔的矩形（走路格子）寬高一格都不能變。直接測頁面的 moveRect，
            // 不在這裡另寫一份夾法（另寫的那份對了，不代表頁面的對）。
            // 位移用小數、各種相位都掃 —— 畫面與走路格子的倍率不是整數，
            // 「移動畫面上的框再換回去」只在某些位置才會差 1 格，掃少了抓不到。
            {
                const r0 = [10, 19, 6, 14];
                const w0 = r0[1] - r0[0], h0 = r0[3] - r0[2];
                let drifted = 0, outside = 0, tried = 0;
                for (let dx = -60; dx <= 60; dx += 0.7) for (const dy of [-60, -7.3, -1.2, 0, 2.6, 9.9, 60]) {
                    const r = g.__p.mv(r0, dx, dy); tried++;
                    if (r[1] - r[0] !== w0 || r[3] - r[2] !== h0) drifted++;
                    if (r[0] < F.minX || r[1] > F.maxX || r[2] < F.minY || r[3] > F.maxY) outside++;
                }
                ok(tried > 500, '平移掃得太少');
                ok(drifted === 0, `平移之後尺寸變了 ${drifted} 次（原本 ${w0}x${h0} 走路格）`);
                ok(outside === 0, `平移超出場地 ${outside} 次`);
                // 拖到最邊要真的貼齊（夾住之後還是要能貼邊，不是停在半路）
                const left = g.__p.mv(r0, -999, -999), right = g.__p.mv(r0, 999, 999);
                ok(left[0] === F.minX && left[2] === F.minY, '拖到左上角沒有貼齊：' + JSON.stringify(left));
                ok(right[1] === F.maxX && right[3] === F.maxY, '拖到右下角沒有貼齊：' + JSON.stringify(right));
            }
        } else if (!err) { ok(false, '抓不到前端的換算函式'); }
    }
}

console.log(`\n結果：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
