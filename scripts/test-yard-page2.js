#!/usr/bin/env node
'use strict';
/**
 * test-yard-page2.js — 營地第二頁的事件流程（docs/yard-page2-spec.md）
 *
 * 起一隻**隔離**的 daemon（AGUMON_STATE_DIR 指到 temp，營地是現場合成的 4 隻），
 * 用 dev 指令走完：第二階段 → 對峙 → 出戰 → 結算（贏：解鎖、Keramon、分頁；輸／放棄：退場）。
 * 戰鬥要十幾秒才打完 —— 測試直接把 temp 的 ranch.json 裡的開打拍數往前推，下一次 /yard 就結算。
 * 不碰使用者真的存檔；角色美術讀已安裝的（唯讀）。
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };

const REPO = path.resolve(__dirname, '..');
const SD   = fs.mkdtempSync(path.join(os.tmpdir(), 'vpet-page2-'));
const RANCH = path.join(SD, 'ranch.json');
const CHARS = ['agumon', 'gabumon', 'palmon', 'tentomon'];
fs.writeFileSync(RANCH, JSON.stringify({ v: 1, pets: CHARS.map((c, i) => ({ id: 'p' + i, keptAt: i + 1, state: { characterId: c } })) }));
fs.writeFileSync(path.join(SD, 'color-state.json'), JSON.stringify({ characterId: 'greymon' }));
fs.writeFileSync(path.join(SD, 'hook.json'), JSON.stringify({ ts: 1 }));
fs.writeFileSync(path.join(SD, 'fest.json'), JSON.stringify({ costume: false }));

const PORT = 3191;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const req = (method, p, body) => new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, s => {
        let d = ''; s.on('data', c => d += c); s.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res({ raw: d }); } }); });
    r.on('error', rej); if (body) r.write(JSON.stringify(body)); r.end();
});
const cmd  = (action, args = {}) => req('POST', '/cmd', { action, args });
const yard = (q = '') => req('GET', '/yard' + q);
const ranch = () => JSON.parse(fs.readFileSync(RANCH, 'utf8'));
const edit  = (fn) => { const r = ranch(); fn(r); fs.writeFileSync(RANCH, JSON.stringify(r)); };
const stateRanch = async () => { await wait(900); return (await req('GET', '/state')).ranch || {}; };   // /state 每拍才更新

(async () => {
    const d = spawn(process.execPath, [path.join(REPO, 'src/daemon/daemon.js'), '--isolated'],
        { env: { ...process.env, AGUMON_DAEMON_PORT: String(PORT), AGUMON_STATE_DIR: SD }, stdio: 'ignore' });
    try {
        let up = false;
        for (let i = 0; i < 150 && !up; i++) { try { await req('GET', '/state'); up = true; } catch (e) { await wait(100); } }
        ok(up, 'daemon 起不來');

        console.log('— 平常的營地不受影響 —');
        let y = await yard();
        ok(y.ok && !y.event && y.pages === 1 && y.cap === 4 && y.pets.length === 4, '沒有事件時營地應該照舊（一頁、上限 4、4 隻）');
        // 節日預覽（?fest=）：今天不一定是節日，要比較「強制非節慶」得先確定平常看得到節日背景
        ok((await yard('?fest=halloween')).festival, '前提不成立：節日預覽沒有節日背景（下面「強制非節慶」測不出來）');

        console.log('— 第二階段：前線提示、對峙 —');
        ok((await cmd('page2Dev', { act: 'quest' })).ok, 'dev 進第二階段失敗');
        ok((await stateRanch()).page2Notice === true, '第二階段待觸發，前線沒有提示旗標');
        y = await yard();
        ok(y.event && y.event.stage === 'standoff', '進營地沒有對峙');
        ok(y.festival === null && !y.feast, '對峙要強制非節慶背景（連圍爐也蓋過去）');
        ok((await yard('?fest=halloween')).festival === null, '節日期間的對峙沒有強制非節慶背景');
        ok(y.pages === 1 && y.pets.length === 4 && y.enemy, '對峙要畫我方 4 隻和 Armagemon');
        ok(y.pets.every(p => p.x + 16 <= y.enemy.x), '我方要站在左邊、Armagemon 在右邊');
        await cmd('page2Seen');
        ok((await stateRanch()).page2Notice === false, '提示看過了（page2Seen）還在跳');

        console.log('— 出戰（贏）—');
        ok(!(await cmd('page2Fight', { which: 'nobody' })).ok, '指定不存在的那隻也能出戰');
        await cmd('page2Dev', { act: 'win' });
        ok((await cmd('page2Fight', { which: 'p1' })).ok, '出戰失敗');
        ok(!(await cmd('page2Fight', { which: 'p2' })).ok, '已經在打了還能再派一隻');
        ok(ranch().page2Fight && ranch().page2Fight.id === 'p1' && ranch().page2Fight.win === true, '出戰沒記下是誰、勝負');
        await wait(900);
        y = await yard();
        ok(y.event && y.event.stage === 'fight' && Array.isArray(y.event.battle.lines) && y.event.battle.lines.length, '戰鬥中沒有蓋版的戰鬥畫面');
        ok(y.event.fighter && y.event.fighter.id === 'p1', '戰鬥畫面不知道派的是誰');
        edit(r => { r.page2Fight.startStep -= 1000; });   // 快轉到打完
        y = await yard();
        ok(y.event && y.event.stage === 'result' && y.event.win === true, '打完沒有結算成「贏」');
        const r1 = ranch();
        ok(!!r1.page2At && !r1.page2Quest && !r1.page2Fight, '贏了沒解鎖／事件沒清乾淨');
        ok(r1.pets.length === 5 && r1.pets[4].state.characterId === 'keramon', '贏了營地第 5 格沒有 Keramon');
        ok(y.event.keramonId === r1.pets[4].id && y.event.keramonPage === 1, '結果沒告訴前端 Keramon 在第二頁（鏡頭要帶過去）');
        ok(y.cap === 8, '解鎖後上限不是 8');
        await cmd('page2Ack');
        y = await yard();
        ok(!y.event && !ranch().page2Result, '演完（page2Ack）結果沒清掉');

        console.log('— 分頁 —');
        ok(y.pages === 2 && y.page === 0 && y.pets.length === 4, '5 隻應該分兩頁、第一頁 4 隻');
        y = await yard('?pg=1');
        ok(y.page === 1 && y.pets.length === 1 && y.pets[0].char === 'keramon', '第二頁應該只有 Keramon');
        const kid = y.pets[0].id;
        y = await yard('?pg=1&drop=' + kid);
        ok(y.drop && y.drop.id === kid && y.drop.frames.length === 2, '空降要回傳那隻的兩幀和落點');
        ok(!y.pets.some(p => p.id === kid), '空降中伺服器還在畫那隻（會看到兩隻）');
        y = await yard('?pg=7');
        ok(y.page === 1, '頁碼超出沒有夾住');

        console.log('— 輸：老師講完才退場、退完回平常 —');
        await cmd('page2Dev', { act: 'quest' }); await cmd('page2Dev', { act: 'lose' });
        ok((await cmd('page2Fight', { which: 'p0' })).ok, '第二次出戰失敗');
        edit(r => { r.page2Fight.startStep -= 1000; });
        y = await yard();
        ok(y.event && y.event.stage === 'result' && y.event.win === false && !y.event.exiting, '輸了沒結算、或還沒講完就開始退場');
        ok(!ranch().page2Quest, '輸了要從打 Diablomon 重來（事件要清掉）');
        ok(y.enemy && y.pets.length === 4, '輸了的畫面要停在對峙（Armagemon 還在）');
        ok(ranch().pets.length === 5, '輸了不該動到營地成員');
        await cmd('page2Ack');
        y = await yard();
        ok(y.event && y.event.exiting, '講完（page2Ack）沒開始退場');
        edit(r => { r.page2Result.exitStep -= 100; });   // 快轉到退完
        y = await yard();
        ok(!y.event && !ranch().page2Result, '退出畫面了還沒回到平常');

        console.log('— 放棄 —');
        ok(!(await cmd('page2GiveUp')).ok, '沒有挑戰也能放棄');
        await cmd('page2Dev', { act: 'quest' });
        ok((await cmd('page2GiveUp')).ok, '放棄失敗');
        y = await yard();
        ok(y.event && y.event.stage === 'result' && y.event.win === false && y.event.gaveUp, '放棄要視同戰敗');
        ok(!ranch().page2Quest, '放棄後事件沒清掉（要從 Diablomon 重來）');

        console.log('— dev 只在開發版 —');
        const src = fs.readFileSync(path.join(REPO, 'src/daemon/daemon.js'), 'utf8');
        ok(/const DEV_ONLY\s*=\s*new Set\(\[[^\]]*'page2Dev'/.test(src), 'page2Dev 沒列在 DEV_ONLY（release 版也能強制解鎖）');
    } catch (e) {
        fail++; console.log('  ✗ 例外：' + e.stack);
    } finally {
        d.kill(); await wait(400);
        try { fs.rmSync(SD, { recursive: true, force: true }); } catch (e) {}
    }
    console.log(`\n結果：${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
