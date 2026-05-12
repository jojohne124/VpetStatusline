'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const INSTALL_ROOT = __dirname;
const STATE_DIR    = path.join(INSTALL_ROOT, 'state');
const ASSETS_DIR   = path.join(INSTALL_ROOT, 'assets');

const HOOK_FILE   = path.join(STATE_DIR, 'hook.json');
const ANCHOR_GAP  = 4;
const STEP_MS     = 1000;
const IDLE_MS     = 600000;
const MAX_POS     = 20;
const EXPR_CHANCE = 0.10;
const EXPR_HOLD   = 3;

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
    try {
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(stateFile, JSON.stringify(s));
    } catch(e) {}
}

// ── 走路（三角波）────────────────────────────────────────────────
function computeWalk(step) {
    const period = MAX_POS * 2;
    const phase  = ((step % period) + period) % period;
    const pos    = phase <= MAX_POS ? phase : (period - phase);
    return { pos, facing: phase < MAX_POS ? 'right' : 'left' };
}

// ── 進化檢查 ─────────────────────────────────────────────────────
// Returns new characterId if evolution triggered, else null
// 單一條件評估，回傳 ready 狀態（true = 此條件已達成）
// ns: 命名空間前綴，用來隔離每個條件的 state
function evalCondition(cond, ns, st, input, nowSec) {
    if (cond.type === 'r5h_peak') {
        const rolled = rl => rl?.resets_at && rl.resets_at <= nowSec;
        const used   = rolled(input.rate_limits?.five_hour) ? 0
            : Math.round(input.rate_limits?.five_hour?.used_percentage ?? 0);
        const thr = cond.threshold ?? 95;
        if (used >= thr)          { st[ns + '_peaked'] = true; }
        else if (st[ns + '_peaked']) { st[ns + '_peaked'] = false; st[ns + '_ready'] = true; }
        return !!st[ns + '_ready'];
    }

    if (cond.type === 'cost_threshold') {
        const delta = (input.cost?.total_cost_usd ?? 0) - (st._evoCostBase ?? 0);
        if (delta >= (cond.usd ?? 10))
            st[ns + '_ready'] = true;
        return !!st[ns + '_ready'];
    }

    return false;
}

function checkEvolution(st, input, config) {
    if (!config.evolvesTo || config.evolvesTo.length === 0) return null;
    const nowSec = Math.floor(Date.now() / 1000);

    for (const evo of config.evolvesTo) {
        // 支援 conditions 陣列或舊格式的單一 condition
        const conditions = evo.conditions ?? (evo.condition ? [evo.condition] : []);
        if (!conditions.length) continue;
        const op = evo.operator ?? 'and';

        const ready = conditions.map((cond, idx) =>
            evalCondition(cond, `_evo_${evo.character}_c${idx}`, st, input, nowSec)
        );

        const triggered = op === 'or' ? ready.some(Boolean) : ready.every(Boolean);
        if (triggered) {
            conditions.forEach((_, idx) => { delete st[`_evo_${evo.character}_c${idx}_ready`]; });
            st._evoCostBase = input.cost?.total_cost_usd ?? 0; // 進化後重設差值基準
            return evo.character;
        }
    }
    return null;
}

// ── 核心狀態機 ───────────────────────────────────────────────────
// charDef: { F, EXPRS, ROAR_FRAMES, TOKEN_RESET_FRAMES, sleepFrames, SLEEP_PERIOD? }

// hold 必須是偶數，才能讓動畫結束後 step % 2 的奇偶回到正確位置
const evenHold = n => n % 2 === 0 ? n : n + 1;

