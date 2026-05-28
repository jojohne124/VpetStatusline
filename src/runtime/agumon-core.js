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
const MAX_POS     = 36;                                                 // 走路範圍：對齊 BATTLE_SCENE_WIDTH(52) - 角色寬(16)
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
// atomic write：tmp 寫入後 rename（rename 在同 fs 上是 atomic），避免並行讀到 partial write
function atomicWrite(file, data) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, file);
    } catch(e) {
        try { fs.unlinkSync(tmp); } catch(_) {}
    }
}
function loadState(stateFile) {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch(e) {}
    return {};
}
function saveState(stateFile, s) {
    if (!s || !s.characterId) return;   // 防護：state 被弄空時不覆蓋 disk，避免角色倒退
    atomicWrite(stateFile, JSON.stringify(s));
}

// ── 走路（三角波）────────────────────────────────────────────────
function computeWalk(step, offset = 0) {
    const period = MAX_POS * 2;
    const phase  = (((step + offset) % period) + period) % period;
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

// ── 進化（Evolution）─────────────────────────────────────────────
const EVO_LENGTH = 12;                                                 // 0-5 dna1/2/3 ×2 / 6-7 dna_end1 隱形 / 8 dna_end2 光繭破裂 / 9-11 新角色 IDLE-HAPPY 交替

function decideEvoFrame(elapsed, oldF, newF, pos) {
    const base = {
        kind: 'evo',
        elapsed,
        useNewChar: false,
        frameIdx: oldF.IDLE_1 ?? 0,
        facing: 'left',
        pos,
        overlaySpriteName: null,
        overlayFrameIdx: 0,
        hideChar: false,
    };
    // 0-5: 舊角色 + DNA 在 dna1 → dna2 → dna3 循環（2 圈）
    //   step 0: IDLE_1（靜止觸發）
    //   step 1-5: HAPPY（被進化能量包覆的興奮表情）
    if (elapsed <= 5) {
        const charIdx = (elapsed === 0)
            ? (oldF.IDLE_1 ?? 0)
            : (oldF.HAPPY  ?? oldF.IDLE_1 ?? 0);
        return { ...base, frameIdx: charIdx, overlaySpriteName: 'dna', overlayFrameIdx: elapsed % 3 };
    }
    // 6-7: dna_end1 光繭包覆（角色隱形）
    if (elapsed <= 7) return { ...base, useNewChar: true, hideChar: true,
                                  overlaySpriteName: 'dna_end1', overlayFrameIdx: 0 };
    // 8: 新角色 HAPPY + dna_end2 光繭破裂（角色可見、特效疊在上方）
    if (elapsed === 8) return { ...base, useNewChar: true,
                                  frameIdx: newF.HAPPY ?? newF.IDLE_1 ?? 0,
                                  overlaySpriteName: 'dna_end2', overlayFrameIdx: 0 };
    // 9-11: 新角色 HAPPY ↔ IDLE_1 交替（無特效）
    const newIdx = (elapsed % 2 === 0)
        ? (newF.IDLE_1 ?? 0)
        : (newF.HAPPY  ?? newF.IDLE_1 ?? 0);
    return { ...base, useNewChar: true, frameIdx: newIdx };
}

// ── 戰鬥（Battle）─────────────────────────────────────────────────
const BATTLE_LENGTH    = 19;                                           // v1：共 19 step（Encounter 3 拍 + Boom 3 拍）
const BATTLE_LENGTH_V2 = 21;                                           // v2：encounter 多 2 拍（cut-in 滑入 + 對峙）→ 共 21 step
const BATTLE_SAFETY    = 30;                                           // 殘留清理門檻

const safeF = (F, name, fallback = 0) => F[name] ?? fallback;

function getCharacterRank(name) {
    try {
        const config = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, name, 'config.json'), 'utf8'));
        return config.rank || 'UnRank';
    } catch(e) { return 'UnRank'; }
}

// 各階級戰力上限（UnRank 無上限）
const TIER_CAP = { Child: 50, Adult: 100, Perfect: 150, Ultimate: 200, UnRank: Infinity };
function getTierCap(rank) { return TIER_CAP[rank] ?? Infinity; }

// 角色基礎 power（config.power）；未填預設 10，使用者填好實際值
function getCharacterPower(name) {
    try {
        const config = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, name, 'config.json'), 'utf8'));
        return typeof config.power === 'number' ? config.power : 10;
    } catch(e) { return 10; }
}

