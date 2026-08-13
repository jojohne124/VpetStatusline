#!/usr/bin/env node
// v7+battle: 共用單一 state，支援單角色 + 戰鬥表演兩種渲染模式
'use strict';
const fs   = require('fs');
const path = require('path');
const {
    STATE_DIR, ANCHOR_GAP, BATTLE_SCENE_WIDTH,
    EVO_LENGTH,
    loadState, saveState, atomicWrite, decideAgumon, checkEvolution, resetStageStats,
    recordAlbumIfChanged,
    applyForceFlags, applyForceTriggers, clearForceCharacter,
    getCharacterStage, computeInheritedPower, alignWalkPhase, reapStalePids,
    buildStatusLines, composeOutput, visLen,
    loadCharacter, loadShared, getSharedFrame, isHighTierStarter,
    renderCells, flipRows, overlayCells, composeSleepScene, composeStatusCard, composeTreeScene, getFacingRows, composeBattleScene, composeEvoScene, composeDropScene, silhouetteArt,
    updateEvoHistory,
} = require('./agumon-core');

const STATE_FILE = path.join(STATE_DIR, 'color-state.json');
const FORCE_FILE = path.join(STATE_DIR, 'force-char.json');
const HEARTBEAT_FILE = path.join(STATE_DIR, 'daemon-heartbeat.json');

// C 方案：daemon 若活著（每秒寫 heartbeat）就由它當唯一寫入者。本 statusLine 偵測到
// heartbeat 新鮮 → 退「唯讀」：照常算出當前該顯示的畫面，但不觸發指令、不 consume force、
// 不 saveState（避免與 daemon 搶寫 color-state.json）。heartbeat 過期／不存在 → readOnly=false
// → 完全等同原本的自寫行為（沒裝 daemon 的人零變化）。
const DAEMON_FRESH_MS = 4000;   // daemon 每秒寫；4 秒內視為活著
function daemonIsAuthoritative() {
    try {
        const hb = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf8'));
        return hb && typeof hb.ts === 'number' && (Date.now() - hb.ts) < DAEMON_FRESH_MS;
    } catch (e) { return false; }
}

// 安全讀取角色 art / bullet-art；失敗回 null
function tryLoadArt(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) { return null; }
}

// Watchdog：父行程（Claude Code）異常關閉／洩漏 stdin 管線時，'end' 不會觸發，本行程會卡在
// event loop 等待而變孤兒（Windows 殺父不連帶殺子）。用 ref'd 計時器（不可 unref——unref 的
// 計時器不算進 libuv poll 逾時，loop 阻塞等 stdin 時不會被叫醒 → 形同虛設）。收到 'end' 後
// clearTimeout，正常路徑零延遲退出。
// 註：此計時器只擋得住「event loop 仍在轉、卡在 async 等待」的孤兒（實測 stdin 不 end → 8 秒
// 自殺）；擋不了「主執行緒同步卡死 / 行程被記憶體壓力換頁凍結」——那類殘留由下方 reapStale()
// 交由「後續每一個新啟動的健康行程」跨行程清除（見該函式）。
const _watchdog = setTimeout(() => process.exit(0), 8000);

// 跨行程收屍：每個新啟動的 statusline 都先掃描 pids/，把「已登記超過 REAP_AGE 卻還活著」的
// 舊行程（＝卡死/凍結的孤兒，健康行程早就退出並自我除名了）直接 SIGKILL。killer 是剛被排程、
// 正常在跑的新行程，故不受「孤兒自己被換頁凍結、連自己的計時器都跑不動」影響——這是唯一能清掉
// 記憶體壓力下殭屍孤兒的機制。閒置時 statusline 仍每 5~15 秒被叫用一次，故週末也會持續收屍。
//
// ⚠️ 每個行程只寫／刪「自己那一個 pid 檔」，絕不整份讀改寫共享名單。舊版用單一 live-pids.json
// 當共享 map，兩個時間重疊的行程會 read-modify-write 互相覆蓋：B 先讀到（還沒有 A 的）舊快照、
// A 寫入自己、B 再把舊快照寫回 → A 的登記被抹掉 → A 之後凍結成孤兒也永遠查不到、收不了屍。
// 目錄列表即名單，天生無競態。
// 收屍那段（探活 / SIGKILL / 回探確認才刪檔）已抽到 agumon-core 的 reapStalePids()，
// 讓 daemon 也能共用同一份 —— daemon-only 安裝沒部署本檔，hook 的孤兒得由 daemon 來收。
// 登記／除名仍留在這裡：core 那支刻意不登記自己（長駐行程一登記就會被當成卡死孤兒殺掉）。
const PIDS_DIR   = path.join(STATE_DIR, 'pids');
function pidFile(pid) { return path.join(PIDS_DIR, pid + '.pid'); }
function reapStale() {
    try { fs.mkdirSync(PIDS_DIR, { recursive: true }); } catch(e) {}
    // 先登記自己：單一檔案的整檔寫入，不依賴任何共享狀態
    try { fs.writeFileSync(pidFile(process.pid), String(Date.now())); } catch(e) {}
    reapStalePids(PIDS_DIR, process.pid);
}
// 自我除名：正常退出前刪掉自己的 pid 檔，避免 PID 被作業系統回收再指派給別的行程後被誤殺。
// （死掉行程的殘留檔也會在每次 render 的掃描中被清掉，故「殘留檔存活到 PID 被回收且超過 20 秒」
//   幾乎不可能發生。）
function deregister() { try { fs.unlinkSync(pidFile(process.pid)); } catch(e) {} }
try { reapStale(); } catch(e) {}
process.on('exit', deregister);   // 任何正常退出（含 watchdog process.exit）都自我除名；被 SIGKILL 收屍時不觸發（正確）

