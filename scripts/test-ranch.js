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
    const CAP = core.ranchCap();
    // ⚠️ 塞滿要用 ranchCap() 而不是在檔案裡寫一個小 cap ——
    // 上限是產品設定、不吃存檔（見 loadRanch 的說明），檔案裡寫 cap 沒有任何作用。
    const full = { v: 1, pets: Array.from({ length: CAP }, (_, i) => (
        { id: 'p' + i, keptAt: i + 1, state: { characterId: i % 2 ? 'gabumon' : 'agumon' } })) };
    fs.writeFileSync(RANCH, JSON.stringify(full));
    const st = veteran();
    core.applyRanchOp(st, { ranchTriggerTs: Date.now(), ranchOp: { op: 'keep' } }, RANCH);
    ok(core.loadRanch(RANCH).pets.length === CAP, `滿了（${CAP}）還是收得進去（應該要拒絕）`);

    // 存檔裡的 cap 一律不作數：舊檔存過 cap:8，改常數若被它蓋掉，既有玩家完全不受影響
    fs.writeFileSync(RANCH, JSON.stringify({ v: 1, cap: 99, pets: full.pets }));
    core.applyRanchOp(veteran(), { ranchTriggerTs: Date.now() - 3, ranchOp: { op: 'keep' } }, RANCH);
    ok(core.loadRanch(RANCH).pets.length === CAP, '存檔裡的 cap 蓋過了常數（上限不該吃存檔）');
    ok(!('cap' in core.loadRanch(RANCH)), 'loadRanch 應該把舊的 cap 欄位丟掉');

    // 滿的時候 swap 仍要可用（一進一出，數量不變）
    const st2 = { characterId: 'greymon' };
    core.applyRanchOp(st2, { ranchTriggerTs: Date.now() - 1, ranchOp: { op: 'swap', id: 'p0' } }, RANCH);
    ok(st2.characterId === 'agumon', '牧場滿的時候 swap 失敗了（一進一出不該受上限影響）');
    ok(core.loadRanch(RANCH).pets.length === CAP, 'swap 之後數量變了');

    // release
    const before = core.loadRanch(RANCH).pets.length;
    core.applyRanchOp({}, { ranchTriggerTs: Date.now() - 2, ranchOp: { op: 'release', id: 'p1' } }, RANCH);
    ok(core.loadRanch(RANCH).pets.length === before - 1, 'release 沒有刪掉');
    ok(!core.loadRanch(RANCH).pets.some(p => p.id === 'p1'), 'release 刪錯人');
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
        // 寬度對齊家裡的舞台（BASE_COLS = 52）—— 兩個畫面在同一個版位切換，
        // 寬度一樣才不會每按一次按鈕整頁就跳一下。
        ok(F.w === 52, `院子寬度應與前線舞台同寬（52），實際 ${F.w}`);
        ok(F.maxX > 0 && F.maxY > 0, '院子小到放不下一隻角色');
        // 院子只有「收起來的那些」。現役正在你身邊過生活，不在冰箱裡 ——
        // 兩邊都出現的話看不出「收進去」和「拿出來」的差別。
        ok(out.placed.length === 2, `院子應只有 2 隻收藏，實際 ${out.placed.length}`);
        ok(!out.placed.some(p => p.char === 'greymon'), '現役跑進院子裡了');
        // 院子是自己的地方，不該有野生 vpet 亂入
        ok(!out.placed.some(p => String(p.key).startsWith('npc:')), '院子出現了 NPC');

        // 院子不畫名牌：52 dot 寬塞 8 隻，名牌會互相擠掉一半，要知道是誰改用右鍵選單。
        let labelCount = 0;
        for (const [, l] of out.labels) labelCount += l.length;
        ok(labelCount === 0, `院子畫了 ${labelCount} 個名牌（應該一個都沒有）`);
        // 右鍵選單靠這兩個欄位做命中判定與送指令
        ok(out.placed.every(p => p.ranchId && p.name), '院子成員缺 ranchId / name（右鍵選單會壞）');
        // 不留名牌位 → 可走高度要比留的時候多 2
        ok(F.maxY === F.h - W.SPRITE, `院子不該保留名牌位（maxY=${F.maxY}，應為 ${F.h - W.SPRITE}）`);

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

