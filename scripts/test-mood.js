#!/usr/bin/env node
'use strict';
// 驗證心情（隱藏屬性，彩蛋性質的勝率控制）。
//   五級 -2..+2；摸摸 +1（夾 +2）、摸到不爽直接 -2、戰鬥表演結束歸 0、進化/換角色歸 0
//   勝率補正 心情 x 5%（clamp [5%,95%] 照舊）；走路 10% 表情：負只生氣、正只 exprs[0]
// 用法：node scripts/test-mood.js
//
// 注意：core 的 ASSETS_DIR 是相對它自己的位置算的 —— repo 樹下的 src/runtime/ 沒有 assets/，
// 所以要驗「真實 power / 真實 exprs」得用已安裝的那份（~/.claude/agumon-statusline）。
// 沒安裝就退回 repo 版，需要資產的幾節自動跳過（不算失敗），CI/新 clone 仍跑得動。
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const INSTALLED = path.join(os.homedir(), '.claude', 'agumon-statusline', 'agumon-core.js');
let core;
try { core = require(INSTALLED); }
catch (e) { core = require('../src/runtime/agumon-core.js'); }

let pass = 0, fail = 0, skip = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } };

const TMP = path.join(os.tmpdir(), `vpet-mood-test-${process.pid}.json`);
function pet(st, mood, ts) {
    fs.writeFileSync(TMP, JSON.stringify({ petTriggerTs: ts, petMood: mood }));
    core.applyForceFlags(st, TMP);
}

// ── 1. 純函數：夾範圍與 0 不落地 ──────────────────────────────────────
console.log('— 心情 API —');
{
    const st = {};
    ok(core.getMood(st) === 0, '未設定時應為 0');
    core.setMood(st, 5);   ok(core.getMood(st) === 2,  '超過上限應夾到 +2');
    core.setMood(st, -5);  ok(core.getMood(st) === -2, '超過下限應夾到 -2');
    core.setMood(st, 0);   ok(!('mood' in st), 'mood=0 應 delete（state 檔不長胖）');
    core.bumpMood(st, 1);  core.bumpMood(st, 1);  core.bumpMood(st, 1);
    ok(core.getMood(st) === 2, 'bumpMood 連加應夾在 +2');
}

// ── 2. 摸摸 / 不爽 ────────────────────────────────────────────────────
console.log('— 摸摸與不爽 —');
{
    const st = { characterId: 'greymon', lastActivityAt: Date.now() };
    let t = Date.now();
    pet(st, 'happy',  t++); ok(core.getMood(st) === 1,  '摸摸 → +1');
    pet(st, 'happy',  t++); ok(core.getMood(st) === 2,  '再摸 → +2');
    pet(st, 'happy',  t++); ok(core.getMood(st) === 2,  '第三次 → 仍夾在 +2');
    pet(st, 'refuse', t++); ok(core.getMood(st) === -2, '摸到不爽 → 直接 -2（不是遞減）');
    pet(st, 'happy',  t++); ok(core.getMood(st) === -1, '-2 摸一次 → -1（要摸回來得摸四次）');

    // 同一筆 trigger 重放不該再算一次（lastPetTriggerTs 去重）
    const st2 = { characterId: 'greymon', lastActivityAt: Date.now() };
    const ts  = t++;
    pet(st2, 'happy', ts); const m = core.getMood(st2);
    pet(st2, 'happy', ts); ok(core.getMood(st2) === m, '重放同一筆 petTriggerTs → 心情不再變');
}

// ── 3. 戰鬥表演結束歸零（同時確認勝率照常計入）───────────────────────
// decideAgumon 由 now 自行算 step（STEP_MS=1000），所以要餵遞增的 now。
console.log('— 戰鬥結束歸零 —');
{
    let charDef = null;
    try { charDef = core.loadCharacter('greymon').charDef; } catch (e) {}
    if (!charDef) { skip++; console.log('  – 讀不到資產，跳過'); }
    else {
        const STEP_MS = 1000;
        const step0 = Math.floor(Date.now() / STEP_MS);
        const st = { characterId: 'greymon', mood: 1, battleStartStep: step0,
                     battleEnemy: 'kabuterimon', battleWin: true,
                     battleShownElapsed: -1, battleVersion: 1 };
        let ended = false;
        for (let k = 0; k <= core.BATTLE_LENGTH + 4 && !ended; k++) {
            const now = (step0 + k) * STEP_MS;
            st.lastActivityAt = now;
            core.decideAgumon({}, st, now, charDef, { allowBattle: true });
            if (!(st.battleStartStep >= 0)) ended = true;
        }
        ok(ended, '戰鬥表演應正常播完（走 onEnd 而非 onExpired）');
        ok(core.getMood(st) === 0, '戰鬥結束 → 心情歸 0');
        ok(st.battleTotalCount === 1 && st.battleWinCount === 1, '勝率照常計入 1 勝 / 1 場');
    }
}

