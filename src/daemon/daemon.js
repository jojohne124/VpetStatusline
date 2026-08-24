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
const plaza = require('./plaza');   // 廣場／院子的合成器（走路在 ../shared/plaza-walk.js）
const PW    = require('../shared/plaza-walk.js');   // 拍子換算（摸摸要把停走的拍數扣掉）
const YT    = require('./yard-touch');              // 牧場摸摸的狀態機（輪詢間隔也從這裡取）
const WX    = require('../shared/weather.js');
const wxSrc = require('./weather-source.js');

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
// scope：這顆鈕在哪個畫面出現。'home' = 只在前線、'both' = 兩邊都有。
// 前線的鈕多半是對「現役那一隻」下指令（卡片、進化樹、睡覺…），在牧場畫面按了
// 只會影響一隻根本沒顯示在畫面上的桌寵 —— 那比按鈕消失更難懂。
const UI_BUTTONS = [
    ['card',   '🪪 卡片'],
    ['tree',   '🌳 進化樹'],
    ['album',  '📖 圖鑑', { scope: 'both' }],
    ['yard',   '🐮 牧場', { scope: 'both' }],
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
    { label: '📋 牧場清單', action: 'ranch',     fields: [], scope: 'both' },
    { label: '📥 收進牧場', action: 'keep',      fields: [], scope: 'both',
      confirm: '會把現役收進牧場，並抽一隻新的桌寵。收進去的隨時可以換回來。確定嗎？' },
    { label: '🔄 換出牧場', action: 'swap',      fields: [['which', '編號或角色名']], scope: 'both' },
    { label: '🗑 放生',     action: 'release',   fields: [['which', '編號或角色名']], scope: 'both',
      confirm: '放生會**永久刪除**那一隻，救不回來。確定嗎？' },
    { label: '🖼 舞台底圖', action: 'bg',        fields: [] },
    { label: '🩺 doctor',   action: 'doctor',    fields: [], scope: 'both' },
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
// 當初是走路跳幀的根治：computeUsage 整份重掃 JSONL 要 ~2.1s > 1s tick，
// 在主迴圈跑會拖慢每秒 render → step 跳 2 → 走路跳幀。
//
// token-source 改成增量掃描之後（2026-08-24），單次已經降到 ~4ms，
// 主迴圈其實跑得動了 —— 但 worker 保留：冷啟動那一次仍要 ~1.5s，而且「掃描多久」
// 取決於使用者累積了多少 transcript，不該由主迴圈去賭那個數字。
// 主迴圈永遠只讀 cachedUsage。
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
// 院子用的走路快取（key -> 走到第幾拍的快照）。長駐在 daemon 上，不必每次請求重播。
const yardCaches = new Map();


// 院子的拍子與家裡的不同（750ms vs 1000ms），而且不依賴 daemon 的 tick 計數 ——
// 用牆鐘算，重開 daemon 也接得上，日後接共用廣場時同一條式子還要加上 serverNow 校正。
const plazaStep = () => require('../shared/plaza-walk.js').stepAt(Date.now());

// 天氣。daemon 唯一的對外連線（見 weather-source.js 開頭的規則）——
// get() 永遠立刻回傳快取，需要更新時在背景抓，/yard 這條路徑不等網路。
const weather = wxSrc.create({
    installRoot: core.INSTALL_ROOT,
    stateDir:    STATE_DIR,
    log:         (m) => console.log('   ' + m),
});
// 天氣預覽：?w=rain 之類的參數強制指定，讓五種表演不用等真的下雨才看得到。
// 只影響回傳的畫面，不寫進任何檔案，也不影響真實天氣的抓取。
function weatherFor(q) {
    const real = weather.get();
    // 開發專屬。跟其他 dev 功能同一條規矩：只把 UI 藏起來是不夠的，
    // /yard 是公開端點，伺服器端必須一起擋，否則 release 版照樣能用網址切天氣。
    if (!q || IS_RELEASE) return real;
    // 分隔符同時吃 + 與空白：查詢字串的 + 本來就會被解碼成空白，
    // 直接在網址列手打 ?w=clear+cold 的人不該踩到這個坑。
    //
    // 不規定順序、也不規定一定要指定天空：cold 是**獨立旗標**，跟任何天空都能組。
    // 現實中「陰・寒流」「雨・寒流」才是台灣冬天的常態，晴・寒流反而少見 ——
    // 預覽若只給幾個寫死的組合，等於把資料模型講錯了。
    //   ?w=cold       → 真實天空 + 強制寒流
    //   ?w=rain+cold  → 雨 + 寒流（順序隨意）
    const parts = String(q).trim().toLowerCase().split(/[+ ]+/).filter(Boolean);
    const sky   = parts.find(x => WX.SKY_ORDER.includes(x)) || null;
    const cold  = parts.includes('cold');
    if (!sky && !cold) return real;   // 看不懂的參數一律忽略
    return { ...real, sky: sky || real.sky, cold, preview: true };
}

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
                // 各來源小計（Claude Code / Codex…）。totals 是合計 —— 桌寵的「花費」
                // 語意是「你在所有 AI 上燒了多少」，面板要能看出是誰貢獻的。
                bySource: Object.fromEntries(
                    Object.entries(usage.bySource || {}).map(([k, b]) => [k, b.costUSD])),
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

// ── 補一輪「看作業系統行程表」的收屍 ──────────────────────────────────────
// 上面那輪只看 state/pids/ 這份登記表，而**有一整類孤兒不在登記表裡**：
//
//   statusline 的 watchdog 8 秒後呼叫 process.exit(0)，'exit' handler 會刪掉自己的
//   pid 檔（deregister）—— 但如果它在那之後卡在收尾出不去（多半是往已經斷掉的 stdout
//   flush），行程就活著、登記卻已經撤銷。實測這種孤兒的樣貌是 **1 個執行緒、0 CPU、
//   working set 0**：worker 執行緒都拆光了，只剩主執行緒卡住。
//   一台開機 126 小時的機器上累積了 20 個，約每天 4 個。
//
// 換句話說：登記是由「快死的行程自己」撤銷的，一旦死到一半卡住就從名單上消失。
// 唯一看得到它們的是作業系統行程表 —— 那正是 doctor 在做的事，所以直接叫 doctor，
// 不重寫一份掃描邏輯（判定條件分兩份寫遲早會分叉）。
//
// ⚠️ 一定要 spawn 成獨立行程：doctor 的掃描是同步的 PowerShell CIM 查詢，實測 2.4 秒。
//    在 daemon 主迴圈跑會卡掉兩三拍 → 走路跳幀，那正是當初把 token 掃描搬去 worker 的原因。
const ORPHAN_SWEEP_MS = 10 * 60 * 1000;   // 每天才長 4 個，10 分鐘一輪綽綽有餘（≈0.4% 一顆核心）
function sweepOrphans() {
    const doctor = path.join(core.INSTALL_ROOT, 'doctor.js');
    if (!fs.existsSync(doctor)) return;    // 沒安裝 doctor（例如直接跑 repo）就跳過
    try {
        const child = require('child_process')
            .spawn(process.execPath, [doctor], { detached: true, stdio: 'ignore' });
        child.unref();                     // 別讓它擋住 daemon 退出
        child.on('error', () => {});
    } catch (e) { /* 收屍失敗不該影響任何其他功能 */ }
}
setInterval(sweepOrphans, ORPHAN_SWEEP_MS).unref();
// 啟動時先掃一輪：daemon 剛起來時往往正是「上一輪累積了一堆」的時候。
// 但**延後**再做 —— 這行在 server.listen 之前，直接呼叫等於把一次 CreateProcess
// 塞進啟動路徑。實測讓 test-daemon-page 的固定 2 秒等待偶爾不夠而連不上；
// 收屍是家務事，沒有任何理由排在「開始服務」前面。
setTimeout(sweepOrphans, 3000).unref();

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

// ── 牧場的摸摸 ─────────────────────────────────────────────────────
// 純表演：只換一幀表情、開心時原地跳，**不動心情值、不寫 ranch.json**。
// 牧場是冰箱，裡面的東西不會因為你戳牠而成長或變壞 —— 這是使用者明確要的分界。
//
// 狀態機本體在 ./yard-touch.js。抽出去唯一的理由是可測試：daemon.js 一 require
// 就 server.listen，測試載不進來，而停走的拍數要累加、結清、還要跨反應保管，
// 那種帳不該只靠肉眼在瀏覽器上驗。
//
// 連戳判定跟現役那隻共用同一組門檻（TOUCH_WINDOW_MS / TOUCH_LIMIT / SULK_MS），
// 但計數是**每隻各自獨立**的：戳 A 五下不該讓 B 也生氣。
const yardTouch = YT.create({
    windowMs: TOUCH_WINDOW_MS, limit: TOUCH_LIMIT, sulkMs: SULK_MS, stepAt: PW.stepAt,
});
const yardPetTouch = (id) => ({ ok: true, action: 'yardPet', mood: yardTouch.pet(id) });
const yardReactMap = (alive) => yardTouch.react(alive);
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
    bg:          ()  => ['bg'],        // 舞台底圖編輯器（另開頁面，寫的是使用者自己的 bg.png）
    doctor:      ()  => ['doctor', '--check'],   // 只診斷不清，避免網頁一按就殺行程
    stats:       ()  => ['stats'],
    pvp:         (a) => a.name ? ['pvp', a.name] : ['pvp'],
    code:        (a) => a.name ? ['code', a.name] : ['code'],
    'pvp-setup': (a) => (a.url && a.key) ? ['pvp-setup', a.url, a.key, ...(a.name ? [a.name] : [])] : null,
    switch:      (a) => a.name ? [a.name] : null,          // 裸角色名/編號
    evolve:      (a) => a.name ? ['evolve', a.name] : null,
    battle:      (a) => ['battle', ...(a.enemy ? [a.enemy] : []), ...(a.result ? [a.result] : [])],
    // 牧場（docs/ranch-spec.md）。release 一律補 yes —— CLI 的二次確認是為終端機使用者
    // 設計的，網頁這邊由 data-confirm 的對話框負責，不能讓 subprocess 吊在等輸入。
    ranch:       ()  => ['ranch'],
    keep:        ()  => ['keep'],
    swap:        (a) => a.which ? ['swap', a.which] : null,
    release:     (a) => a.which ? ['release', a.which, 'yes'] : null,
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
    // 牧場的摸摸：純表演，不動心情也不寫任何檔。args.which = ranch entry 的內部 id。
    if (action === 'yardPet') {
        if (!args.which) return { ok: false, error: '要指定是哪一隻' };
        return yardPetTouch(args.which);
    }

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

// 整份前端都塞在這個 template literal 裡，所以裡面的反斜線會被吃掉一層 ——
// 連註解也一樣。要在前端字串裡放換行，用 String.fromCharCode(10)，不要寫跳脫字元，
// 否則組出來的是「字串字面值中間有真的換行」，瀏覽器整個 script 直接 SyntaxError
// （伺服器端完全正常，node --check 也過，只有頁面死掉）。
// scripts/test-daemon-page.js 會把頁面拉下來做語法檢查，釘住這類壞法。
// ── 寒風用的點陣 ─────────────────────────────────────────────────────
// 直接借天狐獸的子彈美術（使用者指名的參考）。它本來就是一團青色的風 ——
// 中心亮、外圍青、周圍散幾點閃光，那幾點閃光是這個造型好看的關鍵，自己畫很難拿捏。
//
// 借現成的還有一個好處：它是**點陣**。先前用向量畫的螺旋是畫面上唯一不是像素風的
// 東西，就算形狀對了也還是格格不入。
//
// 抽成 [dx,dy,r,g,b] 的扁平清單再內嵌進頁面：只有數字，不含反斜線，
// 塞進 template literal 是安全的（見 HTML 常數上方的警告）。
function loadWindArt() {
    try {
        const f = path.join(core.ASSETS_DIR, 'tenkomon', 'bullet-art.json');
        const rows = JSON.parse(fs.readFileSync(f, 'utf8')).frames[0];
        const out = [];
        rows.forEach((row, r) => (row || []).forEach((c, x) => {
            if (!c) return;
            if (c[0] >= 0) out.push([x, r * 2,     c[0], c[1], c[2]]);
            if (c[3] >= 0) out.push([x, r * 2 + 1, c[3], c[4], c[5]]);
        }));
        if (!out.length) throw new Error('空的');
        return packWind(out);
    } catch (e) {
        // 美術不在（換過角色表、精簡過 release）也不能讓牧場開不起來 ——
        // 退回一小團青色方塊，形狀差一點但不會是空白。
        const P = [[1,0],[2,0],[0,1],[1,1],[2,1],[3,1],[1,2],[2,2],[5,0],[6,3]];
        return packWind(P.map(([x, y]) => [x, y, 117, 232, 240]));
    }
}

/**
 * [x,y,r,g,b] → 依顏色分組的 [{c:'rgb(...)', p:[x,y,x,y,...]}]。
 * 分組是為了前端每幀只設三次 fillStyle 而不是 49 次；順便把左上角推到 (0,0)，
 * 前端就不用管原圖的留白。
 */
function packWind(dots) {
    const mx = Math.min(...dots.map(d => d[0])), my = Math.min(...dots.map(d => d[1]));
    const by = new Map();
    for (const [x, y, r, g, b] of dots) {
        const key = r + ',' + g + ',' + b;
        if (!by.has(key)) by.set(key, []);
        by.get(key).push(x - mx, y - my);
    }
    const w = Math.max(...dots.map(d => d[0])) - mx + 1;
    return { w, groups: [...by.entries()].map(([c, p]) => ({ c: 'rgb(' + c + ')', p })) };
}
const WIND_ART = loadWindArt();

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
  /* 院子是 96 欄（768px），比家裡的 52 欄寬。canvas 的 max-width:100% 在窄視窗會把它
     縮小，而縮小後 1 dot 不再是整數個 px，像素風會糊掉 —— 家裡那邊為了地平線對齊
     已經踩過一次。院子寧可讓 petbox 裁掉右邊，也不要非整數倍縮放。 */
  body.yard canvas{max-width:none}
  body.yard #petbox{overflow:auto}
  /* 院子不鋪底圖：那張圖是為家裡 52x8 的橫幅舞台烘的（center/cover），
     放到 96x24 會被裁成完全不同的一塊，看起來像另一張圖。等院子有自己的美術再說。 */
  body.yard #stage{background:rgb(24,24,24)}
  /* 天氣層：疊在角色畫布正上方，只有牧場會出現。
     刻意不用 image-rendering:pixelated —— 雨絲、光線是向量畫的，柵格化反而變鋸齒。
     pointer-events:none 是必要的，否則它會吃掉右鍵選單的命中判定。 */
  #wx{position:absolute;display:none;pointer-events:none;z-index:2}
  body.yard #wx{display:block}
  /* 右上角的日期／時間／天氣。用 HTML 疊層而不是畫點陣字：52 dot 寬塞一整行日期
     會佔掉整列又糊掉，而這裡本來就不是像素風的一部分，是「看板」。 */
  #hud{position:absolute;display:none;top:6px;right:8px;z-index:3;text-align:right;
       pointer-events:none;font-size:11px;line-height:1.4;color:#e6edf3;
       text-shadow:0 1px 3px #000, 0 0 6px #000, 0 0 2px #000}
  body.yard #hud{display:block}
  #hud .wx{font-size:13px;font-weight:600;letter-spacing:.5px}
  #hud .prev{color:#d29922;font-size:10px}
  #wxsel{background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;
         font:inherit;font-size:11px;padding:1px 4px;margin-left:6px}
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
  /* 右鍵選單。position:fixed + 依點擊座標定位，不塞進舞台裡 ——
     舞台有 overflow:hidden，選單擺進去會被裁掉。 */
  #ctx{position:fixed;z-index:50;display:none;min-width:150px;background:#161b22;
       border:1px solid #30363d;border-radius:6px;padding:4px;box-shadow:0 6px 20px rgba(0,0,0,.5)}
  #ctx .hd{padding:4px 8px;font-size:12px;color:#c9d1d9;border-bottom:1px solid #30363d;margin-bottom:4px}
  #ctx .hd .k2{color:#8b949e;font-size:11px}
  #ctx button{display:block;width:100%;text-align:left;margin:0;border:0;background:none;
              color:#c9d1d9;padding:6px 8px;border-radius:4px;font-size:12px;cursor:pointer}
  #ctx button:hover{background:#21262d}
  #ctx button.danger{color:#f85149}
