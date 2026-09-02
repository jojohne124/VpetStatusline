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

const { loadAlbum, ALBUM_FILE, getCharacterStage, silhouetteArt, loadCharacter } = core;

// ⚠️ 刻意不用 core.getRosterSet()：它把 roster 快取在模組變數裡（_rosterSetCache），
//    對短命的 statusline 行程是划算的，但本 server 是常駐的 —— 用 route editor 改完
//    實裝名單後只重新整理網頁，會拿到開站當下的舊名單。圖鑑的契約是「每次開啟都對齊
//    當前的路線設計」，所以這裡每次都重讀。檔案小（一份 json），成本可忽略。
function loadRosterFresh() {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, 'roster.json'), 'utf8'));
        const list = Array.isArray(raw) ? raw : raw.roster;
        return Array.isArray(list) && list.length ? new Set(list) : null;
    } catch (e) { return null; }   // 讀不到 → fail-open（不過濾），與 core 的行為一致
}

function loadStartersFresh() {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, 'roster.json'), 'utf8'));
        return Array.isArray(raw.starters) && raw.starters.length ? raw.starters : null;
    } catch (e) { return null; }
}

function loadSpecialRules() {
    try {
        const j = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, 'special-evolutions.json'), 'utf8'));
        return Array.isArray(j.rules) ? j.rules : [];
    } catch (e) { return []; }
}
const RULES = require('../shared/evo-rules.js');   // 可達性判定（純敵人＝走不到 starter）
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
    const roster = loadRosterFresh();
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
    return pruneUnreachable(out);
}

