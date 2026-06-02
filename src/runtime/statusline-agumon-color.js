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
    renderCells, flipRows, overlayCells, composeSleepScene, composeStatusCard, getFacingRows, composeBattleScene, composeEvoScene, composeDropScene,
} = require('./agumon-core');

const STATE_FILE = path.join(STATE_DIR, 'color-state.json');
const FORCE_FILE = path.join(STATE_DIR, 'force-char.json');

// 把 _evoCostBase 重置到當前 cost，並啟動 5 秒 sticky 視窗（讓多視窗用各自 cost bump 到 max）
function tryResetEvoBase(st, i) {
    const cost = i.cost?.total_cost_usd;
    if (cost && cost > 0) {
        st._evoCostBase = cost;
        st._evoCheatStickyUntilMs = Date.now() + 5000;
        delete st._evoCostBasePending;
        return true;
    }
    return false;
}

// 安全讀取角色 art / bullet-art；失敗回 null
function tryLoadArt(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) { return null; }
}

let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
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
                    // cost 缺失/為 0 → pending；下次 refresh cost 有效再 reset。
                    // 否則 base=0 + 下次 cost=正常值 會讓 delta 立刻超門檻 → 切換後立即被誤觸發進化。
                    if (force.resetCostBase) {
                        if (!tryResetEvoBase(st, i)) st._evoCostBasePending = true;
                    }
                }
            }
            // 延後處理：上次 resetCostBase 時 cost 還沒有效
            if (st._evoCostBasePending) tryResetEvoBase(st, i);
            // Sticky：cheat 後 5 秒內，把 base 往上抬到任何視窗看到的 max cost。
            // 解決多視窗 race（每個視窗各自 cost 不同 → 後寫的覆蓋前寫的 → 用另一視窗較低 base 算 delta → 誤觸發進化）。
            if (st._evoCheatStickyUntilMs) {
                if (Date.now() < st._evoCheatStickyUntilMs) {
                    const cost = i.cost?.total_cost_usd;
                    if (cost && cost > (st._evoCostBase ?? 0)) st._evoCostBase = cost;
                } else {
                    delete st._evoCheatStickyUntilMs;
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
                const enemyArt        = enemyChar ? tryLoadArt(enemyChar.artFile) : null;
                const meBulletArt     = tryLoadArt(bulletArtFile);
                const enemyBulletArt  = enemyChar ? tryLoadArt(enemyChar.bulletArtFile) : null;
                const meCutInArt      = tryLoadArt(cutinArtFile);
                const enemyCutInArt   = enemyChar ? tryLoadArt(enemyChar.cutinArtFile) : null;
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
                    enemyRightOffset: enemyChar?.charDef?.RIGHT_OFFSET ?? null,
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

        if (result.kind === 'single' && !outputLines) {
            const { frameIdx, facing } = result;
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

        const maxStatusW = Math.max(...statusLines.map(visLen));
        const aguCol = result.kind === 'battle'
            ? maxStatusW + ANCHOR_GAP
            : maxStatusW + ANCHOR_GAP + (result.pos ?? 0);

        process.stdout.write(composeOutput(statusLines, outputLines, aguCol));
    } catch(e) {
        process.stdout.write('statusline-agumon-color: ' + e.message);
    }
});
