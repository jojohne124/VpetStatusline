'use strict';
// ── PoC 步驟 2：獨立時鐘 daemon ──────────────────────────────────────────────
//
// 目的：證明「把時鐘從 statusLine 指令裡拆出來」可行——本行程自己每秒 tick 一次，
//       跑既有 decideAgumon 表演管線，資料源吃 token-source.js（讀 JSONL），
//       完全不依賴 Claude Code 是否呼叫 statusLine，因此分頁 idle / 背景也照跑。
//       開一個 localhost 頁面即時顯示 pet + 時鐘 + token，肉眼驗證。
//
// ⚠️ PoC 隔離：用「獨立的 daemon-state.json」，不碰真正的 color-state.json，
//    避免跟現有 statusLine 搶寫、污染正式進度。要 discard 只需刪這兩個檔 + 停行程。
//    正式版才需決定「單一寫入者」（daemon 當家或 statusLine 唯讀）。
//
// 用法：node src/daemon/daemon.js        （預設埠 3010，可用 AGUMON_DAEMON_PORT 覆蓋）
//       瀏覽器開 http://localhost:3010

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const { Worker } = require('worker_threads');
const { spawnSync } = require('child_process');

// 優先用「已安裝」的 core（跟 statusLine 同一份權威），抓不到再退回 repo 內。
let core;
const INSTALLED_CORE = path.join(os.homedir(), '.claude', 'agumon-statusline', 'agumon-core.js');
try { core = require(INSTALLED_CORE); }
catch (e) { core = require(path.join(__dirname, '..', 'runtime', 'agumon-core.js')); }

const { computeUsage } = require('./token-source');

const {
    STATE_DIR, EVO_LENGTH, MAX_POS,
    loadState, saveState, decideAgumon, checkEvolution,
    loadCharacter, loadShared, getSharedFrame, isHighTierStarter,
    renderCells, composeSleepScene, composeStatusCard, composeTreeScene,
    getFacingRows, composeBattleScene, composeEvoScene, composeDropScene,
    silhouetteArt, updateEvoHistory,
    applyForceFlags, applyForceTriggers, clearForceCharacter,
    getCharacterStage, computeInheritedPower, resetStageStats, recordAlbumIfChanged,
    alignWalkPhase,
} = core;

// 模式：預設「隔離」(寫 daemon-state.json，不接管、不寫 heartbeat) → 純顯示/PoC，跑了也不影響 statusLine。
//       --authoritative → 「當家」：寫真 color-state.json + 每拍寫 heartbeat，statusLine 偵測到就退唯讀。
//
// daemon-only 安裝（install.js --daemon-only 留下的 DAEMON_ONLY 標記）→ 預設當家。
// 那種環境根本沒有 statusLine 在跑，隔離模式只會寫進沒人讀的 daemon-state.json，
// 使用者會看到「pet 完全不動、指令都沒反應」而找不到原因。--isolated 可強制覆寫回隔離。
const DAEMON_ONLY   = fs.existsSync(path.join(core.INSTALL_ROOT, 'DAEMON_ONLY'));
const AUTHORITATIVE = process.argv.includes('--isolated') ? false
                    : (process.argv.includes('--authoritative') || DAEMON_ONLY);
const STATE_FILE     = path.join(STATE_DIR, AUTHORITATIVE ? 'color-state.json' : 'daemon-state.json');
const HEARTBEAT_FILE = path.join(STATE_DIR, 'daemon-heartbeat.json');
const FORCE_FILE     = path.join(STATE_DIR, 'force-char.json');   // vpet 指令；當家時由 daemon 讀

// release 版 gate：與 statusline-cheat 同一個標記檔。強制戰鬥在 CLI 是開發指令
// （release 只留 battle on/off），UI 按鈕自然也要一致 → release 不顯示、且伺服器端擋掉。
// 只隱藏按鈕是不夠的：/cmd 是公開端點，必須在伺服器端一起擋。
const IS_RELEASE = fs.existsSync(path.join(core.INSTALL_ROOT, 'RELEASE'));
// 與 statusline-cheat.js 的 release gate 對齊（那邊是 blockedCmd / blockedBattle / blockedSwitch）。
// 兩份名單必須一致，否則會出現「按鈕在網頁上看得到、按下去子行程回一句『此版本未提供此指令』」。
const DEV_ONLY   = new Set(['battle', 'evolve', 'stats', 'switch', 'pvp-server']);

// UI 上要露出的快捷鈕（一鍵、不用填參數）。**只影響版面，不影響功能** ——
// 沒列在這裡的指令照樣能用（CLI `vpet <cmd>`，或直接 POST /cmd），只是不佔畫面。
//   摸摸 → 直接點角色就好，按鈕多餘
//   hide/show/pin/unpin → statusline 顯示專屬，daemon 沒有狀態列可隱藏／釘住，不做
// confirm：按下去要先二次確認（重抽會直接換掉現在的桌寵）
// dev: 只在非 release 露出。
// ⚠️ 這是「UI 露不露臉」，跟下面伺服器端的 DEV_ONLY 是兩回事 —— sleep/wake 在 CLI
//    的 release 版是開放的（vpet help 的玩家區就有），所以不能進 DEV_ONLY，否則
//    會變成「終端機打得動、網頁 POST 卻被擋」。這裡只是不把按鈕擺出來。
const UI_BUTTONS = [
    ['card',   '🪪 卡片'],
    ['tree',   '🌳 進化樹'],
    ['album',  '📖 圖鑑'],
    ['sleep',  '😴 睡覺', { dev: true }],
    ['wake',   '☀ 喚醒', { dev: true }],
];

