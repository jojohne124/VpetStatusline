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
const BATTLE_DELAY_MS = 5000;   // prompt 後思考超過這秒數 → 自動觸發戰鬥（取代無效的 thinking 字串偵測）
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

// 終端顯示寬度（東亞全形/CJK 算 2 格），用於把文字對齊到指定 cell 欄位
function isWideChar(ch) {
    const c = ch.codePointAt(0);
    return (c >= 0x1100 && c <= 0x115F) || (c >= 0x2E80 && c <= 0xA4CF) ||
           (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0xF900 && c <= 0xFAFF) ||
           (c >= 0xFE30 && c <= 0xFE4F) || (c >= 0xFF00 && c <= 0xFF60) ||
           (c >= 0xFFE0 && c <= 0xFFE6) || (c >= 0x20000 && c <= 0x3FFFD);
}
const dispWidth = s => [...stripAnsi(s)].reduce((w, ch) => w + (isWideChar(ch) ? 2 : 1), 0);

// ── 狀態 ─────────────────────────────────────────────────────────
// 清掃孤兒 tmp：process 在 write→rename 之間被 kill 時 catch 來不及執行，會留下 tmp 殘骸。
// 掃同目錄、刪掉超過 30 秒未被 rename 掉的 <file>.*.tmp（在途的更年輕，不碰）。
function sweepStaleTmps(file) {
    try {
        const dir  = path.dirname(file);
        const base = path.basename(file);
        const now  = Date.now();
        for (const name of fs.readdirSync(dir)) {
            if (!name.startsWith(`${base}.`) || !name.endsWith('.tmp')) continue;
            const full = path.join(dir, name);
            try { if (now - fs.statSync(full).mtimeMs > 30000) fs.unlinkSync(full); } catch(_) {}
        }
    } catch(_) {}
}
// atomic write：tmp 寫入後 rename（rename 在同 fs 上是 atomic），避免並行讀到 partial write
function atomicWrite(file, data) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        sweepStaleTmps(file);
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

// 取得當前 git 分支名：直接讀 .git/HEAD（不 spawn 子行程，杜絕同步卡死與 AV 掃描成本）。
// 從 startDir 往上找 .git；支援 .git 為目錄(一般 repo)或檔案(worktree → gitdir 指向)。
// detached HEAD（HEAD 直接是 SHA）回 null，行為同舊版 branch !== 'HEAD' 的跳過。
function gitBranch(startDir) {
    try {
        let dir = startDir || process.cwd();
        for (let i = 0; i < 40; i++) {
            const gitPath = path.join(dir, '.git');
            let headFile = null;
            try {
                const stt = fs.statSync(gitPath);
                if (stt.isDirectory()) {
                    headFile = path.join(gitPath, 'HEAD');
                } else if (stt.isFile()) {
                    const m = fs.readFileSync(gitPath, 'utf8').match(/gitdir:\s*(.+)/);
                    if (m) headFile = path.join(path.resolve(dir, m[1].trim()), 'HEAD');
                }
            } catch (_) {}
            if (headFile) {
                try {
                    const head = fs.readFileSync(headFile, 'utf8').trim();
                    const rm = head.match(/^ref:\s*refs\/heads\/(.+)$/);
                    return rm ? rm[1].trim() : null;
                } catch (_) { return null; }
            }
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    } catch (_) {}
    return null;
}

// ── 走路（三角波）────────────────────────────────────────────────
function computeWalk(step, offset = 0) {
    const period = MAX_POS * 2;
    const phase  = (((step + offset) % period) + period) % period;
    const pos    = phase <= MAX_POS ? phase : (period - phase);
    return { pos, facing: phase < MAX_POS ? 'right' : 'left' };
}

// ── 進化花費累積（cost_threshold 用）──────────────────────────────
// 改良差額制：i.cost.total_cost_usd 是「本 session」累計，關視窗→新 session 會歸 0。
// 舊的「base 相減」在跨 session 時會進度歸零、甚至 delta 變負卡住。
// 改為 per-session 高水位 + 加總：每個 session_id 記其最高 cost，總和 = 累積花費。
// 進化/reset 時清空。max() 冪等 → 多視窗共用 state 也 race-safe（不會被交替灌爆）。
// 每個 session 記 { s: 起算基準 cost, p: 高水位 cost }；貢獻 = max(0, p - s)。
// 首見該 session 時 s=p=當前 cost → 從這一刻起算（清空後當前 session 貢獻自然歸 0，
// 不會把已花的 cost 重新算進來）。跨 session 各記各的、加總 → 關視窗不丟進度。
const EVO_SPEND_CAP = 200;   // 防 state 膨脹：session 數上限（超過丟貢獻最小的；正常進化前不會到）
function updateEvoSpend(st, i) {
    const cost = i?.cost?.total_cost_usd;
    const sid  = i?.session_id;
    if (typeof cost !== 'number' || cost < 0 || !sid) return;
    let m = st._evoSpendBySession;
    if (!m || typeof m !== 'object') m = st._evoSpendBySession = {};
    const e = m[sid];
    if (!e || typeof e !== 'object') m[sid] = { s: cost, p: cost };   // 首見：以當前 cost 為基準
    else if (cost > e.p) e.p = cost;                                  // 高水位（max 冪等 → race-safe）
    const keys = Object.keys(m);
    if (keys.length > EVO_SPEND_CAP) {
        const contrib = k => Math.max(0, (m[k].p || 0) - (m[k].s || 0));
        keys.sort((a, b) => contrib(a) - contrib(b));
        for (const k of keys.slice(0, keys.length - EVO_SPEND_CAP)) delete m[k];
    }
}
function evoSpendTotal(st) {
    const m = st._evoSpendBySession;
    if (!m) return 0;
    let sum = 0;
    for (const k in m) { const e = m[k]; if (e) sum += Math.max(0, (e.p || 0) - (e.s || 0)); }
    return sum;
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
        const delta = evoSpendTotal(st);   // 跨 session 累積花費（高水位加總）
        if (delta >= (cond.usd ?? 10))
            st[ns + '_ready'] = true;
        return !!st[ns + '_ready'];
    }

    if (cond.type === 'win_rate') {
        // 即時累積勝率（本階段戰績；不 latch，與狀態卡顯示的勝率一致 = 所見即所得）。
        // minBattles 保證樣本/節奏，場數不足不觸發。
        const total = st.battleTotalCount || 0;
        const wins  = st.battleWinCount  || 0;
        if (total < (cond.minBattles ?? 0)) return false;
        return (wins / total) * 100 >= (cond.pct ?? 100);
    }

    if (cond.type === 'time_of_day') {
        // 日夜分歧：06:00–18:00 為日，其餘為夜。即時 gate（不 latch，同 win_rate），
        // 用當地時間 getHours()。多視窗同一時刻判定一致 → 無 race。
        const hour  = new Date().getHours();
        const isDay = hour >= 6 && hour < 18;
        return cond.period === 'night' ? !isDay : isDay;
    }

    return false;
}

