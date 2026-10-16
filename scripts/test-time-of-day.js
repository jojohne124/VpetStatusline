#!/usr/bin/env node
'use strict';
// 驗證 time_of_day 進化條件（日夜分歧）。
// 規則：06:00–18:00 為日，其餘為夜。即時 gate、不 latch。
// 用法：node scripts/test-time-of-day.js
const fs   = require('fs');
const path = require('path');
const core = require('../src/runtime/agumon-core.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } };

// ── 1. 邊界對照表（複製 runtime 的判定式，逐時驗證 06–18 為日）──────────
console.log('— 24 小時日夜對照（06:00–18:00 為日）—');
const expectDay = h => h >= 6 && h < 18;
for (let h = 0; h < 24; h++) {
    const isDay = h >= 6 && h < 18;
    ok(isDay === expectDay(h), `hour ${h} 判定錯誤`);
    if (h === 5 || h === 6 || h === 17 || h === 18) {
        console.log(`  ${String(h).padStart(2, '0')}:00 → ${isDay ? '日 ☀' : '夜 🌙'}  (邊界)`);
    }
}

// ── 2. 端對端：checkEvolution 在「當前真實時刻」走對分支 ──────────────
// 兩條分支只掛 time_of_day（day / night），互斥 → 當前時刻必有且僅有一條達標。
const config = {
    evolvesTo: [
        { character: 'daymon',   conditions: [{ type: 'time_of_day', period: 'day'   }] },
        { character: 'nightmon', conditions: [{ type: 'time_of_day', period: 'night' }] },
    ],
};
const nowHour = new Date().getHours();
const expected = (nowHour >= 6 && nowHour < 18) ? 'daymon' : 'nightmon';
const got = core.checkEvolution({}, {}, config);
console.log(`\n— 端對端（現在 ${String(nowHour).padStart(2,'0')}:00）—`);
console.log(`  期望進化目標：${expected}`);
console.log(`  實際回傳：    ${got}`);
ok(got === expected, `checkEvolution 應回傳 ${expected}，實得 ${got}`);

// ── 3. 與 win_rate 共用 operator:and（夜晚 + 勝率達標才進化）──────────
// 模擬「夜間 + 已達勝率」→ 只有當前是夜才該觸發。
const andCfg = {
    evolvesTo: [{
        character: 'lilithmon',
        operator: 'and',
        conditions: [
            { type: 'win_rate', pct: 0, minBattles: 0 },   // 必過（門檻 0）
            { type: 'time_of_day', period: 'night' },
        ],
    }],
};
const gotAnd = core.checkEvolution({ battleTotalCount: 10, battleWinCount: 10 }, {}, andCfg);
const isNight = !(nowHour >= 6 && nowHour < 18);
console.log(`\n— and 組合（win_rate + 夜晚）—`);
console.log(`  現在是${isNight ? '夜' : '日'} → 期望 ${isNight ? 'lilithmon' : 'null'}，實得 ${gotAnd}`);
ok(gotAnd === (isNight ? 'lilithmon' : null), `and 組合判定錯誤`);

// ── 3. win_rate.minWins：本階段勝場門檻（Diablomon → Armagemon）──────────
{
    const cfg = { evolvesTo: [{ character: 'agumon', conditions: [{ type: 'win_rate', pct: 0, minBattles: 0, minWins: 30 }] }] };
    ok(core.checkEvolution({ battleTotalCount: 40, battleWinCount: 29 }, {}, cfg) === null, '勝場 29 < 30 卻進化了');
    ok(core.checkEvolution({ battleTotalCount: 80, battleWinCount: 30 }, {}, cfg) === 'agumon', '勝場到 30 沒進化（輸的場次不該扣）');
    const plain = { evolvesTo: [{ character: 'agumon', conditions: [{ type: 'win_rate', pct: 0, minBattles: 0 }] }] };
    ok(core.checkEvolution({}, {}, plain) === 'agumon', '沒寫 minWins 的舊條件被擋住了');
    // Diablomon 實際的設定：要靠勝場、不是秒進化
    const dia = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'characters', 'Diablomon', 'config.json'), 'utf8'));
    const e = (dia.evolvesTo || []).find(x => x.character === 'armagemon');
    const w = e && e.conditions.find(c => c.type === 'win_rate');
    ok(w && w.minWins > 0, 'Diablomon → Armagemon 沒有勝場門檻');
    // Zephagamon → Ace：戰力 200 + 進化後 72 小時 + 勝率 80%（2026-10-16 拍板，原本只有戰力 + 24 小時太簡單）
    const zep = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'characters', 'Zephagamon', 'config.json'), 'utf8'));
    const ze = (zep.evolvesTo || []).find(x => x.character === 'zephagamon_ace');
    const zc = (t) => ze && ze.conditions.find(c => c.type === t);
    ok(zc('power_at_least') && zc('power_at_least').power === 200, 'Zephagamon → Ace 的戰力門檻不是 200');
    ok(zc('elapsed_since') && zc('elapsed_since').since === 'evolve' && zc('elapsed_since').seconds === 72 * 3600, 'Zephagamon → Ace 不是進化後 72 小時');
    ok(zc('win_rate') && zc('win_rate').pct === 80 && zc('win_rate').minBattles > 0, 'Zephagamon → Ace 沒有勝率 80%（或沒有最少場數，首戰全勝就過）');
    // 路線編輯器：讀、白名單、存三處都要有 minWins，不然存一次檔就消失
    const srv = fs.readFileSync(path.join(__dirname, '..', 'src', 'editor', 'route_editor_server.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'editor', 'route_editor.html'), 'utf8');
    ok(/minWins: win && win\.minWins != null/.test(srv), '編輯器讀不到 minWins');
    ok(/minWins: p\.minWins/.test(srv), '編輯器白名單沒有 minWins（存檔後會消失）');
    ok(/win\.minWins = e\.minWins/.test(srv), '編輯器存檔沒寫回 minWins（Armagemon 會變成秒進化）');
    ok(/'minWins',this\.value/.test(html), '編輯器頁面沒有勝場欄位');
}

console.log(`\n結果：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