// 進階摺疊區：不常用的開關 + 需要填參數的指令。避免主畫面被塞爆。
//   buttons: 同一列多顆鈕（開/關這種成對的開關）
//   fields : 輸入框；沒有欄位就只有一顆「執行」
//   dev    : 開發限定（release 不露出；若同時列在 DEV_ONLY，伺服器端也會擋）
const UI_FORMS = [
    { label: '🎲 重抽桌寵', action: 'reset', fields: [],
      confirm: '重抽會換掉現在的桌寵，且無法復原。確定嗎？' },
    { label: '🧊 進化凍結', buttons: [['freeze', '凍結'], ['unfreeze', '解除']] },
    { label: '⚔ 自動戰鬥', buttons: [['battleOn', '開'], ['battleOff', '關']] },
    { label: '🩺 doctor',   action: 'doctor',    fields: [] },
    { label: '👻 幽靈對戰', action: 'pvp',       fields: [['name', '對手名牌（留空＝隨機）']] },
    { label: '🏷 名牌',     action: 'code',      fields: [['name', '新名牌（留空＝查看目前）']] },
    { label: '🔧 PvP 設定', action: 'pvp-setup', fields: [['url', 'Worker URL'], ['key', 'API key'], ['name', '名牌（可留空）']] },
    { label: '🔀 切換角色', action: 'switch',    fields: [['name', '角色名或編號']], dev: true },
    { label: '✨ 立即進化', action: 'evolve',    fields: [['name', '進化目標角色名']], dev: true },
    { label: '⚔ 指定戰鬥', action: 'battle',    fields: [['enemy', '敵人（留空＝隨機）'], ['result', 'win / lose（留空＝依機率）']], dev: true },
    { label: '📊 隱藏統計', action: 'stats',     fields: [], dev: true },
];
const PORT           = parseInt(process.env.AGUMON_DAEMON_PORT || '3010', 10);
const STEP_MS        = 1000;

function tryLoadArt(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }

// 走路位移：statusline 靠 aguCol+pos 把角色擺到不同欄；daemon 沒有狀態列，改把角色畫到一個
// 固定寬「舞台」上、左邊墊 pos 個空欄，角色就會左右踱步（pos 0..MAX_POS）。舞台寬固定 →
// canvas 每幀同寬、不抖動。
// 舞台寬度必須是「固定值」，不能算成 MAX_POS + spriteW。
// 睡覺場景經 composeSleepScene 後是 24 欄（角色 16 + Zzz 8），算出來會變 60 欄 = 480px，
// 超過 #stage 的 416px → canvas 的 max-width:100% 把它縮到 86.7%，而 height:auto 讓高度
// 跟著縮成 111px，置中後角色就浮起來約 2 dot（地平線對不上，看起來像飄在半空）。
// 固定 BASE_COLS 後所有 single 場景同寬同高，地平線永遠貼齊 padding 的那 1 dot。
function padWalkStage(rows, pos) {
    if (!rows || !rows.length) return rows;
    const spriteW = rows[0].length;
    const stageW  = Math.max(BASE_COLS, spriteW);
    // 較寬的場景（睡覺）可移動範圍相應變小，避免右緣溢出舞台
    const off     = Math.max(0, Math.min(pos | 0, stageW - spriteW));
    return rows.map(row => {
        const out = new Array(stageW).fill(null);
        for (let c = 0; c < row.length; c++) out[off + c] = row[c];
        return out;
    });
}

// 從 JSONL token-source 合成一份「像 statusLine 輸入」的物件餵給表演管線。
// 只有 cost / session_id 是玩法真正吃的（updateEvoSpend）；其餘為顯示用。
function buildInput(usage) {
    const a = usage.activeSessionUsage;
    // context% 為 PoC 近似（JSONL 不直接帶 context 佔用），用近 10 分鐘 output 粗估，純顯示。
    const ctxApprox = Math.min(95, Math.round((usage.burn10m.output || 0) / 1200));
    return {
        render_width_chars: 120,
        session_id: usage.activeSession || 'daemon',
        cost:  { total_cost_usd: a ? a.costUSD : 0 },
        model: { display_name: 'Claude ⟨daemon⟩' },
        context_window: { used_percentage: ctxApprox },
        cwd: (a && a.cwd) || process.cwd(),
        rate_limits: {},   // JSONL 無 rate-limit % → PoC 顯示 0%（正式版要另接）
    };
}