function checkEvolution(st, input, config) {
    if (!config.evolvesTo || config.evolvesTo.length === 0) return null;
    const nowSec = Math.floor(Date.now() / 1000);

    // 每 tick 評估「所有」進化路線（不在第一條達成時就 return），
    // 讓各路線的 latch 狀態（_ready/_peaked）都保持更新，再決定走哪條。
    const roster = getRosterSet();   // 未實裝（不在 roster）的目標直接跳過
    const ready = [];
    for (const evo of config.evolvesTo) {
        if (roster && !roster.has(evo.character)) continue;
        // 支援 conditions 陣列或舊格式的單一 condition
        const conditions = evo.conditions ?? (evo.condition ? [evo.condition] : []);
        if (!conditions.length) continue;
        const op = evo.operator ?? 'and';

        const flags = conditions.map((cond, idx) =>
            evalCondition(cond, `_evo_${evo.character}_c${idx}`, st, input, nowSec)
        );
        const ok = op === 'or' ? flags.some(Boolean) : flags.every(Boolean);
        if (ok) ready.push({ evo, conditions });
    }
    if (!ready.length) return null;

    // 分歧進化：多條路線同時達成時，以「進化目標戰力（power）強者」為優先。
    ready.sort((a, b) => getCharacterPower(b.evo.character) - getCharacterPower(a.evo.character));
    const { evo, conditions } = ready[0];
    conditions.forEach((_, idx) => { delete st[`_evo_${evo.character}_c${idx}_ready`]; });
    st._evoSpendBySession = {};   // 進化後清空累積花費，下一階重新累積
    return evo.character;
}

// ── 核心狀態機 ───────────────────────────────────────────────────
// charDef: { F, EXPRS, ROAR_FRAMES, TOKEN_RESET_FRAMES, sleepFrames, SLEEP_PERIOD? }

// hold 必須是偶數，才能讓動畫結束後 step % 2 的奇偶回到正確位置
const evenHold = n => n % 2 === 0 ? n : n + 1;

// ── 進化（Evolution）─────────────────────────────────────────────
const EVO_LENGTH = 12;                                                 // 0-5 dna1/2/3 ×2 / 6-7 dna_end1 隱形 / 8 dna_end2 光繭破裂 / 9-11 新角色 IDLE-HAPPY 交替

// Reset 掉落表演：新 starter 從上方掉進畫面（超出上緣裁掉，不加高），落地腳下左右噴煙塵
const DROP_FALL   = 3;                                                 // 掉落幀數（0..DROP_FALL 從上滑到定位）
const DROP_LAND   = 2;                                                 // 落地停留 + 煙塵幀數
const DROP_LENGTH = DROP_FALL + DROP_LAND;

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

// ── 狀態卡（Card）─────────────────────────────────────────────────
// 5 拍：elapsed 0 = fade-in dim，1-3 = 全亮，4 = fade-out dim，>=5 隱藏
const CARD_LENGTH = 5;
const TREE_LENGTH = 6;   // 進化歷程顯示拍數（約 6 秒）：0 fade-in、1-4 全亮、5 fade-out
const CARD_SCENE_WIDTH = 52;  // 對齊 BATTLE_SCENE_WIDTH，足以蓋住整個走路範圍

// ── 戰鬥（Battle）─────────────────────────────────────────────────
const BATTLE_LENGTH    = 19;                                           // v1：共 19 step（Encounter 3 拍 + Boom 3 拍）
const BATTLE_LENGTH_V2 = 21;                                           // v2：encounter 多 2 拍（cut-in 滑入 + 對峙）→ 共 21 step
const BATTLE_SAFETY    = 30;                                           // 殘留清理門檻

const safeF = (F, name, fallback = 0) => F[name] ?? fallback;

