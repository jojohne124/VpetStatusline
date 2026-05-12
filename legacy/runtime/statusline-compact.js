#!/usr/bin/env node
// v3: compact multi-line, fixed 2 rows, fits any window height
const fs = require('fs');
const os = require('os');
const path = require('path');

const R = '\x1b[0m', DIM = '\x1b[2m';
const CYAN = '\x1b[36m', GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', BLUE = '\x1b[34m';

const bar = (pct, len = 8) => '█'.repeat(Math.round(pct / 100 * len)) + '░'.repeat(len - Math.round(pct / 100 * len));
const cc  = pct => pct >= 80 ? RED : pct >= 50 ? YELLOW : GREEN;
const fmtTok = n => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n);
const fmtDur = ms => {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  return rm ? `${h}h${rm}m` : `${h}h`;
};
const countdown = (resetsAt, windowSec) => {
  if (!resetsAt) return '';
  const now = Math.floor(Date.now() / 1000);
  let s = resetsAt - now;
  if (s <= 0) s = windowSec - (now % windowSec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
};

let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const i = JSON.parse(d);

    // ── Model + effort ──
    const modelName = (i.model?.display_name || '?').replace('Claude ', '');
    let effort = '';
    try {
      const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
      const lvl = s.effortLevel;
      if (lvl && lvl !== 'default') effort = ` ${DIM}${lvl}${R}`;
    } catch(e) {}

    // ── Auth (cached 10min) ──
    let userEmail = '';
    try {
      const authCache = path.join(os.homedir(), '.claude', 'auth-cache.json');
      let cache = {};
      try { cache = JSON.parse(fs.readFileSync(authCache, 'utf8')); } catch(e) {}
      if (!cache.email || !cache.ts || Date.now() - cache.ts > 600000) {
        const out = require('child_process').execSync(
          'C:/Users/kaihsiangchang/AppData/Roaming/npm/claude.cmd auth status',
          { encoding: 'utf8', timeout: 5000 }
        );
        const data = JSON.parse(out);
        cache = { email: data.email || '', ts: Date.now() };
        fs.writeFileSync(authCache, JSON.stringify(cache));
      }
      userEmail = cache.email ? `${DIM}${cache.email}${R}` : '';
    } catch(e) {}

    // ── Cost cumulative ──
    const sid = (i.session_id || 'x').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
    const cumPath = path.join(os.tmpdir(), `claude-cum-${sid}.json`);
    const curCost = i.cost?.total_cost_usd ?? 0;
    const curDur  = i.cost?.total_duration_ms ?? 0;
    let sessCost = curCost, sessDur = curDur;
    try {
      const cum = JSON.parse(fs.readFileSync(cumPath, 'utf8'));
      sessCost = cum.cost?.total ?? curCost;
      sessDur  = cum.dur?.total  ?? curDur;
    } catch(e) {}
    let allCost = 0;
    try {
      for (const f of fs.readdirSync(os.tmpdir())) {
        if (!f.startsWith('claude-cum-')) continue;
        try { allCost += JSON.parse(fs.readFileSync(path.join(os.tmpdir(), f), 'utf8')).cost?.total ?? 0; } catch(e) {}
      }
    } catch(e) { allCost = sessCost; }

    // ── Context ──
    const ctx  = Math.round(i.context_window?.used_percentage ?? 0);
    const toks = (i.context_window?.total_input_tokens ?? 0) + (i.context_window?.total_output_tokens ?? 0);

    // ── Quota ──
    const now = Math.floor(Date.now() / 1000);
    const rolled = rl => rl?.resets_at && rl.resets_at <= now;
    const r5h = rolled(i.rate_limits?.five_hour) ? 0 : Math.round(i.rate_limits?.five_hour?.used_percentage ?? 0);
    const r7d = rolled(i.rate_limits?.seven_day) ? 0 : Math.round(i.rate_limits?.seven_day?.used_percentage ?? 0);
    const cd5 = countdown(i.rate_limits?.five_hour?.resets_at, 5 * 3600);
    const cd7 = countdown(i.rate_limits?.seven_day?.resets_at, 7 * 86400);

    // ── Git ──
    let gitStr = '';
    try {
      const { spawnSync } = require('child_process');
      const cwd = i.cwd || process.cwd();
      const branch = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 1000 }).stdout.trim();
      if (branch && branch !== 'HEAD') {
        const dirty = spawnSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8', timeout: 1000 }).stdout.trim();
        gitStr = ` ${DIM}(${GREEN}${branch}${dirty ? RED+'*' : ''}${DIM})${R}`;
      }
    } catch(e) {}

    // ── Summary ──
    let summary = '';
    try {
      const summaryFile = path.join(os.tmpdir(), `claude-summary-${sid}.txt`);
      if (fs.existsSync(summaryFile))
        summary = fs.readFileSync(summaryFile, 'utf8').trim().split('\n')[0];
    } catch(e) {}

    const S = `  ${DIM}·${R}  `;

    // Line 1: model · effort · git · $cost ($total) · duration · ctx% · tokens
    const line1 = [
      `${CYAN}${modelName}${R}${effort}${gitStr}`,
      `${DIM}$${R}${sessCost.toFixed(2)} ${DIM}($${allCost.toFixed(0)}) ${fmtDur(sessDur)}${R}`,
      `${DIM}ctx${R}${cc(ctx)}${ctx}%${R} ${DIM}${fmtTok(toks)}${R}`,
    ].join(S);

    // Line 2: quota bars
    const line2 = [
      `${DIM}5h${R} ${cc(r5h)}${bar(r5h)}${R} ${cc(r5h)}${r5h}%${R}${cd5 ? ` ${DIM}⟳ ${cd5}${R}` : ''}`,
      `${DIM}7d${R} ${cc(r7d)}${bar(r7d)}${R} ${cc(r7d)}${r7d}%${R}${cd7 ? ` ${DIM}⟳ ${cd7}${R}` : ''}`,
    ].join(S);

    // Line 3: summary (only if available)
    const line3 = summary ? `${DIM}summary${R} ${summary}` : '';

    const lines = [line1, line2];
    if (line3) lines.push(line3);
    if (userEmail) lines.push(userEmail);
    process.stdout.write(lines.join('\n'));
  } catch(e) {
    process.stdout.write('statusline: ' + e.message);
  }
});