// 表演分派：忠實複製 statusline-agumon-color.js 的 decide→compose 流程，
// 但拿掉 cheat/force、pids/watchdog（daemon 是常駐單行程，不需要那套孤兒防護）。
// 回傳 { kind, petLines(ANSI array|null) }。狀態列不在這演（daemon 有自己的 token 面板）。
function renderTick(i, st, now) {
    const step = Math.floor(now / STEP_MS);

    // 0. 當家模式：讀 force-char.json 套 vpet 指令（與 statusLine 共用同一份核心邏輯）
    if (AUTHORITATIVE) applyForceFlags(st, FORCE_FILE);

    // 1. 進化 commit（必須在 loadCharacter 之前）
    if (st.evoStartStep != null && st.evoStartStep >= 0) {
        const targetElapsed = step - st.evoStartStep;
        const wouldAdvance  = Math.min(targetElapsed, (st.evoShownElapsed ?? -1) + 1);
        if (wouldAdvance >= EVO_LENGTH) {
            const prevCharId = st.characterId;
            st.characterId = st.evoNextCharId || st.characterId;
            // SU：戰力繼承「進化前基礎 power + 訓練值」（須在 delete trainingBonus 之前算）
            if (getCharacterStage(st.characterId) === 'Super-Ultimate') {
                st.inheritedPower = computeInheritedPower(st, prevCharId);
            } else {
                delete st.inheritedPower;
            }
            st.evoStartStep = -1; st.evoNextCharId = null; st.evoShownElapsed = -1;
            // 走路相位接回表演位置（與 statusline 的 commit 同一套；漏了新角色會瞬移）
            alignWalkPhase(st, step, st.lastPos ?? 0, st.lastFacing);
            delete st.exprStartStep; delete st.roarStartStep; delete st.lastStepSeen; delete st.happyStartStep;
            resetStageStats(st);   // 訓練值/勝率/隱藏統計歸零 + 記錄 lastEvolveAt（與 statusLine 共用）
            if (AUTHORITATIVE) clearForceCharacter(FORCE_FILE);   // 清 force.character 免無限迴圈
        }
    }

    if (!st.characterId) st.characterId = 'agumon';
    const { charDef, artFile, bulletArtFile, cutinArtFile, config } = loadCharacter(st.characterId);
    updateEvoHistory(st);
    recordAlbumIfChanged(st);   // 圖鑑：只在角色變動時碰磁碟

    // 1.5 + 2. force 觸發（drop/強制進化）
    if (AUTHORITATIVE) applyForceTriggers(st, step);

    // 2. 自然進化觸發（freeze 凍結時跳過，與 statusLine 一致）
    if (!(st.evoStartStep >= 0) && !st._freezeEvolve) {
        const nextChar = checkEvolution(st, i, config);
        if (nextChar) {
            st.evoStartStep = step; st.evoNextCharId = nextChar; st.evoShownElapsed = -1;
            st.battleStartStep = -1; st.battleEnemy = null; st.battlePending = false;
            delete st.exprStartStep; delete st.roarStartStep; delete st.happyStartStep;
        }
    }

    const result = decideAgumon(i, st, now, charDef, { allowBattle: true });
    let petLines = null;

    if (result.kind === 'battle') {
        const enemyId = result.enemyId || 'godzilla_1999';
        let enemyChar = null;
        try { enemyChar = loadCharacter(enemyId); } catch (e) {}
        const meArt        = tryLoadArt(artFile);
        let enemyArt       = enemyChar ? tryLoadArt(enemyChar.artFile) : null;
        const meBulletArt  = tryLoadArt(bulletArtFile);
        let enemyBulletArt = enemyChar ? tryLoadArt(enemyChar.bulletArtFile) : null;
        const meCutInArt   = tryLoadArt(cutinArtFile);
        let enemyCutInArt  = enemyChar ? tryLoadArt(enemyChar.cutinArtFile) : null;
        let enemyRightOffset = enemyChar?.charDef?.RIGHT_OFFSET ?? null;
        if (!enemyArt) {   // 黑影 fallback
            let sChar = null; try { sChar = loadCharacter('shadow'); } catch (e) {}
            if (sChar) {
                enemyArt = tryLoadArt(sChar.artFile); enemyBulletArt = tryLoadArt(sChar.bulletArtFile);
                enemyCutInArt = tryLoadArt(sChar.cutinArtFile); enemyRightOffset = sChar?.charDef?.RIGHT_OFFSET ?? null;
            }
            if (!enemyArt) {
                try {
                    const a = loadCharacter('agumon');
                    enemyArt = silhouetteArt(tryLoadArt(a.artFile));
                    enemyBulletArt = silhouetteArt(tryLoadArt(a.bulletArtFile));
                    enemyCutInArt = null; enemyRightOffset = a?.charDef?.RIGHT_OFFSET ?? null;
                } catch (e) {}
            }
        }
        petLines = composeBattleScene({
            frame: result, meArt, enemyArt, meBulletArt, enemyBulletArt, meCutInArt, enemyCutInArt,
            shared: loadShared(), meRightOffset: charDef.RIGHT_OFFSET, enemyRightOffset,
            oppLabel: st.pvpOppLabel || null, meLabel: st.pvpMeLabel || null,
        });
    }
    if (result.kind === 'evo' && !petLines) {
        const charId = result.useNewChar ? st.evoNextCharId : st.characterId;
        let evoChar = null; try { evoChar = loadCharacter(charId); } catch (e) {}
        petLines = composeEvoScene({
            frame: result, charArt: evoChar ? tryLoadArt(evoChar.artFile) : null,
            shared: loadShared(), charRightOffset: evoChar?.charDef?.RIGHT_OFFSET ?? null,
        });
    }
    if (result.kind === 'drop' && !petLines) {
        const art = tryLoadArt(artFile);
        const idle = charDef.F?.IDLE_1 ?? 0;
        const charRows = art ? getFacingRows(art, idle, 'left', charDef.RIGHT_OFFSET) : null;
        const dustName = isHighTierStarter(st.characterId) ? 'dust_hi' : 'dust';
        const dustRows = getSharedFrame(loadShared(), dustName, 0);
        petLines = composeDropScene({ charRows, dustRows, elapsed: result.elapsed });
    }
    if (result.kind === 'card' && !petLines) {
        petLines = composeStatusCard({ charId: st.characterId, st, cutInArt: tryLoadArt(cutinArtFile), dim: result.dim });
    }
    if (result.kind === 'tree' && !petLines) {
        petLines = composeTreeScene(st, { dim: result.dim });
    }
    if (result.kind === 'single' && !petLines) {
        const art = tryLoadArt(artFile);
        if (art) {
            let rows = getFacingRows(art, result.frameIdx, result.facing, charDef.RIGHT_OFFSET);
            if (rows && result.sleepFx) {
                rows = composeSleepScene(rows, getSharedFrame(loadShared(), result.sleepFx, 0));
            }
            if (rows) petLines = renderCells(padWalkStage(rows, result.pos ?? 0));   // 套走路位移
        }
    }

    saveState(STATE_FILE, st);
    // cutIn：只有真正在演 cut-in 的那幾拍才是 true（decideBattleFrame 的 elapsed 0~4），
    // 打鬥過程的拍數不算。前端據此決定要不要塗上下黑邊 —— 用 kind 判斷會整場戰鬥都塗到。
    return { kind: result.kind, petLines, cutIn: !!(result.meCutIn || result.enemyCutIn) };
}

// ── token 掃描：搬到 worker thread，每 5 秒刷新一次，主迴圈只讀快取 ──────────────
// 這是走路跳幀的根治：computeUsage 掃 JSONL ~1.3s > 1s tick，若在主迴圈跑會拖慢每秒
// render → step 跳 2 → 走路跳幀。改由 worker 算、主迴圈讀 cachedUsage（每 tick <10ms）。
function emptyBucket() { return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, tokens: 0, costUSD: 0, messages: 0 }; }
function emptyUsage() {
    return {
        scannedFiles: 0, uniqueMessages: 0, totals: emptyBucket(), byModel: {}, sessions: 0,
        activeSession: null, activeSessionUsage: null, today: emptyBucket(), last5h: emptyBucket(),
        burn10m: emptyBucket(), lastActivityAgoSec: null,
    };
}
let cachedUsage = emptyUsage();
const USAGE_REFRESH_MS = 5000;
function startUsageWorker() {
    let worker;
    try { worker = new Worker(path.join(__dirname, 'token-worker.js')); }
    catch (e) { console.log('   ⚠️ token worker 起不來，退回主迴圈掃描（可能偶爾跳幀）：' + e.message);
                setInterval(() => { try { cachedUsage = require('./token-source').computeUsage({ now: Date.now() }); } catch (e2) {} }, USAGE_REFRESH_MS);
                try { cachedUsage = require('./token-source').computeUsage({}); } catch (e2) {} return; }
    worker.on('message', (m) => { if (m && m.ok && m.usage) cachedUsage = m.usage; });
    worker.on('error', () => {});
    worker.unref();   // 別讓 worker 卡住行程退出
    const req = () => { try { worker.postMessage({ now: Date.now() }); } catch (e) {} };
    req();
    setInterval(req, USAGE_REFRESH_MS).unref();
}
startUsageWorker();

