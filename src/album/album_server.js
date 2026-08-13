#!/usr/bin/env node
'use strict';
/*
 * album_server.js — 圖鑑檢視器（port 3004）。
 *
 * ⚠️ 這是「玩家功能」不是開發工具，所以住在 src/album/ 而不是 src/editor/
 *    —— build-release 會排除整個 src/editor，放錯地方 release 使用者就沒得用。
 *
 * 顯示規則（漸進揭露，避免一開場就是 130 隻的大表）：
 *   可見 = 養過的 ∪ 養過的「直接進化目標」
 *   → 沒碰過的 starter 整條鏈不存在（starter 不會是任何人的進化目標）
 *   → 養過的顯示 idle 動畫 + 名字；只是「下一步」的顯示黑影 + ???
 *   → Super-Ultimate 例外：未取得前節點完全不存在（彩蛋不劇透），取得後才現身
 *
 * 排版在伺服器端即時算，不存座標檔：可見節點會隨進度變動，本來就無法預先排好；
 * 這也順帶讓「日後角色一直增加」不需要任何註冊或重排。
 */
const http = require('http');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

// 與 daemon 同樣的策略：優先用已安裝的 core（跟 statusLine 同一份權威）
let core;
const INSTALLED_CORE = path.join(os.homedir(), '.claude', 'agumon-statusline', 'agumon-core.js');
try { core = require(INSTALLED_CORE); }
catch (e) { core = require(path.join(__dirname, '..', 'runtime', 'agumon-core.js')); }

const { loadAlbum, ALBUM_FILE, getCharacterStage, silhouetteArt, loadCharacter, getRosterSet } = core;
const ASSETS_DIR = path.join(core.INSTALL_ROOT, 'assets');
const PORT = parseInt(process.env.AGUMON_ALBUM_PORT || '3004', 10);
const HTML_FILE = path.join(__dirname, 'album.html');

const SU_STAGE = 'Super-Ultimate';
const STAGE_ORDER = ['Child', 'Adult', 'Perfect', 'Ultimate', SU_STAGE];

function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }

