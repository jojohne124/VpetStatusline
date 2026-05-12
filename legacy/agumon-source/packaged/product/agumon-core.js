'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const HOOK_FILE   = path.join(os.homedir(), '.claude', 'agumon-hook.json');
const ANCHOR_GAP  = 4;
const STEP_MS     = 1000;
const IDLE_MS     = 600000;
const MAX_POS     = 20;
const EXPR_CHANCE = 0.15;
const EXPR_HOLD   = 3;
const ROAR_HOLD   = 3;

// ── ANSI ─────────────────────────────────────────────────────────
const R       = '\x1b[0m';
const DIM     = '\x1b[2m';
const BLUE    = '\x1b[38;2;0;153;255m';
const ORANGE  = '\x1b[38;2;255;176;85m';
const GREEN   = '\x1b[38;2;0;175;80m';
const CYAN    = '\x1b[38;2;86;182;194m';
const RED     = '\x1b[38;2;255;85;85m';
const YELLOW  = '\x1b[38;2;230;200;0m';
const WHITE   = '\x1b[38;2;220;220;220m';
const MAGENTA = '\x1b[38;2;180;140;255m';
const SEP     = ` ${DIM}│${R} `;

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
const visLen    = s => [...stripAnsi(s)].length;

// ── 狀態 ─────────────────────────────────────────────────────────
function loadState(stateFile) {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch(e) {}
    return {};
}
function saveState(stateFile, s) {
    try { fs.writeFileSync(stateFile, JSON.stringify(s)); } catch(e) {}
}

// ── 走路（三角波）────────────────────────────────────────────────
function computeWalk(step) {
    const period = MAX_POS * 2;
    const phase  = ((step % period) + period) % period;
    const pos    = phase <= MAX_POS ? phase : (period - phase);
    return { pos, facing: phase < MAX_POS ? 'right' : 'left' };
}

// ── 核心狀態機 ───────────────────────────────────────────────────
// charDef: { F, EXPRS, ROAR_FRAMES, sleepFrames, SLEEP_PERIOD? }
function decideAgumon(i, st, now, charDef) {
    const { F, EXPRS, ROAR_FRAMES, sleepFrames, SLEEP_PERIOD } = charDef;
    const step = Math.floor(now / STEP_MS);

    try {
        const hook = JSON.parse(fs.readFileSync(HOOK_FILE, 'utf8'));
        if (hook.ts && hook.ts !== st.lastHookTs) {
            st.lastHookTs     = hook.ts;
            st.roarStartStep  = step;
            st.lastActivityAt = now;
        }
    } catch(e) {}
    if (!st.lastActivityAt) st.lastActivityAt = now;

    const walk      = computeWalk(step);
    const walkFrame = (step % 2 === 0) ? F.NORMAL : F.STEP;

    // 大吼最優先
    if (st.roarStartStep != null && st.roarStartStep >= 0) {
        const elapsed = step - st.roarStartStep;
        if (elapsed < ROAR_HOLD) {
            return { frameIdx: ROAR_FRAMES[Math.min(elapsed, ROAR_FRAMES.length - 1)], facing: st.lastFacing ?? walk.facing, pos: st.lastPos ?? walk.pos };
        }
        st.roarStartStep = -1;
    }

    // 睡覺
    if ((now - st.lastActivityAt) > IDLE_MS) {
        const idx = SLEEP_PERIOD ? Math.floor(step / SLEEP_PERIOD) % sleepFrames.length : 0;
        return { frameIdx: sleepFrames[idx], facing: 'left', pos: st.lastPos ?? 0 };
    }

    // 表演中
    if (st.exprStartStep != null && st.exprStartStep >= 0) {
        const elapsed = step - st.exprStartStep;
        if (elapsed < EXPR_HOLD) {
            const expr = EXPRS[st.exprIdx ?? 0];
            return { frameIdx: expr.frames[Math.min(elapsed, expr.frames.length - 1)], facing: st.lastFacing ?? walk.facing, pos: st.lastPos ?? walk.pos };
        }
        st.exprStartStep = -1;
    }

    // 新的一步隨機觸發表情
    if (st.lastStepSeen !== step) {
        st.lastStepSeen = step;
        if (Math.random() < EXPR_CHANCE) {
            st.exprStartStep = step;
            st.exprIdx       = Math.floor(Math.random() * EXPRS.length);
            st.lastPos       = walk.pos;
            st.lastFacing    = walk.facing;
            return { frameIdx: EXPRS[st.exprIdx].frames[0], facing: walk.facing, pos: walk.pos };
        }
    }

    // 正常走路
    st.lastPos    = walk.pos;
    st.lastFacing = walk.facing;
    return { frameIdx: walkFrame, facing: walk.facing, pos: walk.pos };
}

