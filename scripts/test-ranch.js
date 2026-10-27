#!/usr/bin/env node
'use strict';
/**
 * 驗證營地（docs/ranch-spec.md）。
 *
 * 重點只有一個：**交換不能弄丟成長資料**。
 * 現有的換角色路徑會清掉 trainingBonus / 勝率 / tagStats / stats / mood /
 * evoHistory / 進化條件 latch，營地交換若不小心走上那條路，玩家把 WarGreymon
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
// 前一次跑到一半掛掉會留下這個目錄，pid 又會重複 —— 不先清就會 EEXIST，
// 而且是「單獨跑好好的、整套跑才紅」那種查半天的假故障。
fs.rmSync(TMP, { recursive: true, force: true });
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
        // 以下是暫態，收進營地時應該丟掉
        // （battleStartStep 用 -1 = 沒在打，否則會被「表演中不動營地」的保護擋下來）
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

    // 深拷貝：之後改現役不能動到營地裡那份
    st.tagStats.GodZilla.b = 999;
    ok(snap.tagStats.GodZilla.b === 10, '快照是淺拷貝 —— 改現役會連營地裡那份一起改');
}

// ── 2. 還原：舊角色的欄位不可以殘留 ────────────────────────────────────
console.log('— 還原 —');
{
    const snap = core.snapshotPet(veteran());
    // 現役是一隻剛抽到的新寵物，身上沒有 inheritedPower / evoHistory
    const st = { characterId: 'agumon', trainingBonus: 2, birthAt: 1, lastEvolveAt: 1,
                 walkPhaseOffset: 7, lastActivityAt: 123 };
    core.restorePet(st, snap);
    ok(st.characterId === 'wargreymon' && st.trainingBonus === 37, '還原後不是營地裡那隻');
    ok(st.walkPhaseOffset === 7, '還原把走路相位也蓋掉了（那是這個視窗的，不屬於任何一隻）');

    // 反向：新的沒有、舊的有的欄位要被清掉
    const st2 = { characterId: 'agumon', inheritedPower: 999, evoHistory: ['agumon'],
                  _evo_9_ready: true, trainingBonus: 1 };
    core.restorePet(st2, { characterId: 'gabumon', trainingBonus: 5 });
    ok(!('inheritedPower' in st2), '舊角色的 inheritedPower 殘留 → 兩隻的狀態混在一起');
    ok(!('_evo_9_ready' in st2), '舊角色的進化 latch 殘留');
    ok(st2.evoHistory === undefined, '舊角色的 evoHistory 殘留');
}

// ── 3. keep：收進營地 + 換新角色，成長資料要留在營地裡 ─────────────────
console.log('— keep —');
{
    fs.writeFileSync(RANCH, JSON.stringify({ v: 1, cap: 8, pets: [] }));
    const st = veteran();
    const ts = Date.now();
    fs.writeFileSync(FORCE, JSON.stringify({ ranchTriggerTs: ts, ranchOp: { op: 'keep' } }));
    const r = core.applyRanchOp(st, JSON.parse(fs.readFileSync(FORCE, 'utf8')), RANCH);
    ok(r && r.op === 'keep', 'keep 沒有執行');

    const ranch = core.loadRanch(RANCH);
    ok(ranch.pets.length === 1, `營地應有 1 隻，實際 ${ranch.pets.length}`);
    const kept = ranch.pets[0].state;
    const lost = GROWTH_KEYS.filter(k => JSON.stringify(kept[k]) !== JSON.stringify(veteran()[k]));
    ok(lost.length === 0, `收進營地時弄丟：${lost.join(', ')}`);
    ok(typeof ranch.pets[0].id === 'string' && ranch.pets[0].id.length >= 4, 'id 沒有產生');
    ok(ranch.pets[0].keptMood === 2, '收進營地時沒記下那一刻的心情（大便獸的條件要看它）');

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
    ok(ranch.pets.length === 1, `交換後營地數量應不變，實際 ${ranch.pets.length}`);
    const stored = ranch.pets[0].state;
    ok(stored.characterId === 'greymon' && stored.trainingBonus === 11 && stored.battleWinCount === 5,
       '收進去那隻的成長資料不完整');
    ok(ranch.pets[0].id !== 'aaa11', 'id 沒有換新（同一個 id 會跟已取出的那隻撞號）');
}

console.log('— swap 只動被換的那一格 —');
{
    // 院子的走動區域照名單索引分（plaza.js yardOccupants）。換中間那隻，
    // 其他隻的位置（索引）與 id（走路 seed）都不能變，否則全營地一起瞬移。
    const mk = (id, ch) => ({ id, keptAt: 1, state: core.snapshotPet({ characterId: ch }) });
    fs.writeFileSync(RANCH, JSON.stringify({ v: 1, cap: 8,
        pets: [mk('p1', 'agumon'), mk('p2', 'gabumon'), mk('p3', 'palmon'), mk('p4', 'tentomon')] }));
    const st = { characterId: 'greymon' };
    core.applyRanchOp(st, { ranchTriggerTs: Date.now(), ranchOp: { op: 'swap', id: 'p2' } }, RANCH);
    const pets = core.loadRanch(RANCH).pets;
    ok(st.characterId === 'gabumon', 'swap 沒叫出指定那隻');
    ok(pets.length === 4, 'swap 之後數量變了');
    ok(pets[1].state.characterId === 'greymon', '收進去那隻沒放回原本那一格（第 2 格是 ' + pets[1].state.characterId + '）');
    ok(pets[1].id !== 'p2', '原地放回卻沿用舊 id（撞號）');
    ok(pets[0].id === 'p1' && pets[2].id === 'p3' && pets[3].id === 'p4',
       '其他隻的順序變了（全營地會換區瞬移）：' + pets.map(p => p.id).join(','));
}

// ── 5. 上限與 release ──────────────────────────────────────────────────
console.log('— 寫檔失敗不可以靜默 —');
{
    // 舊版的 atomicWrite 把所有失敗完全吞掉（catch 之後只刪 tmp）。那不是少一行 log ——
    // Windows 上 rename 蓋既有檔會偶發 EPERM/EBUSY（防毒即時掃描、搜尋索引、
    // 另一個 vpet 行程握著 handle），一次吞掉就是一次收進營地／放生／進化默默沒生效。
    //
    // 這是真的咬過才加的：完整測試套件同時在寫一堆檔時，test-ranch 偶爾紅在
    // 「寫了卻沒生效」，單獨跑永遠重現不了 —— 兩次的症狀都是「ranch.json 的寫入不見了」。
    const dir = path.join(TMP, 'aw');
    fs.mkdirSync(dir, { recursive: true });

    // atomicWrite 在 tick 路徑上，丟例外就是整個 tick 掛掉 —— 所以這裡一律包起來，
    // 讓「它丟例外了」變成一條紅字，而不是整支測試死掉、連結果都印不出來。
    const w = (f, d) => { try { return core.atomicWrite(f, d); } catch (e) { return 'THREW: ' + e.message; } };

    const good = path.join(dir, 'good.json');
    ok(w(good, '{"x":1}') === true, '正常寫入應該回 true');
    ok(fs.readFileSync(good, 'utf8') === '{"x":1}', '正常寫入的內容不對');

    // 寫不進去：拿資料夾當目標，rename 一定失敗
    const blocked = path.join(dir, 'blocked.json');
    fs.mkdirSync(blocked);
    ok(w(blocked, '{}') === false,
       '寫失敗卻回報成功 —— 呼叫端會以為存好了');
    ok(fs.existsSync(blocked + '.write-fail.log'),
       '寫失敗沒有留下任何痕跡（下次再遇到一樣查不出來）');
    ok(/EPERM|EACCES|EBUSY|EISDIR|ENOTDIR/.test(fs.readFileSync(blocked + '.write-fail.log', 'utf8')),
       '痕跡裡沒有錯誤碼，等於沒寫');

    // 失敗時不能留下垃圾 tmp
    const junk = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
    ok(junk.length === 0, `失敗後殘留了 ${junk.length} 個 .tmp`);

    // saveRanch 要把成敗傳出去（applyRanchOp 之後才有機會知道自己白做了）
    ok(core.saveRanch({ v: 1, pets: [] }, path.join(dir, 'r.json')) === true,
       'saveRanch 正常時應該回 true');
    ok(core.saveRanch({ v: 1, pets: [] }, blocked) === false,
       'saveRanch 失敗時應該回 false');

    // 暫時性錯誤要重試、永久性錯誤要立刻放棄 ——
    // 不分的話，磁碟滿了或路徑不合法時每次寫都要白等好幾十毫秒。
    //
    // ⚠️ 這條走了兩次冤枉路，寫下來免得再來一次：
    //    1. 第一版用「花了多久」比較 —— 抓不到「永久錯誤也重試」，因為不合法路徑
    //       就算重試 5 次也只有 20ms，還是短於被擋住那個的 69ms。
    //    2. 第二版改成從 .write-fail.log 讀次數，但**路徑本身太長時，那個 log 也寫不進去**
    //       （log 的路徑更長）。用路徑類的錯誤來測分類，天生測不到。
    //    所以分成兩條各測各的：暫時性看實際重試次數，分類本身直接驗表。
    const tries = (f) => {
        const L = fs.readFileSync(f + '.write-fail.log', 'utf8').trim().split('\n');
        return +(/tries=(\d+)/.exec(L[L.length - 1]) || [])[1];
    };
    w(blocked, '{}');
    ok(tries(blocked) > 1, `暫時性錯誤沒有重試（tries=${tries(blocked)}）`);
    ok(tries(blocked) === core.WRITE_RETRIES + 1,
       `重試次數與 WRITE_RETRIES 對不上（tries=${tries(blocked)}, 上限=${core.WRITE_RETRIES}）`);

    // 分類表：這幾個是 Windows 上「等一下就好」的（防毒/索引/別的行程握著 handle）
    for (const c of ['EPERM', 'EBUSY', 'EACCES'])
        ok(core.TRANSIENT_WRITE_ERRS.has(c), c + ' 應該算暫時性（Windows 上很常見，重試就過）');
    // 這幾個重試再多次也一樣，白等而已
    for (const c of ['ENOSPC', 'EROFS', 'ENAMETOOLONG', 'EISDIR'])
        ok(!core.TRANSIENT_WRITE_ERRS.has(c), c + ' 不該重試（再試幾次都一樣）');

    // 不管路徑多離譜都不可以丟例外 —— 這是寫檔路徑，丟出去就是整個 tick 掛掉
    ok(w(path.join(dir, 'x'.repeat(400) + '.json'), '{}') === false, '路徑不合法時應該回 false（或它直接丟了例外）');
}

console.log('— 收進營地失敗時不可以換角色 —');
{
    // keep 是「先把現役收起來，再抽新的」兩件事，而抽新的那件是靠 force.character。
    // 舊版把 applyRanchOp 的回傳值丟掉、force.character 照套 —— 收起來失敗時
    // 現役就被新角色蓋掉、而且沒進營地，**永久遺失**。
    // 這一節把三種失敗情況都跑過一遍。
    const FORCE = path.join(TMP, 'force-keep.json');
    const writeForce = (o) => fs.writeFileSync(FORCE, JSON.stringify(o));
    const fill = (n) => fs.writeFileSync(RANCH, JSON.stringify({ v: 1, pets:
        Array.from({ length: n }, (_, i) => ({ id: 'q' + i, keptAt: i + 1,
            state: { characterId: 'agumon' } })) }));
    const CAP = core.ranchCap();

    // (1) 營地已滿 —— 永久失敗
    fill(CAP);
    const st1 = { characterId: 'greymon' };
    writeForce({ ranchTriggerTs: Date.now(), ranchOp: { op: 'keep' }, character: 'gabumon' });
    core.applyForceFlags(st1, FORCE, RANCH);
    ok(core.loadRanch(RANCH).pets.length === CAP, '滿了還是收進去了');
    ok(st1.characterId === 'greymon',
       `滿了卻把現役換成 ${st1.characterId} —— 那隻沒進營地，永久遺失`);
    // 配對的「抽新的」要一起作廢，否則下一拍時戳過期、gate 失效，新角色會補上來蓋掉現役
    const f1 = JSON.parse(fs.readFileSync(FORCE, 'utf8'));
    ok(!f1.character, '永久失敗後 force.character 沒被清掉（下一拍還是會把現役蓋掉）');

    // (2) 表演播放中 —— 暫時失敗，指令要保留、下一拍再試
    fill(1);
    const st2 = { characterId: 'greymon', battleStartStep: 5 };
    const ts = Date.now();
    writeForce({ ranchTriggerTs: ts, ranchOp: { op: 'keep' }, character: 'gabumon' });
    core.applyForceFlags(st2, FORCE, RANCH);
    ok(core.loadRanch(RANCH).pets.length === 1, '表演中不該動營地');
    ok(st2.characterId === 'greymon',
       `表演中卻換了角色（${st2.characterId}）—— 現役被蓋掉且沒進營地`);
    ok(st2.lastRanchTriggerTs !== ts,
       '表演中就把指令用掉了 —— 動畫播完之後不會再試，等於整個吞掉');
    // 動畫播完 → 同一份 force 應該自然成功
    delete st2.battleStartStep;
    core.applyForceFlags(st2, FORCE, RANCH);
    ok(core.loadRanch(RANCH).pets.length === 2, '動畫播完之後沒有補做收進營地');
    ok(st2.characterId === 'gabumon', '收進去成功了卻沒換成新角色');
    ok(core.loadRanch(RANCH).pets.some(p => p.state.characterId === 'greymon'),
       '收進營地的不是原本那隻現役');

    // (3) 指令過期 —— 永久失敗
    fill(1);
    const st3 = { characterId: 'greymon' };
    writeForce({ ranchTriggerTs: Date.now() - 10 * 60 * 1000,
                 ranchOp: { op: 'keep' }, character: 'gabumon' });
    core.applyForceFlags(st3, FORCE, RANCH);
    ok(core.loadRanch(RANCH).pets.length === 1, '過期的指令被補做了');
    ok(st3.characterId === 'greymon', '過期卻換了角色 —— 現役遺失');

    // (4) 正常情況不能被擋到
    fill(1);
    const st4 = { characterId: 'greymon' };
    writeForce({ ranchTriggerTs: Date.now(), ranchOp: { op: 'keep' }, character: 'gabumon' });
    core.applyForceFlags(st4, FORCE, RANCH);
    ok(core.loadRanch(RANCH).pets.length === 2, '正常的收進營地被擋掉了');
    ok(st4.characterId === 'gabumon', '正常情況沒有換成新角色');

    // (5) 沒有 ranchOp 的單純換角色不該被波及
    fill(1);
    const st5 = { characterId: 'greymon' };
    writeForce({ character: 'gabumon' });
    core.applyForceFlags(st5, FORCE, RANCH);
    ok(st5.characterId === 'gabumon', '單純換角色被營地的 gate 擋掉了');

    // (6) gate 只該擋 keep。
    // ⚠️ 上面那條擋不住「把 gate 寫成『任何 ranch 操作失敗就不換角色』」——
    //    它根本沒有 ranchOp，壓根進不到 gate。要用**別的 op 失敗**才驗得到範圍。
    //    keep 之所以特殊，是因為只有它的「換角色」跟「收進營地」是配對的一件事。
    fill(1);
    const st6 = { characterId: 'greymon' };
    writeForce({ ranchTriggerTs: Date.now(),
                 ranchOp: { op: 'release', id: 'nope' },   // 找不到 → 失敗
                 character: 'gabumon' });
    core.applyForceFlags(st6, FORCE, RANCH);
    ok(core.loadRanch(RANCH).pets.length === 1, 'release 找不到卻刪掉了東西');
    ok(st6.characterId === 'gabumon',
       'release 失敗連帶把換角色也擋掉了 —— gate 應該只針對 keep');
}

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
    ok(st2.characterId === 'agumon', '營地滿的時候 swap 失敗了（一進一出不該受上限影響）');
    ok(core.loadRanch(RANCH).pets.length === CAP, 'swap 之後數量變了');

    // release
    const before = core.loadRanch(RANCH).pets.length;
    core.applyRanchOp({}, { ranchTriggerTs: Date.now() - 2, ranchOp: { op: 'release', id: 'p1' } }, RANCH);
    ok(core.loadRanch(RANCH).pets.length === before - 1, 'release 沒有刪掉');
    ok(!core.loadRanch(RANCH).pets.some(p => p.id === 'p1'), 'release 刪錯人');
}

// ── 6. 表演中不動營地 ──────────────────────────────────────────────────
console.log('— 表演中 —');
{
    fs.writeFileSync(RANCH, JSON.stringify({ v: 1, cap: 8,
        pets: [{ id: 'zzz', keptAt: 1, state: { characterId: 'agumon' } }] }));
    // 交換會把 st 整包換掉，正在播的戰鬥會接到不存在的對手
    const st = { characterId: 'greymon', battleStartStep: 100 };
    core.applyRanchOp(st, { ranchTriggerTs: Date.now(), ranchOp: { op: 'swap', id: 'zzz' } }, RANCH);
    ok(st.characterId === 'greymon', '戰鬥表演中還是換了角色');
    ok(core.loadRanch(RANCH).pets.length === 1, '戰鬥表演中還是動了營地');
    // 放生例外：不碰現役，前線在打也要馬上生效（不然營地按了放生，要等前線打完才消失）
    const r = core.applyRanchOp(st, { ranchTriggerTs: Date.now() + 1, ranchOp: { op: 'release', id: 'zzz' } }, RANCH);
    ok(r && r.ok === true && core.loadRanch(RANCH).pets.length === 0, '前線戰鬥中放生被延後了（營地裡的那隻遲遲不消失）');
    ok(st.characterId === 'greymon' && st.battleStartStep === 100, '放生動到了正在戰鬥的現役');
}

// ── 7. 壞掉的 ranch.json 不能讓整個流程炸掉 ────────────────────────────
console.log('— 容錯 —');
{
    fs.writeFileSync(RANCH, '{ 這不是 JSON');
    const r = core.loadRanch(RANCH);
    ok(r && Array.isArray(r.pets) && r.pets.length === 0, '壞掉的 ranch.json 沒有退回空營地');
    ok(!('nonexistent' in core.loadRanch(path.join(TMP, 'nope.json'))), '讀不到的檔案應退回空營地');

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
        // 院子是「畫小一號」的：走路在 YARD_FIELD 上算，畫在更細的 YARD_RENDER 上（見 plaza.js）。
        // 合成出來的是畫的那張，所以尺寸要對 YARD_RENDER（它也是從 YARD_FIELD 推出來的）。
        const F = W.YARD_FIELD, R = P.YARD_RENDER;
        ok(out && out.lines.length === R.h / 2, `院子列數應為 ${R.h / 2}，實際 ${out && out.lines.length}`);
        ok(out.lines[0].replace(/\[[0-9;]*m/g, '').length === R.w, `院子欄數應為 ${R.w}`);
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
        ok(P.composeYard(core, { pets: [] }, null, step, {}) === null, '空營地應回 null');
        ok(P.composeYard(core, { pets: [] }, { characterId: 'agumon' }, step, {}) === null,
           '營地空時就算有現役也該回 null（現役不算院子成員）');

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

// ── 營地裡的時間類進化（大便獸彩蛋）──────────────────────────────
// 「任一幼年期在營地放置 48 小時 → 大便獸」。這裡最該釘住的是**不該觸發時不觸發**：
// 誤觸的代價是玩家的收藏被無聲換成別的角色，而且不可逆。
console.log('— 圖鑑：獲得次數 —');
{
    const ALB = path.join(TMP, 'album-count.json');
    try { fs.unlinkSync(ALB); } catch (e) {}
    const cnt = (id) => { try { return (JSON.parse(fs.readFileSync(ALB, 'utf8')).counts || {})[id]; } catch (e) { return undefined; } };
    const st = { characterId: 'agumon' };
    ok(core.recordAlbumIfChanged(st, ALB) === false && cnt('agumon') === undefined, '全新存檔還沒有出生時間就先記了（下一拍會多算一次）');
    st.birthAt = 1000; st.lastEvolveAt = 1000;
    core.recordAlbumIfChanged(st, ALB);
    ok(cnt('agumon') === 1, '第一次取得沒有記 1 次');
    core.recordAlbumIfChanged(st, ALB);
    const again = { ...st }; delete again._albumLast;     // daemon 重開：快取沒了，記號（albumKey）還在
    core.recordAlbumIfChanged(again, ALB);
    ok(cnt('agumon') === 1, '同一隻重複算（每拍或 daemon 重開都會加）');
    Object.assign(again, { characterId: 'greymon', lastEvolveAt: 2000 });   // 進化
    core.recordAlbumIfChanged(again, ALB);
    ok(cnt('greymon') === 1 && cnt('agumon') === 1, '進化成新角色沒有記 1 次');
    Object.assign(again, { characterId: 'agumon', birthAt: 3000, lastEvolveAt: 3000 });   // 新的一隻亞古獸
    core.recordAlbumIfChanged(again, ALB);
    ok(cnt('agumon') === 2, '第二次取得同一種角色沒有變 2 次');
    // 舊資料：收錄過、沒有次數、存檔也沒有記號 → 不加（畫面顯示 1）
    fs.writeFileSync(ALB, JSON.stringify({ v: 1, chars: { gabumon: 5 } }));
    core.recordAlbumIfChanged({ characterId: 'gabumon', birthAt: 9, lastEvolveAt: 9 }, ALB);
    ok(cnt('gabumon') === undefined, '舊存檔一更新，現役那隻就多算一次');
}

console.log('— 特殊進化（營地時效）—');
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
    put(49, child({ albumKey: 'agumon@1' }));   // 收進營地前當過現役：圖鑑記號是亞古獸那次
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
        // 獲得次數：營地裡變的算一次；之後換出來當現役不要再算一次
        ok(alb.counts && alb.counts[TO] === 1, '營地裡進化沒算進獲得次數');
        core.recordAlbumIfChanged({ ...p1.state }, ALBUM);
        ok(JSON.parse(fs.readFileSync(ALBUM, 'utf8')).counts[TO] === 1, '營地裡變的那隻換出來又多算一次');
    }
    ok(age() === null, '已經變過的不該再變一次');

    // 收進營地時心情要 < 0（2026-10-22：大便獸太容易）。舊資料沒有 keptMood 就看現在的心情
    {
        fs.writeFileSync(RULES, JSON.stringify({ rules: [{ id: 'test-neglect', to: TO, fromStage: 'Child',
            conditions: [{ type: 'ranch_hours', hours: 48 }, { type: 'kept_mood_below', value: 0 }] }] }));
        const putM = (keptMood, mood) => fs.writeFileSync(RANCH, JSON.stringify({ cap: 8, seq: 1, pets: [
            { id: 'r1', keptAt: Date.now() - 49 * H, ...(keptMood === undefined ? {} : { keptMood }), state: child({ mood }) } ] }));
        putM(-1, 2);  ok(age() !== null, '心情不好時收進營地、放 49 小時，應該要變');
        putM(0, -2);  ok(age() === null, '收進營地時心情 0（不是 < 0）也變了');
        putM(2, -2);  ok(age() === null, '收進營地時心情好也變了（之後心情變差不算）');
        putM(undefined, -1); ok(age() !== null, '舊資料沒有 keptMood：現在心情不好應該照樣會變');
        putM(undefined, 1);  ok(age() === null, '舊資料沒有 keptMood：現在心情好卻變了');
        const real = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'characters', 'special-evolutions.json'), 'utf8'));
        const suka = real.rules.find(r => r.to === 'sukamon');
        ok(suka && suka.conditions.some(c => c.type === 'kept_mood_below' && c.value === 0), '大便獸的規則沒有「收進營地時心情 < 0」');
    }

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
    // 結果是測試全綠但真機上放了 Child 進營地永遠不會變。真的踩過。
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
        ok(ran, 'force-char.json 不存在時，applyForceFlags 就沒跑到營地老化（會提早 return）');
    }
}

console.log('— 營地第二頁（核心）—');
{
    // 開關（2026-10-16 打開實測）：關著時自然觸發一律不發生（dev 指令另外測，見 test-yard-page2）
    ok(typeof core.PAGE2_ENABLED === 'boolean', 'PAGE2_ENABLED 沒有匯出'); 
    const four = () => ({ v: 1, pets: [1, 2, 3, 4].map(i => ({ id: 'q' + i, keptAt: i, state: { characterId: 'agumon' } })) });
    ok(core.ranchCap() === 4 && core.ranchCap(four()) === 4, '未解鎖的上限應該是 4');
    fs.writeFileSync(RANCH, JSON.stringify(four()));
    ok(core.page2OnBossWin(RANCH, { enabled: false }) === false && !core.loadRanch(RANCH).page2Quest, '開關關著，打贏 Diablomon 卻進了第二階段');
    // 觸發條件（開關打開時）：滿 4 隻、沒解鎖、沒有進行中的事件
    ok(core.page2OnBossWin(RANCH, { enabled: true }) === true, '滿 4 隻打贏 Diablomon 應該進第二階段');
    const q = core.loadRanch(RANCH).page2Quest;
    ok(q && q.seen === false, '第二階段待觸發要記成「還沒看過提示」');
    ok(core.page2OnBossWin(RANCH, { enabled: true }) === false, '已經在第二階段又打贏一次，不該重記（提示會再跳一次）');
    const three = four(); three.pets.pop(); fs.writeFileSync(RANCH, JSON.stringify(three));
    ok(core.page2OnBossWin(RANCH, { enabled: true }) === false, '營地不到 4 隻也進了第二階段');
    // 打贏 Armagemon：解鎖、上限 8、Keramon 補在下一格、事件清掉
    const r = four(); r.page2Quest = { at: 1, seen: true };
    const kid = core.page2Grant(r, 123);
    ok(r.page2At === 123 && core.ranchCap(r) === 8, '解鎖後上限應該是 8');
    ok(r.pets.length === 5 && r.pets[4].id === kid && r.pets[4].state.characterId === 'keramon', '解鎖後營地第 5 格要是一隻新的 Keramon');
    ok(r.page2RewardId === kid, '沒記下送的是哪一隻（dev 重置收不回來）');
    ok(!r.page2Quest, '解鎖後事件進度沒清掉');
    fs.writeFileSync(RANCH, JSON.stringify(r));
    ok(core.page2OnBossWin(RANCH, { enabled: true }) === false, '已經解鎖了還會再進第二階段');
    // 收進營地用解鎖後的上限（5 隻還能收）
    const st = { characterId: 'greymon' };
    const k = core.applyRanchOp(st, { ranchTriggerTs: Date.now(), ranchOp: { op: 'keep' } }, RANCH);
    ok(k && k.ok && core.loadRanch(RANCH).pets.length === 6, '解鎖後 5 隻卻收不進營地（上限沒吃解鎖）');
    // 重抽池：解鎖前抽不到 Keramon（就算被勾成 starter），解鎖後才有、而且只放一份
    const lst = ['agumon', 'keramon', 'gabumon'];
    ok(!core.page2StarterPool(lst, four()).includes('keramon'), '沒解鎖，重抽池卻有 Keramon（starters 勾了牠就漏過去）');
    ok(core.page2StarterPool(lst, four()).join() === 'agumon,gabumon', '擋 Keramon 時把別的 starter 也弄掉了');
    if (core.characterExists('keramon')) {
        ok(core.page2StarterPool(['agumon'], r).includes('keramon'), '解鎖了，重抽池沒有 Keramon');
        ok(core.page2StarterPool(lst, r).filter(x => x === 'keramon').length === 1, '解鎖後 Keramon 在池子裡重複（機率被加倍）');
    }
    // Diablomon 在 roster（Keramon 線實裝）→ 本來就是一般 Ultimate 對手，跟開關無關；
    // 不在 roster 時才靠開關補進池子，開關關著就遇不到。開關只擋「打贏記成第二階段」（上面測了）。
    let met = false;
    for (let s = 1; s <= 400 && !met; s++) if (core.chooseBattleEnemy('wargreymon', s * 7919, null, { total: 0, wins: 0 }) === 'diablomon') met = true;
    const inRoster = core.characterExists('diablomon') && JSON.parse(fs.readFileSync(path.join(path.dirname(INSTALLED), 'assets', 'roster.json'), 'utf8')).roster.includes('diablomon');
    ok(met === inRoster, inRoster ? 'Diablomon 在 roster，Ultimate 卻遇不到' : '開關關著，Ultimate 卻遇到 Diablomon');
    // 營地滿 4 隻在等解鎖 → Diablomon 找上門（每場先擲 10%）；其他時候照平均抽
    if (inRoster) {
        const N = 3000, rate = (ranch, opt = {}, me = 'wargreymon', bs = { total: 0, wins: 0 }) => {
            let k = 0;
            for (let s = 1; s <= N; s++) if (core.chooseBattleEnemy(me, s * 7919, null, bs, { ranch, enabled: true, ...opt }) === 'diablomon') k++;
            return k / N;
        };
        ok(core.PAGE2_BOSS_CHANCE === 0.1, '找上門的機率不是 10%');
        const full = four();
        ok(core.page2BossWanted(full) && !core.page2BossWanted(r) && !core.page2BossWanted({ pets: [{}, {}, {}] }),
           '「營地滿了在等解鎖」判斷錯（沒滿、或已解鎖也算）');
        ok(!core.page2BossWanted({ ...full, page2Quest: { at: 1 } }), '已經打贏在等第二階段，還在加成 Diablomon');
        const hi = rate(full), lo = rate(r), off = rate(full, { enabled: false }), none = rate(null);
        ok(hi > 0.09 && hi < 0.15, `營地滿了遇到 Diablomon 的機率 ${(hi * 100).toFixed(1)}%，不是約 10%＋平均抽的那份`);
        ok(lo < 0.04, `已解鎖還在加成 Diablomon（${(lo * 100).toFixed(1)}%）`);
        ok(off < 0.04 && none < 0.04, '開關關著、或沒給營地時也在加成 Diablomon');
        ok(rate(full, {}, 'agumon') === 0, 'Child 也被 Diablomon 找上門（只有 Ultimate 以上遇得到）');
        // 改抽 SU 強敵的那場不搶：強敵條件成立時，SU 池抽到的場次照樣是 SU
        const strong = { total: 100, wins: 95 }, SU = new Set(['agumon_kizuna', 'burninggodzilla', 'gabumon_kizuna', 'zephagamon_ace', 'armagemon']);
        let suA = 0, suB = 0;
        for (let s = 1; s <= N; s++) {
            if (SU.has(core.chooseBattleEnemy('wargreymon', s * 7919, null, strong, { ranch: null, enabled: true }))) suA++;
            if (SU.has(core.chooseBattleEnemy('wargreymon', s * 7919, null, strong, { ranch: full, enabled: true }))) suB++;
        }
        ok(suA > 0 && suA === suB, `Diablomon 找上門搶掉了 SU 強敵的場次（${suA} → ${suB}）`);
        const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtime', 'agumon-core.js'), 'utf8');
        ok(/chooseBattleEnemy\(myId, seed, st\.lastBattleEnemy,[\s\S]{0,200}?ranch: PAGE2_ENABLED \? loadRanch\(\)/.test(coreSrc),
           '自動戰鬥沒把營地帶給 chooseBattleEnemy（加成永遠不會發生）');
    }
    // 重抽有兩條路（vpet reset、收進營地後抽新的），兩條（含池子空掉的備案）都要過 page2StarterPool
    const cheatSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtime', 'statusline-cheat.js'), 'utf8');
    ok((cheatSrc.match(/core\.page2StarterPool\(/g) || []).length === 4, '重抽的兩條路沒有都過 page2StarterPool（解鎖前抽得到、或解鎖後抽不到 Keramon）');
    ok(!/weightedPickStarter\([^)]*:\s*starters\)/.test(cheatSrc), '重抽的備案直接用 starters（池子空掉時會抽到還沒解鎖的 Keramon）');
}

console.log('— 綽號（跟著這一隻走）—');
{
    // 長度：中文 6 字／英文 12 字；控制字元、零寬字元拿掉；空字串 = 清掉；太長 = null（不收）
    ok(core.normalizeNickname('小黃') === '小黃' && core.normalizeNickname('一二三四五六') === '一二三四五六'
       && core.normalizeNickname('一二三四五六七') === null && core.normalizeNickname('abcdefghijkl') === 'abcdefghijkl'
       && core.normalizeNickname('abcdefghijklm') === null, '綽號長度上限不對（中文 6 字／英文 12 字）');
    ok(core.normalizeNickname('  阿  呆 ') === '阿 呆' && core.normalizeNickname('\u0007x​y') === 'xy' && core.normalizeNickname('   ') === '',
       '綽號沒整理掉空白／控制字元');
    const nick = (st, id, name, busy) => {
        if (busy) st.battleStartStep = 3;
        return core.applyRanchOp(st, { ranchTriggerTs: Date.now() + Math.random(), ranchOp: { op: 'nick', id, name } }, RANCH);
    };
    fs.writeFileSync(RANCH, JSON.stringify({ v: 1, pets: [{ id: 'n1', keptAt: 1, state: { characterId: 'agumon' } }] }));
    // 現役：表演中也照做（只改一個欄位，不碰別的）
    const st = { characterId: 'greymon' };
    ok(nick(st, null, '小黃', true).ok && st.nickname === '小黃', '現役取綽號失敗（或戰鬥中被擋）');
    ok(nick(st, null, '', true).ok && !('nickname' in st), '綽號留空沒有清掉');
    ok(!nick(st, null, '一二三四五六七', true).ok && !('nickname' in st), '太長的綽號也收了');
    // 營地那一隻
    ok(nick(st, 'n1', '阿呆').ok && core.loadRanch(RANCH).pets[0].state.nickname === '阿呆', '營地那隻取綽號失敗');
    ok(!nick(st, 'nope', '阿呆').ok, '營地沒有的那隻也說成功');
    // 收進營地：綽號跟著快照走；抽新的那一隻（換角色）沒有綽號
    const st2 = { characterId: 'greymon', nickname: '小黃', battleStartStep: -1 };
    fs.writeFileSync(RANCH, JSON.stringify({ v: 1, pets: [] }));
    fs.writeFileSync(FORCE, JSON.stringify({ ranchTriggerTs: Date.now(), ranchOp: { op: 'keep' }, character: 'gabumon' }));
    core.applyForceFlags(st2, FORCE, RANCH);
    ok(core.loadRanch(RANCH).pets[0].state.nickname === '小黃', '收進營地時綽號沒跟著那一隻');
    ok(st2.characterId === 'gabumon' && !('nickname' in st2), '新抽的那一隻繼承了上一隻的綽號');
    // 前線卡片：有綽號才多一列；全形字補零寬字元（頁面一個字元一格，中文才不會被擠扁）
    const card = (s) => core.composeStatusCard({ charId: 'agumon', st: s }).map(core.stripAnsi || (x => x)).join('\n');
    const withNick = card({ characterId: 'agumon', nickname: '小黃' }), noNick = card({ characterId: 'agumon' });
    ok(withNick.includes('Nick: 小​黃​') && !noNick.includes('Nick:'), '前線卡片的綽號列不對（沒綽號也顯示，或中文沒補寬度）');
    // 繁中名（2026-10-27）：卡片用 config.json 的 nameZh（安裝版 assets），沒填退回英文名
    ok(core.getDisplayNameZh('gatomon') === '迪路獸' && core.composeStatusCard({ charId: 'gatomon', st: { characterId: 'gatomon' } }).join('\n').includes('Name: 迪\u200b路\u200b獸\u200b'),
       '前線卡片沒顯示繁中名（安裝版 assets 的 config.json 要有 nameZh：先 npm run install-runtime）');
    ok(core.getDisplayNameZh('no_such_char_x') === core.getDisplayName('no_such_char_x'), '沒有繁中名時沒退回英文名');
}

cleanup();
console.log(`\n結果：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
