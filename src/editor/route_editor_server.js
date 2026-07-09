// 進化路線 / 參數編輯器 server
// 啟動：node src/editor/route_editor_server.js
// 與點陣編輯器（sprite_editor_server.js, port 3000）分開的獨立工具。
//
// 資料真相：characters/<Dir>/config.json（power/stage/evolvesTo/conditions）
//           + characters/roster.json（roster[]=已實裝 / starters[]）
// 節點座標另存 characters/evo-layout.json（僅編輯器用，不部署）。
// 存檔同時寫 repo source 與 install assets（~/.claude/agumon-statusline/assets），即時生效。
const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const RULES = require('../shared/evo-rules');

const PORT = 3001;
const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const CHARS_ROOT  = path.join(REPO_ROOT, 'characters');
const ROSTER_PATH = path.join(CHARS_ROOT, 'roster.json');
const LAYOUT_PATH = path.join(CHARS_ROOT, 'evo-layout.json');
const HTML_PATH   = path.join(__dirname, 'route_editor.html');

const INSTALL_DIR = path.join(os.homedir(), '.claude', 'agumon-statusline');
const ASSETS_DIR  = path.join(INSTALL_DIR, 'assets');

// ── 載入所有角色 config（小寫 id → {dir, cfg}）──────────────────────────────
function loadConfigs() {
    const out = {};
    for (const dir of fs.readdirSync(CHARS_ROOT)) {
        const p = path.join(CHARS_ROOT, dir, 'config.json');
        if (!fs.existsSync(p)) continue;
        let cfg; try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch(e) { continue; }
        out[dir.toLowerCase()] = { dir, cfg };
    }
    return out;
}
function loadRoster() {
    try {
        const r = JSON.parse(fs.readFileSync(ROSTER_PATH, 'utf8'));
        if (Array.isArray(r)) return { roster: r, starters: [], starterWeights: {}, highTierStarters: [] };
        return {
            roster: r.roster || [], starters: r.starters || [],
            starterWeights: r.starterWeights || {}, highTierStarters: r.highTierStarters || [],
        };
    } catch(e) { return { roster: [], starters: [], starterWeights: {}, highTierStarters: [] }; }
}
function loadLayout() {
    try { return JSON.parse(fs.readFileSync(LAYOUT_PATH, 'utf8')); } catch(e) { return {}; }
}

// 讀一條邊的 conditions 取 pct / cost / minBattles
function edgeParams(evo) {
    const conds = evo.conditions ?? (evo.condition ? [evo.condition] : []);
    const cost = conds.find(c => c.type === 'cost_threshold');
    const win  = conds.find(c => c.type === 'win_rate');
    const tod  = conds.find(c => c.type === 'time_of_day');
    return {
        pct: win ? win.pct : null,
        cost: cost ? cost.usd : null,
        minBattles: win ? win.minBattles : null,
        time: tod ? tod.period : null,
    };
}

// 讀某角色 idle_1 幀（color-halfblock）給前端畫縮圖。讀不到回 null。
function loadIdleSprite(dir, cfg) {
    try {
        const art = JSON.parse(fs.readFileSync(path.join(CHARS_ROOT, dir, 'art.json'), 'utf8'));
        if (!art.frames || !art.frames.length) return null;
        const idx = (cfg.frames && cfg.frames.IDLE_1 != null) ? cfg.frames.IDLE_1 : 0;
        const cells = art.frames[idx] || art.frames[0];
        return { w: art.width, h: art.height, cells };
    } catch(e) { return null; }
}