</style></head><body>
<div id="ctx"></div>
<h1>🥚 Vpet daemon</h1>
<div id="wrap">
  <div id="petbox"><div id="stage"><canvas id="pet" width="480" height="200"></canvas><canvas id="wx"></canvas><div id="hud"><div id="hudTime">–</div><div class="wx" id="hudWx">–</div></div></div>
    <div id="controls">
      ${UI_BUTTONS.filter(([c, , o]) => !(IS_RELEASE && ((o && o.dev) || DEV_ONLY.has(c))))
                  .map(([c, label, o]) => `<button data-cmd="${c}" data-scope="${(o && o.scope) || 'home'}"${o && o.confirm ? ` data-confirm="${o.confirm}"` : ''}>${label}${o && o.dev ? ' <span class="devtag">dev</span>' : ''}</button>`)
                  .join('\n      ')}
    </div>
    <div id="yardbar" style="display:none;margin-top:6px;font-size:12px;color:#8b949e">
      <span id="yardinfo">–</span>
      <span class="k">（點一下摸摸、按右鍵開選單）</span>
${IS_RELEASE ? '' : `
      <label class="k">天氣預覽 <span class="devtag">dev</span><select id="wxsel">
        <option value="">自動（實際天氣）</option>
        <option value="clear">晴</option>
        <option value="cloudy">陰</option>
        <option value="rain">雨</option>
        <option value="storm">大雨</option>
        <option value="thunder">雷雨</option>
      </select></label>
      <label class="k"><input type="checkbox" id="wxcold"> 寒流</label>`}
    </div>
    <div id="cmdmsg"></div>
    <details id="adv"><summary>⚙ 進階指令</summary>
      ${UI_FORMS.filter(f => !(IS_RELEASE && (f.dev || DEV_ONLY.has(f.action))))
                .map(f => `<div class="form" data-scope="${f.scope || 'home'}"${f.action ? ` data-cmd="${f.action}"` : ''}>
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
    <div><span class="k">全域 cost（所有 AI）：</span><span class="v" id="tcost">–</span></div>
    <div class="k" id="bysrc" style="padding-left:12px"></div>
    <div><span class="k">近 10m burn：</span><span class="v" id="burn">–</span></div>
    <div><span class="k">最近活躍：</span><span class="v" id="lastact">–</span></div>
    <div><span class="k">掃描：</span><span class="v" id="scan">–</span></div>
    <div class="warn" id="err"></div>
  </div>
</div>
<script>
const CW=${CW}, CH=${CH};   // 由伺服器端同一組常數帶入（見 daemon.js 頂部）
// 寒風的點陣（天狐獸的子彈，依顏色分好組）。伺服器端抽好再內嵌，見 loadWindArt。
const WIND_ART=${JSON.stringify(WIND_ART)};
// 風往哪邊吹：+1 = 由左至右，-1 = 由右至左。
// 造型會跟著轉向（見 wxGust），所以改這一個數字就好，不用動美術也不用動繪圖。
// 子彈原圖是朝右的（角色預設朝右發射），所以 +1 時不鏡射。
const WIND_DIR=1;
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
// 視圖：家（statusline 那個舞台）／院子（牧場成員在 96x24 的場地散步）。
// 只是「這個瀏覽器分頁在看哪裡」，不是 daemon 的狀態 —— 開兩個分頁可以一個看家、
// 一個看院子，daemon 不需要知道。
let view = 'home';
function setView(v){
  view = v;
  document.body.classList.toggle('yard', v==='yard');
  document.querySelectorAll('[data-scope]').forEach(el=>{
    el.style.display = (el.dataset.scope==='both' || el.dataset.scope===v) ? '' : 'none';
  });
  document.getElementById('yardbar').style.display = (v==='yard') ? '' : 'none';
  document.querySelectorAll('[data-cmd="yard"]').forEach(b=>{
    // 「家」在這裡有兩個意思會打架：廣場那邊的「回家」是從廣場回到自己的舞台，
    // 牧場這邊按了是回到現役那隻。用「前線」指現役、「牧場」指收藏，不會混。
    b.textContent = (v==='yard') ? '⚔ 前線' : '🐮 牧場';
  });
  hudTick();
  poll();
}

// ── 天氣表演 ────────────────────────────────────────────────────────────
// 分兩層：**色調**在後端（跑在 dot 緩衝上，會吃到角色身上 —— 陽光照在怪身上、
// 寒流把怪凍得發青），**會動的粒子**在這裡。理由是節奏：/yard 是 500ms 輪詢、
// 走路 750ms 一拍，用那個節奏畫雨會變成一格一格瞬移的點，完全不像下雨。
// 這一層走 requestAnimationFrame，跟輪詢完全脫鉤。
//
// 雨滴位置用固定種子起始，重整看到同一場雨；但之後**不需要**跨 client 一致
// （沒有人分得出你我的雨滴有沒有對齊），所以接廣場時這段原封不動就能用。
// 走路那邊就不一樣了，那個必須逐拍決定性，見 shared/plaza-walk.js。
const wxState = {sky:'clear', cold:false};
let wxParts=null, wxLast=0, wxSeed=1;
function wxRand(){ wxSeed=(Math.imul(wxSeed,1664525)+1013904223)>>>0; return wxSeed/4294967296; }

// 天氣畫布要精準疊在角色畫布上。角色畫布每次 draw() 都會依內容重建尺寸，
// 所以每次畫完都要重新對位一次。
function syncWx(){
  const pet=document.getElementById('pet'), wx=document.getElementById('wx');
  const w=pet.offsetWidth, h=pet.offsetHeight;
  wx.style.left=pet.offsetLeft+'px'; wx.style.top=pet.offsetTop+'px';
  if(wx.width!==w||wx.height!==h){ wx.width=w; wx.height=h; }
}

function wxBuild(w,h){
  wxSeed=20260821;
  const P={w:w,h:h,shaft:[],cloud:[],drop:[],wind:[]};
  for(let i=0;i<3;i++)  P.shaft.push({x:wxRand()*w, w:16+wxRand()*26});
  for(let i=0;i<8;i++)  P.cloud.push({x:wxRand()*w, y:2+wxRand()*(h*0.20),
                                      w:24+wxRand()*44, h:2.5+wxRand()*3.5,
                                      v:3+wxRand()*5, a:0.05+wxRand()*0.06});
  // 雨滴池的大小**從 WXR 推出來**，不要寫死。
  // 寫死 120 而雷雨要 150 → 迴圈讀到 P.drop[120] 是 undefined 就丟例外，
  // 而例外發生在雲畫完之後 → 畫面看起來就只有雲，跟陰天一模一樣。
  // （requestAnimationFrame 在函式開頭就排好了，所以它每一幀都照丟，不會停也不會有紅字。）
  const DROPS=Math.max(...Object.values(WXR).map(r=>r.n));
  for(let i=0;i<DROPS;i++)P.drop.push({x:wxRand()*w, y:wxRand()*h, s:0.7+wxRand()*0.6});
  // 冷風：數量刻意少。每一陣都是一個看得出來的造型，這種東西一多就變成一團毛球
  // —— 密度要靠「還認得出單一個形狀」來定。
  // 尺寸對著角色抓：畫布 416x320，一隻角色 16 dot = 128px 高。
  // 子彈點陣約 10x10 dot，每 dot 畫 4~7px → 一陣風 40~70px，約角色的一半。
  // s 取整數，方塊才會對齊像素格。
  for(let i=0;i<5;i++)  P.wind.push({x:wxRand()*w, y:16+wxRand()*(h-72),
                                     s:4+Math.floor(wxRand()*4),
                                     v:34+wxRand()*40, a:0.42+wxRand()*0.28,
                                     vy:(wxRand()-0.5)*5});
  return P;
}

// 密度／速度全部集中在這裡，方便實測後調。場地只有 52x20 格（416x320px），
// 粒子稍微多一點畫面就會爛成雜訊、看不出誰是誰 —— 寧可保守。
const WXR = { rain:{n:40,  vy:175, vx:-28, len:9,  a:0.30, lw:1},
              storm:{n:110, vy:300, vx:-52, len:15, a:0.42, lw:1.4},
              thunder:{n:150, vy:360, vx:-64, len:19, a:0.48, lw:1.6} };
// 閃電：間隔多久打一次（隨機落在這個範圍內）。
// 場地只有 416x320，整片白閃很容易變成騷擾 —— 峰值壓在 0.28、每次只有兩百毫秒，
// 而且刻意做成「雙閃」（真的閃電多半閃兩下），比單次長閃自然又不刺眼。
const WXBOLT_MIN=5000, WXBOLT_MAX=13000;
let wxBoltNext=0, wxBoltAt=0;

// 一陣風 = 天狐獸子彈的點陣，s 是每個 dot 畫幾 px。
// 起點取整數、s 也是整數 → 每個方塊都對齊在整數像素上，邊緣不會被反鋸齒糊掉。
// 這是它跟先前那個向量螺旋最大的差別：畫面上其他東西全是像素，
// 只有天氣是平滑曲線的話，形狀再對也還是格格不入。
function wxGust(g,x,y,s){
  const gx=Math.round(x), gy=Math.round(y), flip=WIND_DIR<0, W=WIND_ART.w;
  for(const grp of WIND_ART.groups){
    g.fillStyle=grp.c;
    const p=grp.p;
    for(let i=0;i<p.length;i+=2){
      const dx=flip?(W-1-p[i]):p[i];
      g.fillRect(gx+dx*s, gy+p[i+1]*s, s, s);
    }
  }
}

function wxDraw(ts){
  requestAnimationFrame(wxDraw);
  const cv=document.getElementById('wx');
  if(view!=='yard'||!cv.width||!cv.height){ wxLast=ts; return; }
  const dt=Math.min(0.1,(ts-wxLast)/1000)||0; wxLast=ts;
  const w=cv.width, h=cv.height, g=cv.getContext('2d');
  if(!wxParts||wxParts.w!==w||wxParts.h!==h) wxParts=wxBuild(w,h);
  const P=wxParts, sky=wxState.sky;
  g.clearRect(0,0,w,h);

  // 晴：斜射的光柱。用 lighter 疊加，只加亮不遮擋 —— 光線蓋住角色會很怪。
  if(sky==='clear'){
    g.globalCompositeOperation='lighter';
    for(const f of P.shaft){
      f.x+=7*dt; if(f.x>w+h) f.x-=w+h+80;
      const grd=g.createLinearGradient(f.x,0,f.x+h*0.55,h);
      grd.addColorStop(0,'rgba(255,238,180,0.13)');
      grd.addColorStop(1,'rgba(255,238,180,0)');
      g.fillStyle=grd;
      g.beginPath();
      g.moveTo(f.x,0); g.lineTo(f.x+f.w,0);
      g.lineTo(f.x+f.w+h*0.55,h); g.lineTo(f.x+h*0.55,h);
      g.closePath(); g.fill();
    }
    g.globalCompositeOperation='source-over';
  }

  // 陰／雨／大雨：最上方一層薄雲。越糟的天氣雲越厚、飄越快。
  if(sky!=='clear'){
    const heavy=(sky==='storm'||sky==='thunder');
    const boost=sky==='thunder'?2.1:sky==='storm'?1.8:sky==='rain'?1.35:1;
    const speed=sky==='thunder'?3.0:heavy?2.4:sky==='rain'?1.5:1;
    for(const c of P.cloud){
      c.x+=c.v*speed*dt; if(c.x-c.w>w) c.x=-c.w*2;
      g.fillStyle='rgba(202,210,222,'+(c.a*boost).toFixed(3)+')';
      g.beginPath(); g.ellipse(c.x,c.y,c.w,c.h,0,0,6.2832); g.fill();
    }
  }

  // 雨／大雨。
  // ⚠️ 規格原本寫「最上方一些淺淺的雨」，這裡改成**整片**由上落下 ——
  //    只在上緣下雨看起來像天花板漏水，不像下雨。改用低透明度控制存在感，
  //    角色一樣看得清楚。要回到只在上方，把 d.y 的範圍夾住即可。
  if(sky==='rain'||sky==='storm'||sky==='thunder'){
    const r=WXR[sky];
    g.strokeStyle='rgba(155,192,255,'+r.a+')'; g.lineWidth=r.lw;
    g.beginPath();
    for(let i=0;i<r.n;i++){
      const d=P.drop[i];
      d.y+=r.vy*d.s*dt; d.x+=r.vx*d.s*dt;
      if(d.y>h){ d.y-=h+r.len; d.x=wxRand()*w; }
      if(d.x<-r.len) d.x+=w+r.len;
      g.moveTo(d.x,d.y); g.lineTo(d.x+r.vx/r.vy*r.len, d.y+r.len);
    }
    g.stroke();
  }

  // 雷雨：在大雨之上加閃電。畫在所有粒子之後 = 蓋住整個畫面，那才像整片天空亮起來。
  //
  // 為什麼雷雨是第五個 sky 而不是像寒流那樣的旗標：打雷一定伴隨下雨，它跟雨是同一個
  // 軸上更嚴重的一格，不是另一個軸。寒流不一樣，晴天也會冷。
  if(sky==='thunder'){
    if(ts>wxBoltNext){ wxBoltNext=ts+WXBOLT_MIN+wxRand()*(WXBOLT_MAX-WXBOLT_MIN); wxBoltAt=ts; }
    const e=ts-wxBoltAt;
    // 雙閃：0~70ms 主閃、130~230ms 較弱的第二下。中間那段暗下來才有「閃」的感覺，
    // 一路線性淡出的話只會像整片畫面在呼吸。
    let a=0;
    if(e<70)                a=0.28*(1-e/70);
    else if(e>=130&&e<230)  a=0.16*(1-(e-130)/100);
    if(a>0){ g.fillStyle='rgba(228,238,255,'+a.toFixed(3)+')'; g.fillRect(0,0,w,h); }
  }

  // 寒流：橫向吹過的冷風。這是**疊加**在天空狀態上的，不是另一種天空 ——
  // 台灣冬天「寒流 + 下雨」是常態，做成互斥的話那天只能二選一。
  // 寒流：少少幾陣「捲」橫著吹過。疊加在任何天空狀態上。
  //
  // 走過三版：
  //   1. 26 條細直線、alpha 0.05~0.17 → 等於看不見，回報「寒流沒顯示」。
  //   2. 40 條加粗加亮 → 看得見了，但變成流星雨。密的直線一律讀成「掉落物」，
  //      不管它是水平的還是垂直的。
  //   3. 5 陣向量畫的螺旋 → 風要靠形狀認不是靠數量，這點對了；但它是畫面上
  //      唯一的平滑曲線，跟滿場的像素格格不入。
  //   4. 5 陣天狐獸子彈的點陣（本版）→ 借現成的美術：中心亮、外圍青、周圍散幾點
  //      閃光。那幾點閃光是造型的關鍵，而且它本來就是點陣，總算跟場景同一種語言。
  //
  // ⚠️ 造型是有方向性的（尾巴上的散點在後面），所以**吹的方向與圖必須一致**。
  //    第一次接的時候風往左吹、圖卻朝右，尾巴跑到前面去了 —— 一眼就看得出怪。
  //    現在由 WIND_DIR 同時決定移動方向與要不要鏡射，不可能再對不上。
  if(wxState.cold){
    for(const k of P.wind){
      const wide=WIND_ART.w*k.s;
      k.x+=k.v*WIND_DIR*dt; k.y+=k.vy*dt;
      // 出畫面（或被垂直漂移帶出上下緣）就從逆風那一側重新進場
      if(k.y<0||k.y+wide>h||(WIND_DIR>0 ? k.x>w : k.x+wide<0)){
        k.x=(WIND_DIR>0 ? -wide-wxRand()*90 : w+wxRand()*90);
        k.y=16+wxRand()*(h-72); k.vy=(wxRand()-0.5)*5;
      }
      g.globalAlpha=k.a;
      wxGust(g,k.x,k.y,k.s);
    }
    g.globalAlpha=1;
  }
}
requestAnimationFrame(wxDraw);

// 右上角的日期／時間。時間走本機時鐘、每秒自己跳，不跟著 /yard 輪詢 ——
// 500ms 輪詢一次就為了更新分鐘數太浪費，而且斷線時時鐘不該跟著停。
const WXWD=['日','一','二','三','四','五','六'];
function hudTick(){
  if(view!=='yard') return;
  const d=new Date(), p2=n=>(n<10?'0':'')+n;
  document.getElementById('hudTime').textContent =
    d.getFullYear()+'/'+p2(d.getMonth()+1)+'/'+p2(d.getDate())+' ('+WXWD[d.getDay()]+')　'
    + p2(d.getHours())+':'+p2(d.getMinutes());
}
setInterval(hudTick,1000);

async function pollYard(){
  // ⚠️ 一定要 encodeURIComponent：查詢字串裡的 + 會被解碼成空白，
  //    clear+cold 送出去在伺服器端會變成 "clear cold"，比對不到就整個退回真實天氣
  //    —— 症狀是「選了寒流卻什麼都沒發生」。踩過一次。
  // 寒流是獨立的勾選框，不是下拉裡的組合選項 —— 它本來就跟天空正交，
  // 混進同一份清單會讓人以為「寒流」是某種天空，也組不出陰・寒流那類常見情況。
  const es = document.getElementById('wxsel');
  const ec = document.getElementById('wxcold');
  const parts=[]; if(es&&es.value) parts.push(es.value); if(ec&&ec.checked) parts.push('cold');
  const q = parts.join('+');
  const y = await (await fetch('/yard'+(q?'?w='+encodeURIComponent(q):''),
                               {cache:'no-store'})).json();
  if(!y.ok){ document.getElementById('err').textContent='⚠️ '+y.error; return; }
  lastYard=y;
  document.getElementById('yardinfo').textContent = y.kept
    ? '牧場 '+y.kept+'/'+y.cap+'　'+y.pets.map(p=>p.code).join('　')
    : '牧場是空的 —— 進階區的「📥 收進牧場」可以把現役收進來（隨時換得回去）';
  document.getElementById('kind').textContent='yard';
  document.getElementById('tick').textContent='#'+y.step;
  if(y.weather){
    wxState.sky = y.weather.sky; wxState.cold = !!y.weather.cold;
    document.getElementById('hudWx').innerHTML =
      y.weather.icon+' '+y.weather.label+(y.weather.temp?'　'+y.weather.temp:'')
      + (y.weather.city?' <span class="k">'+y.weather.city+'</span>':'')
      + (y.weather.preview?' <span class="prev">預覽</span>'
         : y.weather.stale?' <span class="prev">離線</span>':'');
  }
  if(y.lines){ draw(y.lines); }
  else {
    // 空牧場：仍然把畫布撐成完整的場地大小再清空。
    // 只 clearRect 不改尺寸的話，畫布會停在上一次畫過的家裡舞台（52 欄），
    // 空牧場就變成一個小方塊，看起來像壞掉而不是「這裡還沒有東西」。
    const cv=document.getElementById('pet');
    cv.width=y.cols*CW; cv.height=y.rows*CH;
    cv.getContext('2d').clearRect(0,0,cv.width,cv.height);
  }
  syncWx();
}

// 命中判定用「這一拍畫出來的位置」，所以要記住最後一次 /yard 的結果。
// 位置每拍都在動，若改成點下去再問伺服器，回來時已經是下一拍的位置，會抓錯人。
let lastYard=null;
function closeCtx(){ document.getElementById('ctx').style.display='none'; }
document.addEventListener('click',closeCtx);
document.addEventListener('scroll',closeCtx,true);

// 滑鼠事件 → 點到哪一隻（沒點到回 null）。左鍵摸摸與右鍵選單共用同一份判定，
// 分兩份寫遲早會分叉成「右鍵選到 A、左鍵摸到 B」。
function yardHit(ev){
  if(view!=='yard'||!lastYard||!lastYard.pets||!lastYard.pets.length) return null;
  const cv=document.getElementById('pet'), r=cv.getBoundingClientRect();
  // 畫布可能被 CSS 縮放過 → 用 width/rect 的比例換回內部座標，再換成 dot
  const dx=(ev.clientX-r.left)*(cv.width/r.width)/CW;
  const dy=(ev.clientY-r.top )*(cv.height/r.height)/(CH/2);
  const S=lastYard.sprite||16;
  // 由後往前找 = 從畫在最上層的那隻開始，跟眼睛看到的一致
  for(let i=lastYard.pets.length-1;i>=0;i--){
    const p=lastYard.pets[i];
    if(dx>=p.x&&dx<p.x+S&&dy>=p.y&&dy<p.y+S) return p;
  }
  return null;
}

document.getElementById('pet').addEventListener('contextmenu',ev=>{
  const hit=yardHit(ev);
  if(!hit) return;
  ev.preventDefault();
  const el=document.getElementById('ctx');
  const wr=hit.winPct==null?'尚無戰績':(hit.wins+'/'+hit.battles+'　'+hit.winPct+'%');
  // 選單表頭就把該講的都講完了（名字 / 階段 / 戰力 / 勝率 / 收進來的時間），
  // 所以不再給一顆「名片」鈕—— 那顆鈕是把同一份資料倒到畫布下方的 #cmdout，
  // 而牧場畫面的畫布是滿尺寸、外層會捲動，輸出區常常落在看不到的位置，
  // 看起來就像「按了沒反應」。
  el.innerHTML='<div class="hd"><b>'+hit.name+'</b>'+
               (hit.wasName?' <span class="k2">（原：'+hit.wasName+'）</span>':'')+
               '<br><span class="k2">'+
               hit.stage+'　戰力 '+hit.power+'　'+wr+'<br>收於 '+
               new Date(hit.keptAt).toLocaleString()+'</span></div>';
  const add=(txt,fn,cls)=>{const b=document.createElement('button');b.textContent=txt;
    if(cls)b.className=cls;b.onclick=e=>{e.stopPropagation();closeCtx();fn();};el.appendChild(b);};
  add('🔄 換出來（與現役交換）',()=>sendCmd('swap',{which:hit.id}));
  add('🗑 放生（永久刪除）',()=>{ if(confirm('放生「'+hit.name+'」？永久刪除，救不回來。'))
      sendCmd('release',{which:hit.id}); },'danger');
  el.style.display='block';
  el.style.left=Math.min(ev.clientX, innerWidth-el.offsetWidth-8)+'px';
  el.style.top =Math.min(ev.clientY, innerHeight-el.offsetHeight-8)+'px';
});

async function poll(){
  if(view==='yard'){
    try{ await pollYard(); lastFetch=Date.now(); }
    catch(e){ document.getElementById('err').textContent='fetch fail: '+e.message; }
    return;
  }
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
    const bs=u.bySource||{};
    document.getElementById('bysrc').textContent=
      Object.keys(bs).length ? Object.entries(bs).map(([k,v])=>k+' $'+v.toFixed(2)).join('　') : '';
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
    // 牧場操作是「排入 force、下一拍才生效」，所以要等一拍再刷，否則看到的還是舊名單
    if(['keep','swap','release'].includes(action)) setTimeout(poll, 1300);
    // 摸摸馬上刷一次，不然要等下一次輪詢（最多 500ms）才看到牠跳起來，
    // 點下去到有反應之間那半秒會讓人以為沒點到。
    if(action==='yardPet') poll();
  }catch(e){ flashCmdMsg('送出失敗：'+e.message,'#f85149'); }
}
document.querySelectorAll('#controls button').forEach(b=>b.addEventListener('click',()=>{
  // 院子只是換這個分頁在看哪裡，不是送指令給 daemon
  if(b.dataset.cmd==='yard'){ setView(view==='yard'?'home':'yard'); return; }
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
// release 版沒有這顆下拉（dev 專屬），所以要防呆
for(const id of ['wxsel','wxcold']){
  const e=document.getElementById(id);
  if(e) e.addEventListener('change',()=>{ if(view==='yard') poll(); });
}
// 點角色＝摸摸（連戳會生氣）。
// 牧場那一下要先做命中判定：畫布上有好幾隻，而 pet 指令是作用在現役那隻的 ——
// 直接送出去會變成「摸了一隻、爽到另一隻」。所以牧場走 yardPet + 內部 id。
// 而且牧場的摸摸是**純表演，不動心情值** —— 冰箱裡的東西不會因為你戳牠而變好或變壞。
document.getElementById('pet').addEventListener('click',ev=>{
  if(view!=='yard'){ sendCmd('pet'); return; }
  const hit=yardHit(ev);
  if(hit) sendCmd('yardPet',{which:hit.id});
});
setInterval(()=>{document.getElementById('fetchAge').textContent=Math.round((Date.now()-lastFetch)/1000)+'s';},250);
// 輪詢節奏依畫面而定：院子要 ${YT.POLL_MS}ms —— 摸摸的騰空只有那麼久，輪詢慢於它
// 就會整個被取樣漏掉（跳躍的節奏與這個數字綁在一起，見 yard-touch.js）。
// 家裡沒有這種需求，維持 500ms，不必為了沒人在看的畫面多打一倍的請求。
//
// 用自己排下一次而不是 setInterval：/yard 偶爾比間隔慢時，setInterval 會讓請求疊在
// 一起，畫面反而更頓。
const POLL_MS={home:500,yard:${YT.POLL_MS}};
(function pollLoop(){ poll().finally(()=>setTimeout(pollLoop, POLL_MS[view]||500)); })();
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
    // 院子：牧場成員 + 現役在同一個舞台散步（docs/ranch-spec.md 階段 2）。
    // 每次請求現算 —— 合成 20 隻約 0.3ms，沒必要放進主 tick 迴圈給不看院子的人付成本。
    // 名單直接讀 ranch.json，不經過 latest 快取：牧場剛改完就要看得到。
    if (req.url === '/yard' || req.url.startsWith('/yard?')) {
        let body;
        try {
            const ranch = core.loadRanch();
            const st    = loadState(STATE_FILE);
            const step  = plazaStep();
            // ?w=rain / ?w=storm+cold → 預覽指定天氣（見 weatherFor）
            const wq    = new URL(req.url, 'http://x').searchParams.get('w');
            const wx    = weatherFor(wq);
            const alive = new Set((ranch.pets || []).map(p => p.id));
            const out   = plaza.composeYard(core, ranch, st, step,
                                            { caches: yardCaches, react: yardReactMap(alive) });
            // 場地尺寸一定要回傳，**空牧場時尤其重要**：沒有這個，前端拿不到尺寸只能
            // 沿用上一次畫過的畫布（家裡那個 52 欄的小舞台），空牧場看起來就變成
            // 一個小方塊，像功能壞掉而不是「這裡還沒有東西」。
            const F = plaza.YARD_FIELD;
            // 帶座標與資料出去，讓前端能做右鍵選單：click 座標 -> 哪一隻。
            // 命中判定放前端而不是再開一個 /yard/hit 端點 —— 位置每拍都在動，
            // 多一次往返就會對到上一拍的位置，點了會抓錯人。
            const byId = Object.fromEntries((ranch.pets || []).map(p => [p.id, p]));
            const info = (id) => {
                const p = byId[id]; if (!p) return {};
                const st = p.state || {}, cid = st.characterId;
                let stage = '?', power = '?';
                try { stage = core.getCharacterStage(cid); } catch (e) {}
                try {
                    power = Math.min(core.getBasePower(st, cid) + (st.trainingBonus || 0),
                                     core.getTierCap(stage));
                } catch (e) {}
                const b = st.battleTotalCount || 0, w = st.battleWinCount || 0;
                return { stage, power, battles: b, wins: w,
                         winPct: b ? Math.floor(w / b * 100) : null, keptAt: p.keptAt,
                         // 在牧場裡自己變掉的（大便獸彩蛋）：右鍵選單要顯示原本是誰
                         wasName: p.evolvedFrom ? core.getDisplayName(p.evolvedFrom) : null };
            };
            body = { ok: true, step, cols: F.w, rows: F.h / 2, sprite: plaza.SPRITE,
                     weather: { ...wx, ...WX.describe(wx) },
                     cap: core.ranchCap(),
                     kept: (ranch.pets || []).length,
                     lines: out ? out.lines : null,
                     // y 回傳**畫出來**的位置（含跳躍位移），不是地面的 y ——
                     // 前端拿這個做命中判定，用地面 y 的話跳到最高點時點身體會落空。
                     pets: out ? out.placed.map(p => ({
                         id: p.ranchId, name: p.name, char: p.char,
                         x: p.x, y: p.y - (p.jumpDy || 0), ...info(p.ranchId),
                     })) : [] };
        } catch (e) {
            body = { ok: false, error: e.message };
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
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