// seed → 決定性 [0, 1) 隨機數（給多視窗用同一個 seed 算出同一機率擲骰）
function seedRand01(seed) {
    let h = (Math.floor(seed) ^ 0xb5297a4d) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 0x100000000;
}

// 戰力與勝率計算
// 我戰力 = min(我power + trainingBonus, 我階段 cap)
// 敵戰力 = 敵power
// winProb = 我/(我+敵) + expBonus + otherBonus，clamp [0,1]
function computeWinProb(myId, st, enemyId) {
    const myPower = getCharacterPower(myId);
    const myCap   = getTierCap(getCharacterRank(myId));
    const train   = st.trainingBonus ?? 0;
    const myStr   = Math.min(myPower + train, myCap);
    const eStr    = getCharacterPower(enemyId);
    const expBonus   = 0.10;
    const otherBonus = 0;
    const denom = myStr + eStr;
    if (denom <= 0) return 0.5 + expBonus + otherBonus;  // 兩邊都 0 → 給體驗補正後預設
    const raw = myStr / denom + expBonus + otherBonus;
    return Math.max(0, Math.min(1, raw));
}

function chooseBattleEnemy(myId, seed) {
    // 同階隨機（排除自己）；若同階只有自己 → 退回預設。
    // 給 seed 時改用「確定性挑選」：同一個 trigger 在所有視窗算出同一敵人，
    // 避免多視窗各自 random 抽到不同敵人 → 後寫蓋前寫 → 第一幀閃出別的敵人。
    try {
        const rosterData = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, 'roster.json'), 'utf8'));
        const roster = Array.isArray(rosterData) ? rosterData : rosterData.roster;
        const myRank = getCharacterRank(myId);
        const candidates = roster.filter(n => n !== myId && getCharacterRank(n) === myRank);
        if (candidates.length === 0) return 'godzilla_1999';
        let idx;
        if (seed != null) {
            // 32-bit 整數雜湊，把 timestamp seed 打散後取模
            let h = (Math.floor(seed) ^ 0x9e3779b9) >>> 0;
            h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
            h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
            h = (h ^ (h >>> 16)) >>> 0;
            idx = h % candidates.length;
        } else {
            idx = Math.floor(Math.random() * candidates.length);
        }
        return candidates[idx];
    } catch(e) {
        return 'godzilla_1999';
    }
}

// 角色是否有 cut-in art（檔案存在即視為有）
function hasCutIn(charId) {
    if (!charId) return false;
    try { return fs.existsSync(path.join(ASSETS_DIR, charId, 'cutin-art.json')); }
    catch(e) { return false; }
}

// v2 vs v1 分鏡選擇：只在「我方與敵方都有 cut-in art」時啟用 v2
function pickBattleVersion(myId, enemyId) {
    return (hasCutIn(myId) && hasCutIn(enemyId)) ? 2 : 1;
}

function battleLength(version) { return version === 2 ? BATTLE_LENGTH_V2 : BATTLE_LENGTH; }