// ── 狀態列 ───────────────────────────────────────────────────────
const circleBar = (pct, len = 10) => {
    const n = Math.max(0, Math.min(len, Math.round(pct / 100 * len)));
    const color = pct >= 90 ? RED : pct >= 70 ? YELLOW : pct >= 50 ? ORANGE : GREEN;
    return `${color}${'●'.repeat(n)}${DIM}${'○'.repeat(len - n)}${R}`;
};
const pctColor = p => p >= 90 ? RED : p >= 70 ? YELLOW : p >= 50 ? ORANGE : GREEN;

const fmtReset = ts => {
    if (!ts) return '';
    try {
        const d = new Date(ts * 1000), now = new Date();
        const diffH = (d - now) / 3600000;
        if (diffH <= 0) return '';
        if (diffH < 24) {
            const h = Math.floor(diffH), m = Math.floor((diffH - h) * 60);
            return h > 0 ? `${h}h${m}m` : `${m}m`;
        }
        return `${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
    } catch(e) { return ''; }
};

function buildStatusLines(i) {
    const modelName = (i.model?.display_name || i.model || 'Claude');

    let effort = 'default', effortIcon = `${DIM}◑${R}`;
    try {
        const lvl = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).effortLevel;
        if (lvl) {
            effort = lvl;
            effortIcon = lvl === 'high' ? `${MAGENTA}●${R}` : lvl === 'low' ? `${DIM}◔${R}` : `${DIM}◑${R}`;
        }
    } catch(e) {}

    const ctx     = Math.round(i.context_window?.used_percentage ?? 0);
    const cwd     = i.cwd || process.cwd();
    const dirname = path.basename(cwd);
    let gitStr = '';
    try {
        const { spawnSync } = require('child_process');
        const branch = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 1000 }).stdout.trim();
        if (branch && branch !== 'HEAD') {
            const dirty = spawnSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8', timeout: 1000 }).stdout.trim();
            gitStr = ` ${GREEN}(${branch}${dirty ? RED + '*' : ''}${GREEN})${R}`;
        }
    } catch(e) {}

    let allCost = 0;
    try {
        for (const f of fs.readdirSync(os.tmpdir())) {
            if (!f.startsWith('claude-cum-')) continue;
            try { allCost += JSON.parse(fs.readFileSync(path.join(os.tmpdir(), f), 'utf8')).cost?.total ?? 0; } catch(e) {}
        }
    } catch(e) {}

    const nowSec = Math.floor(Date.now() / 1000);
    const rolled = rl => rl?.resets_at && rl.resets_at <= nowSec;
    const r5h    = rolled(i.rate_limits?.five_hour) ? 0 : Math.round(i.rate_limits?.five_hour?.used_percentage ?? 0);
    const r7d    = rolled(i.rate_limits?.seven_day) ? 0 : Math.round(i.rate_limits?.seven_day?.used_percentage ?? 0);
    const rst5   = fmtReset(i.rate_limits?.five_hour?.resets_at);
    const rst7   = fmtReset(i.rate_limits?.seven_day?.resets_at);

    const line1 = [
        `${BLUE}${modelName}${R}`,
        `ctx ${pctColor(ctx)}${ctx}%${R}`,
        `${CYAN}${dirname}${R}${gitStr}`,
        `${effortIcon} ${DIM}${effort}${R}  ${DIM}$${R}${allCost.toFixed(2)}`,
    ].join(SEP);
    const line2 = `${WHITE}current${R} ${circleBar(r5h)} ${pctColor(r5h)}${r5h.toString().padStart(3)}%${R}${rst5 ? `  ${DIM}⟳ ${rst5}${R}` : ''}`;
    const line3 = `${WHITE}weekly ${R} ${circleBar(r7d)} ${pctColor(r7d)}${r7d.toString().padStart(3)}%${R}${rst7 ? `  ${DIM}⟳ ${rst7}${R}` : ''}`;

    return [line1, line2, line3];
}

// ── 排版：左側狀態 + 右側角色 ────────────────────────────────────
const BLANK = '⠀';

function composeOutput(statusLines, agumonLines, aguCol) {
    const TOTAL   = agumonLines.length;
    const startAt = Math.floor((TOTAL - statusLines.length) / 2);
    const output  = [];
    for (let row = 0; row < TOTAL; row++) {
        const si   = row - startAt;
        const left = (si >= 0 && si < statusLines.length) ? statusLines[si] : '';
        const fill = Math.max(1, aguCol - visLen(left));
        output.push(left + BLANK.repeat(fill) + agumonLines[row]);
    }
    return output.join('\n');
}

// ── 從 agumon-assets/<name>/ 載入角色定義 ────────────────────────
function loadCharacter(name) {
    const dir    = path.join(os.homedir(), '.claude', 'agumon-assets', name);
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    return {
        charDef: {
            F:            config.frames,
            sleepFrames:  config.sleepFrames,
            SLEEP_PERIOD: config.sleepPeriod || null,
            ROAR_FRAMES:  config.roarFrames,
            EXPRS:        config.exprs,
        },
        artFile: path.join(dir, 'art.json'),
    };
}

module.exports = {
    ANCHOR_GAP,
    loadState, saveState,
    decideAgumon,
    buildStatusLines,
    composeOutput,
    visLen,
    loadCharacter,
};
