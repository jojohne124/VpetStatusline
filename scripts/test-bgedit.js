#!/usr/bin/env node
// 舞台底圖編輯器：預覽疊圖只能是現在養的那隻（列出全部角色＝暴雷，回報過）。
// 隔離的 state 目錄＋別的 port，不碰使用者真的存檔，也不呼叫 /save、/remove。
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const PORT = 3192;
const get = (p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: p }, s => {
    let d = ''; s.on('data', c => d += c); s.on('end', () => res(JSON.parse(d))); }).on('error', rej));

async function withServer(state, fn) {
    const sd = fs.mkdtempSync(path.join(os.tmpdir(), 'vpet-bgedit-'));
    if (state) fs.writeFileSync(path.join(sd, 'color-state.json'), JSON.stringify(state));
    const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'bgedit', 'bg_editor_server.js')],
        { env: { ...process.env, AGUMON_STATE_DIR: sd, AGUMON_BG_PORT: String(PORT) }, stdio: 'ignore' });
    try {
        for (let i = 0; i < 100; i++) { try { await get('/current'); break; } catch (e) { await wait(100); } }
        await fn();
    } finally {
        srv.kill(); await wait(200);
        try { fs.rmSync(sd, { recursive: true, force: true }); } catch (e) {}
    }
}

(async () => {
    console.log('— 底圖編輯器只疊現在的角色 —');
    await withServer({ characterId: 'gabumon' }, async () => {
        const c = await get('/chars');
        ok(JSON.stringify(c.chars) === '["gabumon"]', '角色清單不是只有現在養的那隻：' + JSON.stringify(c.chars).slice(0, 80));
        const s = await get('/sprite?char=agumon');
        const own = await get('/sprite?char=gabumon');
        ok(s.cells && JSON.stringify(s) === JSON.stringify(own), '改網址還是看得到別的角色');
    });
    await withServer(null, async () => {
        const c = await get('/chars');
        ok(JSON.stringify(c.chars) === '["agumon"]', '沒有存檔時應該是起始的亞古獸：' + JSON.stringify(c.chars).slice(0, 80));
    });
    console.log(`\n結果：${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERR', e.stack); process.exit(1); });