function decideBattleFrame(elapsed, win, enemyId, F, useCutIn = false) {
    const base = {
        kind: 'battle',
        elapsed,
        enemyId,
        win,
        phase: 'encounter',
        meFrameIdx: null,
        meFacing: 'right',
        enemyFrameIdx: null,
        enemyFacing: 'left',
        bullet: null,
        sharedSpriteName: null,
        weather: null,
        position: 'sides',
        meCutIn: false,
        enemyCutIn: false,
        meCutInCol: null,      // null = 用預設 BATTLE_CUTIN_ME_COL；其他值覆寫（用於滑入動畫）
        enemyCutInCol: null,   // 同上
    };
    const IDLE_1 = safeF(F, 'IDLE_1', 0);
    const ANGRY  = safeF(F, 'ANGRY',  IDLE_1);
    const ATTACK = safeF(F, 'ATTACK', ANGRY);
    const HAPPY  = safeF(F, 'HAPPY',  IDLE_1);
    const SAD    = safeF(F, 'SAD',    IDLE_1);

    // ── v2：encounter 多 2 拍（滑入 + 對峙）。
    // step 0：cut-in 滑入半進場（me col -16、enemy col 36，各露出 16 col 的前緣）；無驚嘆號
    // step 1-3：cut-in 全進場 + encounter[0/1/2] 驚嘆號
    // step 4：cut-in 保留、驚嘆號離場（對峙一拍）
    // step 5+：同 v1，把 elapsed 平移 2 重用 v1 邏輯
    if (useCutIn) {
        if (elapsed === 0) return { ...base, meCutIn: true, enemyCutIn: true, meCutInCol: -16, enemyCutInCol: 36 };
        if (elapsed === 1) return { ...base, sharedSpriteName: 'encounter', sharedFrameIdx: 0, meCutIn: true, enemyCutIn: true };
        if (elapsed === 2) return { ...base, sharedSpriteName: 'encounter', sharedFrameIdx: 1, meCutIn: true, enemyCutIn: true };
        if (elapsed === 3) return { ...base, sharedSpriteName: 'encounter', sharedFrameIdx: 2, meCutIn: true, enemyCutIn: true };
        if (elapsed === 4) return { ...base, meCutIn: true, enemyCutIn: true };
        elapsed = elapsed - 2;
    }

    if (elapsed <= 2) {
        // Encounter1 → Encounter2 → Encounter1（manifest.json 中 encounter.indices = [0, X, 0]）
        return { ...base, phase: 'encounter', sharedSpriteName: 'encounter', sharedFrameIdx: elapsed };
    }
    if (elapsed === 3 || elapsed === 5 || elapsed === 6) {
        return { ...base, phase: 'approach', meFrameIdx: ANGRY,  enemyFrameIdx: ANGRY };
    }
    if (elapsed === 4 || elapsed === 7) {
        return { ...base, phase: 'approach', meFrameIdx: IDLE_1, enemyFrameIdx: IDLE_1 };
    }
    if (elapsed >= 8 && elapsed <= 11) {
        const progress = (elapsed - 8) / 3;
        return { ...base, phase: 'attack', meFrameIdx: ATTACK, enemyFrameIdx: ATTACK,
                 bullet: { progress } };
    }
    if (elapsed >= 12 && elapsed <= 14) {
        // Boom1 → Boom2 → Boom1（manifest.json 中 boom.indices = [1, 2, 1]）
        return { ...base, phase: 'boom', sharedSpriteName: 'boom', sharedFrameIdx: elapsed - 12 };
    }
    // result 階段：右上角天氣特效（勝=小太陽 / 敗=小烏雲），整段 result 都掛著
    const weather = win ? 'sun' : 'cloud';
    if (elapsed === 15 || elapsed === 17) {
        return { ...base, phase: 'result', position: 'center',
                 meFrameIdx: IDLE_1, meFacing: 'left', weather };
    }
    if (elapsed === 16 || elapsed === 18) {
        return { ...base, phase: 'result', position: 'center',
                 meFrameIdx: win ? HAPPY : SAD, meFacing: 'left', weather };
    }
    return { ...base, phase: 'result', position: 'center', meFrameIdx: IDLE_1, meFacing: 'left', weather };
}

// seed：跨視窗共享的 trigger 值（cheat 用 lastBattleTriggerTs、自然戰鬥用 lastHookTs）。
// 給 seed → 敵人 + 勝負皆確定性（多視窗算出同一場戰鬥）。勝負改機率制：
//   winProb = computeWinProb(我, 敵)；用 seedRand01(seed) 擲骰決定。
function startBattle(st, step, myId, seed) {
    st.battleStartStep    = step;
    st.battleEnemy        = chooseBattleEnemy(myId, seed);
    if (seed != null) {
        const winProb = computeWinProb(myId, st, st.battleEnemy);
        st.battleWin  = seedRand01(seed) < winProb;
    } else {
        // 無 seed → fallback：50/50 random（極少數沒 seed 來源的路徑）
        st.battleWin = Math.random() < 0.5;
    }
    st.battlePending      = false;
    st.battleVersion      = pickBattleVersion(myId, st.battleEnemy);
    st.battleShownElapsed = -1;
}

