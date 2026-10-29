#!/usr/bin/env node
'use strict';
/**
 * test-godzilla.js — 期間限定事件「怪獸入侵（哥吉拉）」（docs/godzilla-event-spec.md）
 *
 * 起一隻**隔離**的 daemon（AGUMON_STATE_DIR 指到 temp，營地是現場合成的 4 隻 = 剛好滿），
 * 用 /cmd 走完：說明看過 → 三關的設定 → 通關 → 營地滿了領不到 → 空出位置領到哥吉拉寶寶（進圖鑑）→ dev 重置。
 * 打仗本身在頁面本地跑（duel-sim），這裡只驗 daemon 記的進度；頁面那側只檢查有沒有接上。
 * 不碰使用者真的存檔；角色資料讀已安裝的（唯讀）。
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const DS = require('../src/shared/duel-sim.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };

const REPO = path.resolve(__dirname, '..');
const SD   = fs.mkdtempSync(path.join(os.tmpdir(), 'vpet-gz-'));
const RANCH = path.join(SD, 'ranch.json');
const CHARS = ['agumon', 'gabumon', 'palmon', 'tentomon'];
fs.writeFileSync(RANCH, JSON.stringify({ v: 1, pets: CHARS.map((c, i) => ({ id: 'p' + i, keptAt: i + 1, state: { characterId: c } })) }));
fs.writeFileSync(path.join(SD, 'color-state.json'), JSON.stringify({ characterId: 'greymon' }));
fs.writeFileSync(path.join(SD, 'hook.json'), JSON.stringify({ ts: 1 }));

const PORT = 3193;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const req = (method, p, body) => new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, s => {
        let d = ''; s.on('data', c => d += c); s.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res({ raw: d }); } }); });
    r.on('error', rej); if (body) r.write(JSON.stringify(body)); r.end();
});
const cmd   = (action, args = {}) => req('POST', '/cmd', { action, args });
const ranch = () => JSON.parse(fs.readFileSync(RANCH, 'utf8'));
const edit  = (fn) => { const r = ranch(); fn(r); fs.writeFileSync(RANCH, JSON.stringify(r)); };

(async () => {
    console.log('— 場地（duel-sim）—');
    ok(DS.createDuel([10, 10], 'ruins').bg === 'ruins' && DS.createDuel([10, 10], 'ruinsfire').bg === 'ruinsfire', '事件場地（破敗都市）被 createDuel 換掉了');
    ok(DS.createDuel([10, 10], 'nope').bg === DS.BGS[0], '不認得的場地沒有退回預設');
    ok(!DS.BGS.includes('ruins') && !DS.BGS.includes('ruinsfire'), '事件場地不能進一般對戰的隨機場地');

    const d = spawn(process.execPath, [path.join(REPO, 'src/daemon/daemon.js'), '--isolated'],
        { env: { ...process.env, AGUMON_DAEMON_PORT: String(PORT), AGUMON_STATE_DIR: SD, VPET_PLAZA_URL: 'http://127.0.0.1:1' }, stdio: 'ignore' });
    try {
        let up = false;
        for (let i = 0; i < 150 && !up; i++) { try { await req('GET', '/state'); up = true; } catch (e) { await wait(100); } }
        ok(up, 'daemon 起不來');

        console.log('— 一開始 —');
        let r = await cmd('gzInfo');
        ok(r.ok && r.active, '開發版應該一直開著');
        ok(r.seen === false && r.clear.join() === 'false,false,false' && r.claimed === false, '一開始的進度不對：' + JSON.stringify(r));
        ok(r.full === true, '營地 4 隻（上限 4）應該算滿');
        ok(r.stages.map(s => s.me + '>' + s.opp + '@' + s.bg).join() ===
           'godzilla_1954>kiryu@ruins,godzilla_1994>king_ghidorah_2001@ruins,burninggodzilla>destoroyah@ruinsfire', '三關的組合／場地不對');

        console.log('— 說明看過 —');
        ok((await cmd('gzSeen')).seen === true && ranch().gz.seen === true, '說明看過沒記下來');

        console.log('— 開打的設定 —');
        r = await cmd('gzStart', { stage: '0' });
        ok(r.ok && r.me.char === 'godzilla_1954' && r.opp.char === 'kiryu' && r.bg === 'ruins', '第一關的設定不對');
        ok(r.me.str > 0 && r.opp.str > r.me.str, '頭目戰力要比我方高：' + r.me.str + ' vs ' + r.opp.str);
        r = await cmd('gzStart', { stage: '2' });
        ok(r.ok && r.me.char === 'burninggodzilla' && r.opp.char === 'destoroyah' && r.bg === 'ruinsfire', '第三關要在炎上版');
        ok(!(await cmd('gzStart', { stage: '3' })).ok && !(await cmd('gzStart', {})).ok, '不存在的關卡也能開打');

        console.log('— 通關、領獎 —');
        ok(!(await cmd('gzClaim')).ok, '一關都沒過就能領');
        await cmd('gzClear', { stage: '0' });
        r = await cmd('gzClear', { stage: '1' });
        ok(r.clear.join() === 'true,true,false', '通關記錯：' + r.clear);
        ok(!(await cmd('gzClaim')).ok, '只過兩關就能領');
        ok(!(await cmd('gzClear', { stage: '9' })).ok, '不存在的關卡也能記通關');
        r = await cmd('gzClear', { stage: '2' });
        ok(r.clear.every(Boolean), '三關都過了，沒有全通');
        r = await cmd('gzClaim');
        ok(!r.ok && r.full, '營地滿了還領得到');
        ok(ranch().pets.length === 4 && !ranch().gz.rewardId, '營地滿了領不到，卻還是動到營地');
        edit(x => { x.pets = x.pets.filter(p => p.id !== 'p3'); });   // 放生一隻、空出位置
        r = await cmd('gzClaim');
        ok(r.ok && r.claimed, '空出位置還是領不到：' + JSON.stringify(r));
        const pet = ranch().pets.find(p => p.id === ranch().gz.rewardId);
        ok(pet && pet.state.characterId === 'babygodzilla', '營地裡沒有哥吉拉寶寶');
        ok(ranch().pets.length === 4, '領完營地應該是 4 隻');
        let album = {}; try { album = JSON.parse(fs.readFileSync(path.join(SD, 'album.json'), 'utf8')); } catch (e) {}
        ok(album.chars && album.chars.babygodzilla, '哥吉拉寶寶沒進圖鑑');
        ok(!(await cmd('gzClaim')).ok && ranch().pets.length === 4, '可以重複領');

        console.log('— dev 重置 —');
        r = await cmd('gzDev', { act: 'reset' });
        ok(r.ok && !ranch().gz && ranch().pets.length === 3 && !ranch().pets.some(p => p.state.characterId === 'babygodzilla'), 'dev 重置沒有清進度／收走送的那隻');
        ok(ranch().pets.map(p => p.id).join() === 'p0,p1,p2', 'dev 重置動到玩家自己的桌寵');
        r = await cmd('gzDev', { act: 'clear' });
        ok(r.clear.every(Boolean), 'dev 直接通關沒作用');

        console.log('— 頁面有接上 —');
        const html = await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/' }, s => {
            let t = ''; s.on('data', c => t += c); s.on('end', () => res(t)); }).on('error', rej));
        ok(/id="gzbtn"[^>]*data-when="gz"/.test(html), '前線沒有怪獸入侵的按鈕（或沒有 data-when，檔期外也會露臉）');
        ok(html.includes("gz:           ()=>!!(gzState&&gzState.active)"), 'WHEN 沒有 gz');
        ok(html.includes("name==='ruins'||name==='ruinsfire'"), '手動戰鬥沒有破敗都市的背景');
        ok(html.includes("mbDevStart('gz',+b.dataset.gz)") && html.includes("sendCmd('gzClear'"), '選單沒接上開打／通關');
        ok(html.includes("if(gz) gzAfter();"), '結算卡回選單沒接上（三關全通的獎勵講解不會出來）');
    } finally {
        d.kill();
        await wait(300);
        try { fs.rmSync(SD, { recursive: true, force: true }); } catch (e) {}
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERR', e.stack); process.exit(1); });
