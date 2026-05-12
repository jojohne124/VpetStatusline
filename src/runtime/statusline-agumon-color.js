#!/usr/bin/env node
// v7: 共用單一 state（移除失效的 ppid namespace 方案）
const fs     = require('fs');
const path   = require('path');
const { STATE_DIR, ANCHOR_GAP, loadState, saveState, decideAgumon, checkEvolution, buildStatusLines, composeOutput, visLen, loadCharacter } = require('./agumon-core');

const STATE_FILE = path.join(STATE_DIR, 'color-state.json');
const FORCE_FILE = path.join(STATE_DIR, 'force-char.json');

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
        const now = Date.now();

        const st = loadState(STATE_FILE);

        // 作弊碼強制切換
        try {
            const force = JSON.parse(fs.readFileSync(FORCE_FILE, 'utf8'));
            if (force.character) {
                const changed = st.characterId !== force.character;
                st.characterId = force.character;
                if (changed) {
                    Object.keys(st).forEach(k => { if (k.startsWith('_evo_') || k === '_r5hPeaked' || k === '_costEvolved') delete st[k]; });
                    delete st.exprStartStep; delete st.roarStartStep; delete st.lastStepSeen; delete st.happyStartStep;
                    delete st._r5hResetAt;
                    if (force.resetCostBase) st._evoCostBase = i.cost?.total_cost_usd ?? 0;
                }
            }
        } catch(e) {}

        if (!st.characterId) st.characterId = 'agumon';

        const { charDef, artFile, config } = loadCharacter(st.characterId);
        const { frameIdx, facing, pos } = decideAgumon(i, st, now, charDef);

        const nextChar = checkEvolution(st, i, config);
        if (nextChar) {
            st.characterId = nextChar;
            try { fs.unlinkSync(FORCE_FILE); } catch(e) {}
            delete st.exprStartStep;
            delete st.roarStartStep;
            delete st.lastStepSeen;
        }

        saveState(STATE_FILE, st);

        const statusLines = buildStatusLines(i);

        let agumonLines = null;
        try {
            const art = JSON.parse(fs.readFileSync(artFile, 'utf8'));
            const rightOffset = charDef.RIGHT_OFFSET;
            let rows;
            if (facing === 'right' && rightOffset != null) {
                rows = art.frames[frameIdx + rightOffset] || art.frames[frameIdx + rightOffset - 1] || art.frames[0];
            } else {
                rows = art.frames[frameIdx] || art.frames[0];
                if (facing === 'right') rows = flipRows(rows);
            }
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