// ── 4. 進化 / 換角色歸零 ──────────────────────────────────────────────
console.log('— 進化與換角色 —');
{
    const st = { characterId: 'greymon', mood: -1, trainingBonus: 5 };
    core.resetStageStats(st);
    ok(core.getMood(st) === 0, 'resetStageStats → 心情歸 0');

    const st2 = { characterId: 'greymon', mood: 1, lastActivityAt: Date.now() };
    fs.writeFileSync(TMP, JSON.stringify({ character: 'agumon' }));
    core.applyForceFlags(st2, TMP);
    ok(st2.characterId === 'agumon' && core.getMood(st2) === 0, '換角色 → 心情歸 0');
}

// ── 5. 勝率補正（需要真實 power）───────────────────────────────────────
console.log('— 勝率補正 —');
{
    const powered = (() => { try { return core.getCharacterPower('wargreymon') > 100; } catch (e) { return false; } })();
    if (!powered) { skip++; console.log('  – 讀不到資產 power，跳過'); }
    else {
        const p = (my, en, mood) => core.computeWinProb(my, { characterId: my, trainingBonus: 0, mood }, en) * 100;
        const mid0 = p('zephagamon', 'ravemon', 0);
        const B = core.MOOD_WIN_BONUS_PCT;
        ok(Math.abs(p('zephagamon', 'ravemon', 1)  - (mid0 + B))     < 1e-6, '+1 應 +5 個百分點');
        ok(Math.abs(p('zephagamon', 'ravemon', -1) - (mid0 - B))     < 1e-6, '-1 應 -5 個百分點');
        ok(Math.abs(p('zephagamon', 'ravemon', 2)  - (mid0 + B * 2)) < 1e-6, '+2 應 +10 個百分點（每級 5）');
        ok(Math.abs(p('zephagamon', 'ravemon', -2) - (mid0 - B * 2)) < 1e-6, '-2 應 -10 個百分點');
        // clamp 邊界：頂到 95 / 撞到 5 時，心情不該把它推出界
        ok(p('wargreymon', 'agumon', 2) === 95, '打極弱敵仍夾在 95%（+2 不加碼）');
        ok(p('agumon', 'wargreymon', -2) === 5, '打極強敵仍夾在 5%（-2 不追殺）');
    }
}

// ── 6. 走路表情由心情決定 ─────────────────────────────────────────────
console.log('— 走路表情 —');
{
    let ch = null;
    try { ch = core.loadCharacter('agumon'); } catch (e) {}
    if (!ch) { skip++; console.log('  – 讀不到資產，跳過'); }
    else {
        const n = ch.config.exprs.length;
        const sample = (mood) => {
            const seen = new Set();
            for (let k = 0; k < 3000; k++) {
                const st = { characterId: 'agumon', lastActivityAt: Date.now(),
                             exprStartStep: -1, lastStepSeen: -1 };
                if (mood) st.mood = mood;
                core.decideAgumon({}, st, Date.now(), ch.charDef, { allowBattle: false });
                if (st.exprStartStep >= 0) seen.add(st.exprIdx);
            }
            return seen;
        };
        const neg = sample(-1), neg2 = sample(-2), zero = sample(0), pos = sample(1), pos2 = sample(2);
        ok(neg.size === 1 && neg.has(n - 1),  '-1 應只演最後一個表情（慣例 ANGRY）');
        ok(neg2.size === 1 && neg2.has(n - 1), '-2 同樣只演生氣（表情不分級數）');
        ok(pos.size === 1 && pos.has(0),      '+1 應只演 exprs[0]');
        ok(pos2.size === 1 && pos2.has(0),    '+2 同樣只演 exprs[0]');
        ok(zero.size === n,                   '0 應維持隨機（各個表情都出現過）');
    }
}

