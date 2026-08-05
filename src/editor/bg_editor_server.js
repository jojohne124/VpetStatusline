#!/usr/bin/env node
/*
 * bg_editor_server.js — daemon 舞台底圖編輯器（port 3002）。
 *
 * 為什麼影像處理全放在瀏覽器：
 *   預覽必須「所見即所得」。若預覽用 canvas、存檔用 sharp，兩邊的模糊/取樣演算法
 *   不一樣，調好的東西存出來會走鐘。所以瀏覽器直接把成品 canvas 轉成 PNG 送過來，
 *   伺服器只負責落檔 —— 預覽跟檔案保證同一份像素。
 *   （CLI 版 scripts/make-bg.js 仍用 sharp，那是不開瀏覽器時的替代路徑。）
 *
 * 角色縮圖只是預覽用的疊圖，不會被烘進底圖。
 */
const http = require('http');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const PORT        = 3002;
const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const INSTALL_DIR = path.join(os.homedir(), '.claude', 'agumon-statusline');
const ASSETS_DIR  = path.join(INSTALL_DIR, 'assets');
const CHARS_ROOT  = path.join(REPO_ROOT, 'characters');
const BG_FILE     = path.join(INSTALL_DIR, 'bg.png');

const HTML_FILE = path.join(__dirname, 'bg_editor.html');

// 角色資產優先讀已安裝的（＝daemon 實際顯示的那份），沒有再退回 repo
function charDir(id) {
    const a = path.join(ASSETS_DIR, id);
    if (fs.existsSync(path.join(a, 'art.json'))) return a;
    for (const d of fs.readdirSync(CHARS_ROOT, { withFileTypes: true })) {
        if (d.isDirectory() && d.name.toLowerCase() === id.toLowerCase()) {
            const r = path.join(CHARS_ROOT, d.name);
            if (fs.existsSync(path.join(r, 'art.json'))) return r;
        }
    }
    return null;
}

function listChars() {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, 'roster.json'), 'utf8'));
        const ids = Array.isArray(raw) ? raw : (raw.members || raw.roster || []);
        if (ids.length) return ids.slice().sort();
    } catch (e) {}
    try {
        return fs.readdirSync(ASSETS_DIR, { withFileTypes: true })
                 .filter(d => d.isDirectory()).map(d => d.name).sort();
    } catch (e) { return []; }
}

// 回傳 idle 幀的 cell 陣列（半格：每格 [tr,tg,tb,br,bg,bb]，-1 = 該半格透明）
function spriteCells(id) {
    const dir = charDir(id);
    if (!dir) return null;
    const art = JSON.parse(fs.readFileSync(path.join(dir, 'art.json'), 'utf8'));
    let idx = 0;
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
        if (cfg.frames && cfg.frames.IDLE_1 != null) idx = cfg.frames.IDLE_1;
    } catch (e) {}
    return { cells: art.frames[idx] || art.frames[0], width: art.width, height: art.height };
}

function json(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/chars') return json(res, 200, { chars: listChars() });

    if (url.pathname === '/sprite') {
        const id = url.searchParams.get('char') || 'agumon';
        try {
            const s = spriteCells(id);
            return s ? json(res, 200, s) : json(res, 404, { error: 'no art for ' + id });
        } catch (e) { return json(res, 500, { error: e.message }); }
    }

    if (url.pathname === '/current') {
        try {
            const st = fs.statSync(BG_FILE);
            return json(res, 200, { exists: true, size: st.size, mtime: st.mtimeMs });
        } catch (e) { return json(res, 200, { exists: false }); }
    }

    if (req.method === 'POST' && url.pathname === '/save') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 40 * 1024 * 1024) req.destroy(); });
        req.on('end', () => {
            try {
                const { png } = JSON.parse(body);
                const b64 = String(png).replace(/^data:image\/png;base64,/, '');
                const buf = Buffer.from(b64, 'base64');
                fs.mkdirSync(path.dirname(BG_FILE), { recursive: true });
                fs.writeFileSync(BG_FILE, buf);
                json(res, 200, { ok: true, size: buf.length, path: BG_FILE });
            } catch (e) { json(res, 400, { ok: false, error: e.message }); }
        });
        return;
    }

    if (req.method === 'POST' && url.pathname === '/remove') {
        try { fs.unlinkSync(BG_FILE); } catch (e) {}
        return json(res, 200, { ok: true });
    }

    try {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(HTML_FILE));
    } catch (e) {
        res.writeHead(500); res.end('找不到 bg_editor.html');
    }
});

server.listen(PORT, () => {
    console.log(`\n✓ 底圖編輯器 → http://localhost:${PORT}\n`);
    console.log(`  輸出：${BG_FILE}`);
    console.log(`  改完存檔後，daemon 要重開才會吃到新底圖。\n`);
});