// opts.allowBattle: 是否啟用 Thinking 偵測 / battle 表演（預設 false 給 v4）
function decideAgumon(i, st, now, charDef, opts = {}) {
    const { F, EXPRS, ROAR_FRAMES, TOKEN_RESET_FRAMES, sleepFrames, SLEEP_PERIOD } = charDef;
    const step = Math.floor(now / STEP_MS);
    const allowBattle = !!opts.allowBattle;

    let hookFired = false;
    try {
        const hook = JSON.parse(fs.readFileSync(HOOK_FILE, 'utf8'));
        if (hook.ts && hook.ts !== st.lastHookTs) {
            const isFirstLoad = st.lastHookTs === undefined;
            st.lastHookTs = hook.ts;
            if (!isFirstLoad) {
                st.roarStartStep  = step;
                st.lastActivityAt = now;
                hookFired         = true;
                // 訓練補正：每則新訊息 +1，受階段上限約束（UnRank 無上限）
                // 多視窗 race-safe：每個視窗讀同一 disk 狀態都得到 train+1，最後一個寫的 wins，淨增 +1
                const cap   = getTierCap(getCharacterRank(st.characterId));
                const base  = getCharacterPower(st.characterId);
                const train = st.trainingBonus ?? 0;
                if (base + train < cap) st.trainingBonus = train + 1;
            }
        }
    } catch(e) {}
    if (!st.lastActivityAt) st.lastActivityAt = now;

    if (allowBattle && hookFired) {
        // 新訊息 → 重置 thinking 偵測，準備這一輪可觸發 battle
        st.thinkingPrimed = true;
        st.lastThinking   = false;
    }

    if (allowBattle && st.thinkingPrimed && !(st.battleStartStep >= 0) && !st.battlePending) {
        const summary    = i.model?.param_summary || '';
        const isThinking = /thinking/i.test(summary);
        if (isThinking && !st.lastThinking) {
            st.battlePending  = true;
            st.thinkingPrimed = false;
        }
        st.lastThinking = isThinking;
    }

    // ── force battle 觸發（cheat code）─────────────────────────────
    if (allowBattle && st._forceBattle && !(st.battleStartStep >= 0)) {
        // seed = 共享的 trigger ts → 多視窗算出同一敵人/勝負
        startBattle(st, step, st.characterId, st.lastBattleTriggerTs);
        if (st._forceBattleWin === true)  st.battleWin = true;
        if (st._forceBattleWin === false) st.battleWin = false;
        if (typeof st._forceBattleEnemy === 'string') {
            st.battleEnemy = st._forceBattleEnemy;
            // enemy 換掉了 → 重判 cut-in 可用性
            st.battleVersion = pickBattleVersion(st.characterId, st.battleEnemy);
        }
        delete st._forceBattle; delete st._forceBattleWin; delete st._forceBattleEnemy;
    }

    // ── 進化表演（最高優先；超越 battle、roar）─────────
    if (st.evoStartStep != null && st.evoStartStep >= 0) {
        const targetElapsed = step - st.evoStartStep;
        // Frame throttle（同 battle）：每 render 最多 +1，保證每拍都被渲染
        // Commit 由 statusline-agumon-color.js 在「shown 會推進到 EVO_LENGTH」那拍處理
        const prevShown    = st.evoShownElapsed ?? -1;
        const shownElapsed = Math.min(targetElapsed, prevShown + 1);

        // 殘留清理（跨機 / 跨重啟導致 target 不連續）
        if (targetElapsed < 0 || targetElapsed >= EVO_LENGTH + 18) {
            st.evoStartStep    = -1;
            st.evoNextCharId   = null;
            st.evoShownElapsed = -1;
        } else if (shownElapsed >= 0 && shownElapsed < EVO_LENGTH) {
            st.evoShownElapsed = shownElapsed;
            let newF = F;
            try {
                const newChar = loadCharacter(st.evoNextCharId);
                if (newChar?.charDef?.F) newF = newChar.charDef.F;
            } catch(e) {}
            return decideEvoFrame(shownElapsed, F, newF, st.lastPos ?? 0);
        }
        // shownElapsed >= EVO_LENGTH 且 target 未超 safety → 等 statusline commit
    }

    // ── Battle 表演（高優先級；但 ROAR 在它前面播完才啟動）─────────
    if (allowBattle && st.battleStartStep != null && st.battleStartStep >= 0) {
        const targetElapsed = step - st.battleStartStep;
        const useCutIn      = st.battleVersion === 2;
        const length        = battleLength(st.battleVersion);

        // Frame throttle: 每次 render 最多前進 1 拍。Claude refresh 1s vs STEP_MS 750ms
        // 取樣 aliasing 會跳幀；用 shownElapsed 保證每拍都被渲染。
        // 代價：render 稀疏時戰鬥 wallclock 會被拉長（最壞 = render 間隔 × length）。
        const prevShown    = st.battleShownElapsed ?? -1;
        const shownElapsed = Math.min(targetElapsed, prevShown + 1);

        // 殘留清理：跨機 / 跨重啟導致 target 不連續（startStep 來自很久以前）
        if (targetElapsed < 0 || targetElapsed >= BATTLE_SAFETY) {
            st.battleStartStep    = -1;
            st.battleEnemy        = null;
            st.battleVersion      = 1;
            st.battleShownElapsed = -1;
        } else if (shownElapsed < length) {
            st.battleShownElapsed = shownElapsed;
            return decideBattleFrame(shownElapsed, st.battleWin, st.battleEnemy, F, useCutIn);
        } else {
            // 正常結束 → 接續 RESULT 的中央位置，從 col 16 朝左開始走
            st.battleStartStep    = -1;
            st.battleEnemy        = null;
            st.battleVersion      = 1;
            st.battleShownElapsed = -1;
            st.lastStepSeen       = step;
            const PERIOD     = MAX_POS * 2;                            // 40
            const wantPhase  = PERIOD - BATTLE_CENTER_COL;             // pos=center, facing 'left'
            st.walkPhaseOffset = (((wantPhase - step) % PERIOD) + PERIOD) % PERIOD;
        }
    }

    // Token 重置偵測：新 resets_at 嚴格大於 stored + 舊值已過期 → 窗口真的滾過了
    // ⚠ 必須用 `>` 而非 `!==`：搭配下面 Math.max 保留舊值的設計，
    //   若 input 偶發回傳比 stored 還舊的值（多視窗 race / 邊角 case），
    //   `!==` 會觸發 HAPPY 但 stored 不更新 → 4 秒後重複觸發無限循環。
    const r5hResetAt = i.rate_limits?.five_hour?.resets_at;
    const nowSec = Math.floor(now / 1000);
    if (r5hResetAt && st._r5hResetAt
        && r5hResetAt > st._r5hResetAt
        && st._r5hResetAt <= nowSec                    // 舊值已是過去式
        && !(st.happyStartStep >= 0)) {                // 動畫未在播放中
        st.happyStartStep = step;
    }
    if (r5hResetAt) st._r5hResetAt = Math.max(r5hResetAt, st._r5hResetAt || 0);

    // 從睡眠喚醒：重新對齊 walkPhaseOffset，讓 computeWalk(step) 從 lastPos / lastFacing 繼續
    // 否則 step 在睡眠期間持續累加，醒來瞬間 pos 會跳到三角波的別處（包含 ROAR 那幾幀）
    if (st.wasSleeping && (now - st.lastActivityAt) <= IDLE_MS) {
        const PERIOD    = MAX_POS * 2;
        const lastPos   = st.lastPos ?? 0;
        const wantPhase = (st.lastFacing === 'left') ? (PERIOD - lastPos) % PERIOD : lastPos;
        st.walkPhaseOffset = (((wantPhase - step) % PERIOD) + PERIOD) % PERIOD;
        st.wasSleeping = false;
    }

    const walk = computeWalk(step, st.walkPhaseOffset || 0);

    // 強制睡覺（cheat ac --sleep）：最高優先，跳過 roar/battle/expr，持續到 ac --wake
    if (st._forceSleep) {
        st.wasSleeping = true;
        const idx = SLEEP_PERIOD ? Math.floor(step / SLEEP_PERIOD) % sleepFrames.length : 0;
        const sleepFx = idx === 0 ? 'zsleep1' : 'zsleep2';
        return { kind: 'single', frameIdx: sleepFrames[idx], facing: 'left', pos: st.lastPos ?? 0, sleepFx };
    }

    // 大吼最優先（hold 確保為偶數，維持 step 奇偶）
    // 動畫播放中繼續走路（不凍結位置），避免位置定格
    if (st.roarStartStep != null && st.roarStartStep >= 0) {
        const elapsed = step - st.roarStartStep;
        const roarHold = evenHold(ROAR_FRAMES.length + 1);
        if (elapsed < roarHold) {
            return { kind: 'single', frameIdx: ROAR_FRAMES[Math.min(elapsed, ROAR_FRAMES.length - 1)], facing: walk.facing, pos: walk.pos };
        }
        st.roarStartStep = -1;
        // ROAR 結束的同一秒：若有 battlePending，馬上接戰鬥
        if (allowBattle && st.battlePending) {
            startBattle(st, step, st.characterId, st.lastHookTs);
            return decideBattleFrame(0, st.battleWin, st.battleEnemy, F, st.battleVersion === 2);
        }
    }

    // ROAR 沒在播 + battlePending（thinking 在 ROAR 結束後才被偵測）
    if (allowBattle && st.battlePending) {
        startBattle(st, step, st.characterId, st.lastHookTs);
        return decideBattleFrame(0, st.battleWin, st.battleEnemy, F, st.battleVersion === 2);
    }

    // Token 重置高興（hold 確保為偶數）
    if (st.happyStartStep != null && st.happyStartStep >= 0) {
        const elapsed = step - st.happyStartStep;
        const happyHold = evenHold(TOKEN_RESET_FRAMES.length);
        if (elapsed < happyHold) {
            return { kind: 'single', frameIdx: TOKEN_RESET_FRAMES[Math.min(elapsed, TOKEN_RESET_FRAMES.length - 1)], facing: walk.facing, pos: walk.pos };
        }
        st.happyStartStep = -1;
    }

    // 睡覺（靜止不動，保留最後位置）；右上疊 Z 特效：sleep_1→Z、sleep_2→zZ
    if ((now - st.lastActivityAt) > IDLE_MS) {
        st.wasSleeping = true;
        const idx = SLEEP_PERIOD ? Math.floor(step / SLEEP_PERIOD) % sleepFrames.length : 0;
        const sleepFx = idx === 0 ? 'zsleep1' : 'zsleep2';
        return { kind: 'single', frameIdx: sleepFrames[idx], facing: 'left', pos: st.lastPos ?? 0, sleepFx };
    }

    // 表演中（hold 確保為偶數）；位置凍結在觸發當秒，避免表演期間滑動
    if (st.exprStartStep != null && st.exprStartStep >= 0) {
        const expr = EXPRS[st.exprIdx ?? 0];
        const hold = evenHold(expr.hold ?? expr.frames.length);
        const elapsed = step - st.exprStartStep;
        if (elapsed < hold) {
            const frozenWalk = computeWalk(st.exprStartStep, st.walkPhaseOffset || 0);
            return { kind: 'single', frameIdx: expr.frames[Math.min(elapsed, expr.frames.length - 1)], facing: frozenWalk.facing, pos: frozenWalk.pos };
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
            return { kind: 'single', frameIdx: EXPRS[st.exprIdx].frames[0], facing: walk.facing, pos: walk.pos };
        }
    }

    // 走路幀：純函數 of step，多視窗算出來必相同；evenHold 確保動畫結束後 step 奇偶不翻轉
    const walkFrame = ((step + (st.walkPhaseOffset || 0)) % 2 === 0) ? F.IDLE_1 : F.IDLE_2;
    st.lastPos    = walk.pos;
    st.lastFacing = walk.facing;
    return { kind: 'single', frameIdx: walkFrame, facing: walk.facing, pos: walk.pos };
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
    const bulletArtFile = path.join(dir, 'bullet-art.json');
    const cutinArtFile  = path.join(dir, 'cutin-art.json');
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
        bulletArtFile,
        cutinArtFile,
        config,
    };
}