// ── 牧場裡的時間類進化（大便獸彩蛋）──────────────────────────────
// 「任一幼年期在牧場放置 48 小時 → 大便獸」。這裡最該釘住的是**不該觸發時不觸發**：
// 誤觸的代價是玩家的收藏被無聲換成別的角色，而且不可逆。
console.log('— 特殊進化（牧場時效）—');
{
    const H = 3600e3;
    const RULES = path.join(TMP, 'special-evolutions.json');
    const ALBUM = path.join(TMP, 'album.json');
    // 目標必須是 roster 成員才會生效。這裡借一隻穩定存在的 Adult 當替身，
    // 不用 sukamon —— 測試不該綁在「某個彩蛋角色目前有沒有實裝」上。
    const TO = 'greymon';
    const rule = (extra = {}) => {
        fs.writeFileSync(RULES, JSON.stringify({ rules: [{
            id: 'test-neglect', to: TO, fromStage: 'Child',
            conditions: [{ type: 'ranch_hours', hours: 48 }], ...extra }] }));
    };
    const child = (over = {}) => ({
        characterId: 'agumon', trainingBonus: 12, battleTotalCount: 9, battleWinCount: 5,
        mood: 2, stats: { x: { n: 1, t: 2 } }, evoHistory: ['agumon'], ...over,
    });
    const put = (keptAgoH, state) => {
        fs.writeFileSync(RANCH, JSON.stringify({ cap: 8, seq: 1, pets: [
            { id: 'r1', keptAt: Date.now() - keptAgoH * H, state } ] }));
    };
    const load = () => JSON.parse(fs.readFileSync(RANCH, 'utf8')).pets[0];
    const age = (o = {}) => core.applyRanchAging(null, RANCH,
                                                 { rulesFile: RULES, albumFile: ALBUM, ...o });

    rule();
    put(49, child());
    const ch = age();
    ok(ch && ch.length === 1 && ch[0].to === TO, '放了 49 小時應該要變');
    {
        const p1 = load();
        ok(p1.state.characterId === TO, '角色沒有換成目標');
        ok(p1.evolvedFrom === 'agumon', '沒有記下原本是誰（右鍵選單要顯示，不然像收藏不見了）');
        // 比照正常進化 commit：訓練值 / 勝率 / 隱藏統計 / 心情全部歸零
        ok(p1.state.trainingBonus === undefined && p1.state.battleTotalCount === undefined
           && p1.state.mood === undefined && p1.state.stats === undefined,
           '應比照正常進化把本階段資料歸零');
        // 血緣要接上，否則換出來時 updateEvoHistory 會判定斷點、把 tree 清成一格
        ok(JSON.stringify(p1.state.evoHistory) === JSON.stringify(['agumon', TO]),
           `evoHistory 沒接上（得到 ${JSON.stringify(p1.state.evoHistory)}）`);
        const alb = JSON.parse(fs.readFileSync(ALBUM, 'utf8'));
        ok(!!alb.chars[TO], '圖鑑沒登錄 —— 牠從沒當過現役，recordAlbumIfChanged 收不到');
    }
    ok(age() === null, '已經變過的不該再變一次');

    // ── 不該觸發的情況 ──
    rule();
    put(47, child());
    ok(age() === null, '47 小時不該觸發');
    ok(load().state.characterId === 'agumon', '47 小時卻已經被改掉');

    // 「中途取出就重製」＝ keep/swap 會新開一筆 keptAt。這裡直接驗那個語意：
    // 只要 keptAt 是新的，先前待多久都不算數。
    put(0.1, child());
    ok(age() === null, '剛收進去的不該觸發（取出再放回＝新的 keptAt）');

    rule();
    put(200, child({ characterId: 'greymon' }));   // Adult
    ok(age() === null, 'fromStage 不符（Adult）不該觸發');

    put(200, child({ characterId: TO }));
    ok(age() === null, '已經是目標角色的不該再觸發');

    // 看不懂的條件一律不成立 —— 寧可不觸發，也不要亂把人家的收藏變掉
    fs.writeFileSync(RULES, JSON.stringify({ rules: [{
        to: TO, fromStage: 'Child', conditions: [{ type: 'no_such_condition' }] }] }));
    put(200, child());
    ok(age() === null, '未知的條件型別不該觸發');

    // 未實裝的目標不生效 → 規則可以先寫好等美術再進 roster。
    // 這裡用一個一定不存在的 id，不要拿真角色 —— 拿 sukamon 的話，
    // 它一進 roster 這條測試就會無聲失效（本來就發生過：規則先寫、美術後補）。
    fs.writeFileSync(RULES, JSON.stringify({ rules: [{
        to: 'not-a-real-character', fromStage: 'Child',
        conditions: [{ type: 'ranch_hours', hours: 48 }] }] }));
    put(200, child());
    ok(age() === null, '目標不在 roster 時不該觸發（美術未進 roster 前規則應該是惰性的）');
    ok(load().state.characterId === 'agumon', '未實裝目標卻已經把角色改掉');

    // 沒有規則檔 = 沒有特殊進化，不是錯誤
    ok(core.applyRanchAging(null, RANCH, { rulesFile: path.join(TMP, 'nope.json') }) === null,
       '沒有規則檔時不該爆');

    // 節流：這條路徑每拍都會經過，48 小時的判定不需要每秒重算
    rule();
    put(49, child());
    const st = {};
    ok(core.applyRanchAging(st, RANCH, { rulesFile: RULES, albumFile: ALBUM }) !== null,
       '第一次應該要跑');
    put(49, child());
    ok(core.applyRanchAging(st, RANCH, { rulesFile: RULES, albumFile: ALBUM }) === null,
       `節流沒生效（${core.RANCH_AGE_CHECK_MS}ms 內不該重跑）`);
    ok(core.isRanchTransient('_ranchAgeCheckedAt'),
       '_ranchAgeCheckedAt 必須是暫態，否則會被存進快照跟著角色跑');

    // ⚠️ 老化不可以依賴 force-char.json 存在。
    // 第一版把 applyRanchAging 放在 applyForceFlags 讀完 force 檔之後，而那個 parse
    // 失敗就整個 return —— 「檔案不存在」是很正常的狀態（全新安裝、從沒下過 vpet 指令）。
    // 結果是測試全綠但真機上放了 Child 進牧場永遠不會變。真的踩過。
    {
        const S = path.join(TMP, 'st'); fs.mkdirSync(S, { recursive: true });
        const noForce = path.join(S, 'does-not-exist.json');
        rule();
        put(49, child());
        // applyForceFlags 用預設的 ranch/album 路徑，這裡只驗「有沒有跑到老化那一步」：
        // 換個角度 —— 直接確認 force 檔不存在時函式不會在老化之前就 return。
        const st2 = {};
        let ran = false;
        const orig = core.applyRanchAging;
        // 不能 monkey-patch（模組內部是直接呼叫），改用可觀察的副作用：
        // applyForceFlags 會在 st 上蓋 _ranchAgeCheckedAt，那個時戳只有老化路徑會寫。
        core.applyForceFlags(st2, noForce);
        ran = typeof st2._ranchAgeCheckedAt === 'number';
        void orig;
        ok(ran, 'force-char.json 不存在時，applyForceFlags 就沒跑到牧場老化（會提早 return）');
    }
}

cleanup();
console.log(`\n結果：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