function getCharacterStage(name) {
    try {
        const config = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, name, 'config.json'), 'utf8'));
        return config.stage ?? 'UnStage';
    } catch(e) { return 'UnStage'; }
}

// roster 成員 = 「已實裝」角色。進化路線編輯器把未實裝的邊也留在 config.evolvesTo，
// 用 roster 當 gate：不在 roster 的目標不會被進化進去。讀不到 roster 時 fail-open（回 null → 不 gate）。
let _rosterSetCache = null;
function getRosterSet() {
    if (_rosterSetCache) return _rosterSetCache;
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, 'roster.json'), 'utf8'));
        const list = Array.isArray(raw) ? raw : raw.roster;
        _rosterSetCache = new Set(list);
    } catch(e) { _rosterSetCache = null; }
    return _rosterSetCache;
}

// 高階 starter（reset 用另一種登場煙霧 dust_hi）。由編輯器勾選、存 roster.highTierStarters。
let _highTierSetCache = null;
function getHighTierStarterSet() {
    if (_highTierSetCache) return _highTierSetCache;
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, 'roster.json'), 'utf8'));
        _highTierSetCache = new Set(Array.isArray(raw) ? [] : (raw.highTierStarters || []));
    } catch(e) { _highTierSetCache = new Set(); }
    return _highTierSetCache;
}
function isHighTierStarter(id) { return !!id && getHighTierStarterSet().has(id); }

// 各階段戰力上限（UnStage 無上限）
const TIER_CAP = { Child: 50, Adult: 100, Perfect: 150, Ultimate: 200, UnStage: Infinity };
function getTierCap(stage) { return TIER_CAP[stage] ?? Infinity; }

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
// 我戰力 = min(我power + trainingBonus, 我階段 cap)；敵戰力 = 敵power
// 差距制線性：勝率% = 50 + (我戰 - 敵戰) + 體驗補正，clamp [5,95]。
// 每 1 點戰力差 = 1% 勝率，直觀好算；clamp 留 ±5% 爆冷空間。
// 體驗補正：單機 0（純戰力差，與 PvP 一致零和對稱）。（2026-07-09 由 +5 改為 0）
const WIN_EXP_BONUS = 0;      // 單機體驗補正（百分點）
const WIN_FLOOR = 0.05;
const WIN_CEIL  = 0.95;
// 共用勝率核心：給已算好的雙方戰力 + 體驗補正 → 勝率機率。單機與 PvP 共用同一條公式。
function winProbFromStr(myStr, eStr, expBonus = WIN_EXP_BONUS) {
    const pct = 50 + (myStr - eStr) + expBonus;
    return Math.max(WIN_FLOOR, Math.min(WIN_CEIL, pct / 100));
}
function computeWinProb(myId, st, enemyId) {
    const myCap = getTierCap(getCharacterStage(myId));
    const myStr = Math.min(getCharacterPower(myId) + (st.trainingBonus ?? 0), myCap);
    const eStr  = getCharacterPower(enemyId);
    return winProbFromStr(myStr, eStr);
}

function _hashSeed(seed) {
    let h = (Math.floor(seed) ^ 0x9e3779b9) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h;
}

function chooseBattleEnemy(myId, seed, lastEnemyId) {
    // 同階隨機（排除自己）；給 seed → 決定性挑選（多視窗一致）。
    // anti-stick：若抽到的 == 上一場敵人，用 seed+1 變體 re-roll；仍同就順移下一個 candidate。
    //   連續同敵機率從 1/N 降到 ~1/N²，避免短樣本下「一直重複」的觀感。
    try {
        const rosterData = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, 'roster.json'), 'utf8'));
        const roster = Array.isArray(rosterData) ? rosterData : rosterData.roster;
        const myStage = getCharacterStage(myId);
        const candidates = roster.filter(n => n !== myId && getCharacterStage(n) === myStage);
        if (candidates.length === 0) return 'godzilla_1999';
        let pick;
        if (seed != null) {
            pick = candidates[_hashSeed(seed) % candidates.length];
            if (lastEnemyId && pick === lastEnemyId && candidates.length > 1) {
                pick = candidates[_hashSeed(seed + 1) % candidates.length];
                if (pick === lastEnemyId) {
                    const i = candidates.indexOf(lastEnemyId);
                    pick = candidates[(i + 1) % candidates.length];
                }
            }
        } else {
            pick = candidates[Math.floor(Math.random() * candidates.length)];
        }
        return pick;
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

// 角色是否已安裝（config.json 存在）。給黑影 fallback 判斷「對手本機沒有」用。
function characterExists(charId) {
    if (!charId) return false;
    try { return fs.existsSync(path.join(ASSETS_DIR, charId, 'config.json')); }
    catch(e) { return false; }
}

// v2 vs v1 分鏡選擇：只在「我方與敵方都有 cut-in art」時啟用 v2。
// 敵方角色本機沒有（→ 以 Shadow 黑影演出）時：若 Shadow 有 cut-in，視為敵方有 cut-in，
// 我方也有就走 v2（黑影也能演 cut-in）。Shadow 未安裝 → 退回即時染黑 agumon（無 cut-in）→ v1。
function pickBattleVersion(myId, enemyId) {
    const enemyCut = hasCutIn(enemyId) || (!characterExists(enemyId) && hasCutIn('shadow'));
    return (hasCutIn(myId) && enemyCut) ? 2 : 1;
}