// ── 共用 sprite（encounter / boom / ...） ─────────────────────────
function loadShared() {
    const dir         = path.join(ASSETS_DIR, 'shared');
    const manifestPath = path.join(dir, 'manifest.json');
    const artPath      = path.join(dir, 'art.json');
    if (!fs.existsSync(manifestPath) || !fs.existsSync(artPath)) return null;
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const art      = JSON.parse(fs.readFileSync(artPath, 'utf8'));
        return { manifest, art };
    } catch(e) { return null; }
}

function getSharedFrame(shared, name, frameIdx = 0) {
    if (!shared) return null;
    const meta = shared.manifest.sprites?.[name];
    if (!meta || !Array.isArray(meta.indices)) return null;
    const artIdx = meta.indices[frameIdx];
    if (artIdx == null) return null;
    return shared.art.frames[artIdx] || null;
}

// ── 渲染：half-block cell rows → 終端字串 ────────────────────────
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

// 把 overlay cell rows 疊到 base cell rows 之上（非 null 才覆蓋），回傳新 buffer（不改原陣列）
function overlayCells(baseRows, overlayRows) {
    const buf = baseRows.map(r => r.slice());
    if (!overlayRows) return buf;
    for (let r = 0; r < overlayRows.length && r < buf.length; r++) {
        for (let c = 0; c < overlayRows[r].length && c < buf[r].length; c++) {
            if (overlayRows[r][c]) buf[r][c] = overlayRows[r][c];
        }
    }
    return buf;
}

