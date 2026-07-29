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
    getCharacterStage, computeInheritedPower,
} = core;

// 模式：預設「隔離」(寫 daemon-state.json，不接管、不寫 heartbeat) → 純顯示/PoC，跑了也不影響 statusLine。
//       --authoritative → 「當家」：寫真 color-state.json + 每拍寫 heartbeat，statusLine 偵測到就退唯讀。
const AUTHORITATIVE = process.argv.includes('--authoritative');
const STATE_FILE     = path.join(STATE_DIR, AUTHORITATIVE ? 'color-state.json' : 'daemon-state.json');
const HEARTBEAT_FILE = path.join(STATE_DIR, 'daemon-heartbeat.json');
const FORCE_FILE     = path.join(STATE_DIR, 'force-char.json');   // vpet 指令；當家時由 daemon 讀

// release 版 gate：與 statusline-cheat 同一個標記檔。強制戰鬥在 CLI 是開發指令
// （release 只留 battle on/off），UI 按鈕自然也要一致 → release 不顯示、且伺服器端擋掉。
// 只隱藏按鈕是不夠的：/cmd 是公開端點，必須在伺服器端一起擋。
const IS_RELEASE = fs.existsSync(path.join(core.INSTALL_ROOT, 'RELEASE'));
const DEV_ONLY   = new Set(['battle']);
const PORT           = parseInt(process.env.AGUMON_DAEMON_PORT || '3010', 10);
const STEP_MS        = 1000;

function tryLoadArt(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }

// 走路位移：statusline 靠 aguCol+pos 把角色擺到不同欄；daemon 沒有狀態列，改把角色畫到一個
// 固定寬「舞台」上、左邊墊 pos 個空欄，角色就會左右踱步（pos 0..MAX_POS）。舞台寬固定 →
// canvas 每幀同寬、不抖動。
function padWalkStage(rows, pos) {
    if (!rows || !rows.length) return rows;
    const spriteW = rows[0].length;
    const stageW  = MAX_POS + spriteW;   // pos 最大 MAX_POS 時角色右緣 = stageW，剛好放得下
    const off     = Math.max(0, Math.min(pos | 0, MAX_POS));
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
            delete st.exprStartStep; delete st.roarStartStep; delete st.lastStepSeen; delete st.happyStartStep;
            delete st.trainingBonus;
            delete st.battleTotalCount; delete st.battleWinCount; delete st.lastBattleCountedStartStep; delete st.tagStats;
            if (AUTHORITATIVE) clearForceCharacter(FORCE_FILE);   // 清 force.character 免無限迴圈
        }
    }

    if (!st.characterId) st.characterId = 'agumon';
    const { charDef, artFile, bulletArtFile, cutinArtFile, config } = loadCharacter(st.characterId);
    updateEvoHistory(st);

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
    return { kind: result.kind, petLines };
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
function applyCommand(action) {
    if (IS_RELEASE && DEV_ONLY.has(action)) return { ok: false, error: '此版本未提供此指令' };
    if (action === 'pet') return petTouch();   // 觸碰要即時計數，走專用路徑
    const fn = COMMANDS[action];
    if (!fn) return { ok: false, error: 'unknown action: ' + action };
    return { ok: writeForce(fn()), action };
}