// ── 進化歷史（evoHistory）─────────────────────────────────────────
// 記錄桌寵「真正走過」的進化鏈（Child→…→當前），給 vpet tree 展示用。
function _readConfig(charId) {
    try { return JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, charId, 'config.json'), 'utf8')); }
    catch(e) { return null; }
}
// from 的 evolvesTo 是否包含 to（= from 自然進化得到 to）
function isEvolutionTarget(from, to) {
    const c = _readConfig(from);
    return !!(c && Array.isArray(c.evolvesTo) && c.evolvesTo.some(e => e.character === to));
}
// 找 charId 的 parent（誰的 evolvesTo 指向它）
function parentsOf(charId) {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(ASSETS_DIR).filter(n => fs.existsSync(path.join(ASSETS_DIR, n, 'config.json'))); }
    catch(e) { return out; }
    for (const n of names) {
        const c = _readConfig(n);
        if (c && Array.isArray(c.evolvesTo) && c.evolvesTo.some(e => e.character === charId)) out.push(n);
    }
    return out;
}
// 補種用：從 cur 往回推祖先（多 parent 取 power 最強），回 [root…cur]。只在沒有歷史時用一次。
function buildLineageBackward(cur) {
    const chain = [cur];
    for (let guard = 0; guard < 8; guard++) {
        const ps = parentsOf(chain[0]);
        if (!ps.length) break;
        ps.sort((a, b) => getCharacterPower(b) - getCharacterPower(a));
        if (chain.includes(ps[0])) break;   // 防環
        chain.unshift(ps[0]);
    }
    return chain;
}
// 每 tick 在 characterId 定案後呼叫：維護 st.evoHistory。
// last===cur 直接返回（O(1)）；自然進化 append；斷點(reset/cheat 跳轉)重設；空則補種。
function updateEvoHistory(st) {
    const cur = st.characterId;
    if (!cur) return;
    const h = Array.isArray(st.evoHistory) ? st.evoHistory : null;
    if (!h || h.length === 0) { st.evoHistory = buildLineageBackward(cur); return; }
    const last = h[h.length - 1];
    if (last === cur) return;
    if (isEvolutionTarget(last, cur)) h.push(cur);   // 自然進化
    else st.evoHistory = [cur];                       // 斷點 → 重設
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
        meCutInCol: null,      // null = 用動態 settled 落點（依前緣留白後退）；有值則覆寫（滑入動畫）
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
    st.battleEnemy        = chooseBattleEnemy(myId, seed, st.lastBattleEnemy);
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
    // PvP 名牌 label：來自 _pvpOppLabel/_pvpMeLabel（statusline 從 force 帶入）；非 PvP 戰鬥則清空
    st.pvpOppLabel        = st._pvpOppLabel || null;
    st.pvpMeLabel         = st._pvpMeLabel || null;
    st.battleNoCount      = st._battleNoCount || false;   // 跨階 PvP → 這場不計勝率
    delete st._pvpOppLabel; delete st._pvpMeLabel; delete st._battleNoCount;
}