// 睡覺場景：角色放左、特效（Z）放右側額外欄位 → 輸出加寬 buffer（特效在角色右方，不重疊）
const SLEEP_SCENE_WIDTH = 24;   // 角色 16 + 右側 Z 區 8
function composeSleepScene(charRows, fxRows, fxCol = 16) {
    const H = charRows.length;
    const buf = Array.from({ length: H }, () => Array(SLEEP_SCENE_WIDTH).fill(null));
    for (let r = 0; r < H; r++)
        for (let c = 0; c < charRows[r].length && c < SLEEP_SCENE_WIDTH; c++)
            if (charRows[r][c]) buf[r][c] = charRows[r][c];
    if (fxRows)
        for (let r = 0; r < fxRows.length && r < H; r++)
            for (let c = 0; c < fxRows[r].length; c++) {
                const x = fxCol + c;
                if (x >= 0 && x < SLEEP_SCENE_WIDTH && fxRows[r][c]) buf[r][x] = fxRows[r][c];
            }
    return buf;
}

// ── 戰鬥場景合成 ─────────────────────────────────────────────────
// 場景 52 cells 寬 × 8 cells 高（gap 20 cells，子彈輕觸式爆炸）
const BATTLE_SCENE_WIDTH  = 52;
const BATTLE_SCENE_HEIGHT = 8;
const BATTLE_ME_LEFT_COL    = 0;
const BATTLE_ENEMY_RIGHT_COL = BATTLE_SCENE_WIDTH - 16;  // 36
const BATTLE_CENTER_COL      = (BATTLE_SCENE_WIDTH - 16) / 2;  // 18

