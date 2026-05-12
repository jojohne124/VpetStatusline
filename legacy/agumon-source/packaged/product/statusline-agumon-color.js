#!/usr/bin/env node
// v5: 彩色亞古獸動畫（ANSI truecolor cell）
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { ANCHOR_GAP, loadState, saveState, decideAgumon, buildStatusLines, composeOutput, visLen, loadCharacter } = require('./agumon-core');

const STATE_FILE = path.join(os.homedir(), '.claude', 'agumon-color-state.json');
const { charDef: CHAR_DEF, artFile: ART_FILE } = loadCharacter('agumon');

// ── 彩色 cell 渲染 ────────────────────────────────────────────────
function renderCells(rows) {
    const lines = [];
    for (const row of rows) {
        let line = '';
        for (const c of row) {
            if (!c) { line += '⠀'; continue; }
            const [ur, ug, ub, lr, lg, lb] = c;
            const upOk = ur >= 0, loOk = lr >= 0;
            if (upOk && loOk) line += `\x1b[38;2;${ur};${ug};${ub}m\x1b[48;2;${lr};${lg};${lb}m▀\x1b[0m`;
            else if (upOk)    line += `\x1b[38;2;${ur};${ug};${ub}m▀\x1b[0m`;
            else if (loOk)    line += `\x1b[38;2;${lr};${lg};${lb}m▄\x1b[0m`;
            else              line += '⠀';
        }
        lines.push(line);
    }
    return lines;
}

const flipRows = rows => rows.map(r => [...r].reverse());

// ── 主程式 ───────────────────────────────────────────────────────
let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
    try {
        const i   = JSON.parse(d);
        const st  = loadState(STATE_FILE);
        const now = Date.now();

        const { frameIdx, facing, pos } = decideAgumon(i, st, now, CHAR_DEF);
        saveState(STATE_FILE, st);

        const statusLines = buildStatusLines(i);

        let agumonLines = null;
        try {
            const art = JSON.parse(fs.readFileSync(ART_FILE, 'utf8'));
            let rows = art.frames[frameIdx] || art.frames[0];
            if (facing === 'right') rows = flipRows(rows);
            agumonLines = renderCells(rows);
        } catch(e) {}

        if (!agumonLines) {
            process.stdout.write(statusLines.join('\n'));
            return;
        }

        const aguCol = Math.max(...statusLines.map(visLen)) + ANCHOR_GAP + pos;
        process.stdout.write(composeOutput(statusLines, agumonLines, aguCol));
    } catch(e) {
        process.stdout.write('statusline-agumon-color: ' + e.message);
    }
});
