#!/usr/bin/env node
'use strict';
const fs   = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

function render(rows) {
  for (const row of rows) {
    let line = '';
    for (const c of row) {
      if (!c) { line += ' '; continue; }
      const [ur, ug, ub, lr, lg, lb] = c;
      const upOk = ur >= 0, loOk = lr >= 0;
      if (upOk && loOk) line += `\x1b[38;2;${ur};${ug};${ub}m\x1b[48;2;${lr};${lg};${lb}m▀\x1b[0m`;
      else if (upOk)    line += `\x1b[38;2;${ur};${ug};${ub}m▀\x1b[0m`;
      else if (loOk)    line += `\x1b[38;2;${lr};${lg};${lb}m▄\x1b[0m`;
      else              line += ' ';
    }
    console.log(line);
  }
}

const flipRows = rows => rows.map(r => [...r].reverse());

const names = process.argv.slice(2);
if (!names.length) { console.error('用法: node cutin-preview.js <Name> [Name2 ...]'); process.exit(1); }

for (const name of names) {
  const file = path.join(REPO, 'characters', name, 'cutin-art.json');
  if (!fs.existsSync(file)) { console.log(`[skip] ${name}: 找不到 cutin-art.json`); continue; }
  const art = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`── ${name} (${art.width}×${art.height} cells, ${art.frames.length} frame) ──`);
  console.log('[原圖 / 面左]');
  render(art.frames[0]);
  console.log('[翻轉 / 面右]');
  render(flipRows(art.frames[0]));
  console.log();
}
