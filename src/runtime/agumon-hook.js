#!/usr/bin/env node
// Claude Code UserPromptSubmit hook
// 每次使用者按 Enter 送出訊息時觸發，寫入時間戳供 statusline 讀取後大吼
const fs   = require('fs');
const path = require('path');

const INSTALL_ROOT = __dirname;
const HOOK_FILE    = path.join(INSTALL_ROOT, 'state', 'hook.json');

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch(e) {} }

let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
    try {
        ensureDir(path.dirname(HOOK_FILE));
        fs.writeFileSync(HOOK_FILE, JSON.stringify({ ts: Date.now(), event: 'UserPromptSubmit' }));
    } catch(e) {}
    process.stdout.write('');
});