// ── 6. 睡覺中觸碰 = 叫醒，不是摸摸 ──────────────────────────────────────
// 以前是「叫醒 + 照演 happy/refuse + 心情 +1」：畫面會出現「跳一下又倒回去睡」，
// 而且趁牠睡著連點就能刷心情。現在自然睡只叫醒，vpet sleep 仍然叫不動。
console.log('— 睡覺中觸碰 —');
{
    const IDLE_MS = 600000;           // 與 agumon-core 的 IDLE_MS 一致
    const asleepAt = () => Date.now() - IDLE_MS - 60000;

    const st = { characterId: 'greymon', mood: 1, lastActivityAt: asleepAt() };
    pet(st, 'happy', Date.now());
    ok(core.getMood(st) === 1,  '睡覺中被碰 → 心情不變（不算一次摸摸）');
    ok(st._forceWake === true,  '睡覺中被碰 → 應該設 _forceWake');
    ok(!st._forceHappy && !st._forceRefuse, '睡覺中被碰 → 不該演 happy / refuse');

    // 連點在 daemon 那邊會判成 refuse；睡著時同樣只算叫醒，不能把心情打到底
    const st2 = { characterId: 'greymon', mood: 1, lastActivityAt: asleepAt() };
    pet(st2, 'refuse', Date.now());
    ok(core.getMood(st2) === 1, '睡覺中連點 → 心情也不該落底');
    ok(st2._forceWake === true && !st2._forceRefuse, '睡覺中連點 → 只叫醒');

    // 醒著照舊
    const st3 = { characterId: 'greymon', lastActivityAt: Date.now() };
    pet(st3, 'happy', Date.now());
    ok(core.getMood(st3) === 1 && st3._forceHappy === true, '醒著被摸 → 照舊 +1 並演 happy');

    // 強制睡（vpet sleep）契約是「叫不動」：連 _forceWake 都不該設
    const st4 = { characterId: 'greymon', mood: 1, lastActivityAt: asleepAt() };
    fs.writeFileSync(TMP, JSON.stringify({ petTriggerTs: Date.now(), petMood: 'happy', forceSleep: true }));
    core.applyForceFlags(st4, TMP);
    ok(!st4._forceWake && !st4._forceHappy, 'vpet sleep 中被碰 → 什麼都不做');
    ok(core.getMood(st4) === 1, 'vpet sleep 中被碰 → 心情不變');

    // 真的會醒：走一拍之後 lastActivityAt 更新、畫面不再是睡覺幀
    let charDef = null;
    try { charDef = core.loadCharacter('greymon').charDef; } catch (e) {}
    if (!charDef) { skip++; console.log('  – 讀不到資產，跳過「真的會醒」'); }
    else {
        const now = Date.now();
        const stw = { characterId: 'greymon', lastActivityAt: now - IDLE_MS - 60000, _forceWake: true };
        const f = core.decideAgumon({}, stw, now, charDef, {});
        ok(stw.lastActivityAt === now, '叫醒後 lastActivityAt 應更新成現在');
        ok(!(charDef.sleepFrames || []).includes(f.frameIdx), `叫醒後仍在演睡覺幀（frameIdx=${f.frameIdx}）`);
        ok(!('_forceWake' in stw), '_forceWake 應該用完就清掉（否則下一拍會重複計 petWake）');
        ok(core.getStat(stw, 'petWake') >= 1, '叫醒應計入 petWake 統計');

        // 強制睡走一拍：仍然在睡，而且旗標要被丟掉（不能留到 vpet wake 之後才爆發）
        const stf = { characterId: 'greymon', lastActivityAt: now - IDLE_MS - 60000,
                      _forceSleep: true, _forceWake: true, _forceHappy: true };
        const f2 = core.decideAgumon({}, stf, now, charDef, {});
        ok((charDef.sleepFrames || []).includes(f2.frameIdx), 'vpet sleep 中被碰 → 應該還在睡覺幀');
        ok(!('_forceWake' in stf) && !('_forceHappy' in stf), 'vpet sleep 應丟掉觸碰旗標，不留到之後爆發');
    }
}

try { fs.unlinkSync(TMP); } catch (e) {}
console.log(`\n結果：${pass} passed, ${fail} failed` + (skip ? `, ${skip} skipped` : ''));
process.exit(fail ? 1 : 0);