// opts.allowBattle: 是否啟用 Thinking 偵測 / battle 表演（預設 false 給 v4）
function decideAgumon(i, st, now, charDef, opts = {}) {
    const { F, EXPRS, ROAR_FRAMES, TOKEN_RESET_FRAMES, sleepFrames, SLEEP_PERIOD } = charDef;
    const step = Math.floor(now / STEP_MS);
    const allowBattle = !!opts.allowBattle;

    // 每 tick 累積本 session 花費（即使凍結/表演中也累積，避免漏記 cost 高水位）
    updateEvoSpend(st, i);

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
                // 訓練補正：每則新訊息 +1，受階段上限約束（UnStage 無上限）
                // 多視窗 race-safe：每個視窗讀同一 disk 狀態都得到 train+1，最後一個寫的 wins，淨增 +1
                const cap   = getTierCap(getCharacterStage(st.characterId));
                const base  = getCharacterPower(st.characterId);
                const train = st.trainingBonus ?? 0;
                if (base + train < cap) st.trainingBonus = train + 1;
            }
        }
    } catch(e) {}
    if (!st.lastActivityAt) st.lastActivityAt = now;

    if (allowBattle && hookFired) {
        // 新訊息 → 武裝這一回合的自動戰鬥（用 hook ts 當唯一識別，每個 prompt 最多觸發一次）
        st.battleArmHookTs = st.lastHookTs;
    }

    // 自動戰鬥：prompt 後經過 BATTLE_DELAY_MS 仍未開打 → 觸發一次（思考比較久才打）。
    // _noAutoBattle（vpet battle off）可停用；手動 vpet battle 走 _forceBattle 不受影響。
    if (allowBattle && !st._noAutoBattle
        && st.battleArmHookTs && st.battleArmHookTs !== st.battleFiredHookTs
        && !(st.battleStartStep >= 0) && !st.battlePending) {
        if (now - st.battleArmHookTs >= BATTLE_DELAY_MS) {
            st.battlePending     = true;
            st.battleFiredHookTs = st.battleArmHookTs;
        }
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

    // ── Reset 掉落表演（新 starter 空降；優先於 walk/roar，與 evo/battle 互斥）─────────
    if (st.dropStartStep != null && st.dropStartStep >= 0) {
        const targetElapsed = step - st.dropStartStep;
        const prevShown     = st.dropShownElapsed ?? -1;
        const shownElapsed  = Math.min(targetElapsed, prevShown + 1);   // 每拍最多 +1
        if (targetElapsed < 0 || targetElapsed >= DROP_LENGTH + 8) {
            // 殘留清理（跨機/跨重啟）
            st.dropStartStep = -1; st.dropShownElapsed = -1;
        } else if (shownElapsed >= 0 && shownElapsed < DROP_LENGTH) {
            st.dropShownElapsed = shownElapsed;
            return { kind: 'drop', elapsed: shownElapsed };
        } else {
            // 正常結束 → 清掉，從中央接著走（相位對齊，同 battle 結束）
            st.dropStartStep = -1; st.dropShownElapsed = -1;
            st.lastStepSeen = step;
            const PERIOD    = MAX_POS * 2;
            const wantPhase = PERIOD - BATTLE_CENTER_COL;   // pos=center, facing 'left'
            st.walkPhaseOffset = (((wantPhase - step) % PERIOD) + PERIOD) % PERIOD;
        }
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
            st.pvpOppLabel        = null;
            st.pvpMeLabel         = null;
            st.battleNoCount      = false;
        } else if (shownElapsed < length) {
            st.battleShownElapsed = shownElapsed;
            return decideBattleFrame(shownElapsed, st.battleWin, st.battleEnemy, F, useCutIn);
        } else {
            // 正常結束 → 接續 RESULT 的中央位置，從 col 16 朝左開始走
            // 勝率累計：以 battleStartStep 當這場戰鬥的唯一識別，避免多視窗同時偵測到
            // 「結束」而重複加計（同 lastBattleTriggerTs 的思路）。
            // 跨階 PvP（st.battleNoCount）不計勝率；同階/自動/手動戰鬥照常計入
            if (!st.battleNoCount && st.lastBattleCountedStartStep !== st.battleStartStep) {
                st.lastBattleCountedStartStep = st.battleStartStep;
                st.battleTotalCount = (st.battleTotalCount || 0) + 1;
                if (st.battleWin) st.battleWinCount = (st.battleWinCount || 0) + 1;
            }
            st.lastBattleEnemy    = st.battleEnemy;  // 供 anti-stick 用，避免下場連續同敵
            st.battleStartStep    = -1;
            st.battleEnemy        = null;
            st.battleVersion      = 1;
            st.battleShownElapsed = -1;
            st.pvpOppLabel        = null;
            st.pvpMeLabel         = null;
            st.battleNoCount      = false;
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

    // 狀態卡（蓋住睡覺，但 sleep state 不中斷；不阻擋 roar/battle/evo/happy）
    if (st._forceCard) {
        st.cardStartStep = step;
        delete st._forceCard;
    }
    if (st.cardStartStep != null && st.cardStartStep >= 0) {
        const elapsed = step - st.cardStartStep;
        if (elapsed < 0 || elapsed >= CARD_LENGTH) {
            st.cardStartStep = -1;
        } else {
            const dim = (elapsed === 0 || elapsed === CARD_LENGTH - 1);
            return { kind: 'card', dim, pos: 0 };
        }
    }

    // 進化歷程 tree（vpet tree → statusline 顯示；同 card，不阻擋 roar/battle/evo）
    if (st._forceTree) {
        st.treeStartStep = step;
        delete st._forceTree;
    }
    if (st.treeStartStep != null && st.treeStartStep >= 0) {
        const elapsed = step - st.treeStartStep;
        if (elapsed < 0 || elapsed >= TREE_LENGTH) {
            st.treeStartStep = -1;
        } else {
            const dim = (elapsed === 0 || elapsed === TREE_LENGTH - 1);
            return { kind: 'tree', dim, pos: 0 };
        }
    }

    // 強制睡覺（cheat ac --sleep）：持續到 --wake；卡片可在 5 秒內蓋過但 sleep state 不受影響
    if (st._forceSleep) {
        st.wasSleeping = true;
        const idx = SLEEP_PERIOD ? Math.floor(step / SLEEP_PERIOD) % sleepFrames.length : 0;
        const sleepFx = idx === 0 ? 'zsleep1' : 'zsleep2';
        return { kind: 'single', frameIdx: sleepFrames[idx], facing: 'left', pos: st.lastPos ?? 0, sleepFx };
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
    const _branch = gitBranch(cwd);
    if (_branch) {
        gitStr = ` ${GREEN}(${_branch})${R}`;
    }

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

// 黑影 fallback：對手角色本機沒有時（新版才加的角色 / 客製角色 / 資料異常）→
// 用一張現成的幀（通常是 agumon）染成單色剪影當佔位，畫面不破、又切「幽靈對戰」主題。
// 保留透明/半透明結構（-1 維持），存在的像素一律改成 shade 色。
const SILHOUETTE_SHADE = [54, 54, 66];   // 深藍灰
function silhouetteCellRows(rows, shade = SILHOUETTE_SHADE) {
    const [R, G, B] = shade;
    return rows.map(row => row.map(c => {
        if (!c) return null;
        const upOk = c[0] >= 0, loOk = c[3] >= 0;
        return [upOk ? R : -1, upOk ? G : -1, upOk ? B : -1,
                loOk ? R : -1, loOk ? G : -1, loOk ? B : -1];
    }));
}
// 把整張 art（{frames:[...]}）轉成剪影 art，frame 索引維持不變（戰鬥用同一套 IDLE/ATTACK 索引）。
function silhouetteArt(art, shade = SILHOUETTE_SHADE) {
    if (!art || !Array.isArray(art.frames)) return art;
    return { ...art, frames: art.frames.map(f => silhouetteCellRows(f, shade)) };
}
// pixels.json 格式（每幀 flat [r,g,b]|null 陣列）的剪影；給 gen-shadow 從 agumon 產
// Shadow 的可編輯中介檔（editor 角色模式吃 pixels.json）。
function silhouettePixels(pixelsData, shade = SILHOUETTE_SHADE) {
    if (!pixelsData || !Array.isArray(pixelsData.frames)) return pixelsData;
    const [R, G, B] = shade;
    return { ...pixelsData, frames: pixelsData.frames.map(frame => frame.map(px => px ? [R, G, B] : null)) };
}

// 整張 cell rows 做 dim（RGB × factor），用於卡片淡入淡出
function dimCellRows(rows, factor = 0.5) {
    return rows.map(row => row.map(c => {
        if (!c) return null;
        return [
            c[0] >= 0 ? Math.floor(c[0] * factor) : -1,
            c[1] >= 0 ? Math.floor(c[1] * factor) : -1,
            c[2] >= 0 ? Math.floor(c[2] * factor) : -1,
            c[3] >= 0 ? Math.floor(c[3] * factor) : -1,
            c[4] >= 0 ? Math.floor(c[4] * factor) : -1,
            c[5] >= 0 ? Math.floor(c[5] * factor) : -1,
        ];
    }));
}

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

// v2 cut-in settled 位置：兩張各 32 寬，貼在場景兩側 base，再往外「後退」拉開避免交疊。
// 後退量「動態」：依該 cut-in 前緣（面向中央那側）連續透明欄數 blank 決定，
//   retreat = max(0, BATTLE_CUTIN_RETREAT - blank)。
//   → 前段留白已 ≥4 的角色不後退（以原圖自然位置演出）；留白不足者補到共 4 欄的前段淨空。
// 前緣：敵方面左→左緣；我方翻轉面右→右緣（＝原圖左緣，因所有 cut-in 皆左向圖）。
const BATTLE_CUTIN_RETREAT   = 4;                                       // 前段要騰出的總欄數上限
const BATTLE_CUTIN_ME_BASE    = 0;                                     // 我方 base（左側）
const BATTLE_CUTIN_ENEMY_BASE = BATTLE_SCENE_WIDTH - 32;              // 敵方 base（右側）= 20

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

// cell rows 某一側連續「整欄透明」的欄數（fromRight=true 從右緣數，否則左緣）。
// 整欄透明 = 該欄每一列的 cell 皆 null 或上下半都 -1。給 cut-in 動態後退用。
function cutinEdgeBlank(rows, fromRight) {
    if (!rows || !rows.length || !rows[0].length) return 0;
    const W = rows[0].length;
    let n = 0;
    for (let i = 0; i < W; i++) {
        const c = fromRight ? W - 1 - i : i;
        let blank = true;
        for (const row of rows) {
            const cell = row[c];
            if (cell && (cell[0] !== -1 || cell[3] !== -1)) { blank = false; break; }
        }
        if (blank) n++; else break;
    }
    return n;
}
// 依前緣留白算後退量：留白越多退越少，留白 ≥ 上限則不退（0）
function cutinRetreat(rows, fromRight) {
    return Math.max(0, BATTLE_CUTIN_RETREAT - cutinEdgeBlank(rows, fromRight));
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
        const enemyRows = enemyCutInArt.frames[0];   // 敵方面左，前緣=左緣
        // settled 落點動態；滑入動畫(frame.enemyCutInCol 有值)照舊
        const col = frame.enemyCutInCol ?? (BATTLE_CUTIN_ENEMY_BASE + cutinRetreat(enemyRows, false));
        paintCells(buffer, enemyRows, col);
    }
    if (frame.meCutIn && meCutInArt?.frames?.[0]) {
        // 我方需要面右；優先用客製右向（frames[1]），沒有就翻轉左向。前緣=右緣
        const meRows = meCutInArt.frames[1] || flipRows(meCutInArt.frames[0]);
        const col = frame.meCutInCol ?? (BATTLE_CUTIN_ME_BASE - cutinRetreat(meRows, true));
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

    // 編輯器預覽用：回傳原始 cell buffer（52×8），不做 ANSI 化 / 名牌
    if (opts.returnCells) return buffer;

    const lines = renderCells(buffer);

    // PvP 名牌：白字、置於各自角色腳底下（場景最底加一列）。
    // 我方角色固定 col 0-15、敵方 col 36-51，各置中對齊自己的 16-cell 區塊。
    // result（勝負結算）階段收起名牌 → 敵方已離場、我方移到中央，標籤已無對應位置。
    if (frame.phase !== 'result') {
        const cap = captionRow([
            { col: BATTLE_ME_LEFT_COL    + footCenter(opts.meLabel),  label: opts.meLabel  },
            { col: BATTLE_ENEMY_RIGHT_COL + footCenter(opts.oppLabel), label: opts.oppLabel },
        ]);
        if (cap) lines.push(cap);
    }

    return lines;
}

// 名牌置中於 16-cell 角色區塊的左偏移
function footCenter(label) {
    return label ? Math.max(0, Math.floor((16 - dispWidth(label)) / 2)) : 0;
}

// 在場景最底組一列：把多個名牌放到各自欄位（依 col 排序、依顯示寬度避免重疊）
function captionRow(items) {
    const list = items.filter(x => x.label).sort((a, b) => a.col - b.col);
    if (!list.length) return null;
    let line = '', cur = 0;
    for (const { col, label } of list) {
        if (col > cur) { line += '⠀'.repeat(col - cur); cur = col; }
        line += `${WHITE}${label}${R}`;
        cur += dispWidth(label);
    }
    return line;
}

// ── 進化歷程 tree 場景（vpet tree → statusline 顯示）─────────────────
// 1×4 橫排：走過的階段彩色 Idle_1、未到的黑影問號，中間箭頭、下方名字。dim 用於 fade。
const _TREE_STAGE_ORDER = ['Child', 'Adult', 'Perfect', 'Ultimate'];
const _TREE_Q_PAT = [
    '................','....DDDDDDDD....','..DDDDDDDDDDDD..','.DDDWWWWWWWDDDD.',
    '.DDWWDDDDDWWDDD.','.DDDDDDDDDWWDDD.','.DDDDDDDDWWDDDD.','.DDDDDDDWWDDDDD.',
    '.DDDDDDWWDDDDDD.','.DDDDDDWWDDDDDD.','.DDDDDDDDDDDDDD.','.DDDDDDWWDDDDDD.',
    '.DDDDDDWWDDDDDD.','..DDDDDDDDDDDD..','....DDDDDDDD....','................',
];
function _treeQCells() {
    const D = [54, 54, 66], W = [235, 235, 245];
    const px = _TREE_Q_PAT.map(r => [...r].map(c => c === 'D' ? D : c === 'W' ? W : null));
    const rows = [];
    for (let y = 0; y < 16; y += 2) {
        const row = [];
        for (let x = 0; x < 16; x++) {
            const u = px[y][x], l = px[y + 1][x];
            row.push((!u && !l) ? null : [u ? u[0] : -1, u ? u[1] : -1, u ? u[2] : -1, l ? l[0] : -1, l ? l[1] : -1, l ? l[2] : -1]);
        }
        rows.push(row);
    }
    return rows;
}
function _treeIdleCells(name) {
    try {
        const ch  = loadCharacter(name);
        const art = JSON.parse(fs.readFileSync(ch.artFile, 'utf8'));
        const idx = ch.charDef?.F?.IDLE_1 ?? 0;
        return art.frames[idx] || art.frames[0] || null;
    } catch (e) { return null; }
}
function composeTreeScene(st, opts = {}) {
    const dim = !!opts.dim;
    const cur = st.characterId || 'agumon';
    const stageIdx = _TREE_STAGE_ORDER.indexOf(getCharacterStage(cur));
    let reached = (Array.isArray(st.evoHistory) && st.evoHistory.length) ? st.evoHistory.slice() : buildLineageBackward(cur);
    if (reached[reached.length - 1] !== cur) reached.push(cur);
    const qCells = _treeQCells();

    let slots;
    if (stageIdx < 0) slots = [{ name: cur, cells: _treeIdleCells(cur) }];
    else {
        slots = [];
        for (let i = 0; i < 4; i++) {
            if (i <= stageIdx && reached[i]) slots.push({ name: reached[i], cells: _treeIdleCells(reached[i]) });
            else slots.push({ name: '???', cells: qCells });
        }
    }

    const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
    const center16 = s => { s = String(s).slice(0, 16); const l = Math.floor((16 - s.length) / 2); return ' '.repeat(l) + s + ' '.repeat(16 - s.length - l); };
    const blocks = slots.map(sl => renderCells(dim ? dimCellRows(sl.cells || qCells, 0.5) : (sl.cells || qCells)));

    const lines = [];
    for (let r = 0; r < 8; r++) {
        const sep = (r === 3) ? ' → ' : '   ';
        lines.push(blocks.map(b => b[r] || '⠀'.repeat(16)).join(sep));
    }
    lines.push(slots.map(sl => center16(cap(sl.name))).join('   '));
    return lines;
}

// ── 狀態卡合成（左 3 行文字 + 右 CutIn 32 寬，總 52 寬 × 8 高）─────
// dim=true 時整張淡化（RGB×0.5 + 文字 ANSI dim），用於 fade-in/out
function composeStatusCard({ charId, st, cutInArt, dim = false }) {
    const H = 8;
    const TEXT_W = 18;

    // 顯示用 power = my power + trainingBonus，受階段 cap 約束（與戰力公式一致）
    const myPower      = getCharacterPower(charId);
    const myCap        = getTierCap(getCharacterStage(charId));
    const train        = (st && st.trainingBonus) || 0;
    const displayPower = Math.min(myPower + train, myCap);
    const stage        = getCharacterStage(charId);

    // CutIn 32×8 cell（無 CutIn 留空）
    let cutInRows = cutInArt?.frames?.[0]
        ? cutInArt.frames[0]
        : Array.from({ length: H }, () => Array(32).fill(null));
    if (dim) cutInRows = dimCellRows(cutInRows);
    const cutInLines = renderCells(cutInRows);

    const displayName = charId ? charId.charAt(0).toUpperCase() + charId.slice(1) : '';
    // 勝率：勝場 / 總戰鬥場數；0 場顯示 0%（不顯示 NaN）
    const total   = (st && st.battleTotalCount) || 0;
    const wins    = (st && st.battleWinCount) || 0;
    const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;
    const pad = (s) => s + '⠀'.repeat(Math.max(0, TEXT_W - visLen(s)));
    const textRaw = [
        '',
        `Name: ${displayName}`,
        `Power: ${displayPower}`,
        `Stage: ${stage}`,
        `Win Rate: ${winRate}%`,
    ];
    while (textRaw.length < H) textRaw.push('');
    const wrap = dim ? (s) => `\x1b[2m${s}\x1b[0m` : (s) => s;
    const textLines = textRaw.map(s => wrap(pad(s)));

    // text(18) + gap(2) + cutin(32) = 52
    return textLines.map((t, i) => t + '⠀⠀' + (cutInLines[i] || ''));
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

// 把 cell rows 畫到 buffer 的 (row0, col0)，上下左右都裁切（paintCells 只裁 column、固定 row 0）
function paintCellsAt(buffer, rows, row0, col0) {
    if (!rows) return;
    const H = buffer.length, W = buffer[0].length;
    for (let r = 0; r < rows.length; r++) {
        const y = row0 + r;
        if (y < 0 || y >= H) continue;
        for (let c = 0; c < rows[r].length; c++) {
            const x = col0 + c;
            if (x < 0 || x >= W || !rows[r][c]) continue;
            buffer[y][x] = rows[r][c];
        }
    }
}

// 裁出 cell rows 的非空 bounding box（去掉四周空白），回傳 {rows,w,h} 或 null
function trimCells(rows) {
    if (!rows) return null;
    let minR = Infinity, maxR = -1, minC = Infinity, maxC = -1;
    for (let r = 0; r < rows.length; r++)
        for (let c = 0; c < rows[r].length; c++)
            if (rows[r][c]) { if (r < minR) minR = r; if (r > maxR) maxR = r; if (c < minC) minC = c; if (c > maxC) maxC = c; }
    if (maxR < 0) return null;
    const out = [];
    for (let r = minR; r <= maxR; r++) {
        const row = [];
        for (let c = minC; c <= maxC; c++) row.push(rows[r][c] || null);
        out.push(row);
    }
    return { rows: out, w: maxC - minC + 1, h: maxR - minR + 1 };
}

// ── Reset 掉落場景：角色從上方掉入（超出上緣裁切），落地腳下左右噴煙塵 ──
// 煙塵自動裁出 bounding box，貼在角色「輪廓外側」左右腳邊（同一張圖、右側鏡射），
// 否則畫在角色同欄位會被身體蓋住。使用者只要畫一撮煙、放哪都行。
function composeDropScene({ charRows, dustRows, elapsed }) {
    if (!charRows || !charRows.length) return [''];
    const H    = charRows.length;
    const CW   = charRows[0].length;          // 角色寬（通常 16）
    const W    = BATTLE_SCENE_WIDTH;          // 與戰鬥同寬，角色置中（避免靠左）
    const charCol = BATTLE_CENTER_COL;        // 置中欄位（18）
    const buffer  = Array.from({ length: H }, () => Array(W).fill(null));

    // 掉落 y 位移：elapsed 0 → 只露出底部一條（其餘在上緣外被裁）；DROP_FALL → 落定 row 0
    const fall = Math.min(elapsed, DROP_FALL);
    const yOff = -Math.round((H - 1) * (1 - fall / DROP_FALL));   // -(H-1) .. 0
    paintCellsAt(buffer, charRows, yOff, charCol);

    // 落地後（含當拍）噴煙塵：貼角色腳下、左右輪廓外側（左=鏡射、右=原圖）
    const puff = trimCells(dustRows);
    if (elapsed >= DROP_FALL && puff) {
        const top = H - puff.h;                              // 貼底（腳下）
        paintCellsAt(buffer, flipRows(puff.rows), top, charCol - puff.w);  // 左腳（鏡射）
        paintCellsAt(buffer, puff.rows,           top, charCol + CW);      // 右腳（原圖）
    }
    return renderCells(buffer);
}

module.exports = {
    INSTALL_ROOT, STATE_DIR, ASSETS_DIR,
    ANCHOR_GAP,
    BATTLE_LENGTH, BATTLE_LENGTH_V2, BATTLE_SCENE_WIDTH, BATTLE_SCENE_HEIGHT,
    hasCutIn, pickBattleVersion, battleLength,
    EVO_LENGTH,
    DROP_LENGTH,
    decideBattleFrame,
    decideEvoFrame,
    composeEvoScene,
    composeDropScene,
    loadState, saveState, atomicWrite,
    decideAgumon,
    checkEvolution,
    buildStatusLines,
    composeOutput,
    visLen,
    loadCharacter,
    getCharacterStage,
    getCharacterPower,
    getTierCap,
    characterExists,
    isHighTierStarter,
    isEvolutionTarget,
    buildLineageBackward,
    updateEvoHistory,
    computeWinProb,
    winProbFromStr,
    seedRand01,
    chooseBattleEnemy,
    loadShared,
    getSharedFrame,
    renderCells,
    flipRows,
    overlayCells,
    dimCellRows,
    silhouetteCellRows,
    silhouetteArt,
    silhouettePixels,
    characterExists,
    composeSleepScene,
    composeStatusCard,
    composeTreeScene,
    composeBattleScene,
    getFacingRows,
};