// 全庫的 id → {stage, name, evolvesTo[]}
//
// ⚠️ 只收「已實裝」＝ roster 成員。assets/ 底下比 roster 多出十幾個資料夾：
//    還沒接進化鏈的新角色、以及 shadow（黑影 fallback）、majaja（PvP 練習對手）
//    這種本來就不是玩家角色的。它們算進分母會讓「已收錄 X / Y」的 Y 灌水，
//    而且 checkEvolution 本來就用同一個 roster 當 gate（agumon-core.js:546）
//    跳過非 roster 目標 —— 那些節點玩家永遠到不了，畫成 ??? 只是誤導。
//    讀不到 roster 時 fail-open（不過濾），與 core 的 getRosterSet 一致。
function loadAll() {
    const out = {};
    const roster = getRosterSet();
    let dirs = [];
    try { dirs = fs.readdirSync(ASSETS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
    catch (e) { return out; }
    for (const id of dirs) {
        if (roster && !roster.has(id)) continue;
        const cfg = readJSON(path.join(ASSETS_DIR, id, 'config.json'));
        if (!cfg) continue;
        out[id] = {
            id,
            name: cfg.name && cfg.name.toLowerCase() === id ? cfg.name : (id.charAt(0).toUpperCase() + id.slice(1)),
            stage: cfg.stage || 'UnStage',
            next: (cfg.evolvesTo || []).map(e => e.character).filter(Boolean),
        };
    }
    return out;
}

// idle 兩幀的 cell 陣列。raised=false 時轉成黑影。
function idleFrames(id, raised) {
    try {
        const ch  = loadCharacter(id);
        const art = readJSON(ch.artFile);
        if (!art || !art.frames) return null;
        const F = ch.charDef && ch.charDef.F ? ch.charDef.F : {};
        const i1 = F.IDLE_1 != null ? F.IDLE_1 : 0;
        const i2 = F.IDLE_2 != null ? F.IDLE_2 : i1;
        const src = { ...art, frames: [art.frames[i1], art.frames[i2]] };
        const use = raised ? src : silhouetteArt(src);
        return { w: art.width, h: art.height, frames: use.frames };
    } catch (e) { return null; }
}

// ── 可見集合 + 排版 ────────────────────────────────────────────────────────
function buildGraph() {
    const all = loadAll();
    const album = loadAlbum();
    const raised = new Set(Object.keys(album.chars || {}));

    // 可見 = 養過的 ∪ 養過的直接進化目標；SU 未取得則整個不存在
    const visible = new Set();
    for (const id of raised) if (all[id]) visible.add(id);
    for (const id of raised) {
        for (const nx of (all[id] ? all[id].next : [])) {
            if (!all[nx]) continue;
            if (getCharacterStage(nx) === SU_STAGE && !raised.has(nx)) continue;   // SU 不劇透
            visible.add(nx);
        }
    }

    const ids = [...visible];
    const edges = [];
    for (const id of ids) for (const nx of all[id].next) if (visible.has(nx)) edges.push({ from: id, to: nx });

    // ── 血緣樹排版 ──
    // 舊的 evo-layout 是「x=階段、y 依戰力」，同階把不同血緣混在一起 → 連線交叉。
    // 這裡改成：x 仍是階段，y 由深度優先走訪決定 —— 每棵子樹佔一段連續的列，
    // 父節點取子節點列的平均。同一條鏈的連線因此平行，跨鏈交叉幾乎消失。
    const childrenOf = {};
    for (const e of edges) (childrenOf[e.from] = childrenOf[e.from] || []).push(e.to);
    const hasParent = new Set(edges.map(e => e.to));
    const roots = ids.filter(id => !hasParent.has(id)).sort();

    const row = {};
    let nextRow = 0;
    const seen = new Set();
    function place(id) {
        if (seen.has(id)) return row[id];
        seen.add(id);
        const kids = (childrenOf[id] || []).filter(k => !seen.has(k));
        if (!kids.length) { row[id] = nextRow++; return row[id]; }
        const rs = kids.map(place).filter(r => r != null);
        row[id] = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : nextRow++;
        return row[id];
    }
    roots.forEach(place);
    ids.forEach(id => { if (row[id] == null) row[id] = nextRow++; });   // 孤兒（理論上不會有）

    const nodes = ids.map(id => {
        const isRaised = raised.has(id);
        const si = STAGE_ORDER.indexOf(all[id].stage);
        return {
            id,
            name: isRaised ? all[id].name : '???',
            stage: all[id].stage,
            raised: isRaised,
            at: isRaised ? (album.chars[id] || 0) : 0,
            col: si < 0 ? STAGE_ORDER.length : si,
            row: row[id],
            art: idleFrames(id, isRaised),
        };
    });

    // owned 只算「已實裝且養過」的 —— 與 total 同一個母體，否則萬一 album.json 裡有
    // 已從 roster 移除的舊角色，會出現 owned > total 這種看起來壞掉的數字。
    const ownedCount = [...raised].filter(id => all[id]).length;
    return { nodes, edges, total: Object.keys(all).length, owned: ownedCount };
}

function json(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/data') {
        try { return json(res, 200, buildGraph()); }
        catch (e) { return json(res, 500, { error: e.message }); }
    }

    // 點擊時才要 CutIn（不隨 /data 一起送，省流量也避免未取得的角色外洩圖）
    if (url.pathname === '/cutin') {
        const id = url.searchParams.get('char') || '';
        const album = loadAlbum();
        if (!album.chars || !album.chars[id]) return json(res, 403, { error: 'not_owned' });
        try {
            const ch = loadCharacter(id);
            const art = readJSON(ch.cutinArtFile);
            return json(res, 200, art ? { cells: art.frames[0] } : { cells: null });
        } catch (e) { return json(res, 404, { error: 'no_cutin' }); }
    }

    try {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(HTML_FILE));
    } catch (e) { res.writeHead(500); res.end('找不到 album.html'); }
});

server.listen(PORT, () => {
    console.log(`\n✓ vpet 圖鑑 → http://localhost:${PORT}\n`);
    console.log(`  記錄檔：${ALBUM_FILE}\n`);
});