// ── 建圖：給前端 ───────────────────────────────────────────────────────────
function buildGraph() {
    const cfgs = loadConfigs();
    const { roster, starters, starterWeights, highTierStarters } = loadRoster();
    const layout = loadLayout();
    const rosterSet = new Set(roster);
    const starterSet = new Set(starters);
    const highTierSet = new Set(highTierStarters);

    const nodes = [];
    const edges = [];
    for (const id in cfgs) {
        const { dir, cfg } = cfgs[id];
        const lay = layout[id] || {};
        nodes.push({
            id, dir,
            name: cfg.name || id,
            // 沒 stage 欄位的特殊角色（boss）保留為 UnStage，不推導成真階段，
            // 否則存檔會替它們套上 tier cap / 被當該階敵人配對。
            stage: cfg.stage || 'UnStage',
            power: cfg.power ?? 10,
            starter: starterSet.has(id),
            implanted: rosterSet.has(id),
            weight: starterWeights[id] ?? 1,
            highTier: highTierSet.has(id),
            sprite: loadIdleSprite(dir, cfg),
            x: lay.x ?? null,
            y: lay.y ?? null,
        });
        for (const evo of (cfg.evolvesTo || [])) {
            const p = edgeParams(evo);
            edges.push({
                from: id, to: evo.character,
                pct: p.pct, cost: p.cost, minBattles: p.minBattles, time: p.time,
            });
        }
    }
    return { nodes, edges };
}

// ── 驗證：補建議 pct + 死路 ─────────────────────────────────────────────────
function validate(graph) {
    const nodeById = {};
    for (const n of graph.nodes) nodeById[n.id] = n;
    // 每個 parent 用 resolvePcts 算建議值（pct=null 者補公式值 + tie-break）
    const byParent = {};
    for (const e of graph.edges) (byParent[e.from] = byParent[e.from] || []).push(e);
    const suggestions = {};
    for (const from in byParent) {
        const src = nodeById[from]; if (!src) continue;
        const kids = byParent[from].map(e => ({
            tgt: e.to, power: (nodeById[e.to] || {}).power ?? 0,
            pct: e.pct, isNew: e.pct == null, time: e.time,
        }));
        const resolved = RULES.resolvePcts(kids, src.stage, src.power);
        resolved.forEach(k => { suggestions[from + '>' + k.tgt] = k.pct; });
    }
    // 死路用「已定案 pct」（前端有填就用填的，沒填用建議）
    const effEdges = graph.edges.map(e => ({
        from: e.from, to: e.to, time: e.time,
        pct: e.pct != null ? e.pct : suggestions[e.from + '>' + e.to],
    }));
    const dead = RULES.findDeadPaths({ nodes: graph.nodes, edges: effEdges });
    return { suggestions, dead };
}

