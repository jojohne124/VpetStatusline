#!/usr/bin/env node
'use strict';
/**
 * test-jogress.js — 合體進化（規格：docs/jogress-spec.md）
 *
 * 一律載入 **repo 的** core，不是安裝版：這支測的就是還沒 install 的新程式。
 * 所有會碰檔案的地方都走暫存目錄；roster 與組合表一律注入 —— 不讀、也不寫使用者的安裝。
 *
 * 這個功能有一個地方錯了就是「一隻寵物永久消失」，所以失敗路徑每一條都要驗
 * 「沒有動到營地、也沒有排進化」，不只是驗回傳的 reason。
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const core  = require('../src/runtime/agumon-core.js');
const RULES = require('../src/shared/evo-rules.js');
const YT    = require('../src/daemon/yard-touch.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };

const TMP = path.join(os.tmpdir(), `vpet-jogress-test-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });   // 前一次跑到一半掛掉會留下來，pid 又會重複
fs.mkdirSync(TMP, { recursive: true });
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} };

// 測試用的組合表與 roster（假角色，不依賴真資料）
const PAIRS  = RULES.expandJogress({ pairs: [
    { pair: ['ange', 'lady'], to: 'maste' },
    { front: 'a', camp: 'b', to: 'a1' },
    { front: 'b', camp: 'a', to: 'b1' },
    { pair: ['ange', 'ghost'], to: 'notyet' },          // 目標還沒實裝
] }).pairs;
const ROSTER = new Set(['ange', 'lady', 'maste', 'a', 'b', 'a1', 'b1', 'ghost']);
const OPTS   = { pairs: PAIRS, rosterSet: ROSTER };

let seq = 0;
function setup(frontChar, campChars) {
    const ranchFile = path.join(TMP, `ranch-${++seq}.json`);
    const pets = campChars.map((c, i) => ({
        id: 'p' + i, keptAt: Date.now(),
        state: { characterId: c, trainingBonus: 7 },
    }));
    fs.writeFileSync(ranchFile, JSON.stringify({ v: 1, pets }));
    const st = { characterId: frontChar, trainingBonus: 30, battleTotalCount: 9, battleWinCount: 6,
                 evoHistory: ['x', frontChar], evoStartStep: -1, battleStartStep: -1, dropStartStep: -1 };
    return { st, ranchFile, ranch: () => JSON.parse(fs.readFileSync(ranchFile, 'utf8')) };
}
const force = (id, extra) => ({ ranchTriggerTs: Date.now(), ranchOp: { op: 'jogress', id }, ...extra });

// 失敗路徑共用：什麼都不能動
function untouched(env, beforePets, label) {
    ok(env.ranch().pets.length === beforePets, `${label}：營地被動到了（${beforePets} → ${env.ranch().pets.length}）`);
    ok(!env.st._forceEvolve && !env.st.jogressTo, `${label}：失敗卻排了進化`);
}

try {
console.log('— 組合表展開 —');
{
    const r = RULES.expandJogress({ pairs: [
        { pair: ['Ange', 'LADY'], to: 'Maste' },
        { front: 'a', camp: 'b', to: 'a1' },
        { front: 'b', camp: 'a', to: 'b1' },
        { front: 'ange', camp: 'lady', to: 'other' },   // 跟第一組的展開撞到
        { pair: ['c', 'c'], to: 'cc' },                  // A+A
        { pair: ['x'], to: 'bad' }, { front: 'y', to: 'bad' }, { pair: ['p', 'q'] },   // 壞資料
    ] });
    const has = (f, c, t) => r.pairs.some(p => p.front === f && p.camp === c && p.to === t);
    ok(has('ange', 'lady', 'maste') && has('lady', 'ange', 'maste'), 'pair 簡寫沒有展開成兩個方向');
    ok(has('a', 'b', 'a1') && has('b', 'a', 'b1'), '有序的 front/camp 兩個方向應該各自成立、結果不同');
    ok(r.pairs.filter(p => p.front === 'ange' && p.camp === 'lady').length === 1, '同一組出現兩次沒有去重');
    ok(has('ange', 'lady', 'maste'), '重複時應該取**先**出現的那筆（後蓋前會讓「改了沒生效」變無頭案件）');
    ok(r.dupes.length === 1 && r.dupes[0].to === 'other', '被忽略的那筆要回報出來（CLI 靠它提醒）：' + JSON.stringify(r.dupes));
    ok(r.pairs.filter(p => p.front === 'c').length === 1, 'A+A 展開了兩次（自己撞成自己的重複）');
    ok(!r.pairs.some(p => p.to === 'bad') && !r.pairs.some(p => p.front === 'p'), '壞資料應該被略過，不是丟例外');
    ok(RULES.expandJogress(null).pairs.length === 0 && RULES.expandJogress({}).pairs.length === 0,
       '沒有內容時應該回空表');
}

console.log('— 候選 —');
{
    const e = setup('ange', ['lady', 'b', 'lady', 'ghost']);
    const c = core.jogressCandidates(e.st, e.ranch(), OPTS);
    ok(c.length === 2 && c.every(x => x.camp === 'lady' && x.to === 'maste'),
       '候選不對：' + JSON.stringify(c));
    // 營地兩隻同角色：各自是獨立候選，按 id 選（只做「第一組」的話那會變成擲骰子）
    ok(new Set(c.map(x => x.petId)).size === 2, '營地兩隻同角色時應該是兩個獨立候選');
    ok(!c.some(x => x.camp === 'ghost'), '目標不在 roster 的不該是候選（規則可以先寫著等美術）');
    ok(core.jogressCandidates(e.st, e.ranch(), { ...OPTS, frozen: true }).length === 0, '凍結中應該沒有候選');
    ok(core.jogressCandidates({ ...e.st, _freezeEvolve: true }, e.ranch(), OPTS).length === 0,
       '沒傳 frozen 時應該看 st._freezeEvolve');
    const held = core.jogressCandidates(e.st, e.ranch(), { ...OPTS, heldIds: new Set(['p0']) });
    ok(held.length === 1 && held[0].petId === 'p2', '正被拿在手上的那隻不該是候選');
    ok(core.jogressCandidates(e.st, e.ranch(), { ...OPTS, pairs: [] }).length === 0, '沒有組合表時應該沒有候選');
    // 有序：前線 a ＋ 營地 b 是 a1，反過來是 b1
    const ab = setup('a', ['b']);
    ok(core.jogressCandidates(ab.st, ab.ranch(), OPTS)[0].to === 'a1', '有序組合的方向錯了（a＋b 應為 a1）');
    const ba = setup('b', ['a']);
    ok(core.jogressCandidates(ba.st, ba.ranch(), OPTS)[0].to === 'b1', '有序組合的方向錯了（b＋a 應為 b1）');
    // A＋A 只有表裡真的寫了才成立
    const aa = setup('ange', ['ange']);
    ok(core.jogressCandidates(aa.st, aa.ranch(), OPTS).length === 0, 'A＋A 預設不該成立');
}

console.log('— 合體成功 —');
{
    const e = setup('ange', ['b', 'lady']);
    const before = e.ranch().pets.length;
    const r = core.applyRanchOp(e.st, force('p1'), e.ranchFile, null, OPTS);
    ok(r && r.ok === true && r.to === 'maste', '合體失敗：' + JSON.stringify(r));
    const left = e.ranch().pets;
    ok(left.length === before - 1 && !left.some(p => p.id === 'p1'), '營地那隻沒有被消耗掉');
    ok(left.some(p => p.id === 'p0'), '把營地裡**別隻**也刪了');
    ok(e.st._forceEvolve === 'maste', '現役沒有排進化（應該走正常進化，動畫照播）');
    ok(e.st.jogressTo === 'maste', '沒有記 jogressTo —— 動畫沒播完的話這隻就憑空消失了');
    const jf = e.st.jogressFrom || {};
    ok(jf.front === 'ange' && jf.camp === 'lady' && jf.ranchId === 'p1' && jf.to === 'maste' && jf.at > 0,
       'jogressFrom 不完整（卡片日後要講「由誰＋誰而來」）：' + JSON.stringify(jf));
    // 進化本身是 applyForceTriggers 起跑的（跟手動 evolve 同一條路）
    core.applyForceTriggers(e.st, 1000);
    ok(e.st.evoStartStep === 1000 && e.st.evoNextCharId === 'maste', '進化動畫沒有起跑');

    // 同一個 st 再套一次同一個時戳 → 什麼都不做（多視窗／下一拍）
    const again = core.applyRanchOp(e.st, { ...force('p1'), ranchTriggerTs: e.st.lastRanchTriggerTs },
                                    e.ranchFile, null, OPTS);
    ok(again === null, '同一個時戳套了兩次');
}

console.log('— 多視窗搶同一隻 —');
{
    // 兩個視窗在任一個存檔之前都讀到同一份 state —— 慢的那個應該拿到 notfound，而不是再合體一次
    const e = setup('ange', ['lady']);
    const f = force('p0');
    const stB = JSON.parse(JSON.stringify(e.st));
    const a = core.applyRanchOp(e.st, f, e.ranchFile, null, OPTS);
    const b = core.applyRanchOp(stB, f, e.ranchFile, null, OPTS);
    ok(a.ok === true, '第一個視窗應該成功');
    ok(b.ok === false && b.reason === 'notfound', '第二個視窗應該是 notfound：' + JSON.stringify(b));
    ok(!stB._forceEvolve && !stB.jogressTo, '慢的那個視窗也排了進化 —— 一隻營地寵物換到兩次進化');
}

console.log('— 失敗路徑：每一條都不能動到任何東西 —');
{
    let e = setup('ange', ['lady']);
    let r = core.applyRanchOp(e.st, force('nope'), e.ranchFile, null, OPTS);
    ok(r.reason === 'notfound', 'id 不在營地應該是 notfound：' + JSON.stringify(r));
    untouched(e, 1, 'notfound');

    e = setup('ange', ['b']);
    r = core.applyRanchOp(e.st, force('p0'), e.ranchFile, null, OPTS);
    ok(r.reason === 'notmatch' && r.front === 'ange' && r.camp === 'b',
       'notmatch 要帶出是「現役 X ＋ 營地 Y」才講得出缺什麼：' + JSON.stringify(r));
    untouched(e, 1, 'notmatch');

    e = setup('ange', ['ghost']);
    r = core.applyRanchOp(e.st, force('p0'), e.ranchFile, null, OPTS);
    ok(r.reason === 'notmatch', '目標不在 roster 時應該不成立：' + JSON.stringify(r));
    untouched(e, 1, '目標未實裝');

    e = setup('ange', ['lady']);
    r = core.applyRanchOp(e.st, force('p0', { freezeEvolve: true }), e.ranchFile, null, OPTS);
    ok(r.reason === 'frozen', '凍結中應該擋下：' + JSON.stringify(r));
    untouched(e, 1, 'frozen');
    // ⚠️ 凍結要看 force 本身：st._freezeEvolve 在 applyForceFlags 裡比 applyRanchOp **晚**重讀
    e = setup('ange', ['lady']); e.st._freezeEvolve = false;
    r = core.applyRanchOp(e.st, force('p0', { freezeEvolve: true }), e.ranchFile, null, OPTS);
    ok(r.reason === 'frozen', 'st._freezeEvolve 還是舊值時，凍結被放過去了');

    e = setup('ange', ['lady']);
    r = core.applyRanchOp(e.st, force('p0'), e.ranchFile, null, { ...OPTS, heldIds: new Set(['p0']) });
    ok(r.reason === 'held', '正被拿在手上的那隻應該擋下（執行的那一刻也要擋，CLI 看不到拿著）：' + JSON.stringify(r));
    untouched(e, 1, 'held');

    e = setup('ange', ['lady']);
    r = core.applyRanchOp(e.st, force('p0', { ranchTriggerTs: Date.now() - 400000 }), e.ranchFile, null, OPTS);
    ok(r.reason === 'expired', '超過 5 分鐘的指令應該是 expired：' + JSON.stringify(r));
    untouched(e, 1, 'expired');

    // 營地寫不進去：營地那隻還在，前線就**不能**進化 —— 否則等於憑空多出一隻。
    // 唯讀檔模擬（Windows 上 rename 蓋唯讀檔會 EPERM，atomicWrite 重試後回 false）。
    e = setup('ange', ['lady']);
    fs.chmodSync(e.ranchFile, 0o444);
    try {
        r = core.applyRanchOp(e.st, force('p0'), e.ranchFile, null, OPTS);
        const probe = (() => { try { fs.writeFileSync(e.ranchFile + '.probe', ''); fs.renameSync(e.ranchFile + '.probe', e.ranchFile); return true; } catch (x) { return false; } })();
        if (probe) {
            console.log('  （這台機器蓋得過唯讀檔，寫入失敗這條驗不到 —— 跳過）');
        } else {
            ok(r.ok === false && r.reason === 'writefail', '營地寫不進去卻回報成功：' + JSON.stringify(r));
            untouched(e, 1, 'writefail');
        }
    } finally { try { fs.chmodSync(e.ranchFile, 0o666); } catch (x) {} }

    // 表演中：retry，而且指令要**保留**（時戳沒被消耗），播完下一拍自然成功
    e = setup('ange', ['lady']); e.st.battleStartStep = 5;
    const f = force('p0');
    r = core.applyRanchOp(e.st, f, e.ranchFile, null, OPTS);
    ok(r.retry === true && r.reason === 'busy', '戰鬥中應該回 retry：' + JSON.stringify(r));
    untouched(e, 1, 'busy');
    ok(e.st.lastRanchTriggerTs !== f.ranchTriggerTs, '表演中就把時戳吃掉了 —— 播完之後不會再做');
    e.st.battleStartStep = -1;
    r = core.applyRanchOp(e.st, f, e.ranchFile, null, OPTS);
    ok(r.ok === true, '表演播完後同一道指令應該成功：' + JSON.stringify(r));
}

console.log('— 保險：動畫沒播完也要落地 —');
{
    // 這是整個功能最危險的地方：營地那隻當下就刪了，進化卻要等動畫播完。
    // 動畫逾時（onExpired 清掉 evoNextCharId）的話，沒有這道保險就是一隻寵物憑空消失。
    const e = setup('ange', ['lady']);
    core.applyRanchOp(e.st, force('p0'), e.ranchFile, null, OPTS);
    core.applyForceTriggers(e.st, 100);
    ok(core.settleJogress(e.st) === false && e.st.characterId === 'ange', '動畫還在播就提前落地了');
    // 模擬逾時：decideAgumon 的 onExpired 做的就是這三件事
    e.st.evoStartStep = -1; e.st.evoNextCharId = null; e.st.evoShownElapsed = -1;
    ok(core.settleJogress(e.st) === true, '動畫逾時後沒有補落地');
    ok(e.st.characterId === 'maste', '補落地後角色不對：' + e.st.characterId);
    ok(!('jogressTo' in e.st), '落地後 jogressTo 沒收掉（下一拍會再落地一次）');
    // 跟正常進化同一套清理
    ok(!('trainingBonus' in e.st) && !('battleTotalCount' in e.st) && e.st.lastEvolveAt > 0,
       '補落地沒有 resetStageStats（訓練值／勝率應該歸零，跟正常進化一樣）');

    // 正常播完：角色已經是 to 了，這裡只把記號收掉，不再重設一次
    const n = setup('ange', ['lady']);
    core.applyRanchOp(n.st, force('p0'), n.ranchFile, null, OPTS);
    n.st.characterId = 'maste'; n.st.trainingBonus = 3; delete n.st._forceEvolve;   // commit 之後又練了一點
    core.settleJogress(n.st);
    ok(!('jogressTo' in n.st), '正常 commit 之後記號沒收掉');
    ok(n.st.trainingBonus === 3, '正常 commit 之後又被重設了一次（把 commit 之後練的吃掉）');

    // 排著還沒起跑（_forceEvolve 還在）→ 不要搶先落地，讓動畫播
    const q = setup('ange', ['lady']);
    core.applyRanchOp(q.st, force('p0'), q.ranchFile, null, OPTS);
    ok(core.settleJogress(q.st) === false && q.st.characterId === 'ange', '進化還沒起跑就被保險搶先落地，動畫沒了');
}

console.log('— 走完整一拍（applyForceFlags）—');
{
    const e = setup('ange', ['lady']);
    const forceFile = path.join(TMP, 'force-full.json');
    fs.writeFileSync(forceFile, JSON.stringify(force('p0')));
    core.applyForceFlags(e.st, forceFile, e.ranchFile, OPTS);
    ok(e.st._forceEvolve === 'maste', 'applyForceFlags 沒有把合體送進 applyRanchOp（opts 沒往下傳？）');
    ok(e.ranch().pets.length === 0, '走完整一拍營地那隻沒消耗');
    // 逾時之後，下一拍的 applyForceFlags 自己就要把它落地
    core.applyForceTriggers(e.st, 10);
    e.st.evoStartStep = -1; e.st.evoNextCharId = null;
    core.applyForceFlags(e.st, forceFile, e.ranchFile, OPTS);
    ok(e.st.characterId === 'maste', '下一拍的 applyForceFlags 沒有跑保險');
    // force 檔不存在也要跑保險（applyForceFlags 讀不到 force 會提早 return）
    const g = setup('ange', ['lady']);
    core.applyRanchOp(g.st, force('p0'), g.ranchFile, null, OPTS);
    delete g.st._forceEvolve;
    core.applyForceFlags(g.st, path.join(TMP, 'no-such-force.json'), g.ranchFile, OPTS);
    ok(g.st.characterId === 'maste', 'force 檔不存在時保險沒跑（它被排在讀檔之後了）');
}

console.log('— 血緣：合體不是斷點 —');
{
    // 不認合體的話 Angewomon → Mastemon 會被當成斷點，vpet tree 只剩一格
    const st = { characterId: 'maste', evoHistory: ['gato', 'ange'] };
    core.updateEvoHistory(st, { pairs: PAIRS });
    ok(JSON.stringify(st.evoHistory) === '["gato","ange","maste"]',
       '合體後血緣被重設了：' + JSON.stringify(st.evoHistory));
    // 反方向不算（lady 那條也是 maste，但這裡現役的前一隻是 ange）—— 而真的斷點照樣重設
    const cut = { characterId: 'maste', evoHistory: ['gato', 'zzz'] };
    core.updateEvoHistory(cut, { pairs: PAIRS });
    ok(JSON.stringify(cut.evoHistory) === '["maste"]', '不是合體也不是進化的跳轉應該照樣當斷點');
    // ⚠️ 不能靠「合體當下先把 to 寫進 evoHistory」—— 動畫 12 拍才 commit，現役還是 front
    const early = { characterId: 'ange', evoHistory: ['gato', 'ange', 'maste'] };
    core.updateEvoHistory(early, { pairs: PAIRS });
    ok(JSON.stringify(early.evoHistory) === '["ange"]',
       '（哨兵）提早寫歷史本來就會被洗掉 —— 這條若不紅了，代表 updateEvoHistory 的語意變了，要重看合體的血緣處理');
    ok(core.isJogressStep('ange', 'maste', { pairs: PAIRS }) && !core.isJogressStep('maste', 'ange', { pairs: PAIRS }),
       'isJogressStep 方向錯了');
}

console.log('— 可達性：雙親都要拿得到 —');
{
    const G = (ids, edges) => ({ nodes: ids.map(id => ({ id, stage: 'Adult' })), edges: edges.map(([from, to]) => ({ from, to })) });
    const pairs = [{ front: 'x', camp: 'y', to: 'z' }];
    let r = RULES.reachableFrom(G(['s', 'x', 'y', 'z'], [['s', 'x'], ['s', 'y']]), ['s'], [], pairs);
    ok(r.has('z'), '雙親都可達時合體結果應該可達');
    r = RULES.reachableFrom(G(['s', 'x', 'y', 'z'], [['s', 'x']]), ['s'], [], pairs);
    ok(!r.has('z'), '只有一方可達時合體結果不該可達（那是半條線）');
    // 合體結果之後的鏈也要跟著算（要跑到不動點，不是一輪）
    r = RULES.reachableFrom(G(['s', 'x', 'y', 'z', 'z2'], [['s', 'x'], ['s', 'y'], ['z', 'z2']]), ['s'], [], pairs);
    ok(r.has('z2'), '合體結果之後的進化鏈沒有跟著算進來');
    // 雙親其中一隻要等別條線先走到（第二輪才可達）
    r = RULES.reachableFrom(G(['s', 'x', 'y', 'z', 'q'], [['s', 'x']]), ['s'],
                            [{ to: 'y', fromStage: 'Adult' }], pairs);
    ok(r.has('z'), '雙親之一要靠特殊進化才拿得到時，合體結果沒有被算進來');
    // 目標不在圖上（被 roster 濾掉）→ 不能把它塞進結果
    r = RULES.reachableFrom(G(['s', 'x', 'y'], [['s', 'x'], ['s', 'y']]), ['s'], [], pairs);
    ok(!r.has('z'), '目標不在圖上卻被算成可達');
}

console.log('— daemon：誰正被拿在手上 —');
{
    let now = 1e12;
    const yt = YT.create({ windowMs: 3000, limit: 5, sulkMs: 3000,
                           stepAt: (t) => Math.floor(t / 1000), heldMaxMs: 30000 });
    ok(yt.heldIds(now).size === 0, '還沒拿任何東西就有 held');
    yt.grab('p1', now);
    ok(yt.heldIds(now).has('p1'), '拿起來之後 heldIds 沒有那隻');
    yt.drop('p1', 10, 10, 'right', now + 10);
    ok(!yt.heldIds(now + 10).has('p1'), '放下之後還算拿著');
    yt.grab('p2', now);
    ok(!yt.heldIds(now + 31000).has('p2'), '拿超過租約（拿的人已經不在了）還算拿著 —— 那隻永遠不能合體');
}

console.log('— 接線 —');
{
    const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
    // 部署清單漏了的症狀：候選永遠是空的 → 按鈕永遠不出現、指令永遠說不成立，零錯誤訊息
    ok(/characters', 'jogress\.json'\)/.test(read('scripts/install.js')) && /ASSETS_DIR, 'jogress\.json'/.test(read('scripts/install.js')),
       'install.js 沒有把 jogress.json 帶到 assets/');
    ok(/'jogress\.json'\]/.test(read('scripts/build-release.js')), 'build-release.js 的資料清單沒有 jogress.json');
    const cli = read('src/runtime/statusline-cheat.js');
    // release 版要能用：一定要在 SUBCMDS（否則 vpet jogress 會被當成裸角色名擋掉），且不在 blockedCmd
    ok(/SUBCMDS = \[[^\]]*'jogress'/.test(cli), 'SUBCMDS 沒有 jogress —— release 版打 vpet jogress 會被當成切換角色擋掉');
    const blocked = (cli.match(/const blockedCmd\s*=\s*\[([^\]]*)\]/) || [])[1] || '';
    ok(blocked && !/jogress/.test(blocked), '合體進化被放進 release 的 blockedCmd 了（它是玩家功能）');
    ok(/RANCH_CMDS = \[[^\]]*'--jogress'/.test(cli), 'CLI 的營地指令沒有 --jogress');
    ok(/ranchOp\s*=\s*\{ op: 'jogress', id: pet\.id \}/.test(cli), 'CLI 沒有用 ranch id 指定營地那隻（兩隻同角色時會擲骰子）');
    ok(/args\[2\] !== 'yes'/.test(cli.slice(cli.indexOf("'--jogress'"))), 'CLI 的合體沒有二次確認（營地那隻是永久消失）');
    const dm = read('src/daemon/daemon.js');
    ok(/applyForceFlags\(st, FORCE_FILE, undefined, \{ heldIds: heldYardIds\(\) \}\)/.test(dm),
       'daemon 沒有把「正被拿著」的名單傳給 applyForceFlags');
    // 第一拍同步跑會撞 TDZ（BASE_COLS、yardTouch），而失敗點在營地寫完、state 存檔前
    ok(/^setImmediate\(doTick\);/m.test(dm) && !/^doTick\(\);/m.test(dm),
       'daemon 的第一拍又變回同步呼叫 —— 當家模式第一拍會撞 TDZ，啟動時排著的 swap／合體會遺失');
    ok(/reachableFrom\(\{ nodes, edges \}, starters, loadSpecialRules\(\), jogress\)/.test(read('src/album/album_server.js')),
       '圖鑑的可達性沒有吃合體（Mastemon 會被藏起來）');
    // 比對**呼叫**（帶括號），不是字串 —— album 的註解裡就寫著「不用 core.loadJogress」
    ok(!/core\.loadJogress\(/.test(read('src/album/album_server.js')),
       '圖鑑用了 core.loadJogress —— 它優先載入安裝版 core，沒 install 前沒有這個函式，整本圖鑑會壞');
    ok(/G\.jogress/.test(read('src/editor/route_editor.html')), '路線編輯器的「可取得」沒有吃合體');
    ok(/jogress: loadJogressPairs\(\)/.test(read('src/editor/route_editor_server.js')), '路線編輯器的 /graph 沒有帶合體組合');
}

console.log('— 真資料 —');
{
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'characters', 'jogress.json'), 'utf8'));
    const { pairs, dupes } = RULES.expandJogress(raw);
    const roster = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'characters', 'roster.json'), 'utf8'));
    ok(pairs.length > 0, 'characters/jogress.json 沒有任何組合');
    ok(dupes.length === 0, 'characters/jogress.json 有重複的組合：' + JSON.stringify(dupes));
    const dirs = new Set(fs.readdirSync(path.join(__dirname, '..', 'characters')).map(d => d.toLowerCase()));
    const missing = pairs.flatMap(p => [p.front, p.camp, p.to]).filter(id => !dirs.has(id));
    ok(missing.length === 0, 'jogress.json 指到不存在的角色：' + [...new Set(missing)].join(' '));
    // 規格的第一組
    ok(pairs.some(p => p.front === 'angewomon' && p.camp === 'ladydevimon' && p.to === 'mastemon')
       && pairs.some(p => p.front === 'ladydevimon' && p.camp === 'angewomon' && p.to === 'mastemon'),
       '規格的第一組（Angewomon ＋ LadyDevimon ＝ Mastemon，兩個方向）不在表裡');
    ok(roster.roster.includes('mastemon'), 'mastemon 不在 roster（目標未實裝 = 合體永遠不成立）');
}
} finally { cleanup(); }

console.log(`\n結果：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
