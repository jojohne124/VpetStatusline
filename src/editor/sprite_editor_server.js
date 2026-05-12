// 啟動方式：node sprite_editor_server.js <character>
// 例：node sprite_editor_server.js agumon
const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFileSync } = require('child_process');

const name = process.argv[2] || 'agumon';
const PORT = 3000;

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const CHAR_DIR    = path.join(REPO_ROOT, 'characters', name);
const JSON_PATH   = path.join(CHAR_DIR, 'pixels.json');
const HTML_PATH   = path.join(__dirname, 'sprite_editor.html');
const CHAR_CLI    = path.join(REPO_ROOT, 'src', 'tools', 'char-cli.js');

const INSTALL_DIR = path.join(os.homedir(), '.claude', 'agumon-statusline');
const ASSETS_DIR  = path.join(INSTALL_DIR, 'assets');
const STATE_DIR   = path.join(INSTALL_DIR, 'state');

if (!fs.existsSync(CHAR_DIR)) {
    console.error(`找不到角色資料夾：${CHAR_DIR}`);
    process.exit(1);
}

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(HTML_PATH));
    }
    else if (req.method === 'GET' && req.url === '/meta') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        let frameNames = null, rightOffset = null;
        try {
            const cfg = JSON.parse(fs.readFileSync(path.join(CHAR_DIR, 'config.json'), 'utf8'));
            frameNames = cfg.frameNames || null;
            rightOffset = cfg.rightOffset ?? null;
        } catch(e) {}
        res.end(JSON.stringify({ name, frameNames, rightOffset }));
    }
    else if (req.method === 'GET' && req.url === '/data') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(fs.readFileSync(JSON_PATH));
    }
    else if (req.method === 'POST' && req.url === '/save') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                if (fs.existsSync(JSON_PATH)) fs.copyFileSync(JSON_PATH, JSON_PATH + '.bak');
                fs.writeFileSync(JSON_PATH, body);

                let convertOut = '';
                try {
                    convertOut = execFileSync('node', [CHAR_CLI, 'build', name], { encoding: 'utf8' });
                } catch(e) { convertOut = 'build error: ' + e.message; }

                // 部署 art.json 到 statusline runtime（讓 statusline 即時吃到新圖）
                const assetDir = path.join(ASSETS_DIR, name.toLowerCase());
                const artSrc   = path.join(CHAR_DIR, 'art.json');
                const artDst   = path.join(assetDir, 'art.json');
                try {
                    if (!fs.existsSync(assetDir)) fs.mkdirSync(assetDir, { recursive: true });
                    fs.copyFileSync(artSrc, artDst);
                } catch(e) { convertOut += '\ncopy error: ' + e.message; }

                // 清除 statusline 狀態快取
                const stateFile = path.join(STATE_DIR, 'color-state.json');
                try { fs.unlinkSync(stateFile); } catch(e) {}

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, convert: convertOut.trim() }));
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
    }
    else { res.writeHead(404); res.end('Not found'); }
});

server.listen(PORT, () => {
    console.log(`\n✓ Sprite editor [${name}] → http://localhost:${PORT}\n`);
    console.log('  編輯完按 Ctrl+S 或「儲存」');
    console.log('  儲存時自動：備份 pixels.json、重建 art.json、部署到 ~/.claude/agumon-statusline/、清除快取');
    console.log('\n  Ctrl+C 結束\n');
});
