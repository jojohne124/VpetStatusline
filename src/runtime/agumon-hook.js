#!/usr/bin/env node
// Claude Code UserPromptSubmit hook
// 每次使用者按 Enter 送出訊息時觸發，寫入時間戳供 statusline 讀取後大吼
const fs   = require('fs');
const path = require('path');

const INSTALL_ROOT = __dirname;
const HOOK_FILE    = path.join(INSTALL_ROOT, 'state', 'hook.json');

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch(e) {} }

// Watchdog：父行程異常關閉／洩漏 stdin 管線時，'end' 不會觸發，本 hook 會卡成孤兒。
// 必須用 ref'd 計時器（不可 unref）——unref 的計時器不算進 libuv poll 逾時，loop 阻塞在
// 等 stdin 時不會被叫醒 → 形同虛設（詳見 statusline-agumon-color.js 同段註解）。收到 'end'
// 後 clearTimeout，正常路徑零延遲退出。
const _watchdog = setTimeout(() => process.exit(0), 8000);

let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
    clearTimeout(_watchdog);
    try {
        ensureDir(path.dirname(HOOK_FILE));
        fs.writeFileSync(HOOK_FILE, JSON.stringify({ ts: Date.now(), event: 'UserPromptSubmit' }));
    } catch(e) {}
    process.stdout.write('');
});