// v2 cut-in settled 位置：32 寬，往兩側各退 BATTLE_CUTIN_RETREAT 拉開距離
const BATTLE_CUTIN_RETREAT   = 4;                                       // 各退 4 cells → 中央 col 24-27 重疊 4 cells
const BATTLE_CUTIN_ME_COL    = 0 - BATTLE_CUTIN_RETREAT;                // -4 (左側裁掉 4 cells)
const BATTLE_CUTIN_ENEMY_COL = (BATTLE_SCENE_WIDTH - 32) + BATTLE_CUTIN_RETREAT; // 24 (右側裁掉 4 cells)

function paintCells(buffer, rows, col0) {
    if (!rows) return;
    const H = buffer.length;
    const W = buffer[0].length;
    for (let r = 0; r < rows.length && r < H; r++) {
        for (let c = 0; c < rows[r].length; c++) {
            const dx = col0 + c;
            if (dx < 0 || dx >= W) continue;
            const cell = rows[r][c];
            if (!cell) continue;
            buffer[r][dx] = cell;
        }
    }
}

// 取得指定 facing 的 sprite rows
function getFacingRows(art, frameIdx, facing, rightOffset) {
    if (frameIdx == null || !art) return null;
    let rows;
    if (facing === 'right' && rightOffset != null) {
        rows = art.frames[frameIdx + rightOffset] || art.frames[frameIdx + rightOffset - 1] || art.frames[0];
    } else {
        rows = art.frames[frameIdx] || art.frames[0];
        if (facing === 'right') rows = flipRows(rows);
    }
    return rows;
}

