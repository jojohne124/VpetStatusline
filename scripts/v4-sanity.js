#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const os   = require('os');

const STATUSLINE = path.join(os.homedir(), '.claude', 'agumon-statusline', 'statusline-agumon.js');
const payload = {
    model: { display_name: 'Claude' },
    context_window: { used_percentage: 10 },
    cost: { total_cost_usd: 0.5 },
    rate_limits: { five_hour: { used_percentage: 5 }, seven_day: { used_percentage: 1 } },
    cwd: process.cwd(),
};
const r = spawnSync('node', [STATUSLINE], { input: JSON.stringify(payload), encoding: 'utf8' });
console.log(r.stdout);
if (r.stderr) console.error('stderr:', r.stderr);
console.log(`\n[v4 sanity] exit=${r.status}  lines=${(r.stdout||'').split('\n').length}`);