let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
    clearTimeout(_watchdog);
    try {
        const i   = JSON.parse(d);
        const now = Date.now();
        const st  = loadState(STATE_FILE);
        const readOnly = daemonIsAuthoritative();   // daemon 當家時本行程只顯示、不寫

        // ── 作弊碼 / 指令：讀 force-char.json 套用到 st（與 daemon 共用同一份核心邏輯）──
        // daemon 當家（readOnly）時由 daemon 讀 force、本行程不碰，避免雙寫。
        if (!readOnly) applyForceFlags(st, FORCE_FILE);

        if (!st.characterId) {
            // 診斷 log：disk state 缺 characterId 時記錄上下文，協助日後查 regression 原因
            try {
                let rawSize = -1, rawPreview = '(read-fail)';
                try {
                    const raw = fs.readFileSync(STATE_FILE, 'utf8');
                    rawSize = raw.length;
                    rawPreview = raw.slice(0, 200);
                } catch(_) {}
                const stKeys = Object.keys(st).join(',') || '(none)';
                const forceExists = fs.existsSync(FORCE_FILE);
                const line = `${new Date().toISOString()} pid=${process.pid} st_keys=[${stKeys}] raw_size=${rawSize} force_exists=${forceExists} raw="${rawPreview.replace(/"/g, '\\"')}"\n`;
                fs.appendFileSync(STATE_FILE + '.corrupt.log', line);
            } catch(_) {}
            st.characterId = 'agumon';
        }

        // ── 進化生命週期 ────────────────────────────────────────────
        // STEP_MS 必須跟 agumon-core 一致（1000ms = 1 step/sec），否則 step 對不上會
        // 讓 decideAgumon 內的殘留清理把 evoStartStep 重設掉
        const STEP_MS = 1000;
        const step = Math.floor(now / STEP_MS);
        // 1. commit：表演結束 → 切換 characterId（必須在 loadCharacter 之前，否則
        //    commit 那一步會用舊 charDef 載入 art，render 出舊角色走路 1 幀）
        // 用 shownElapsed 判斷而非 target：搭配 core 的 frame throttle，避免 wallclock 超過
        // 但仍有未播完的拍卡在後面就提前 commit
        if (!readOnly && st.evoStartStep != null && st.evoStartStep >= 0) {
            const targetElapsed = step - st.evoStartStep;
            const prevShown     = st.evoShownElapsed ?? -1;
            const wouldAdvance  = Math.min(targetElapsed, prevShown + 1);
            if (wouldAdvance >= EVO_LENGTH) {
                const prevCharId = st.characterId;
                st.characterId = st.evoNextCharId || st.characterId;
                // Super-Ultimate：戰力繼承「進化前的基礎 power + 訓練值」當新的 base（上限改 210）。
                // 必須在 delete trainingBonus 之前算。非 SU 目標則清掉舊繼承值，回歸 config.power。
                if (getCharacterStage(st.characterId) === 'Super-Ultimate') {
                    st.inheritedPower = computeInheritedPower(st, prevCharId);
                } else {
                    delete st.inheritedPower;
                }
                st.evoStartStep = -1;
                st.evoNextCharId = null;
                st.evoShownElapsed = -1;
                // 表演期間畫面釘在 lastPos，但 step 照跑 → 不重對齊的話新角色會從十幾格外冒出來。
                // 與 drop / battle / 睡醒同一套（daemon 的 commit 也有一份）。
                alignWalkPhase(st, step, st.lastPos ?? 0, st.lastFacing);
                delete st.exprStartStep; delete st.roarStartStep; delete st.lastStepSeen; delete st.happyStartStep;
                resetStageStats(st);   // 訓練值/勝率/隱藏統計歸零 + 記錄 lastEvolveAt（與 daemon 共用）
                clearForceCharacter(FORCE_FILE);   // 清 force.character，避免「進化→拉回→進化」無限迴圈
            }
        }

        const { charDef, artFile, bulletArtFile, cutinArtFile, config } = loadCharacter(st.characterId);

        // characterId 此刻已定案 → 維護進化歷史（給 vpet tree 用；自然進化 append、斷點重設、空補種）
        if (!readOnly) updateEvoHistory(st);
        // 圖鑑：只在角色變動時碰磁碟（內部用 st._albumLast 短路）
        if (!readOnly) recordAlbumIfChanged(st);

        // 1.5 + 2. cheat trigger：reset 掉落空降 / 強制進化（與 daemon 共用）
        if (!readOnly) applyForceTriggers(st, step);

        // 3. 自然觸發：checkEvolution 命中（freeze 凍結時跳過，cost 仍累積，解除後達標即進化）
        if (!readOnly && !(st.evoStartStep >= 0) && !st._freezeEvolve) {
            const nextChar = checkEvolution(st, i, config);
            if (nextChar) {
                st.evoStartStep = step;
                st.evoNextCharId = nextChar;
                st.evoShownElapsed = -1;
                st.battleStartStep = -1; st.battleEnemy = null; st.battlePending = false;
                delete st.exprStartStep; delete st.roarStartStep; delete st.happyStartStep;
            }
        }

        const result = decideAgumon(i, st, now, charDef, { allowBattle: true });

        const statusLines = buildStatusLines(i);

        // vpet hide：只顯示狀態列、不畫 pet（狀態照常前進，進化/戰鬥計數不受影響）。
        // 想看 pet 的人到獨立介面（daemon 頁面）看即可。daemon 顯示層不理這旗標。
        if (st._petHidden) {
            if (!readOnly) saveState(STATE_FILE, st);
            process.stdout.write(statusLines.join('\n'));
            return;
        }

        let outputLines = null;

        if (result.kind === 'battle') {
            // 寬度檢查：場景 48 cells + status 最寬 + ANCHOR_GAP
            const renderW   = i.render_width_chars ?? 999;
            const maxStatus = Math.max(...statusLines.map(visLen));
            const needed    = maxStatus + ANCHOR_GAP + BATTLE_SCENE_WIDTH;

            if (renderW < needed) {
                // 寬度不足 → 本視窗退回單角色 IDLE_1，但 NOT 寫回 state
                // （避免影響其他寬視窗的戰鬥；窄視窗只是「本地降級」）
                result.kind     = 'single';
                result.frameIdx = charDef.F.IDLE_1 ?? 0;
                result.facing   = 'left';
                result.pos      = st.lastPos ?? 0;
            } else {
                // 載入敵方 art + bullet
                const enemyId   = result.enemyId || 'godzilla_1999';
                let enemyChar   = null;
                try { enemyChar = loadCharacter(enemyId); } catch(e) {}
                const meArt           = tryLoadArt(artFile);
                let enemyArt          = enemyChar ? tryLoadArt(enemyChar.artFile) : null;
                const meBulletArt     = tryLoadArt(bulletArtFile);
                let enemyBulletArt    = enemyChar ? tryLoadArt(enemyChar.bulletArtFile) : null;
                const meCutInArt      = tryLoadArt(cutinArtFile);
                let enemyCutInArt     = enemyChar ? tryLoadArt(enemyChar.cutinArtFile) : null;
                let enemyRightOffset  = enemyChar?.charDef?.RIGHT_OFFSET ?? null;

                // 黑影 fallback：本機沒有對手角色（新版才加 / 客製 / 資料異常）→ 以 Shadow 角色演出。
                // 名牌照常顯示對手名字、勝負由 PvP 卡片預先決定（與敵方本機 power 無關）→ 只影響外觀、不影響公平。
                if (!enemyArt) {
                    let sChar = null;
                    try { sChar = loadCharacter('shadow'); } catch(e) {}
                    if (sChar) {
                        // 專屬 Shadow 角色（已 baked、可在 editor 編輯；有 cut-in → 配合 v2）
                        enemyArt         = tryLoadArt(sChar.artFile);
                        enemyBulletArt   = tryLoadArt(sChar.bulletArtFile);
                        enemyCutInArt    = tryLoadArt(sChar.cutinArtFile);
                        enemyRightOffset = sChar?.charDef?.RIGHT_OFFSET ?? null;
                    }
                    if (!enemyArt) {
                        // Shadow 未安裝 → 退而即時染黑 agumon（無 cut-in → 該場已退 v1）
                        try {
                            const a = loadCharacter('agumon');
                            enemyArt         = silhouetteArt(tryLoadArt(a.artFile));
                            enemyBulletArt   = silhouetteArt(tryLoadArt(a.bulletArtFile));
                            enemyCutInArt    = null;
                            enemyRightOffset = a?.charDef?.RIGHT_OFFSET ?? null;
                        } catch(e) {}
                    }
                }
                const shared          = loadShared();

                outputLines = composeBattleScene({
                    frame:            result,
                    meArt,
                    enemyArt,
                    meBulletArt,
                    enemyBulletArt,
                    meCutInArt,
                    enemyCutInArt,
                    shared,
                    meRightOffset:    charDef.RIGHT_OFFSET,
                    enemyRightOffset: enemyRightOffset,
                    oppLabel:         st.pvpOppLabel || null,   // PvP 對手名牌：白字置敵方腳下
                    meLabel:          st.pvpMeLabel  || null,   // PvP 我方名牌：白字置我方腳下
                });
            }
        }

        if (result.kind === 'evo' && !outputLines) {
            const charId = result.useNewChar ? st.evoNextCharId : st.characterId;
            let evoChar = null;
            try { evoChar = loadCharacter(charId); } catch(e) {}
            const evoArt = evoChar ? tryLoadArt(evoChar.artFile) : null;
            const shared = loadShared();
            outputLines = composeEvoScene({
                frame:           result,
                charArt:         evoArt,
                shared,
                charRightOffset: evoChar?.charDef?.RIGHT_OFFSET ?? null,
            });
        }

        if (result.kind === 'drop' && !outputLines) {
            const art      = tryLoadArt(artFile);
            const idle     = charDef.F?.IDLE_1 ?? 0;
            const charRows = art ? getFacingRows(art, idle, 'left', charDef.RIGHT_OFFSET) : null;
            // 高階 starter 用另一種登場煙霧 dust_hi（目前為 dust 複本，待美術替換）
            const dustName = isHighTierStarter(st.characterId) ? 'dust_hi' : 'dust';
            const dustRows = getSharedFrame(loadShared(), dustName, 0);   // 未畫時為空白 → 不顯示煙塵
            outputLines = composeDropScene({ charRows, dustRows, elapsed: result.elapsed });
        }

        if (result.kind === 'card' && !outputLines) {
            const cutInArt = tryLoadArt(cutinArtFile);
            outputLines = composeStatusCard({ charId: st.characterId, st, cutInArt, dim: result.dim });
        }

        if (result.kind === 'tree' && !outputLines) {
            outputLines = composeTreeScene(st, { dim: result.dim });
        }

        if (result.kind === 'single' && !outputLines) {
            let { frameIdx, facing } = result;
            // debug pin（vpet pin）：固定顯示 IDLE_1 朝左，與 tree 印出的同一張，供對照
            try { if (JSON.parse(fs.readFileSync(FORCE_FILE, 'utf8')).pinIdle) { frameIdx = charDef.F?.IDLE_1 ?? 0; facing = 'left'; } } catch(e) {}
            const art = tryLoadArt(artFile);
            if (art) {
                const rows = getFacingRows(art, frameIdx, facing, charDef.RIGHT_OFFSET);
                // 睡覺 Z 特效：角色右方加寬一塊放 Z（不疊在角色身上）
                if (rows && result.sleepFx) {
                    const fxRows = getSharedFrame(loadShared(), result.sleepFx, 0);
                    outputLines = renderCells(composeSleepScene(rows, fxRows));
                } else if (rows) {
                    outputLines = renderCells(rows);
                }
            }
        }

        if (!readOnly) saveState(STATE_FILE, st);   // daemon 當家時不寫，避免搶寫

        if (!outputLines) {
            process.stdout.write(statusLines.join('\n'));
            return;
        }

        // 進化歷程：直接輸出(從第 0 欄起，不接狀態列)→ 67 寬可放進一般終端，狀態列暫時讓位
        if (result.kind === 'tree') {
            process.stdout.write(outputLines.join('\n'));
            return;
        }

        const maxStatusW = Math.max(...statusLines.map(visLen));
        const aguCol = result.kind === 'battle'
            ? maxStatusW + ANCHOR_GAP
            : maxStatusW + ANCHOR_GAP + (result.pos ?? 0);

        process.stdout.write(composeOutput(statusLines, outputLines, aguCol));
    } catch(e) {
        process.stdout.write('statusline-agumon-color: ' + e.message);
    }
});
