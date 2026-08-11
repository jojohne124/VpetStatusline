#!/usr/bin/env node
/*
 * cutin_editor_server.js — CutIn 裁切編輯器（port 3003）。
 *
 * 用途：從大張點陣原圖（big.png）拉一個 32x16 的框，裁出戰鬥／卡片用的 CutIn。
 *
 * 為什麼是 32x16 且只能 1:1 裁切：
 *   char-cli 的 cutin 目標固定 32x16 邏輯像素（→ 32 欄 x 8 列半格）。來源尺寸必須是
 *   32x16 的整數倍才不會糊 —— 非整數倍會走 nearest 硬取樣，點陣就毀了。
 *   所以框的大小只提供「能整除的倍率」，不讓自由縮放。
 *
 * 存檔流程：裁切 → 放大 3x 存成 CutIn.png（與現有 125 隻同規格，日後手改也好操作）
 *          → 呼叫 char-cli cutin 轉出 cutin-art.json（沿用同一份轉檔程式，避免兩套邏輯分歧）
 *          → 部署到 installed assets。
 */
const http = require('http');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT        = 3003;
const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const CHARS_ROOT  = path.join(REPO_ROOT, 'characters');
const INSTALL_DIR = path.join(os.homedir(), '.claude', 'agumon-statusline');
const ASSETS_DIR  = path.join(INSTALL_DIR, 'assets');
const HTML_FILE   = path.join(__dirname, 'cutin_editor.html');

const TW = 32, TH = 16;          // CutIn 邏輯網格
const OUT_SCALE = 3;             // 存成 96x48，與既有 CutIn.png 同規格

function charDirs() {
    return fs.readdirSync(CHARS_ROOT, { withFileTypes: true })
             .filter(d => d.isDirectory())
             .map(d => d.name)
             .filter(n => fs.existsSync(path.join(CHARS_ROOT, n, 'config.json')));
}

function json(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // 角色清單：標出誰有 big.png（可裁）、誰已有 CutIn.png
    if (url.pathname === '/chars') {
        const list = charDirs().map(name => ({
            name,
            big:   fs.existsSync(path.join(CHARS_ROOT, name, 'big.png')),
            cutin: fs.existsSync(path.join(CHARS_ROOT, name, 'CutIn.png')),
        }));
        return json(res, 200, { chars: list });
    }

    // 來源圖：big.png（優先）或現有 CutIn.png，給瀏覽器 canvas 載入
    if (url.pathname === '/src') {
        const name = url.searchParams.get('char') || '';
        const which = url.searchParams.get('file') || 'big';
        const f = path.join(CHARS_ROOT, name, which === 'cutin' ? 'CutIn.png' : 'big.png');
        try {
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
            res.end(fs.readFileSync(f));
        } catch (e) { res.writeHead(404); res.end(); }
        return;
    }

    // 存檔：瀏覽器把「已經裁好並放大 3x 的 96x48 PNG」送過來，伺服器落檔 + 轉檔 + 部署。
    // 裁切在瀏覽器做的理由同 bg_editor：預覽與成品保證是同一份像素。
    if (req.method === 'POST' && url.pathname === '/save') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 20 * 1024 * 1024) req.destroy(); });
        req.on('end', () => {
            try {
                const { char, png } = JSON.parse(body);
                if (!char || !charDirs().includes(char)) return json(res, 400, { ok: false, error: '未知角色 ' + char });
                const dir = path.join(CHARS_ROOT, char);
                const outP = path.join(dir, 'CutIn.png');

                // 先備份既有的，改壞了還能還原
                if (fs.existsSync(outP) && !fs.existsSync(outP + '.bak')) fs.copyFileSync(outP, outP + '.bak');

                fs.writeFileSync(outP, Buffer.from(String(png).replace(/^data:image\/png;base64,/, ''), 'base64'));

                // 沿用 char-cli 轉檔（單一真理，不另寫一份半格轉換）
                const log = execFileSync('node', [path.join(REPO_ROOT, 'src', 'tools', 'char-cli.js'), 'cutin', char],
                                         { cwd: REPO_ROOT, encoding: 'utf8' });

                // 部署到 installed（daemon / statusline 讀這份）
                let deployed = false;
                const dst = path.join(ASSETS_DIR, char.toLowerCase(), 'cutin-art.json');
                try {
                    if (fs.existsSync(path.dirname(dst))) {
                        fs.copyFileSync(path.join(dir, 'cutin-art.json'), dst);
                        deployed = true;
                    }
                } catch (e) {}
                json(res, 200, { ok: true, log: log.trim(), deployed });
            } catch (e) { json(res, 400, { ok: false, error: e.message }); }
        });
        return;
    }

    try {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(HTML_FILE));
    } catch (e) { res.writeHead(500); res.end('找不到 cutin_editor.html'); }
});

server.listen(PORT, () => {
    console.log(`\n✓ CutIn 裁切編輯器 → http://localhost:${PORT}\n`);
    console.log(`  來源：characters/<角色>/big.png`);
    console.log(`  存檔：CutIn.png(${TW * OUT_SCALE}x${TH * OUT_SCALE}) → cutin-art.json → 部署\n`);
});