// ── 時鐘 ──
let tick = 0;
let startedAt = Date.now();
let latest = { tick: 0, kind: 'init', petLines: null, usage: null, at: startedAt, err: null };

function doTick() {
    const now = Date.now();
    try {
        const usage = cachedUsage;   // 讀快取，不在主迴圈掃 JSONL → tick 保持輕量、走路不跳幀
        const i  = buildInput(usage);
        const st = loadState(STATE_FILE);
        if (!st.characterId) st.characterId = 'agumon';
        const out = renderTick(i, st, now);
        forceSleeping = !!st._forceSleep;   // 給 petTouch 判斷「叫不動」
        // 當家模式：render 成功才寫 heartbeat → statusLine 據此退唯讀。tick 若拋錯就不更新，
        // heartbeat 4 秒過期 → statusLine 自動接管（daemon 壞掉的 failsafe）。
        if (AUTHORITATIVE) { try { fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({ ts: now, pid: process.pid })); } catch (e) {} }
        latest = {
            tick: ++tick,
            at: now,
            kind: out.kind,
            cutIn: !!out.cutIn,                           // 正在演 cut-in 的拍 → 前端塗黑邊
            petLines: out.petLines,                       // ANSI 陣列（瀏覽器解析）
            usage: {
                activeSession: usage.activeSession,
                activeCostUSD: usage.activeSessionUsage ? usage.activeSessionUsage.costUSD : 0,
                totalCostUSD:  usage.totals.costUSD,
                burn10mTokens: usage.burn10m.tokens,
                burn10mCostUSD: usage.burn10m.costUSD,
                lastActivityAgoSec: usage.lastActivityAgoSec,
                uniqueMessages: usage.uniqueMessages,
                scannedFiles: usage.scannedFiles,
            },
            character: st.characterId,
            err: null,
        };
    } catch (e) {
        latest = Object.assign({}, latest, { tick: ++tick, at: now, err: e.message });
    }
}

doTick();
setInterval(doTick, STEP_MS);   // ← 獨立時鐘：跟 Claude Code 有沒有呼叫指令無關

// 跨行程收屍：平常是每個新啟動的 statusline 在做，但 daemon-only 安裝根本沒部署
// statusline-agumon-color.js → hook 若被凍結成孤兒就沒人清。daemon 是常駐的，補上這一輪。
// 只收屍、不登記自己（長駐行程一登記就會被當成「活著又逾時」的卡死孤兒殺掉）。
// 兩者都在跑時重複收屍無害：判定準則相同，且只殺「確認卡死」的。
const REAP_INTERVAL_MS = 30000;
const PIDS_DIR = path.join(STATE_DIR, 'pids');
setInterval(() => { try { core.reapStalePids(PIDS_DIR); } catch (e) {} }, REAP_INTERVAL_MS);

// ── UI 指令 → force-char.json（跟 vpet CLI 同一個指令通道）───────────────────
// 當家時 daemon 自己讀套用；隔離時 statusLine 讀 → UI 等於「圖形版 vpet 指令」，兩模式皆可用。
// merge 寫入（保留其他欄位），與 statusline-cheat 寫法一致。
function writeForce(patch) {
    let f = {};
    try { f = JSON.parse(fs.readFileSync(FORCE_FILE, 'utf8')); } catch (e) {}
    Object.assign(f, patch);
    try {
        fs.mkdirSync(path.dirname(FORCE_FILE), { recursive: true });
        fs.writeFileSync(FORCE_FILE, JSON.stringify(f));
        return true;
    } catch (e) { return false; }
}
// ── 觸碰互動：正常摸摸 → happy；短時間連戳 → refuse 鬧脾氣 ─────────────────────
// 計數必須在這層（HTTP 收到點擊的當下）做：daemon 每秒才 tick 一次，1 秒內連點好幾下
// 只會被 tick 看到最後一筆 → 放到 tick 層永遠偵測不到連點。
const TOUCH_WINDOW_MS = 3000;   // 判定窗口
const TOUCH_LIMIT     = 5;      // 窗口內達此次數 → 生氣
const SULK_MS         = 3000;   // 生氣後鬧脾氣：這段期間再戳也不理
let touchTimes = [];
let sulkUntil  = 0;
let forceSleeping = false;   // 由每拍的 doTick 更新（vpet sleep 狀態）
function petTouch() {
    const now = Date.now();
    // vpet sleep 強制睡：叫不動。回明確訊息，避免使用者以為點擊壞了；也不累計連戳。
    if (forceSleeping) return { ok: true, action: 'pet', mood: 'asleep' };
    if (now < sulkUntil) return { ok: true, action: 'pet', mood: 'sulking' };   // 鬧脾氣中，不回應
    touchTimes = touchTimes.filter(t => now - t < TOUCH_WINDOW_MS);
    touchTimes.push(now);
    let mood = 'happy';
    if (touchTimes.length >= TOUCH_LIMIT) {
        mood = 'refuse';
        sulkUntil  = now + SULK_MS;
        touchTimes = [];
    }
    writeForce({ petTriggerTs: now, petMood: mood });
    return { ok: true, action: 'pet', mood };
}

