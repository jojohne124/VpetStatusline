#!/usr/bin/env node
// v7+battle: 共用單一 state，支援單角色 + 戰鬥表演兩種渲染模式
'use strict';
const fs   = require('fs');
const path = require('path');
const {
    STATE_DIR, ANCHOR_GAP, BATTLE_SCENE_WIDTH,
    EVO_LENGTH,
    loadState, saveState, atomicWrite, decideAgumon, checkEvolution,
    buildStatusLines, composeOutput, visLen,
    loadCharacter, loadShared, getSharedFrame,
    renderCells, flipRows, overlayCells, composeSleepScene, composeStatusCard, composeTreeScene, getFacingRows, composeBattleScene, composeEvoScene, composeDropScene, silhouetteArt,
    updateEvoHistory,
} = require('./agumon-core');

const STATE_FILE = path.join(STATE_DIR, 'color-state.json');
const FORCE_FILE = path.join(STATE_DIR, 'force-char.json');

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

// 跨行程收屍：每個新啟動的 statusline 都先掃描 live-pids，把「已登記超過 REAP_AGE 卻還活著」的
// 舊行程（＝卡死/凍結的孤兒，健康行程早就退出並自我除名了）直接 SIGKILL。killer 是剛被排程、
// 正常在跑的新行程，故不受「孤兒自己被換頁凍結、連自己的計時器都跑不動」影響——這是唯一能清掉
// 記憶體壓力下殭屍孤兒的機制。閒置時 statusline 仍每 5~15 秒被叫用一次，故週末也會持續收屍。
const PIDS_FILE  = path.join(STATE_DIR, 'live-pids.json');
const REAP_AGE_MS = 20000;   // 活著且登記超過 20 秒 = 卡死（健康 render 1~3 秒早已退出並除名）
function reapStale() {
    let map = {};
    try { map = JSON.parse(fs.readFileSync(PIDS_FILE, 'utf8')) || {}; } catch(e) {}
    const now = Date.now();
    for (const key of Object.keys(map)) {
        const pid = +key;
        if (pid === process.pid) continue;
        let alive = true;
        try { process.kill(pid, 0); } catch(e) { alive = false; }   // 訊號 0：只探活、不影響
        if (!alive) { delete map[key]; continue; }                   // 已退出（含自我除名）→ 清出名單
        if (now - map[key] > REAP_AGE_MS) {                          // 活著又逾時 = 卡死孤兒 → 收屍
            try { process.kill(pid, 'SIGKILL'); } catch(e) {}
            delete map[key];
        }
    }
    map[process.pid] = now;
    try { atomicWrite(PIDS_FILE, JSON.stringify(map)); } catch(e) {}
}
// 自我除名：正常退出前把自己從名單移除，避免 PID 被作業系統回收再指派給別的行程後被誤殺。
function deregister() {
    try {
        const map = JSON.parse(fs.readFileSync(PIDS_FILE, 'utf8')) || {};
        delete map[process.pid];
        atomicWrite(PIDS_FILE, JSON.stringify(map));
    } catch(e) {}
}
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

        // ── 作弊碼：強制切換角色 / 強制戰鬥 ───────────────────────
        // 角色切換仍是「first-write-wins」（會 consume force.character）
        // 戰鬥改用 token 制（battleTriggerTs）：每個視窗各自比對，不 consume，可多視窗同時觸發
        try {
            const force = JSON.parse(fs.readFileSync(FORCE_FILE, 'utf8'));
            if (force.character) {
                const changed = st.characterId !== force.character;
                st.characterId = force.character;
                if (changed) {
                    Object.keys(st).forEach(k => { if (k.startsWith('_evo_') || k === '_r5hPeaked' || k === '_costEvolved') delete st[k]; });
                    delete st.exprStartStep; delete st.roarStartStep; delete st.lastStepSeen; delete st.happyStartStep;
                    delete st._r5hResetAt;
                    delete st.trainingBonus;  // 切角色歸零（與進化/reset 一致）
                    delete st.battleTotalCount; delete st.battleWinCount; delete st.lastBattleCountedStartStep;  // 勝率歸零
                    // 新角色 → 累積花費歸零；下一拍 updateEvoSpend 會以當前 session cost 為新基準（貢獻 0），
                    // 不會把「切換前已花的 cost」算進新角色的進化進度。
                    st._evoSpendBySession = {};
                    delete st._evoCostBase; delete st._evoCheatStickyUntilMs; delete st._evoCostBasePending;  // 清掉舊制殘留
                }
            }
            // Battle token：trigger 時間戳不同於本視窗上次看過的，且 10 秒內仍有效，才觸發
            if (force.battleTriggerTs && force.battleTriggerTs !== st.lastBattleTriggerTs) {
                const age = Date.now() - force.battleTriggerTs;
                if (age >= 0 && age < 10000 && !(st.battleStartStep >= 0)) {
                    st._forceBattle = true;
                    if (typeof force.forceBattleWin === 'boolean')   st._forceBattleWin   = force.forceBattleWin;
                    if (typeof force.forceBattleEnemy === 'string')  st._forceBattleEnemy = force.forceBattleEnemy;
                    // PvP 名牌（戰鬥演出腳下）；非 PvP 戰鬥 force 無此欄 → 清空
                    st._pvpOppLabel = (typeof force.pvpOppLabel === 'string') ? force.pvpOppLabel : null;
                    st._pvpMeLabel  = (typeof force.pvpMeLabel  === 'string') ? force.pvpMeLabel  : null;
                    // 跨階對戰不計勝率旗標（同階/手動/自動戰鬥皆 false → 照常計入）
                    st._battleNoCount = (force.battleNoCount === true);
                }
                st.lastBattleTriggerTs = force.battleTriggerTs;   // 不論是否觸發都記下，避免日後 stale 重觸發
            }
            // Evolution token：強制進化（age window 拉長到 5 分鐘，容許 statusline 偶發 idle）
            if (force.evolveTriggerTs && force.evolveTriggerTs !== st.lastEvolveTriggerTs) {
                const age = Date.now() - force.evolveTriggerTs;
                if (age >= 0 && age < 300000 && !(st.evoStartStep >= 0) && typeof force.evolveTarget === 'string') {
                    st._forceEvolve = force.evolveTarget;
                }
                st.lastEvolveTriggerTs = force.evolveTriggerTs;
            }
            // Reset 掉落 token：reset 抽到新 starter → 播空降表演（10 秒內有效，不 consume）
            if (force.dropTriggerTs && force.dropTriggerTs !== st.lastDropTriggerTs) {
                const age = Date.now() - force.dropTriggerTs;
                if (age >= 0 && age < 10000 && !(st.dropStartStep >= 0)) st._forceDrop = true;
                st.lastDropTriggerTs = force.dropTriggerTs;
            }
            // Sleep 開關（cheat）：持續到 --wake 才解除，發訊息不會喚醒
            st._forceSleep = !!force.forceSleep;
            // Freeze 開關（cheat）：凍結自動進化，持續到 --unfreeze（手動 evolve 不受影響）
            st._freezeEvolve = !!force.freezeEvolve;
            // 自動戰鬥開關（cheat）：vpet battle off 停用 prompt 後自動戰鬥（手動 vpet battle 不受影響）
            st._noAutoBattle = !!force.autoBattleOff;
            // Card token：cheat 顯示狀態卡（不排隊：trigger 當下若被長動畫擋住直接丟；睡覺不算阻擋）
            if (force.cardTriggerTs && force.cardTriggerTs !== st.lastCardTriggerTs) {
                const age = Date.now() - force.cardTriggerTs;
                const blocked = (st.battleStartStep >= 0) || (st.evoStartStep >= 0) || (st.cardStartStep >= 0);
                if (age >= 0 && age < 10000 && !blocked) {
                    st._forceCard = true;
                }
                st.lastCardTriggerTs = force.cardTriggerTs;
            }
            // 進化歷程 tree（vpet tree）：同 card，trigger 當下若被長動畫擋住直接丟
            if (force.treeTriggerTs && force.treeTriggerTs !== st.lastTreeTriggerTs) {
                const age = Date.now() - force.treeTriggerTs;
                const blocked = (st.battleStartStep >= 0) || (st.evoStartStep >= 0);
                if (age >= 0 && age < 10000 && !blocked) st._forceTree = true;
                st.lastTreeTriggerTs = force.treeTriggerTs;
            }
        } catch(e) {}

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
        if (st.evoStartStep != null && st.evoStartStep >= 0) {
            const targetElapsed = step - st.evoStartStep;
            const prevShown     = st.evoShownElapsed ?? -1;
            const wouldAdvance  = Math.min(targetElapsed, prevShown + 1);
            if (wouldAdvance >= EVO_LENGTH) {
                st.characterId = st.evoNextCharId || st.characterId;
                st.evoStartStep = -1;
                st.evoNextCharId = null;
                st.evoShownElapsed = -1;
                delete st.exprStartStep; delete st.roarStartStep; delete st.lastStepSeen; delete st.happyStartStep;
                delete st.trainingBonus;  // 進化歸零
                delete st.battleTotalCount; delete st.battleWinCount; delete st.lastBattleCountedStartStep;  // 勝率歸零
                // 清掉 force.character，避免下次 refresh 把角色拉回進化前 → 形成「進化→拉回→進化」無限迴圈
                try {
                    const f = JSON.parse(fs.readFileSync(FORCE_FILE, 'utf8'));
                    delete f.character; delete f.resetCostBase;
                    fs.writeFileSync(FORCE_FILE, JSON.stringify(f));
                } catch(e) {}
            }
        }

        const { charDef, artFile, bulletArtFile, cutinArtFile, config } = loadCharacter(st.characterId);

        // characterId 此刻已定案 → 維護進化歷史（給 vpet tree 用；自然進化 append、斷點重設、空補種）
        updateEvoHistory(st);

        // 1.5 cheat trigger：reset 掉落表演（角色已切換成新 starter，演出空降）
        if (st._forceDrop && !(st.dropStartStep >= 0) && !(st.evoStartStep >= 0)) {
            st.dropStartStep = step;
            st.dropShownElapsed = -1;
            delete st._forceDrop;
            st.battleStartStep = -1; st.battleEnemy = null; st.battlePending = false;  // 互斥
            delete st.exprStartStep; delete st.roarStartStep; delete st.happyStartStep;
        }

        // 2. cheat trigger：強制進化
        if (st._forceEvolve && !(st.evoStartStep >= 0)) {
            st.evoStartStep = step;
            st.evoNextCharId = st._forceEvolve;
            st.evoShownElapsed = -1;
            delete st._forceEvolve;
            st.battleStartStep = -1; st.battleEnemy = null; st.battlePending = false;
            delete st.exprStartStep; delete st.roarStartStep; delete st.happyStartStep;
        }
        // 3. 自然觸發：checkEvolution 命中（freeze 凍結時跳過，cost 仍累積，解除後達標即進化）
        if (!(st.evoStartStep >= 0) && !st._freezeEvolve) {
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
            const dustRows = getSharedFrame(loadShared(), 'dust', 0);   // 未畫時為空白 → 不顯示煙塵
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

        saveState(STATE_FILE, st);

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