// ── 存檔：寫回 config + roster + layout，部署到 assets ──────────────────────
function save(graph) {
    const cfgs = loadConfigs();
    const nodeById = {};
    for (const n of graph.nodes) nodeById[n.id] = n;
    const { suggestions } = validate(graph);

    // 每個 parent 的 edges
    const byParent = {};
    for (const e of graph.edges) (byParent[e.from] = byParent[e.from] || []).push(e);

    const written = [];
    const deployErrors = [];
    for (const n of graph.nodes) {
        const entry = cfgs[n.id];
        if (!entry) continue;               // 只編既有角色（不建新角色/美術）
        const cfg = entry.cfg;
        cfg.power = n.power;
        // 只有選了真階段才寫；UnStage（特殊 boss 的 sentinel）維持 config 原樣
        // （原本無 stage 就保持無、原本寫 "UnStage" 就保留），runtime 兩者等價。
        if (n.stage && n.stage !== 'UnStage') cfg.stage = n.stage;
        const kids = (byParent[n.id] || []).slice()
            .sort((a, b) => ((nodeById[a.to] || {}).power ?? 0) - ((nodeById[b.to] || {}).power ?? 0));
        cfg.evolvesTo = kids.map(e => {
            const conds = [
                { type: 'cost_threshold', usd: e.cost != null ? e.cost : RULES.costFor(n.stage) },
                { type: 'win_rate',
                  pct: e.pct != null ? e.pct : suggestions[e.from + '>' + e.to],
                  minBattles: e.minBattles != null ? e.minBattles : RULES.minBattlesFor(n.stage) },
            ];
            if (e.time) conds.push({ type: 'time_of_day', period: e.time });
            return { character: e.to, conditions: conds };
        });

        const srcPath = path.join(CHARS_ROOT, entry.dir, 'config.json');
        fs.copyFileSync(srcPath, srcPath + '.bak');
        const json = JSON.stringify(cfg, null, 2) + '\n';
        fs.writeFileSync(srcPath, json);
        // 部署到 assets/<lc>/config.json
        try {
            const dstDir = path.join(ASSETS_DIR, n.id);
            if (fs.existsSync(dstDir)) fs.writeFileSync(path.join(dstDir, 'config.json'), json);
        } catch(e) { deployErrors.push(`${n.id}: ${e.message}`); }
        written.push(n.id);
    }

    // roster / starters：保留既有順序、加新去舊
    const { roster: oldRoster, starters: oldStarters } = loadRoster();
    const implantedSet = new Set(graph.nodes.filter(n => n.implanted).map(n => n.id));
    const starterSet   = new Set(graph.nodes.filter(n => n.starter).map(n => n.id));
    const roster   = oldRoster.filter(id => implantedSet.has(id));
    for (const id of [...implantedSet].sort()) if (!roster.includes(id)) roster.push(id);
    const starters = oldStarters.filter(id => starterSet.has(id));
    for (const id of [...starterSet].sort()) if (!starters.includes(id)) starters.push(id);
    // starter 權重（非 1 才存，保持精簡）+ 高階 starter 清單（reset 用 dust_hi）
    const starterWeights = {};
    for (const n of graph.nodes) if (n.starter && n.weight != null && n.weight !== 1) starterWeights[n.id] = n.weight;
    const highTierStarters = graph.nodes.filter(n => n.starter && n.highTier).map(n => n.id).sort();
    const rosterOut = JSON.stringify({ roster, starters, starterWeights, highTierStarters }, null, 2) + '\n';
    fs.copyFileSync(ROSTER_PATH, ROSTER_PATH + '.bak');
    fs.writeFileSync(ROSTER_PATH, rosterOut);
    try { fs.writeFileSync(path.join(ASSETS_DIR, 'roster.json'), rosterOut); }
    catch(e) { deployErrors.push(`roster: ${e.message}`); }

    // layout（座標）— 只寫 source，不部署
    const layout = {};
    for (const n of graph.nodes) if (n.x != null && n.y != null) layout[n.id] = { x: Math.round(n.x), y: Math.round(n.y) };
    fs.writeFileSync(LAYOUT_PATH, JSON.stringify(layout, null, 2) + '\n');

    const { dead } = validate(graph);
    return { ok: true, written: written.length, roster: roster.length, starters: starters.length, dead, deployErrors };
}

function readBody(req) {
    return new Promise(resolve => {
        let b = ''; req.on('data', c => b += c); req.on('end', () => resolve(b));
    });
}

const server = http.createServer(async (req, res) => {
    const urlPath = req.url.split('?')[0];
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    try {
        if (req.method === 'GET' && urlPath === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(fs.readFileSync(HTML_PATH));
        } else if (req.method === 'GET' && urlPath === '/graph') {
            json(200, buildGraph());
        } else if (req.method === 'POST' && urlPath === '/validate') {
            const g = JSON.parse(await readBody(req));
            json(200, validate(g));
        } else if (req.method === 'POST' && urlPath === '/save') {
            const g = JSON.parse(await readBody(req));
            json(200, save(g));
        } else {
            res.writeHead(404); res.end('Not found');
        }
    } catch(e) {
        json(500, { ok: false, error: e.message });
    }
});

server.listen(PORT, () => {
    console.log(`\n✓ 進化路線編輯器 → http://localhost:${PORT}\n`);
    console.log('  拖拉節點排版、連線編輯進化邊、右側面板改 power/stage/條件');
    console.log('  ☑實裝 = 加入 roster（未實裝角色不會出場也不會被進化進去）');
    console.log('  存檔：寫回 characters/ 與 ~/.claude/agumon-statusline/assets（即時生效）');
    console.log('\n  Ctrl+C 結束\n');
});
