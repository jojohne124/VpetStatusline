#!/usr/bin/env node
const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  const result = spawnSync('node', [
    path.join(os.homedir(), '.claude', 'statusline.js')
  ], { input, encoding: 'utf8', timeout: 10000 });

  const raw = result.stdout || '';
  const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const clean = stripAnsi(line);
    // Skip border and divider lines (┌ └ ├)
    if (/^[┌└├]/.test(clean)) continue;
    // Strip leading DIM│RESET + optional space
    let p = line.replace(/^\x1b\[2m[│]\x1b\[0m ?/, '');
    // Strip trailing DIM│RESET (one or more), including any that follow only spaces
    p = p.replace(/\s*(\x1b\[2m[│]\x1b\[0m\s*)+$/, '');
    if (p.trimEnd()) out.push(p.trimEnd());
  }

  process.stdout.write(out.join('\n'));
});