function composeBattleScene(opts) {
    const {
        frame,
        meArt, enemyArt,
        meBulletArt, enemyBulletArt,
        meCutInArt = null, enemyCutInArt = null,
        shared,
        meRightOffset = null,
        enemyRightOffset = null,
    } = opts;

    const buffer = Array.from({ length: BATTLE_SCENE_HEIGHT },
        () => Array(BATTLE_SCENE_WIDTH).fill(null));

    // ── v2 cut-in（先畫，作為背景；shared sprite / 角色會壓在上方）─────
    // 兩張各 32 cell 寬，中央 12 cell 重疊（col 20-31）。原圖固定面左：
    //   - 敵方在右 → 維持面左（原樣朝向中央/我方）
    //   - 我方在左 → 翻轉成面右（朝中央/敵方）→ 兩邊互瞪
    // 我方畫在敵方之上（玩家視角優先）
    if (frame.enemyCutIn && enemyCutInArt?.frames?.[0]) {
        const col = frame.enemyCutInCol ?? BATTLE_CUTIN_ENEMY_COL;
        paintCells(buffer, enemyCutInArt.frames[0], col);
    }
    if (frame.meCutIn && meCutInArt?.frames?.[0]) {
        const col = frame.meCutInCol ?? BATTLE_CUTIN_ME_COL;
        // 我方需要面右；優先用客製右向（frames[1]），沒有就翻轉左向
        const meRows = meCutInArt.frames[1] || flipRows(meCutInArt.frames[0]);
        paintCells(buffer, meRows, col);
    }

    // 共用 sprite 居中（在角色下方繪製，cut-in 上方繪製）
    if (frame.sharedSpriteName && shared) {
        const spriteRows = getSharedFrame(shared, frame.sharedSpriteName, frame.sharedFrameIdx ?? 0);
        if (spriteRows) paintCells(buffer, spriteRows, BATTLE_CENTER_COL);
    }

    // 子彈（在角色下方繪製 → 角色身體會擋住子彈左/右半，視覺上像從體內冒出）
    // 兩顆子彈從各自身體中央出發，到中央輕觸爆炸
    // 我方子彈：col 8 → 14（painted 11-20 → 17-26）
    // 敵方子彈：col 28 → 22（painted 31-40 → 25-34）
    // 起點分離，終點僅 2-cell 重疊（col 25-26）→ 接觸即爆
    // 繪製順序：「勝者」的子彈後畫 → 兩子彈相交處勝者在上方（視覺預告勝負）
    if (frame.bullet && typeof frame.bullet.progress === 'number') {
        const p = Math.max(0, Math.min(1, frame.bullet.progress));
        const colMe    = Math.round(8 + p * 6);
        const colEnemy = Math.round(28 - p * 6);
        const paintMe    = () => { if (meBulletArt?.frames?.[0])    paintCells(buffer, meBulletArt.frames[0], colMe); };
        const paintEnemy = () => { if (enemyBulletArt?.frames?.[0]) paintCells(buffer, flipRows(enemyBulletArt.frames[0]), colEnemy); };
        if (frame.win) { paintEnemy(); paintMe(); }     // 我方勝 → 我方子彈在上方
        else           { paintMe();    paintEnemy(); }  // 敵方勝 → 敵方子彈在上方
    }

    // 我方（畫在子彈上方）
    if (frame.meFrameIdx != null) {
        const rows  = getFacingRows(meArt, frame.meFrameIdx, frame.meFacing, meRightOffset);
        const col   = frame.position === 'center' ? BATTLE_CENTER_COL : BATTLE_ME_LEFT_COL;
        paintCells(buffer, rows, col);
    }

    // 敵方（畫在子彈上方）
    if (frame.enemyFrameIdx != null) {
        const rows = getFacingRows(enemyArt, frame.enemyFrameIdx, frame.enemyFacing, enemyRightOffset);
        paintCells(buffer, rows, BATTLE_ENEMY_RIGHT_COL);
    }

    // 天氣特效（勝=sun / 敗=cloud）→ 右上角，畫在最上層
    if (frame.weather && shared) {
        const wRows = getSharedFrame(shared, frame.weather, 0);
        if (wRows) paintCells(buffer, wRows, BATTLE_SCENE_WIDTH - 16);  // col 36，sprite 內容靠上 → 右上角
    }

    return renderCells(buffer);
}

// ── 進化場景合成（單角色 + DNA overlay）─────────────────────────
function composeEvoScene({ frame, charArt, shared, charRightOffset = null }) {
    const W = 16, H = 8;
    const buffer = Array.from({ length: H }, () => Array(W).fill(null));
    if (!frame.hideChar && charArt) {
        const rows = getFacingRows(charArt, frame.frameIdx, frame.facing, charRightOffset);
        if (rows) paintCells(buffer, rows, 0);
    }
    if (frame.overlaySpriteName && shared) {
        const rows = getSharedFrame(shared, frame.overlaySpriteName, frame.overlayFrameIdx);
        if (rows) paintCells(buffer, rows, 0);
    }
    return renderCells(buffer);
}

module.exports = {
    INSTALL_ROOT, STATE_DIR, ASSETS_DIR,
    ANCHOR_GAP,
    BATTLE_LENGTH, BATTLE_LENGTH_V2, BATTLE_SCENE_WIDTH, BATTLE_SCENE_HEIGHT,
    hasCutIn, pickBattleVersion, battleLength,
    EVO_LENGTH,
    decideBattleFrame,
    decideEvoFrame,
    composeEvoScene,
    loadState, saveState, atomicWrite,
    decideAgumon,
    checkEvolution,
    buildStatusLines,
    composeOutput,
    visLen,
    loadCharacter,
    getCharacterRank,
    getCharacterPower,
    getTierCap,
    computeWinProb,
    seedRand01,
    chooseBattleEnemy,
    loadShared,
    getSharedFrame,
    renderCells,
    flipRows,
    overlayCells,
    composeSleepScene,
    composeBattleScene,
    getFacingRows,
};
