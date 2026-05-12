// 簡易 HTTP 伺服器：編輯 packaged/assets/agumon_pixels_color.json
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 3000;
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const JSON_PATH = path.join(ASSETS_DIR, 'agumon_pixels_color.json');
const HTML_PATH = path.join(__dirname, 'sprite_editor.html');

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(HTML_PATH));
    return;
  }
  if (req.method === 'GET' && req.url === '/data') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(fs.readFileSync(JSON_PATH));
    return;
  }
  if (req.method === 'POST' && req.url === '/save') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        if (fs.existsSync(JSON_PATH)) fs.copyFileSync(JSON_PATH, JSON_PATH + '.bak');
        fs.writeFileSync(JSON_PATH, body);

        let convertOut = '';
        try {
          convertOut = execSync('node color_convert_to_cells.js', { cwd: __dirname, encoding: 'utf8' });
        } catch (e) {
          convertOut = 'convert error: ' + e.message;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, convert: convertOut.trim() }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n✓ Sprite editor running at http://localhost:${PORT}\n`);
  console.log('  - 編輯的是 packaged/assets/agumon_pixels_color.json');
  console.log('  - 儲存時自動重生 packaged/assets/agumon_art_color.json');
  console.log('\n  Ctrl+C 結束伺服器\n');
});