// ── HTTP 顯示層 ──
const HTML = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>agumon daemon</title>
<style>
  body{background:#0d1117;color:#c9d1d9;font-family:ui-monospace,Consolas,monospace;margin:0;padding:20px}
  h1{font-size:15px;color:#58a6ff;margin:0 0 12px}
  #wrap{display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start}
  #petbox{background:#010409;border:1px solid #30363d;border-radius:8px;padding:12px;image-rendering:pixelated;max-width:100%;overflow:hidden}
  /* 進化樹在 SU 後是 5 格（92 字元寬 ≈ 736px），比一般表演寬得多 →
     讓 canvas 自動縮到容器內，避免被裁切或撐破版面。pixelated 保持像素感。 */
  canvas{image-rendering:pixelated;display:block;cursor:pointer;max-width:100%;height:auto}
  .panel{font-size:13px;line-height:1.7}
  .k{color:#8b949e} .v{color:#e6edf3;font-weight:600}
  .big{font-size:22px;color:#3fb950}
  .warn{color:#d29922}
  pre{margin:6px 0 0;color:#8b949e;font-size:12px;white-space:pre}
  .badge{display:inline-block;padding:1px 8px;border-radius:10px;background:#1f6feb;color:#fff;font-size:12px}
  #controls{margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;max-width:480px}
  #controls button{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer}
  #controls button:hover{background:#30363d;border-color:#8b949e}
  #cmdmsg{margin-top:6px;min-height:16px;color:#3fb950;font-size:12px}
</style></head><body>
<h1>🥚 agumon daemon — 獨立時鐘 + JSONL token 源（點角色＝摸摸，連戳會生氣）</h1>
<div id="wrap">
  <div id="petbox"><canvas id="pet" width="480" height="200"></canvas>
    <div id="controls">
      <button data-cmd="pet">🤚 摸摸</button>
      ${IS_RELEASE ? '' : '<button data-cmd="battle">⚔️ 戰鬥</button>'}
      <button data-cmd="card">🪪 卡片</button>
      <button data-cmd="tree">🌳 進化樹</button>
      <button data-cmd="drop">🪂 空降</button>
      <button data-cmd="sleep">😴 睡</button>
      <button data-cmd="wake">☀️ 醒</button>
      <button data-cmd="freeze">❄️ 凍結進化</button>
      <button data-cmd="unfreeze">🔥 解凍</button>
    </div>
    <div id="cmdmsg"></div></div>
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
// 每個終端字元 = 1px 寬 × 2px 高（▀ 把字元切成上/下兩個像素）。要像素方正 → CH = 2×CW，
// 否則每個半格 8×4 會把角色壓扁（太扁）。CW=8 → 半格 8×8 方正。
const CW=8, CH=16;
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
  for(let r=0;r<rows.length;r++){
    for(let c=0;c<rows[r].length;c++){
      const cell=rows[r][c]; if(!cell)continue;
      const x=c*CW,y=r*CH;
      if(cell.ch!==undefined){   // 真文字：畫字（卡片數值 / 名牌）
        ctx.fillStyle=cell.col?('rgb('+cell.col.join(',')+')'):'#c9d1d9';
        ctx.fillText(cell.ch,x,y+1);
      }else{                     // 半格像素
        if(cell.top){ctx.fillStyle='rgb('+cell.top.join(',')+')';ctx.fillRect(x,y,CW,CH/2);}
        if(cell.bot){ctx.fillStyle='rgb('+cell.bot.join(',')+')';ctx.fillRect(x,y+CH/2,CW,CH/2);}
      }
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
async function sendCmd(action){
  const el=document.getElementById('cmdmsg');
  try{
    const r=await (await fetch('/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})})).json();
    const MOOD={happy:'摸摸 ♥',refuse:'牠生氣了！別一直戳',sulking:'鬧脾氣中…不理你',asleep:'牠睡死了，叫不動（vpet wake 才會醒）'};
    el.textContent = r.ok ? (MOOD[r.mood] || ('已送出：'+action)) : ('失敗：'+(r.error||action));
    el.style.color = r.ok ? ((r.mood==='refuse'||r.mood==='sulking')?'#d29922':'#3fb950') : '#f85149';
  }catch(e){el.textContent='送出失敗：'+e.message;el.style.color='#f85149';}
}
document.querySelectorAll('#controls button').forEach(b=>b.addEventListener('click',()=>sendCmd(b.dataset.cmd)));
document.getElementById('pet').addEventListener('click',()=>sendCmd('pet'));   // 點角色＝摸摸（連戳會生氣）
setInterval(()=>{document.getElementById('fetchAge').textContent=Math.round((Date.now()-lastFetch)/1000)+'s';},250);
setInterval(poll,500); poll();
</script></body></html>`;

const server = http.createServer((req, res) => {
    if (req.url === '/state') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(Object.assign({}, latest, { uptimeSec: (Date.now() - startedAt) / 1000 })));
        return;
    }
    if (req.method === 'POST' && req.url === '/cmd') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
        req.on('end', () => {
            let action = '';
            try { action = JSON.parse(body).action; } catch (e) {}
            const r = applyCommand(action);
            res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(r));
        });
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
});
server.listen(PORT, () => {
    console.log(`🥚 agumon daemon 已啟動  [${AUTHORITATIVE ? '當家 authoritative' : '隔離 isolated'}]`);
    console.log(`   時鐘：每 ${STEP_MS}ms tick 一次（獨立於 Claude Code）`);
    if (AUTHORITATIVE) {
        console.log(`   ⚠️ 當家模式：寫真 ${STATE_FILE} + heartbeat，statusLine 會退唯讀`);
    } else {
        console.log(`   state：${STATE_FILE}（隔離，不碰正式 color-state.json，跑了不影響 statusLine）`);
    }
    console.log(`   開啟：http://localhost:${PORT}`);
});
