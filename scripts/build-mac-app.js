#!/usr/bin/env node
'use strict';
/**
 * build-mac-app.js — 由 tools/vpet-standalone.applescript 產生 vpet-standalone.app
 *
 * 為什麼要有 .app：macOS 雙擊 .command 一定會開 Terminal 視窗（小黑窗），
 * 而 .app bundle 不會 —— 這是 Windows 那邊 .vbs 的對應物。
 *
 * 為什麼不把 .app 直接進 git：osacompile 產出的是編譯後的 main.scpt（二進位），
 * 進 git 會變成不可 diff 的產物。改成留 .applescript 原始碼 + 本地建置。
 *
 * 非 macOS 直接跳過（osacompile 是 macOS 內建工具）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SRC = path.join(REPO, 'tools', 'vpet-standalone.applescript');
const OUT = path.join(REPO, 'vpet-standalone.app');

if (process.platform !== 'darwin') {
    console.log('[build-mac-app] 非 macOS，跳過（.app 只在 macOS 有意義）。');
    process.exit(0);
}
if (!fs.existsSync(SRC)) {
    console.error(`[build-mac-app] 找不到來源：${SRC}`);
    process.exit(1);
}

// osacompile 不會覆寫既有 bundle，先清掉舊的
fs.rmSync(OUT, { recursive: true, force: true });

const r = spawnSync('osacompile', ['-o', OUT, SRC], { stdio: 'inherit' });
if (r.status !== 0) {
    console.error('[build-mac-app] osacompile 失敗。');
    process.exit(r.status || 1);
}
console.log(`[build-mac-app] 已產生 ${path.relative(REPO, OUT)} —— 雙擊即可啟動，不會有小黑窗。`);
