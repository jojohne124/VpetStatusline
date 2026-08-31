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
    ok(sb.overlapPct > sg.overlapPct * 3,
       `rows 應該明顯比 quadFull 差（${sb.overlapPct.toFixed(1)}% vs ${sg.overlapPct.toFixed(1)}%）`);
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
        const epilogue = ';globalThis.__p={setST:(s)=>{ST=s;},r2b:(r)=>rectToBody(r),b2r:(b)=>bodyToRect(b)};';
        let err = null;
        try { vm.runInContext(m[1] + epilogue, g, { timeout: 5000 }); } catch (e) { err = e; }
        ok(!err, '頁面 script 執行就爆了：' + (err && err.message));
        if (!err && g.__p) {
            const F = W.YARD_FIELD;
            // ⚠️ margin 一定要給。少了它 zoneGap() 會是 NaN，而 NaN 一路傳下去
            //    畫出來只是「框沒出現」，不會報錯 —— 假 ST 漏欄位就是這樣騙過測試的。
            g.__p.setST({ field: { minX: F.minX, maxX: F.maxX, minY: F.minY, maxY: F.maxY },
                          sprite: W.SPRITE, margin: W.ZONE_MARGIN });
            // 整場（左上角能站遍全場）→ 身體覆蓋整張畫布（可走範圍 + 一個角色）
            const full = g.__p.r2b([F.minX, F.maxX, F.minY, F.maxY]);
            ok(full.x === F.minX && full.y === F.minY, `整場的原點不對：(${full.x},${full.y})`);
            ok(full.w === F.maxX - F.minX + W.SPRITE && full.h === F.maxY - F.minY + W.SPRITE,
               `整場的身體範圍應是 ${F.maxX - F.minX + W.SPRITE}x${F.maxY - F.minY + W.SPRITE}，得到 ${full.w}x${full.h}`);

            // **畫面上的框必須等於 runtime 真正算出來的區域**（回報過「實際的可走
            // 範圍似乎比編輯的小」）。編輯器全程 exact，所以這是純粹的 +16 dot。
            for (const name of Object.keys(W.YARD_LAYOUTS[3])) {
                const exact = Z.builtinToExact(3, name);
                const zones = W.yardZones(3, undefined, undefined, { exact });
                exact.forEach((r, i) => {
                    const b = g.__p.r2b(r), z = zones[i];
                    const same = b.x === z.minX && b.y === z.minY
                              && b.w === z.maxX - z.minX + W.SPRITE
                              && b.h === z.maxY - z.minY + W.SPRITE;
                    ok(same, `${name} #${i + 1} 畫面的框與實際區域不符：`
                        + `框 ${b.w}x${b.h}@(${b.x},${b.y}) vs 實際 `
                        + `${z.maxX - z.minX + W.SPRITE}x${z.maxY - z.minY + W.SPRITE}@(${z.minX},${z.minY})`);
                });
            }

            // 來回換算要**完全**對得回去（exact 是純加減，沒有分支，不該有誤差）
            for (const r of Z.builtinToExact(3, 'quadFull')) {
                const back = g.__p.b2r(g.__p.r2b(r));
                ok(JSON.stringify(back) === JSON.stringify(r),
                   `exact -> body -> exact 對不回去：${JSON.stringify(r)} -> ${JSON.stringify(back)}`);
            }

            // **平移不可以改變尺寸** —— 這是「移動區到邊緣會變動區塊大小」那個 bug。
            // 一路平移到貼齊四個邊，每一步的寬高都要跟原本一樣。
            {
                const r0 = [10, 19, 6, 14];
                const b0 = g.__p.r2b(r0);
                let drifted = 0;
                for (const [dx, dy] of [[-99, 0], [99, 0], [0, -99], [0, 99], [-99, -99], [99, 99]]) {
                    // 模擬前端拖曳時的夾法：先夾位置、不動尺寸
                    const maxW = F.maxX - F.minX + W.SPRITE, maxH = F.maxY - F.minY + W.SPRITE;
                    const b = { ...b0 };
                    b.x = Math.max(0, Math.min(maxW - b.w, b.x + dx));
                    b.y = Math.max(0, Math.min(maxH - b.h, b.y + dy));
                    const back = g.__p.r2b(g.__p.b2r(b));
                    if (back.w !== b0.w || back.h !== b0.h) drifted++;
                }
                ok(drifted === 0, `平移之後尺寸變了 ${drifted} 次（原本 ${b0.w}x${b0.h}）`);
            }
        } else if (!err) { ok(false, '抓不到前端的換算函式'); }
    }
}

console.log(`\n結果：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
