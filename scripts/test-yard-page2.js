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
        // 切法只用內建的：使用者在編輯器另存成預設的切法（例如 5 隻的 Keramon 區域橫跨兩頁）不能影響結果
        { env: { ...process.env, AGUMON_DAEMON_PORT: String(PORT), AGUMON_STATE_DIR: SD,
                 AGUMON_YARD_LAYOUTS: path.join(SD, 'no-yard-layouts.json') }, stdio: 'ignore' });
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
        edit(r => { r.page2Losses = 3; });   // 之前輸過三場：這場 +15%，打贏要清掉
        ok((await cmd('page2Fight', { which: 'p1' })).ok, '出戰失敗');
        ok(ranch().page2Fight.bonus === 0.15, '輸過三場，勝率沒有 +15%');
        ok(!(await cmd('page2Fight', { which: 'p2' })).ok, '已經在打了還能再派一隻');
        ok(ranch().page2Fight && ranch().page2Fight.id === 'p1' && ranch().page2Fight.win === true, '出戰沒記下是誰、勝負');
        await wait(900);
        y = await yard();
        ok(y.event && y.event.stage === 'fight' && Array.isArray(y.event.battle.lines) && y.event.battle.lines.length, '戰鬥中沒有蓋版的戰鬥畫面');
        ok(y.event.fighter && y.event.fighter.id === 'p1', '戰鬥畫面不知道派的是誰');
        ok(/[^\x00-\x7f]/.test(y.event.fighter.name || ''), '戰鬥畫面派出去那隻的名字不是繁中名：' + y.event.fighter.name);
        edit(r => { r.page2Fight.startStep -= 1000; });   // 快轉到打完
        y = await yard();
        ok(y.event && y.event.stage === 'result' && y.event.win === true, '打完沒有結算成「贏」');
        const r1 = ranch();
        ok(!!r1.page2At && !r1.page2Quest && !r1.page2Fight, '贏了沒解鎖／事件沒清乾淨');
        // 送的哈哈獸要進圖鑑（2026-10-27 回報：得到了、圖鑑沒有）；這隻的 albumKey 先記好，之後換到前線不會再多算一次
        const alb = JSON.parse(fs.readFileSync(path.join(SD, 'album.json'), 'utf8'));
        const gift = r1.pets.find(p => p.id === r1.page2RewardId);
        ok(alb.chars.keramon && alb.counts && alb.counts.keramon === 1, '解鎖送的哈哈獸沒有進圖鑑：' + JSON.stringify(alb));
        ok(gift && gift.state.albumKey === 'keramon@' + gift.state.lastEvolveAt, '送的哈哈獸沒記 albumKey（換到前線會再算一次）');
        ok(!r1.page2Losses, '打贏了，輸的場數沒清掉');
        ok(r1.pets.length === 5 && r1.pets[4].state.characterId === 'keramon', '贏了營地第 5 格沒有 Keramon');
        ok(y.event.keramonId === r1.pets[4].id && y.event.keramonPage === 1, '結果沒告訴前端 Keramon 在第二頁（鏡頭要帶過去）');
        // 還沒演完（page2Ack 前）Keramon 不能露面：兩頁都不畫牠，前端沒帶 ?drop= 也一樣
        {
            const a = await yard(), b = await yard('?pg=1');
            ok(![...a.pets, ...b.pets].some(p => p.id === r1.pets[4].id), '打贏還沒演完，Keramon 就先出現在營地裡（滑過去之前就露面）');
        }
        ok(y.cap === 8, '解鎖後上限不是 8');
        await cmd('page2Ack');
        y = await yard();
        ok(!y.event && !ranch().page2Result, '演完（page2Ack）結果沒清掉');

        console.log('— 分頁（兩頁一起走，頁 = 鏡頭）—');
        ok(y.pages === 2 && y.page === 0, '解鎖後 5 隻應該分兩頁');
        const y0 = y;
        y = await yard('?pg=1');
        ok(y.page === 1, '第二頁打不開');
        ok(new Set([...y0.pets, ...y.pets].map(p => p.id)).size === 5, '兩頁加起來沒看到全部 5 隻');
        ok(y0.zones.length === 5 && y.zones.length === 5 && y0.zones[0].minX - y.zones[0].minX === y.cols,
           '分區框沒換成這一頁的座標（第二頁的框要往左移一頁寬）');
        const kid = r1.pets[4].id;
        // 拎起來／放下：座標是「這一頁」的。漏了頁碼換算，第二頁拎起來那一下會跳到右邊畫面外、放下會掉到第一頁
        {
            const yk = await yard('?pg=1'), pk = yk.pets.find(p => p.id === kid);
            ok(!!pk, '前提不成立：Keramon 不在第二頁的畫面裡');
            if (pk) {
                const g = await cmd('yardGrab', { which: kid, pg: '1' });
                ok(g.ok && Math.abs(g.x - pk.x) <= 3 && Math.abs(g.y - pk.y) <= 3, `第二頁拎起來的位置對不上畫面（${g.x},${g.y} vs ${pk.x},${pk.y}）`);
                const d = await cmd('yardDrop', { which: kid, x: String(g.x), y: String(g.y), pg: '1' });
                ok(d.ok && Math.abs(d.x - g.x) <= 2, `第二頁放下的位置跑掉了（${d.x} vs ${g.x}）`);
                await wait(300);
                const after = (await yard('?pg=1')).pets.find(p => p.id === kid);
                ok(after && Math.abs(after.x - g.x) <= 4, '放下之後 Keramon 不在第二頁剛放的地方');
            }
        }
        y = await yard('?pg=1&drop=' + kid);
        ok(y.drop && y.drop.id === kid && y.drop.frames.length === 2, '空降要回傳那隻的兩幀和落點');
        ok(!y.pets.some(p => p.id === kid), '空降中伺服器還在畫那隻（會看到兩隻）');
        y = await yard('?pg=7');
        ok(y.page === 1, '頁碼超出沒有夾住');

        console.log('— 輸：助手講完才退場、退完回平常 —');
        await cmd('page2Dev', { act: 'quest' }); await cmd('page2Dev', { act: 'lose' });
        ok((await cmd('page2Fight', { which: 'p0' })).ok, '第二次出戰失敗');
        edit(r => { r.page2Fight.startStep -= 1000; });
        y = await yard();
        ok(y.event && y.event.stage === 'result' && y.event.win === false && !y.event.exiting, '輸了沒結算、或還沒講完就開始退場');
        ok(!ranch().page2Quest, '輸了要從打 Diablomon 重來（事件要清掉）');
        ok(ranch().page2Losses === 1, '輸了沒記下輸的場數（越挫越勇 +5% 用）');
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
        ok(ranch().page2Losses === 1, '放棄也算進輸的場數了（沒有真的打）');
        // 越挫越勇：輸過一場 → 這場勝率 +5%；再輸 → 記成 2
        await cmd('page2Dev', { act: 'quest' }); await cmd('page2Dev', { act: 'lose' });
        ok((await cmd('page2Fight', { which: 'p0' })).ok, '輸過之後再出戰失敗');
        const f2 = ranch().page2Fight;
        ok(f2 && f2.bonus === 0.05 && f2.prob >= 0.1 && f2.prob <= 0.95, '輸過一場，這場勝率沒有 +5%：' + JSON.stringify(f2));
        edit(r => { r.page2Fight.startStep -= 1000; });
        await yard();
        ok(ranch().page2Losses === 2, '再輸一場沒有累加');

        console.log('— dev 重置：可以反覆測 —');
        edit(r => { r.pets.push({ id: 'mine', keptAt: 9, state: { characterId: 'keramon' } }); });   // 玩家自己養的
        const rid = ranch().page2RewardId;
        ok(rid && ranch().pets.some(p => p.id === rid), '前提不成立：解鎖送的 Keramon 不在營地');
        ok((await cmd('page2Dev', { act: 'reset' })).ok, 'dev 重置失敗');
        const rr = ranch();
        ok(!rr.page2At && !rr.page2Quest && !rr.page2Result && !rr.page2RewardId && !rr.page2Losses, '重置後事件旗標沒清乾淨');
        ok(!rr.pets.some(p => p.id === rid), '重置後解鎖送的 Keramon 還在（重測時營地會超過 4 隻）');
        ok(rr.pets.some(p => p.id === 'mine'), '重置把玩家自己養的 Keramon 也收走了');
        ok(rr.pets.length === 5, '重置動到了其他營地成員');

        console.log('— 台詞、mini 的選角 —');
        const T = require('../src/daemon/page2-talk.js');
        ok(!/Diablomon|Armagemon|Keramon/i.test(JSON.stringify(T)), '事件台詞還有英文角色名（要用繁中名）');
        const src = fs.readFileSync(path.join(REPO, 'src/daemon/daemon.js'), 'utf8');
        // 原則：事件演出一律放舞台下方，永遠不蓋住上面的畫面（2026-10-27 定）。不能有「置中」的退路；小視窗撐高 body 下內距、關掉縮回
        const sp = (src.match(/function storyPlace\(\)\{[^]*?\n\}/) || [''])[0];
        ok(sp && !/\(H-ph\)\/2/.test(sp) && /p\.style\.top=Math\.round\(bot\+10\)\+'px'/.test(sp) && /bot\+window\.scrollY\+10/.test(sp)
           && /bot=hl\?Math\.max\(st\.bottom, hl\.getBoundingClientRect\(\)\.bottom\+14\):st\.bottom;/.test(sp),
           '助手對話框不是一律放在舞台下方（會蓋住營地／廣場）');
        ok(/document\.body\.style\.paddingBottom=\(IN_MINI\|\|!fits\)\?/.test(sp) && /document\.body\.style\.paddingBottom='';/.test(src), '小視窗沒有撐高（或關掉沒縮回）');

        console.log('— dev 只在開發版 —');
        ok(/const DEV_ONLY\s*=\s*new Set\(\[[^\]]*'page2Dev'/.test(src), 'page2Dev 沒列在 DEV_ONLY（release 版也能強制解鎖）');
    } catch (e) {
        fail++; console.log('  ✗ 例外：' + e.stack);
    } finally {
        d.kill(); await wait(400);
        try { fs.rmSync(SD, { recursive: true, force: true }); } catch (e) {}
    }
    console.log('— 修正前就解鎖的人：圖鑑補登哈哈獸 —');
    {
        const SD2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vpet-page2b-'));
        fs.writeFileSync(path.join(SD2, 'ranch.json'), JSON.stringify({ v: 1, page2At: 1, page2RewardId: 'k',
            pets: [{ id: 'k', keptAt: 1, state: { characterId: 'keramon', birthAt: 1, lastEvolveAt: 1 } }] }));
        fs.writeFileSync(path.join(SD2, 'color-state.json'), JSON.stringify({ characterId: 'greymon' }));
        fs.writeFileSync(path.join(SD2, 'hook.json'), JSON.stringify({ ts: 1 }));
        const P2 = 3192;
        const d2 = spawn(process.execPath, [path.join(REPO, 'src/daemon/daemon.js'), '--isolated'],
            { env: { ...process.env, AGUMON_DAEMON_PORT: String(P2), AGUMON_STATE_DIR: SD2, AGUMON_YARD_LAYOUTS: path.join(SD2, 'none.json') }, stdio: 'ignore' });
        const get2 = (p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: P2, path: p }, s => { let d = ''; s.on('data', c => d += c); s.on('end', () => res(d)); }).on('error', rej));
        try {
            let up = false;
            for (let i = 0; i < 150 && !up; i++) { try { await get2('/state'); up = true; } catch (e) { await wait(100); } }
            await get2('/yard');
            let alb = {}; try { alb = JSON.parse(fs.readFileSync(path.join(SD2, 'album.json'), 'utf8')); } catch (e) {}
            ok(alb.chars && alb.chars.keramon, '已經解鎖、營地有哈哈獸，圖鑑卻沒補登');
        } finally { d2.kill(); await wait(400); try { fs.rmSync(SD2, { recursive: true, force: true }); } catch (e) {} }
    }
    console.log(`\n結果：${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