// roster 只擋掉一半。**在 roster 裡、但沒有任何角色進化到它**的那幾隻
// （biollante / xiquemon / shishimamon / destoroyah）症狀一模一樣：
// 玩家永遠到不了，卻算在分母裡 —— 永遠停在 129/133，四個 ??? 解不開。
//
// 規則：走不到 starter 的都算純敵人。用**算的**而不是列名單 ——
// 名單會過期，musyamon 那條鏈就是靠 roster 意外擋住的，不是有人記得把它列進去。
function pruneUnreachable(all) {
    const starters = loadStartersFresh();
    if (!starters) return all;   // fail-open，同 roster
    const nodes = Object.values(all).map(n => ({ id: n.id, stage: n.stage }));
    const edges = [];
    for (const n of Object.values(all))
        for (const nx of n.next) if (all[nx]) edges.push({ from: n.id, to: nx });
    const reach = RULES.reachableFrom({ nodes, edges }, starters, loadSpecialRules());
    if (!reach) return all;
    const out = {};
    for (const id of Object.keys(all)) if (reach.has(id)) out[id] = all[id];
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

    // ── 血緣圖排版 ──
    // x = 階段；y 由走訪順序決定。每次請求重算，所以進化鏈一改、重新整理就對齊新路線。
    //
    // ⚠️ 進化圖是 DAG 不是樹：不同起點會匯流到同一隻（例如 biyomon 和 pteromon 共用
    //    整棵 birdramon 子樹；metalgreymon_2010 有兩個父節點）。舊版把它當樹處理，
    //    兩個毛病：
    //      1. 起點只按 id 字母序排 → 明明共用子樹的兩條線被不相干的家族隔開
    //      2. 父節點只取「還沒被別人認領」的子節點平均 → 後走訪到的起點被擠到最底，
    //         拉出一條橫跨整張圖的長邊（pteromon row 14 → birdramon row 5.75）
    //
    // 現在分三步：
    //   1. 起點先依「連通分量」分組（互相共用節點的算同一組），組內再按 id 排 →
    //      有血緣關係的線一定相鄰
    //   2. 依這個順序 DFS，只有葉節點依序拿列號
    //   3. 反拓樸序回推內部節點 = 「所有」子節點的平均（含被別人先認領的）→
    //      匯流點的父節點會落在子節點中間，長邊縮短
    const childrenOf = {};
    for (const e of edges) (childrenOf[e.from] = childrenOf[e.from] || []).push(e.to);
    const hasParent = new Set(edges.map(e => e.to));
    const roots = ids.filter(id => !hasParent.has(id)).sort();

    // 1. 連通分量（把邊當無向）→ 起點分組
    const comp = {};
    {
        const adj = {};
        const link = (a, b) => { (adj[a] = adj[a] || []).push(b); (adj[b] = adj[b] || []).push(a); };
        for (const e of edges) link(e.from, e.to);
        let cid = 0;
        for (const id of ids) {
            if (comp[id] != null) continue;
            const stack = [id];
            comp[id] = cid;
            while (stack.length) {
                const cur = stack.pop();
                for (const nb of (adj[cur] || [])) if (comp[nb] == null) { comp[nb] = cid; stack.push(nb); }
            }
            cid++;
        }
    }
    // 分量的先後：用該分量內最小的起點 id 當代表，保證每次結果一致（重新整理不會跳動）
    const compFirstRoot = {};
    for (const r of roots) if (compFirstRoot[comp[r]] == null) compFirstRoot[comp[r]] = r;
    const orderedRoots = roots.slice().sort((a, b) => {
        const ca = compFirstRoot[comp[a]], cb = compFirstRoot[comp[b]];
        if (ca !== cb) return ca < cb ? -1 : 1;   // 先比分量代表
        return a < b ? -1 : (a > b ? 1 : 0);      // 同分量內按 id
    });

    // 2. DFS 走訪，收「後序」（子節點全部完成才把自己 push 進去）。
    //
    // ⚠️ 一定要後序，不能用前序反過來當拓樸序。DAG 有 cross edge：peckmon → crowmon，
    //    而 crowmon 早就從 birdramon 那條路走過了。前序裡 peckmon 排在 crowmon 之後，
    //    反過來處理時 crowmon 還沒算出列號 → peckmon 取不到子節點平均，被丟到最底。
    //    後序保證「每個節點被處理時，它的所有子節點都已完成」，cross edge 也成立。
    const row = {};
    const post = [];
    const seen = new Set();
    (function walk(list) {
        for (const id of list) {
            if (seen.has(id)) continue;
            seen.add(id);
            walk(childrenOf[id] || []);
            post.push(id);
        }
    })(orderedRoots);
    ids.forEach(id => { if (!seen.has(id)) { seen.add(id); post.push(id); } });   // 孤兒（理論上不會有）

    // 3. 依後序處理：葉節點依序拿列號，內部節點取「所有」子節點的平均
    //    （含被別的分支先認領的，這是與舊版最關鍵的差異 —— 匯流點的父節點會落在
    //    子節點中間，而不是被擠到圖的最底端拉出一條長邊）。
    //    葉節點在後序中的相對先後與前序相同，所以視覺上仍是由上而下依血緣排列。
    let nextRow = 0;
    for (const id of post) {
        const kids = childrenOf[id] || [];
        if (!kids.length) { row[id] = nextRow++; continue; }
        const rs = kids.map(k => row[k]).filter(r => r != null);
        row[id] = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : nextRow++;
    }

    // 4. 同欄防重疊。取平均會讓同一階的兩隻算出一樣的列（實測 biyomon 與 pteromon
    //    都落在 5.12、metalgreymon 與 g-metalgreymon 都落在 1.00）→ 畫面上直接疊在
    //    一起，比長邊更難讀。舊版是靠「每棵子樹各佔一段連續列」碰巧避開的。
    //    這裡逐欄掃過去，保證同欄相鄰節點至少差 1 列；只往下推，相對順序不變。
    const colOf = {};
    for (const id of ids) {
        const si = STAGE_ORDER.indexOf(all[id].stage);
        colOf[id] = si < 0 ? STAGE_ORDER.length : si;
    }
    const postIdx = {};
    post.forEach((id, i) => { postIdx[id] = i; });
    const byCol = {};
    for (const id of ids) (byCol[colOf[id]] = byCol[colOf[id]] || []).push(id);
    for (const c of Object.keys(byCol)) {
        // 平手時用後序索引決定先後 → 同樣的輸入永遠得到同樣的圖，重新整理不會跳動
        const list = byCol[c].sort((a, b) => (row[a] - row[b]) || (postIdx[a] - postIdx[b]));
        let prev = -Infinity;
        for (const id of list) {
            if (row[id] < prev + 1) row[id] = prev + 1;
            prev = row[id];
        }
    }

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
