#!/usr/bin/env node
'use strict';
/**
 * 驗證牧場（docs/ranch-spec.md）。
 *
 * 重點只有一個：**交換不能弄丟成長資料**。
 * 現有的換角色路徑會清掉 trainingBonus / 勝率 / tagStats / stats / mood /
 * evoHistory / 進化條件 latch，牧場交換若不小心走上那條路，玩家把 WarGreymon
 * 拿回來會發現訓練值 0 —— 而且不會有任何錯誤訊息，只是幾十小時無聲消失。
 * 這種 bug 沒有測試就等著發生。
 *
 * 用法：node scripts/test-ranch.js
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const INSTALLED = path.join(os.homedir(), '.claude', 'agumon-statusline', 'agumon-core.js');
let core;
try { core = require(INSTALLED); }
catch (e) { core = require('../src/runtime/agumon-core.js'); }

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };

const TMP   = path.join(os.tmpdir(), `vpet-ranch-test-${process.pid}`);
fs.mkdirSync(TMP, { recursive: true });
const RANCH = path.join(TMP, 'ranch.json');
const FORCE = path.join(TMP, 'force.json');
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} };

// 一隻「養了很久」的桌寵：每一個欄位都是玩家花時間累積出來的
function veteran() {
    return {
        characterId: 'wargreymon',
        trainingBonus: 37,
        inheritedPower: 210,
        birthAt: 1_700_000_000_000,
        lastEvolveAt: 1_700_500_000_000,
        battleTotalCount: 73, battleWinCount: 47,
        tagStats: { GodZilla: { b: 10, w: 4 } },
        stats: { petRefuse: { n: 1, t: 123 } },
        lifeStats: { petWake: { n: 5, t: 456 } },
        mood: 2,
        evoHistory: ['agumon', 'greymon', 'metalgreymon', 'wargreymon'],
        _evo_0_ready: true, _r5hPeaked: true, _r5hResetAt: 1_700_600_000,
        _evoSpendBySession: { abc: { s: 12.5 } },
        // 以下是暫態，收進牧場時應該丟掉
        // （battleStartStep 用 -1 = 沒在打，否則會被「表演中不動牧場」的保護擋下來）
        battleStartStep: -1, evoShownElapsed: 3, walkPhaseOffset: 29,
        lastPetTriggerTs: 999, _forceBattle: true, pvpMeLabel: '阿張',
        lastActivityAt: 1_700_700_000_000, _albumLast: 'wargreymon',
    };
}

const GROWTH_KEYS = ['characterId', 'trainingBonus', 'inheritedPower', 'birthAt', 'lastEvolveAt',
    'battleTotalCount', 'battleWinCount', 'tagStats', 'stats', 'lifeStats', 'mood',
    'evoHistory', '_evo_0_ready', '_r5hPeaked', '_r5hResetAt', '_evoSpendBySession'];

// ── 1. 快照：成長欄位一個都不能少，暫態欄位一個都不能留 ────────────────
console.log('— 快照 —');
{
    const st = veteran();
    const snap = core.snapshotPet(st);
    const lost = GROWTH_KEYS.filter(k => JSON.stringify(snap[k]) !== JSON.stringify(st[k]));
    ok(lost.length === 0, `快照弄丟了成長欄位：${lost.join(', ')}`);

    const leaked = ['battleStartStep', 'evoShownElapsed', 'walkPhaseOffset', 'lastPetTriggerTs',
                    '_forceBattle', 'pvpMeLabel', 'lastActivityAt', '_albumLast']
                   .filter(k => k in snap);
    ok(leaked.length === 0, `快照留下了暫態欄位：${leaked.join(', ')}`);

    // 深拷貝：之後改現役不能動到牧場裡那份
    st.tagStats.GodZilla.b = 999;
    ok(snap.tagStats.GodZilla.b === 10, '快照是淺拷貝 —— 改現役會連牧場裡那份一起改');
}

// ── 2. 還原：舊角色的欄位不可以殘留 ────────────────────────────────────
console.log('— 還原 —');
{
    const snap = core.snapshotPet(veteran());
    // 現役是一隻剛抽到的新寵物，身上沒有 inheritedPower / evoHistory
    const st = { characterId: 'agumon', trainingBonus: 2, birthAt: 1, lastEvolveAt: 1,
                 walkPhaseOffset: 7, lastActivityAt: 123 };
    core.restorePet(st, snap);
    ok(st.characterId === 'wargreymon' && st.trainingBonus === 37, '還原後不是牧場裡那隻');
    ok(st.walkPhaseOffset === 7, '還原把走路相位也蓋掉了（那是這個視窗的，不屬於任何一隻）');

    // 反向：新的沒有、舊的有的欄位要被清掉
    const st2 = { characterId: 'agumon', inheritedPower: 999, evoHistory: ['agumon'],
                  _evo_9_ready: true, trainingBonus: 1 };
    core.restorePet(st2, { characterId: 'gabumon', trainingBonus: 5 });
    ok(!('inheritedPower' in st2), '舊角色的 inheritedPower 殘留 → 兩隻的狀態混在一起');
    ok(!('_evo_9_ready' in st2), '舊角色的進化 latch 殘留');
    ok(st2.evoHistory === undefined, '舊角色的 evoHistory 殘留');
}

// ── 3. keep：收進牧場 + 換新角色，成長資料要留在牧場裡 ─────────────────
console.log('— keep —');
{
    fs.writeFileSync(RANCH, JSON.stringify({ v: 1, cap: 8, pets: [] }));
    const st = veteran();
    const ts = Date.now();
    fs.writeFileSync(FORCE, JSON.stringify({ ranchTriggerTs: ts, ranchOp: { op: 'keep' } }));
    const r = core.applyRanchOp(st, JSON.parse(fs.readFileSync(FORCE, 'utf8')), RANCH);
    ok(r && r.op === 'keep', 'keep 沒有執行');

    const ranch = core.loadRanch(RANCH);
    ok(ranch.pets.length === 1, `牧場應有 1 隻，實際 ${ranch.pets.length}`);
    const kept = ranch.pets[0].state;
    const lost = GROWTH_KEYS.filter(k => JSON.stringify(kept[k]) !== JSON.stringify(veteran()[k]));
    ok(lost.length === 0, `收進牧場時弄丟：${lost.join(', ')}`);
    ok(typeof ranch.pets[0].id === 'string' && ranch.pets[0].id.length >= 4, 'id 沒有產生');

    // 同一筆 trigger 重放不該再收一次
    core.applyRanchOp(st, JSON.parse(fs.readFileSync(FORCE, 'utf8')), RANCH);
    ok(core.loadRanch(RANCH).pets.length === 1, '同一筆 ranchTriggerTs 重放又收了一隻');
}

// ── 4. swap：一進一出，兩邊的狀態都要完整 ──────────────────────────────
console.log('— swap —');
{
    const kept = core.snapshotPet(veteran());
    fs.writeFileSync(RANCH, JSON.stringify({ v: 1, cap: 8,
        pets: [{ id: 'aaa11', keptAt: 1, state: kept }] }));
    // 現役是另一隻，也養了一陣子
    const st = { characterId: 'greymon', trainingBonus: 11, battleTotalCount: 9,
                 battleWinCount: 5, birthAt: 5, lastEvolveAt: 6, walkPhaseOffset: 3 };
    const ts = Date.now();
    const r = core.applyRanchOp(st, { ranchTriggerTs: ts, ranchOp: { op: 'swap', id: 'aaa11' } }, RANCH);
    ok(r && r.op === 'swap', 'swap 沒有執行');

    // 出來的那隻
    const lost = GROWTH_KEYS.filter(k => JSON.stringify(st[k]) !== JSON.stringify(veteran()[k]));
    ok(lost.length === 0, `叫出來的那隻弄丟：${lost.join(', ')}`);

    // 進去的那隻
    const ranch = core.loadRanch(RANCH);
    ok(ranch.pets.length === 1, `交換後牧場數量應不變，實際 ${ranch.pets.length}`);
    const stored = ranch.pets[0].state;
    ok(stored.characterId === 'greymon' && stored.trainingBonus === 11 && stored.battleWinCount === 5,
       '收進去那隻的成長資料不完整');
    ok(ranch.pets[0].id !== 'aaa11', 'id 沒有換新（同一個 id 會跟已取出的那隻撞號）');
}

// ── 5. 上限與 release ──────────────────────────────────────────────────
console.log('— 上限 / release —');
{
    const full = { v: 1, cap: 2, pets: [
        { id: 'a', keptAt: 1, state: { characterId: 'agumon' } },
        { id: 'b', keptAt: 2, state: { characterId: 'gabumon' } },
    ] };
    fs.writeFileSync(RANCH, JSON.stringify(full));
    const st = veteran();
    core.applyRanchOp(st, { ranchTriggerTs: Date.now(), ranchOp: { op: 'keep' } }, RANCH);
    ok(core.loadRanch(RANCH).pets.length === 2, '滿了還是收得進去（應該要拒絕）');

    // 滿的時候 swap 仍要可用（一進一出，數量不變）
    const st2 = { characterId: 'greymon' };
    core.applyRanchOp(st2, { ranchTriggerTs: Date.now() - 1, ranchOp: { op: 'swap', id: 'a' } }, RANCH);
    ok(st2.characterId === 'agumon', '牧場滿的時候 swap 失敗了（一進一出不該受上限影響）');
    ok(core.loadRanch(RANCH).pets.length === 2, 'swap 之後數量變了');

    // release
    const before = core.loadRanch(RANCH).pets.length;
    core.applyRanchOp({}, { ranchTriggerTs: Date.now() - 2, ranchOp: { op: 'release', id: 'b' } }, RANCH);
    ok(core.loadRanch(RANCH).pets.length === before - 1, 'release 沒有刪掉');
    ok(!core.loadRanch(RANCH).pets.some(p => p.id === 'b'), 'release 刪錯人');
}

// ── 6. 表演中不動牧場 ──────────────────────────────────────────────────
console.log('— 表演中 —');
{
    fs.writeFileSync(RANCH, JSON.stringify({ v: 1, cap: 8,
        pets: [{ id: 'zzz', keptAt: 1, state: { characterId: 'agumon' } }] }));
    // 交換會把 st 整包換掉，正在播的戰鬥會接到不存在的對手
    const st = { characterId: 'greymon', battleStartStep: 100 };
    core.applyRanchOp(st, { ranchTriggerTs: Date.now(), ranchOp: { op: 'swap', id: 'zzz' } }, RANCH);
    ok(st.characterId === 'greymon', '戰鬥表演中還是換了角色');
    ok(core.loadRanch(RANCH).pets.length === 1, '戰鬥表演中還是動了牧場');
}

// ── 7. 壞掉的 ranch.json 不能讓整個流程炸掉 ────────────────────────────
console.log('— 容錯 —');
{
    fs.writeFileSync(RANCH, '{ 這不是 JSON');
    const r = core.loadRanch(RANCH);
    ok(r && Array.isArray(r.pets) && r.pets.length === 0, '壞掉的 ranch.json 沒有退回空牧場');
    ok(!('nonexistent' in core.loadRanch(path.join(TMP, 'nope.json'))), '讀不到的檔案應退回空牧場');

    // 指定不存在的 id → 什麼都不做，不能拋例外
    fs.writeFileSync(RANCH, JSON.stringify({ v: 1, cap: 8, pets: [] }));
    const st = { characterId: 'greymon' };
    let threw = false;
    try { core.applyRanchOp(st, { ranchTriggerTs: Date.now(), ranchOp: { op: 'swap', id: '不存在' } }, RANCH); }
    catch (e) { threw = true; }
    ok(!threw, 'swap 到不存在的 id 會拋例外');
    ok(st.characterId === 'greymon', 'swap 失敗卻改了現役');
}

// ── 8. 院子（階段 2）─────────────────────────────────────────────────
console.log('— 院子 —');
{
    const P = require('../src/daemon/plaza.js');
    const W = require('../src/shared/plaza-walk.js');
    const hasArt = (() => { try { return !!P.loadArt(core, 'agumon'); } catch (e) { return false; } })();
    if (!hasArt) { console.log('  – 讀不到角色美術，跳過'); }
    else {
        const ranch = { v: 1, cap: 8, pets: [
            { id: 'aaa11', keptAt: 1, state: { characterId: 'wargreymon' } },
            { id: 'bbb22', keptAt: 2, state: { characterId: 'renamon' } },
        ] };
        const step = W.stepAt(Date.now());
        const out = P.composeYard(core, ranch, { characterId: 'greymon' }, step, { caches: new Map() });
        // 院子與廣場是不同的場地，尺寸各自決定 —— 這裡順便釘住「院子確實比廣場大」，
        // 免得日後有人把 field 參數拿掉又退回共用同一組常數。
        const F = W.YARD_FIELD;
        ok(out && out.lines.length === F.h / 2, `院子列數應為 ${F.h / 2}，實際 ${out && out.lines.length}`);
        ok(out.lines[0].replace(/\[[0-9;]*m/g, '').length === F.w, `院子欄數應為 ${F.w}`);
        ok(F.w > W.PLAZA_W && F.h > W.PLAZA_H, '院子沒有比廣場大');
        // 院子只有「收起來的那些」。現役正在你身邊過生活，不在冰箱裡 ——
        // 兩邊都出現的話看不出「收進去」和「拿出來」的差別。
        ok(out.placed.length === 2, `院子應只有 2 隻收藏，實際 ${out.placed.length}`);
        ok(!out.placed.some(p => p.char === 'greymon'), '現役跑進院子裡了');
        // 院子是自己的地方，不該有野生 vpet 亂入
        ok(!out.placed.some(p => String(p.key).startsWith('npc:')), '院子出現了 NPC');

        // 空的就回 null，讓呼叫端自己決定顯示什麼（而不是畫一張空圖，那看起來像壞掉）
        ok(P.composeYard(core, { pets: [] }, null, step, {}) === null, '空牧場應回 null');
        ok(P.composeYard(core, { pets: [] }, { characterId: 'agumon' }, step, {}) === null,
           '牧場空時就算有現役也該回 null（現役不算院子成員）');

        // 院子的場地比較大 → 走位不能沿用廣場的界限
        let oob = 0;
        for (let k = 0; k < 300; k++) {
            const o = P.composeYard(core, ranch, null, step + k, { caches: new Map() });
            for (const q of o.placed) {
                if (q.x < F.minX || q.x > F.maxX || q.y < F.minY || q.y > F.maxY) oob++;
            }
        }
        ok(oob === 0, `院子裡走出界 ${oob} 次`);

        // 走位要連續：長駐的快取與剛開的視窗必須算出同一個位置
        const warm = new Map(); let diff = 0;
        for (let k = 0; k < 200; k++) {
            const a = P.composeYard(core, ranch, { characterId: 'greymon' }, step + k, { caches: warm });
            if (k % 61 === 0) {
                const b = P.composeYard(core, ranch, { characterId: 'greymon' }, step + k, { caches: new Map() });
                if (JSON.stringify(a.placed.map(p => [p.key, p.x, p.y]))
                 !== JSON.stringify(b.placed.map(p => [p.key, p.x, p.y]))) diff++;
            }
        }
        ok(diff === 0, `院子的走位在有無快取時不一致（${diff} 次）`);
    }
}

// ── 9. 重播上限：呼叫端傳爛參數不可以讓伺服器卡死 ──────────────────────
console.log('— 重播上限 —');
{
    const W = require('../src/shared/plaza-walk.js');
    // joinStep=0 + 牆鐘 step ≈ 24 億拍。沒有上限保護的話 posAt 會跑一億多次同步迴圈，
    // 把整個 event loop 卡住 —— 實際發生過，連無關的 /state 都一起停擺。
    const t0 = Date.now();
    const p = W.posAt({ seed: 1, joinStep: 0 }, W.stepAt(Date.now()), null);
    const ms = Date.now() - t0;
    ok(ms < 500, `極端 joinStep 花了 ${ms}ms（應該被 MAX_REPLAY 擋下來）`);
    ok(p.x >= W.MIN_X && p.x <= W.MAX_X && p.y >= W.MIN_Y && p.y <= W.MAX_Y, '重播上限之後位置出界');
}

cleanup();
console.log(`\n結果：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