const COMMANDS = {
    battle:    () => ({ battleTriggerTs: Date.now() }),
    card:      () => ({ cardTriggerTs:   Date.now() }),
    tree:      () => ({ treeTriggerTs:   Date.now() }),
    drop:      () => ({ dropTriggerTs:   Date.now() }),   // 空降演出（非真 reset 抽角色）
    sleep:     () => ({ forceSleep: true }),
    wake:      () => ({ forceSleep: false }),
    freeze:    () => ({ freezeEvolve: true }),
    unfreeze:  () => ({ freezeEvolve: false }),
    battleOff: () => ({ autoBattleOff: true }),
    battleOn:  () => ({ autoBattleOff: false }),
};
// ── 需要參數／需要輸出／不只是寫 force 的指令 → 轉呼叫 vpet CLI 子行程 ────────────
// 為什麼不在 daemon 重寫一份：reset 的加權抽選、pvp 的連線、doctor 的行程掃描，
// 邏輯都在 statusline-cheat.js（567 行的 top-level if-chain，不是函式庫）。抄一份過來
// 就會變成兩套實作，改一邊忘一邊 → 「終端機打 vpet reset 和網頁按重抽，抽到的不一樣」。
// 這個 repo 已經吃過複製品分叉的虧（進化 commit 兩份，害相位重對齊漏了一邊）。
// 代價是每次多開一個 node 行程（實測約 140ms）—— 這些都是低頻操作，按鈕感覺不出來。
//
// 安全性：/cmd 是 localhost 公開端點。用陣列形式 spawn（不經 shell）→ 參數不會被當指令解析；
// action 一律走白名單，只有下面 CLI_ACTIONS 列出的能執行。
const CHEAT_CLI = path.join(core.INSTALL_ROOT, 'statusline-cheat.js');
const CLI_TIMEOUT_MS = 15000;   // doctor 掃行程可能久一點；卡住就中止，不要吊死 HTTP

// action → 組出 CLI 參數。回 null = 參數不合法。
const CLI_ACTIONS = {
    reset:       ()  => ['reset'],
    album:       ()  => ['album'],
    doctor:      ()  => ['doctor', '--check'],   // 只診斷不清，避免網頁一按就殺行程
    stats:       ()  => ['stats'],
    pvp:         (a) => a.name ? ['pvp', a.name] : ['pvp'],
    code:        (a) => a.name ? ['code', a.name] : ['code'],
    'pvp-setup': (a) => (a.url && a.key) ? ['pvp-setup', a.url, a.key, ...(a.name ? [a.name] : [])] : null,
    switch:      (a) => a.name ? [a.name] : null,          // 裸角色名/編號
    evolve:      (a) => a.name ? ['evolve', a.name] : null,
    battle:      (a) => ['battle', ...(a.enemy ? [a.enemy] : []), ...(a.result ? [a.result] : [])],
};

function runCli(args) {
    const r = spawnSync(process.execPath, [CHEAT_CLI, ...args],
                        { encoding: 'utf8', timeout: CLI_TIMEOUT_MS, windowsHide: true });
    if (r.error) return { ok: false, error: `執行失敗：${r.error.message}` };
    const out = ((r.stdout || '') + (r.stderr || '')).trim();
    // CLI 用 exit code 1 表示「找不到角色 / 此版本未提供」之類的拒絕，輸出仍要帶回去給使用者看
    return { ok: r.status === 0, output: out || '(無輸出)' };
}

function applyCommand(action, args = {}) {
    if (IS_RELEASE && DEV_ONLY.has(action)) return { ok: false, error: '此版本未提供此指令' };
    if (action === 'pet') return petTouch();   // 觸碰要即時計數，走專用路徑

    // 快路徑：純粹寫一個旗標的指令直接寫 force，省掉 140ms 的行程開銷。
    // 這些在 CLI 那邊也只是寫同樣的欄位，沒有額外邏輯，不會分叉。
    const fn = COMMANDS[action];
    if (fn) return { ok: writeForce(fn()), action };

    const build = CLI_ACTIONS[action];
    if (!build) return { ok: false, error: 'unknown action: ' + action };
    const argv = build(args || {});
    if (!argv) return { ok: false, error: '參數不足' };
    return Object.assign({ action }, runCli(argv));
}

// ── HTTP 顯示層 ──
// 畫布格點：每個終端字元 = 1px 寬 × 2px 高（▀ 把字元切成上/下兩個像素）。
// 要像素方正 → CH = 2×CW，否則每個半格 8×4 會把角色壓扁。CW=8 → 半格 8×8 方正。
// BASE_COLS/BASE_ROWS = 一般表演的尺寸，用來當舞台底盤的下限（見 #stage 的說明）：
//   走路 52×8、卡片 52×8、戰鬥 52×8（BATTLE_SCENE_WIDTH/HEIGHT）都是這個大小，
//   進化表演只有 16×8（比較小 → 置中），進化樹 35~92×9（比較大 → 撐寬底盤）。
// 這些值同時給 CSS 與前端 JS 用，只有這一份，不要在下面的 <script> 裡另外寫死。
const CW = 8, CH = 16;
const BASE_COLS = 52, BASE_ROWS = 8;
const PAD_DOTS  = 1;    // 舞台上下各留幾個 dot（1 dot = 半格 = CH/2 px）

// 舞台底圖（選配）。放了就當灰白面板用，沒放就維持原本的深灰純色。
const BG_FILE   = path.join(core.INSTALL_ROOT, 'bg.png');
const HAS_BG    = fs.existsSync(BG_FILE);

