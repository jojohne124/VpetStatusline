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
    loadCharacter, loadShared,
    renderCells, flipRows, getFacingRows, composeBattleScene, composeEvoScene,
} = require('./agumon-core');

const STATE_FILE = path.join(STATE_DIR, 'color-state.json');
const FORCE_FILE = path.join(STATE_DIR, 'force-char.json');

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
                    if (force.resetCostBase) st._evoCostBase = i.cost?.total_cost_usd ?? 0;
                }
            }
            // Battle token：trigger 時間戳不同於本視窗上次看過的，且 10 秒內仍有效，才觸發
            if (force.battleTriggerTs && force.battleTriggerTs !== st.lastBattleTriggerTs) {
                const age = Date.now() - force.battleTriggerTs;
                if (age >= 0 && age < 10000 && !(st.battleStartStep >= 0)) {
                    st._forceBattle = true;
                    if (typeof force.forceBattleWin === 'boolean')   st._forceBattleWin   = force.forceBattleWin;
                    if (typeof force.forceBattleEnemy === 'string')  st._forceBattleEnemy = force.forceBattleEnemy;
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
        if (st.evoStartStep != null && st.evoStartStep >= 0 && (step - st.evoStartStep) >= EVO_LENGTH) {
            st.characterId = st.evoNextCharId || st.characterId;
            st.evoStartStep = -1;
            st.evoNextCharId = null;
            delete st.exprStartStep; delete st.roarStartStep; delete st.lastStepSeen; delete st.happyStartStep;
            // 清掉 force.character，避免下次 refresh 把角色拉回進化前 → 形成「進化→拉回→進化」無限迴圈
            try {
                const f = JSON.parse(fs.readFileSync(FORCE_FILE, 'utf8'));
                delete f.character; delete f.resetCostBase;
                fs.writeFileSync(FORCE_FILE, JSON.stringify(f));
            } catch(e) {}
        }

        const { charDef, artFile, bulletArtFile, config } = loadCharacter(st.characterId);

        // 2. cheat trigger：強制進化
        if (st._forceEvolve && !(st.evoStartStep >= 0)) {
            st.evoStartStep = step;
            st.evoNextCharId = st._forceEvolve;
            delete st._forceEvolve;
            st.battleStartStep = -1; st.battleEnemy = null; st.battlePending = false;
            delete st.exprStartStep; delete st.roarStartStep; delete st.happyStartStep;
        }
        // 3. 自然觸發：checkEvolution 命中
        if (!(st.evoStartStep >= 0)) {
            const nextChar = checkEvolution(st, i, config);
            if (nextChar) {
                st.evoStartStep = step;
                st.evoNextCharId = nextChar;
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
                const shared          = loadShared();

                outputLines = composeBattleScene({
                    frame:            result,
                    meArt,
                    enemyArt,
                    meBulletArt,
                    enemyBulletArt,
                    shared,
                    meRightOffset:    charDef.RIGHT_OFFSET,
                    enemyRightOffset: enemyChar?.charDef?.RIGHT_OFFSET ?? null,
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

        if (result.kind === 'single' && !outputLines) {
            const { frameIdx, facing } = result;
            const art = tryLoadArt(artFile);
            if (art) {
                const rows = getFacingRows(art, frameIdx, facing, charDef.RIGHT_OFFSET);
                if (rows) outputLines = renderCells(rows);
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
