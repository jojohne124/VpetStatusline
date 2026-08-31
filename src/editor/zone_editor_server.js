#!/usr/bin/env node
'use strict';
/**
 * 營地走動範圍編輯器（port 3005）
 *
 * 拖拉每一隻的可走範圍，右側即時看模擬數字（重疊 / 場地利用 / 貼邊），
 * 存檔寫成 characters/yard-layouts.json 並同步到 assets/（即時生效，不用重跑 install）。
 *
 * ── 為什麼要有這個 ──
 * 分區是**看不見的**：角色為什麼不往那邊走、為什麼三隻擠在一起，只能靠猜。
 * 而好壞又不是肉眼看幾秒動畫能判斷的（重疊率要跑幾千拍才穩定），所以編輯器
 * 一定要把模擬數字擺在旁邊，否則就只是把猜測換個地方做。
 *
 * ── 座標 ──
 * 存的是 { exact: [[minX,maxX,minY,maxY], ...] } —— **dot 絕對座標**，指角色
 * 左上角能站的範圍。畫面上編的是**身體會蓋到的範圍**（+ 一個角色的寬高），
 * 換算在前端做（就是減掉那 16 dot），後端只收左上角範圍。
 *
 * ⚠️ 不用內建表那種「比例 + 接縫讓開」：那個換算在場地邊界有分支，不可逆 ——
 *    把一塊區域平移到貼邊時尺寸會跟著變。直接操作的工具不能有這種行為。
 *
 * 用法：node src/editor/zone_editor_server.js  或雙擊 zone-editor.bat
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const W = require('../shared/plaza-walk.js');

const PORT        = 3005;
const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const CHARS_ROOT  = path.join(REPO_ROOT, 'characters');
const REPO_FILE   = path.join(CHARS_ROOT, 'yard-layouts.json');
const INSTALL_DIR = path.join(os.homedir(), '.claude', 'agumon-statusline');
const ASSETS_FILE = path.join(INSTALL_DIR, 'assets', 'yard-layouts.json');
const HTML_PATH   = path.join(__dirname, 'zone_editor.html');

const F = W.YARD_FIELD, SPR = W.SPRITE;

// ── 資料 ─────────────────────────────────────────────────────────────
function loadOverride() {
    try {
        const j = JSON.parse(fs.readFileSync(REPO_FILE, 'utf8'));
        return { layouts: j.layouts || {}, default: j.default || {} };
    } catch (e) { return { layouts: {}, default: {} }; }
}

// 內建表 + 覆寫檔。內建的標成 builtin（前端讓它唯讀，避免以為改得動）。
function buildState() {
    const over = loadOverride();
    const out = { field: { w: F.w, h: F.h, minX: F.minX, maxX: F.maxX, minY: F.minY, maxY: F.maxY },
                  sprite: SPR, margin: W.ZONE_MARGIN, counts: {} };
    for (const n of Object.keys(W.YARD_LAYOUTS).map(Number)) {
        const builtin = W.YARD_LAYOUTS[n] || {};
        const custom  = over.layouts[n] || {};
        out.counts[n] = {
            def: over.default[n] || W.YARD_LAYOUT_DEFAULT[n] || null,
            // 一律以 exact 交出去 —— 前端只處理一種座標，少一個會漂的地方。
            // 內建的是比例簡寫，這裡先跑一次 yardZones 換算成實際 dot。
            layouts: [
                ...Object.keys(builtin).map(name => ({ name, builtin: true, rects: builtinToExact(n, name) })),
                ...Object.keys(custom).map(name => ({
                    name, builtin: false,
                    rects: Array.isArray(custom[name])
                        ? W.yardZones(n, F, W.ZONE_MARGIN, custom[name]).map(z => [z.minX, z.maxX, z.minY, z.maxY])
                        : (custom[name].exact || []),
                })),
            ],
        };
    }
    return out;
}

// ── 模擬 ─────────────────────────────────────────────────────────────
// 跟 test-plaza 用同一組指標。試跑 12 組 seed x 1500 拍 —— 再少數字會抖，
// 再多會讓「拖一下等一下」變得難用（目前約 0.2 秒）。
function overlapArea(a, b) {
    const dx = Math.min(a.x + SPR, b.x + SPR) - Math.max(a.x, b.x);
    const dy = Math.min(a.y + SPR, b.y + SPR) - Math.max(a.y, b.y);
    return (dx > 0 && dy > 0) ? dx * dy : 0;
}

function measure(zones, trials = 12, steps = 1500) {
    const n = zones.length;
    let bad = 0, tot = 0, area = 0, pairs = 0, real = 0, seen = 0, stay = 0, shortest = Infinity;
    const heat = zones.map(() => new Map());
    const cov = new Set();
    for (let t = 0; t < trials; t++) {
        const occ = [], cache = new Array(n).fill(null);
        for (let i = 0; i < n; i++) occ.push({ seed: 1000 * t + i * 37 + 11, joinStep: 0 });
        for (let s = 0; s < steps; s++) {
            const p = [];
            for (let i = 0; i < n; i++) {
                const q = W.posAt(occ[i], s, cache[i], zones[i]); cache[i] = q.cache; p.push(q); seen++;
                heat[i].set(q.x + ',' + q.y, (heat[i].get(q.x + ',' + q.y) || 0) + 1);
                for (let bx = q.x; bx < q.x + SPR; bx++)
                    for (let by = q.y; by < q.y + SPR; by++) cov.add(bx + ',' + by);
                if (q.x <= F.minX || q.x >= F.maxX || q.y <= F.minY || q.y >= F.maxY) {
                    real++; if (!q.moving) stay++;
                }
            }
            let worst = 0;
            for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
                const o = overlapArea(p[a], p[b]); pairs++; area += o; worst = Math.max(worst, o);
            }
            if (worst >= SPR * SPR * 0.25) bad++;
            tot++;
        }
        for (let i = 0; i < n; i++) {
            const z = zones[i];
            let st = { ...W.startPos(occ[i].seed, z), k: 0 };
            for (let j = 0; j < 150; j++) {
                const leg = W.legAt(occ[i].seed, st.k, st.x, st.y, z);
                if (!leg.stay) shortest = Math.min(shortest, leg.len);
                const [ox, oy] = W.offsetAt(leg.vx, leg.vy, leg.len);
                st.x += ox; st.y += oy; st.k += 1;
            }
        }
    }
    let hot = 0;
    zones.forEach((z, i) => {
        const cells = (z.maxX - z.minX + 1) * (z.maxY - z.minY + 1);
        const sum = [...heat[i].values()].reduce((a, b) => a + b, 0);
        if (sum) hot = Math.max(hot, Math.max(...heat[i].values()) / sum * cells);
    });
    const all = (F.maxX - F.minX + SPR) * (F.maxY - F.minY + SPR);
    return {
        overlapPct: 100 * bad / tot,          // 嚴重重疊（一對蓋掉 >= 25% 身體）的拍數比例
        avgOverlap: area / pairs,
        coverPct:   100 * cov.size / all,     // 場地利用（身體蓋到的面積 / 全場）
        edgePct:    100 * real / seen,        // 貼**真實場地邊**（區域邊界是隱形的，不算）
        stayOnEdge: stay,
        hottest:    hot,
        shortestLeg: shortest === Infinity ? 0 : shortest,
    };
}

// 區域本身合不合法（跟 test-plaza 的門檻對齊，訊息要能直接照著改）
function validate(zones) {
    const warn = [];
    zones.forEach((z, i) => {
        if (z.maxX < z.minX || z.maxY < z.minY) warn.push(`#${i + 1} 反向（寬或高是負的）`);
        else if (Math.max(z.maxX - z.minX, z.maxY - z.minY) < W.MIN_LEG)
            warn.push(`#${i + 1} 太小，連一步（MIN_LEG=${W.MIN_LEG}）都走不滿，那一隻會定住`);
    });
    return warn;
}

// exact = dot 絕對座標（編輯器的預設）；否則當成比例矩形（內建表的簡寫）
function rectsToZones(rects, exact = true) {
    return W.yardZones(rects.length, F, W.ZONE_MARGIN, exact ? { exact: rects } : rects);
}

// 內建表是比例的，要拿到編輯器裡編就先換算成 exact
function builtinToExact(n, name) {
    return W.yardZones(n, F, W.ZONE_MARGIN, name).map(z => [z.minX, z.maxX, z.minY, z.maxY]);
}

// ── 存檔：repo + 已安裝的 assets 雙寫（跟路線編輯器同一套）──────────
function save(body) {
    const n = Number(body.n);
    const name = String(body.name || '').trim();
    if (!(n >= 1)) return { ok: false, error: 'n 不合法' };
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(name))
        return { ok: false, error: '名稱只能用英數 / - / _，1~24 字（它會出現在 dev 下拉與網址參數裡）' };
    if (W.YARD_LAYOUTS[n] && W.YARD_LAYOUTS[n][name])
        return { ok: false, error: `「${name}」是內建切法，請換一個名字（內建的留著當對照組）` };
    if (!Array.isArray(body.rects) || body.rects.length !== n)
        return { ok: false, error: `要 ${n} 塊區域，收到 ${(body.rects || []).length} 塊` };
    for (const r of body.rects) {
        if (!Array.isArray(r) || r.length !== 4 || r.some(v => !Number.isInteger(v)))
            return { ok: false, error: '區域座標必須是 4 個整數（minX, maxX, minY, maxY，單位 dot）' };
        const [minX, maxX, minY, maxY] = r;
        if (minX < F.minX || maxX > F.maxX || minY < F.minY || maxY > F.maxY)
            return { ok: false, error: `區域超出場地（可站範圍 x ${F.minX}~${F.maxX}、y ${F.minY}~${F.maxY}）` };
        if (maxX < minX || maxY < minY) return { ok: false, error: '區域反向（max 小於 min）' };
    }
    const warn = validate(rectsToZones(body.rects));
    if (warn.length && !body.force) return { ok: false, error: warn.join('；'), warn };

    const over = loadOverride();
    over.layouts[n] = over.layouts[n] || {};
    over.layouts[n][name] = { exact: body.rects.map(r => r.map(v => Math.round(v))) };
    if (body.setDefault) over.default[n] = name;

    const text = JSON.stringify(over, null, 2) + '\n';
    const written = [], errors = [];
    for (const p of [REPO_FILE, ASSETS_FILE]) {
        try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); written.push(p); }
        catch (e) { errors.push(`${p}: ${e.message}`); }
    }
    return { ok: errors.length === 0, written, errors, warn };
}

function remove(body) {
    const n = Number(body.n), name = String(body.name || '');
    const over = loadOverride();
    if (!over.layouts[n] || !over.layouts[n][name])
        return { ok: false, error: '這不是自訂切法（內建的刪不掉）' };
    delete over.layouts[n][name];
    if (over.default[n] === name) delete over.default[n];
    const text = JSON.stringify(over, null, 2) + '\n';
    const errors = [];
    for (const p of [REPO_FILE, ASSETS_FILE]) {
        try { fs.writeFileSync(p, text); } catch (e) { errors.push(`${p}: ${e.message}`); }
    }
    return { ok: errors.length === 0, errors };
}

function readBody(req) {
    return new Promise(resolve => {
        let b = ''; req.on('data', c => { b += c; if (b.length > 65536) req.destroy(); });
        req.on('end', () => resolve(b));
    });
}

const server = http.createServer(async (req, res) => {
    const urlPath = req.url.split('?')[0];
    const json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
    };
    try {
        if (req.method === 'GET' && urlPath === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(fs.readFileSync(HTML_PATH));
        } else if (req.method === 'GET' && urlPath === '/state') {
            json(200, buildState());
        } else if (req.method === 'POST' && urlPath === '/measure') {
            const b = JSON.parse(await readBody(req));
            const zones = rectsToZones(b.rects || [], b.exact !== false);
            json(200, { ok: true, zones, warn: validate(zones), stats: measure(zones) });
        } else if (req.method === 'POST' && urlPath === '/save') {
            json(200, save(JSON.parse(await readBody(req))));
        } else if (req.method === 'POST' && urlPath === '/delete') {
            json(200, remove(JSON.parse(await readBody(req))));
        } else {
            res.writeHead(404); res.end('Not found');
        }
    } catch (e) {
        json(500, { ok: false, error: e.message });
    }
});

// 只有直接執行才 listen —— 測試要 require 進來驗 measure / validate / save，
// 一 require 就佔住 port 的話那些邏輯只能用 HTTP 繞著測（route_editor 踩過的坑）。
if (require.main === module) server.listen(PORT, () => {
    console.log(`\n✓ 營地走動範圍編輯器 → http://localhost:${PORT}\n`);
    console.log('  拖框改每一隻的走動範圍，右側即時跑模擬（重疊 / 場地利用 / 貼邊）');
    console.log('  內建切法唯讀，存成新名字；勾「設為預設」才會真的換掉營地用的那個');
    console.log(`  存檔：characters/${path.basename(REPO_FILE)} 與 assets/（即時生效，不用重跑 install）`);
    console.log('\n  Ctrl+C 結束\n');
});

module.exports = { measure, validate, save, remove, buildState, rectsToZones, builtinToExact,
                   PORT, REPO_FILE, ASSETS_FILE };