function decideAgumon(i, st, now, charDef) {
    const { F, EXPRS, ROAR_FRAMES, TOKEN_RESET_FRAMES, sleepFrames, SLEEP_PERIOD } = charDef;
    const step = Math.floor(now / STEP_MS);

    try {
        const hook = JSON.parse(fs.readFileSync(HOOK_FILE, 'utf8'));
        if (hook.ts && hook.ts !== st.lastHookTs) {
            const isFirstLoad = st.lastHookTs === undefined;
            st.lastHookTs = hook.ts;
            if (!isFirstLoad) {
                st.roarStartStep  = step;
                st.lastActivityAt = now;
            }
        }
    } catch(e) {}
    if (!st.lastActivityAt) st.lastActivityAt = now;

    // Token 重置偵測：舊 resets_at 已過期 + 新值不同 → 窗口真的滾過了
    const r5hResetAt = i.rate_limits?.five_hour?.resets_at;
    const nowSec = Math.floor(now / 1000);
    if (r5hResetAt && st._r5hResetAt
        && r5hResetAt !== st._r5hResetAt
        && st._r5hResetAt <= nowSec                    // 舊值已是過去式
        && !(st.happyStartStep >= 0)) {                // 動畫未在播放中
        st.happyStartStep = step;
    }
    if (r5hResetAt) st._r5hResetAt = Math.max(r5hResetAt, st._r5hResetAt || 0);

    const walk = computeWalk(step);

    // 大吼最優先（hold 確保為偶數，維持 step 奇偶）
    // 動畫播放中繼續走路（不凍結位置），避免位置定格
    if (st.roarStartStep != null && st.roarStartStep >= 0) {
        const elapsed = step - st.roarStartStep;
        const roarHold = evenHold(ROAR_FRAMES.length + 1);
        if (elapsed < roarHold) {
            return { frameIdx: ROAR_FRAMES[Math.min(elapsed, ROAR_FRAMES.length - 1)], facing: walk.facing, pos: walk.pos };
        }
        st.roarStartStep = -1;
    }

    // Token 重置高興（hold 確保為偶數）
    if (st.happyStartStep != null && st.happyStartStep >= 0) {
        const elapsed = step - st.happyStartStep;
        const happyHold = evenHold(TOKEN_RESET_FRAMES.length);
        if (elapsed < happyHold) {
            return { frameIdx: TOKEN_RESET_FRAMES[Math.min(elapsed, TOKEN_RESET_FRAMES.length - 1)], facing: walk.facing, pos: walk.pos };
        }
        st.happyStartStep = -1;
    }

    // 睡覺（靜止不動，保留最後位置）
    if ((now - st.lastActivityAt) > IDLE_MS) {
        const idx = SLEEP_PERIOD ? Math.floor(step / SLEEP_PERIOD) % sleepFrames.length : 0;
        return { frameIdx: sleepFrames[idx], facing: 'left', pos: st.lastPos ?? 0 };
    }

    // 表演中（hold 確保為偶數）；位置凍結在觸發當秒，避免表演期間滑動
    if (st.exprStartStep != null && st.exprStartStep >= 0) {
        const expr = EXPRS[st.exprIdx ?? 0];
        const hold = evenHold(expr.hold ?? expr.frames.length);
        const elapsed = step - st.exprStartStep;
        if (elapsed < hold) {
            const frozenWalk = computeWalk(st.exprStartStep);
            return { frameIdx: expr.frames[Math.min(elapsed, expr.frames.length - 1)], facing: frozenWalk.facing, pos: frozenWalk.pos };
        }
        st.exprStartStep = -1;
        st.lastStepSeen  = step; // 確保本 step 不再觸發 expr，至少接一幀走路
    }

    // 新的一步隨機觸發表情
    if (st.lastStepSeen !== step) {
        st.lastStepSeen = step;
        if (Math.random() < EXPR_CHANCE) {
            st.exprStartStep = step;
            st.exprIdx       = Math.floor(Math.random() * EXPRS.length);
            return { frameIdx: EXPRS[st.exprIdx].frames[0], facing: walk.facing, pos: walk.pos };
        }
        // 走路幀依上一幀交替，不依賴 step % 2，避免 timing jitter 造成同幀重複
        st.lastWalkFrame = (st.lastWalkFrame === F.IDLE_1) ? F.IDLE_2 : F.IDLE_1;
    }

    // 正常走路
    st.lastPos    = walk.pos;
    st.lastFacing = walk.facing;
    return { frameIdx: st.lastWalkFrame ?? F.IDLE_1, facing: walk.facing, pos: walk.pos };
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
            gitStr = ` ${GREEN}(${branch})${R}`;
        }
    } catch(e) {}

    const allCost = i.cost?.total_cost_usd ?? 0;

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
    const dir    = path.join(ASSETS_DIR, name);
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    return {
        charDef: {
            F:                  config.frames,
            sleepFrames:        config.sleepFrames,
            SLEEP_PERIOD:       config.sleepPeriod || null,
            ROAR_FRAMES:        config.roarFrames,
            TOKEN_RESET_FRAMES: config.tokenResetFrames || [7, 0, 7],
            EXPRS:              config.exprs,
            RIGHT_OFFSET:       config.rightOffset ?? null,
        },
        artFile: path.join(dir, 'art.json'),
        config,
    };
}

module.exports = {
    INSTALL_ROOT, STATE_DIR, ASSETS_DIR,
    ANCHOR_GAP,
    loadState, saveState,
    decideAgumon,
    checkEvolution,
    buildStatusLines,
    composeOutput,
    visLen,
    loadCharacter,
};
