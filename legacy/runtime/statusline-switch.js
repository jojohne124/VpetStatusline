#!/usr/bin/env node
// Usage: node ~/.claude/statusline-switch.js [1|2|3|4|5]
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSIONS = {
  '1': { cmd: 'powershell.exe -NoProfile -NonInteractive -File C:/Users/kaihsiangchang/.claude/statusline.ps1', label: 'PS1 原版' },
  '2': { cmd: 'node C:/Users/kaihsiangchang/.claude/statusline-oneline.js', label: '單行 JS' },
  '3': { cmd: 'node C:/Users/kaihsiangchang/.claude/statusline-compact.js', label: '緊湊 2 行 JS' },
  '4': { cmd: 'node C:/Users/kaihsiangchang/.claude/statusline-agumon.js', label: '黑白亞古獸動畫' },
  '5': { cmd: 'node C:/Users/kaihsiangchang/.claude/statusline-agumon-color.js', label: '彩色亞古獸動畫' },
};

const ver = process.argv[2];
if (!VERSIONS[ver]) {
  console.log('用法: node statusline-switch.js [1|2|3|4|5]');
  console.log('  1 = PS1 原版（PowerShell）');
  console.log('  2 = 單行 JS');
  console.log('  3 = 緊湊 2 行 JS');
  console.log('  4 = 黑白亞古獸動畫（braille）');
  console.log('  5 = 彩色亞古獸動畫（ANSI truecolor）');
  process.exit(1);
}

const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
settings.statusLine = settings.statusLine || {};
settings.statusLine.type = 'command';
settings.statusLine.command = VERSIONS[ver].cmd;
settings.statusLine.refreshInterval = settings.statusLine.refreshInterval || 30;

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
console.log(`✓ 已切換到版本 ${ver}：${VERSIONS[ver].label}`);