const HTML = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>Vpet daemon</title>
<style>
  body{background:#0d1117;color:#c9d1d9;font-family:ui-monospace,Consolas,monospace;margin:0;padding:20px}
  h1{font-size:15px;color:#58a6ff;margin:0 0 12px}
  #wrap{display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start}
  /* 深灰而非純黑：角色有黑色描邊，純黑背景會讓輪廓糊掉分不出來 */
  #petbox{background:rgb(30,30,30);border:1px solid #444c56;border-radius:8px;padding:12px;image-rendering:pixelated;max-width:100%;overflow:hidden}
  /* 舞台底線：canvas 每幀依內容大小重建，直接放進 petbox 會讓深灰底盤忽大忽小
     （最明顯的是進化表演只有 16 字元寬，底盤瞬間縮到三分之一）。
     用 min-width/min-height 釘住一般表演的尺寸（52×8 = 走路／卡片／戰鬥），
     canvas 維持原生大小置中；只有進化樹（35~92×9）需要時才把底盤撐寬。
     不用固定 width：那會讓一般表演永遠佔著五格進化樹的寬度，版面太空。 */
  /* width:fit-content 是關鍵 —— #stage 是 block，預設會撐滿 #petbox 的內容寬，
     而 #petbox 是 #wrap（flex + wrap）的項目，可用寬度隨視窗變動 → 舞台跟著變寬變窄，
     底圖是 center/cover，寬度一動就重新裁切，看起來就是「拉視窗背景會微微變」。
     改成 fit-content 後舞台只跟內容走：一般表演固定 min-width，只有進化樹才撐寬。
     也刻意不留 max-width:100% —— 那會在窄視窗把 canvas 縮小，地平線又會對不上
     （就是先前睡覺角色浮起來那個 bug）。窄到放不下就由 #petbox 的 overflow:hidden 裁掉。 */
  #stage{width:fit-content;min-width:${BASE_COLS * CW}px;min-height:${BASE_ROWS * CH}px;
         /* 上下各留 ${PAD_DOTS} dot（1 dot = 半格 = ${CH / 2}px）。用 padding 而不是墊高 min-height，
            這樣進化樹那種比較高的場景也一樣有留白，不會頂到邊。底圖會鋪滿含 padding 的範圍。 */
         padding:${PAD_DOTS * (CH / 2)}px 0;
         position:relative;
         display:flex;align-items:center;justify-content:center;
         border-radius:4px;overflow:hidden;${HAS_BG ? `
         /* 灰白面板（比照原版）：底圖已在 make-bg.js 壓好亮度帶，這裡不再加濾鏡。
            要現場微調就在 devtools 加 filter，定案後回去改 make-bg.js 的 lo/hi 重烘。 */
         background:#d2d2d2 url(/bg) center/cover;` : ''}}
  canvas{image-rendering:pixelated;display:block;cursor:pointer;max-width:100%;height:auto}
  /* 黑邊：只蓋上下那 ${PAD_DOTS} dot 的留白，不動中間 —— 這樣戰鬥的非 cut-in 拍
     仍然看得到底圖，只有邊緣被收乾淨。用偽元素而不是換整片 background，
     否則整個舞台會變黑、底圖在戰鬥期間整段消失。 */
  #stage.letterbox::before,#stage.letterbox::after{
    content:'';position:absolute;left:0;right:0;height:${PAD_DOTS * (CH / 2)}px;background:#000;z-index:1}
  #stage.letterbox::before{top:0} #stage.letterbox::after{bottom:0}
  .panel{font-size:13px;line-height:1.7}
  .k{color:#8b949e} .v{color:#e6edf3;font-weight:600}
  .big{font-size:22px;color:#3fb950}
  .warn{color:#d29922}
  pre{margin:6px 0 0;color:#8b949e;font-size:12px;white-space:pre}
  .badge{display:inline-block;padding:1px 8px;border-radius:10px;background:#1f6feb;color:#fff;font-size:12px}
  /* 按鈕列暫時隱藏（試乾淨版面）。要拿回來：把 display:none 改成 flex。
     隱藏不影響功能——按鈕仍在 DOM、事件照綁，點角色摸摸也照常運作。 */
  #controls{display:flex;margin-top:10px;gap:6px;flex-wrap:wrap;max-width:480px}
  #controls button{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer}
  #controls button:hover{background:#30363d;border-color:#8b949e}
  /* 提示字 3 秒後淡出；min-height 保留讓版面不會跳動 */
  #cmdmsg{margin-top:6px;min-height:16px;color:#3fb950;font-size:12px;opacity:0;transition:opacity .5s}
  /* 進階區：要填參數的指令。預設收起，避免主畫面被塞爆 */
  #adv{margin-top:8px;max-width:480px}
  #adv summary{cursor:pointer;color:#8b949e;font-size:12px;user-select:none}
  #adv summary:hover{color:#c9d1d9}
  .form{display:flex;gap:4px;align-items:center;margin-top:6px;flex-wrap:wrap}
  .form .lbl{font-size:12px;color:#8b949e;min-width:74px}
  .form input{background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:5px;
              padding:3px 7px;font:inherit;font-size:12px;width:120px}
  .form input:focus{outline:none;border-color:#58a6ff}
  .form button{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:5px;
               padding:3px 9px;font:inherit;font-size:12px;cursor:pointer}
  .form button:hover{background:#30363d;border-color:#8b949e}
  .devtag{color:#d29922;font-size:11px}
  /* 指令輸出：子行程的 stdout 原樣顯示（doctor / stats / code 這種有回應的） */
  #cmdout{margin-top:8px;max-width:480px;display:none;background:#0d1117;border:1px solid #30363d;
          border-radius:6px;padding:8px 10px;font-size:12px;color:#c9d1d9;
          white-space:pre-wrap;word-break:break-all;max-height:260px;overflow:auto}
</style></head><body>
<h1>🥚 Vpet daemon</h1>
<div id="wrap">
  <div id="petbox"><div id="stage"><canvas id="pet" width="480" height="200"></canvas></div>
    <div id="controls">
      ${UI_BUTTONS.filter(([c, , o]) => !(IS_RELEASE && ((o && o.dev) || DEV_ONLY.has(c))))
                  .map(([c, label, o]) => `<button data-cmd="${c}"${o && o.confirm ? ` data-confirm="${o.confirm}"` : ''}>${label}${o && o.dev ? ' <span class="devtag">dev</span>' : ''}</button>`)
                  .join('\n      ')}
    </div>
    <div id="cmdmsg"></div>
    <details id="adv"><summary>⚙ 進階指令</summary>
      ${UI_FORMS.filter(f => !(IS_RELEASE && (f.dev || DEV_ONLY.has(f.action))))
                .map(f => `<div class="form"${f.action ? ` data-cmd="${f.action}"` : ''}>
        <span class="lbl">${f.label}${f.dev ? ' <span class="devtag">dev</span>' : ''}</span>
        ${(f.fields || []).map(([k, ph]) => `<input data-f="${k}" placeholder="${ph}">`).join('')}
        ${f.buttons ? f.buttons.map(([a, t]) => `<button data-cmd="${a}">${t}</button>`).join('')
                    : `<button${f.confirm ? ` data-confirm="${f.confirm}"` : ''}>執行</button>`}
      </div>`).join('\n      ')}
    </details>
    <div id="cmdout"></div></div>
  <div class="panel">
    <div>daemon tick：<span class="big" id="tick">–</span> <span class="badge" id="kind">–</span></div>
    <div class="k">（背景／切走這個分頁再回來，tick 仍持續跳 = 時鐘不依賴前景）</div>
    <div style="height:10px"></div>
    <div><span class="k">角色：</span><span class="v" id="char">–</span></div>
    <div><span class="k">daemon uptime：</span><span class="v" id="uptime">–</span></div>
    <div><span class="k">此頁距上次抓取：</span><span class="v" id="fetchAge">–</span></div>
    <div style="height:10px"></div>
    <div class="k">── JSONL token 資料源 ──</div>
    <div><span class="k">活躍 session：</span><span class="v" id="asess">–</span></div>
    <div><span class="k">本 session cost：</span><span class="v" id="acost">–</span></div>
    <div><span class="k">全域 cost：</span><span class="v" id="tcost">–</span></div>
    <div><span class="k">近 10m burn：</span><span class="v" id="burn">–</span></div>
    <div><span class="k">最近活躍：</span><span class="v" id="lastact">–</span></div>
    <div><span class="k">掃描：</span><span class="v" id="scan">–</span></div>
    <div class="warn" id="err"></div>
  </div>
</div>
<script>
const CW=${CW}, CH=${CH};   // 由伺服器端同一組常數帶入（見 daemon.js 頂部）
function parseAnsi(line){
  // 回傳每個 cell：半格 {top,bot}、真文字 {ch,col}（卡片數值/PvP名牌）、空白 null。
  const cells=[]; let fg=null,bg=null,idx=0;
  while(idx<line.length){
    if(line[idx]==='\\x1b'){
      const m=/^\\x1b\\[([0-9;]*)m/.exec(line.slice(idx));
      if(m){
        const parts=m[1].split(';').map(Number);
        if(m[1]===''||parts[0]===0){fg=null;bg=null;}
        else if(parts[0]===38&&parts[1]===2){fg=[parts[2],parts[3],parts[4]];}
        else if(parts[0]===48&&parts[1]===2){bg=[parts[2],parts[3],parts[4]];}
        idx+=m[0].length; continue;
      }
    }
    const ch=line[idx];
    if(ch==='▀'){cells.push({top:fg,bot:bg});}
    else if(ch==='▄'){cells.push({top:null,bot:fg});}
    else if(ch==='⠀'||ch===' '){cells.push(null);}   // 空白
    else {cells.push({ch:ch,col:fg});}               // 真文字（半格以外一律當文字畫）
    idx++;
  }
  return cells;
}
function draw(petLines){
  const cv=document.getElementById('pet'),ctx=cv.getContext('2d');
  ctx.clearRect(0,0,cv.width,cv.height);
  if(!petLines){return;}
  const rows=petLines.map(parseAnsi);
  const maxW=Math.max(0,...rows.map(r=>r.length));
  cv.width=Math.max(1,maxW*CW); cv.height=Math.max(1,rows.length*CH);
  ctx.textBaseline='top'; ctx.font='13px ui-monospace, Consolas, monospace';
  // 半格像素
  for(let r=0;r<rows.length;r++){
    for(let c=0;c<rows[r].length;c++){
      const cell=rows[r][c]; if(!cell||cell.ch!==undefined)continue;
      const x=c*CW,y=r*CH;
      if(cell.top){ctx.fillStyle='rgb('+cell.top.join(',')+')';ctx.fillRect(x,y,CW,CH/2);}
      if(cell.bot){ctx.fillStyle='rgb('+cell.bot.join(',')+')';ctx.fillRect(x,y+CH/2,CW,CH/2);}
    }
  }
  // 文字（卡片欄位 / 進化樹名稱 / PvP 名牌）：整段一起畫，再水平縮放到剛好 = 該段格數×CW。
  // 逐字 fillText 會壞掉：格距只有 8px，但 13px 字型的字寬更寬 → 互相擠壓，
  // 且最後一個字會超出 canvas 右緣被切掉（進化樹名字被截就是這個原因）。
  const colOf = c => c && c.col ? 'rgb('+c.col.join(',')+')' : '#c9d1d9';
  for(let r=0;r<rows.length;r++){
    let c=0;
    while(c<rows[r].length){
      const cell=rows[r][c];
      if(!cell||cell.ch===undefined){c++;continue;}
      const start=c, style=colOf(cell);
      let txt='';
      while(c<rows[r].length){
        const k=rows[r][c];
        if(!k||k.ch===undefined||colOf(k)!==style)break;   // 換色就斷段
        txt+=k.ch; c++;
      }
      const target=(c-start)*CW;
      const w=ctx.measureText(txt).width;
      ctx.save();
      ctx.translate(start*CW, r*CH+1);
      if(w>0)ctx.scale(target/w,1);        // 精準塞進格子寬度
      ctx.fillStyle=style;
      // 深色 halo：卡片欄位與進化樹名字都沒帶 ANSI 顏色，走的是預設淺灰 —— 那是為
      // 深色底盤挑的，一旦鋪了灰白底圖就等於隱形。描邊讓文字在任何亮度的底圖上都讀得到。
      // shadowBlur 走裝置座標、不受上面的水平 scale 影響；連畫兩次是為了把 halo 加厚
      // （單次的 alpha 太淡壓不住亮底），最後一次關掉 shadow 畫出乾淨的字面。
      ctx.shadowColor='rgba(0,0,0,.95)'; ctx.shadowBlur=4;
      ctx.fillText(txt,0,0);
      ctx.fillText(txt,0,0);
      ctx.shadowBlur=0; ctx.shadowColor='transparent';
      ctx.fillText(txt,0,0);
      ctx.restore();
    }
  }
}
let lastFetch=Date.now();
async function poll(){
  try{
    const s=await (await fetch('/state',{cache:'no-store'})).json();
    lastFetch=Date.now();
    document.getElementById('tick').textContent='#'+s.tick;
    document.getElementById('kind').textContent=s.kind;
    // cut-in 想吃滿整個畫面，上下那 1 dot 留白會透出底圖，看起來像沒對齊 → 塗黑當黑邊。
    // 戰鬥只在真正演 cut-in 的那幾拍套（打鬥過程不套，那時留白透出底圖是正常的）；
    // 卡片右半整片都是 CutIn 圖，所以整段顯示期間都套。
    document.getElementById('stage').classList.toggle('letterbox', !!s.cutIn || s.kind==='card');
    document.getElementById('char').textContent=s.character;
    document.getElementById('uptime').textContent=Math.round(s.uptimeSec)+'s';
    draw(s.petLines);
    const u=s.usage||{};
    document.getElementById('asess').textContent=(u.activeSession||'–').slice(0,8);
    document.getElementById('acost').textContent='$'+(u.activeCostUSD||0).toFixed(4);
    document.getElementById('tcost').textContent='$'+(u.totalCostUSD||0).toFixed(2);
    document.getElementById('burn').textContent=(u.burn10mTokens||0).toLocaleString()+' tok / $'+(u.burn10mCostUSD||0).toFixed(4);
    document.getElementById('lastact').textContent=(u.lastActivityAgoSec==null?'?':u.lastActivityAgoSec+'s 前');
    document.getElementById('scan').textContent=(u.scannedFiles||0)+' 檔 / '+(u.uniqueMessages||0).toLocaleString()+' unique msg';
    document.getElementById('err').textContent=s.err?('⚠️ '+s.err):'';
  }catch(e){document.getElementById('err').textContent='fetch fail: '+e.message;}
}
// 提示字 3 秒後自動淡出（每次新訊息都重設計時，連續操作不會被前一則的倒數提前清掉）
let cmdMsgTimer=null;
function flashCmdMsg(text,color){
  const el=document.getElementById('cmdmsg');
  el.textContent=text; el.style.color=color; el.style.opacity='1';
  if(cmdMsgTimer)clearTimeout(cmdMsgTimer);
  cmdMsgTimer=setTimeout(()=>{ el.style.opacity='0'; },3000);
}
// 子行程的輸出是給終端機看的，帶 ANSI 色碼 → 網頁顯示前先剝掉
const stripAnsi = s => String(s).replace(/\[[0-9;]*[A-Za-z]/g,'');
function showOutput(text){
  const el=document.getElementById('cmdout');
  if(!text){ el.style.display='none'; return; }
  el.textContent=stripAnsi(text); el.style.display='block';
}
async function sendCmd(action,args){
  try{
    const r=await (await fetch('/cmd',{method:'POST',headers:{'Content-Type':'application/json'},
                                       body:JSON.stringify({action,args:args||{}})})).json();
    const MOOD={happy:'摸摸 ♥',refuse:'牠生氣了！別一直戳',sulking:'鬧脾氣中…不理你',asleep:'牠睡死了，叫不動（vpet wake 才會醒）'};
    flashCmdMsg(r.ok ? (MOOD[r.mood] || ('已送出：'+action)) : ('失敗：'+(r.error||action)),
                r.ok ? ((r.mood==='refuse'||r.mood==='sulking')?'#d29922':'#3fb950') : '#f85149');
    // 有回應文字的指令（doctor / stats / code / reset…）把 CLI 輸出原樣秀出來；
    // 失敗時也要顯示 —— 「找不到角色」那種訊息正是使用者需要看到的
    showOutput(r.output || r.error || '');
  }catch(e){ flashCmdMsg('送出失敗：'+e.message,'#f85149'); }
}
document.querySelectorAll('#controls button').forEach(b=>b.addEventListener('click',()=>{
  const c=b.dataset.confirm;
  if(c && !confirm(c)) return;      // 破壞性操作（重抽）先問一次
  sendCmd(b.dataset.cmd);
}));
// 進階區：把該列的輸入框收成 {欄位:值} 一起送出。
// 一列可以有多顆鈕（開/關成對的開關）→ 動作優先取按鈕自己的 data-cmd，沒有才用整列的。
document.querySelectorAll('#adv .form').forEach(row=>{
  const collect=()=>{
    const args={};
    row.querySelectorAll('input').forEach(i=>{ if(i.value.trim()) args[i.dataset.f]=i.value.trim(); });
    return args;
  };
  row.querySelectorAll('button').forEach(b=>
    b.addEventListener('click',()=>{
      const c=b.dataset.confirm;
      if(c && !confirm(c)) return;    // 破壞性操作（重抽）先問一次
      sendCmd(b.dataset.cmd||row.dataset.cmd,collect());
    }));
  row.querySelectorAll('input').forEach(i=>
    i.addEventListener('keydown',e=>{ if(e.key==='Enter')sendCmd(row.dataset.cmd,collect()); }));
});
document.getElementById('pet').addEventListener('click',()=>sendCmd('pet'));   // 點角色＝摸摸（連戳會生氣）
setInterval(()=>{document.getElementById('fetchAge').textContent=Math.round((Date.now()-lastFetch)/1000)+'s';},250);
setInterval(poll,500); poll();
</script></body></html>`;

const server = http.createServer((req, res) => {
    // 舞台底圖：使用者自己放的圖（scripts/make-bg.js 產出）。沒放就 404，CSS 退回純色。
    // 刻意不內嵌進 js、也不隨 release 出貨 —— 底圖是個人化的東西，每個人的照片不一樣，
    // 塞進 repo 只會讓 daemon.js 或 release 無謂變肥。
    if (req.url === '/bg') {
        try {
            const buf = fs.readFileSync(BG_FILE);
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
            res.end(buf);
        } catch (e) {
            res.writeHead(404); res.end();
        }
        return;
    }
    if (req.url === '/state') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(Object.assign({}, latest, { uptimeSec: (Date.now() - startedAt) / 1000 })));
        return;
    }
    if (req.method === 'POST' && req.url === '/cmd') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
        req.on('end', () => {
            let action = '', args = {};
            try {
                const j = JSON.parse(body);
                action = j.action;
                // 只收字串欄位，長度設限 —— /cmd 是公開端點，別讓瀏覽器塞奇怪東西進 argv
                if (j.args && typeof j.args === 'object') {
                    for (const k of Object.keys(j.args)) {
                        const v = j.args[k];
                        if (typeof v === 'string' && v.length <= 200) args[k] = v.trim();
                    }
                }
            } catch (e) {}
            const r = applyCommand(action, args);
            res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(r));
        });
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
});
server.listen(PORT, () => {
    console.log(`🥚 agumon daemon 已啟動  [${AUTHORITATIVE ? '當家 authoritative' : '隔離 isolated'}]`
        + (DAEMON_ONLY ? '  (daemon-only 安裝 → 預設當家)' : ''));
    console.log(`   時鐘：每 ${STEP_MS}ms tick 一次（獨立於 Claude Code）`);
    if (AUTHORITATIVE) {
        console.log(`   ⚠️ 當家模式：寫真 ${STATE_FILE} + heartbeat，statusLine 會退唯讀`);
    } else {
        console.log(`   state：${STATE_FILE}（隔離，不碰正式 color-state.json，跑了不影響 statusLine）`);
    }
    console.log(`   開啟：http://localhost:${PORT}`);
});
