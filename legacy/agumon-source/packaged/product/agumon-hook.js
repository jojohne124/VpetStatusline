#!/usr/bin/env node
// Claude Code UserPromptSubmit hook（可分享版）
// 每次使用者送出訊息時觸發，寫入 ~/.claude/agumon-hook.json 供 statusline 觸發大吼
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK_FILE = path.join(os.homedir(), '.claude', 'agumon-hook.json');

let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    fs.writeFileSync(HOOK_FILE, JSON.stringify({ ts: Date.now(), event: 'UserPromptSubmit' }));
  } catch (e) {}
  process.stdout.write('');
});

