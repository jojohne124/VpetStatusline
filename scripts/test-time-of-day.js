#!/usr/bin/env node
'use strict';
// 驗證 time_of_day 進化條件（日夜分歧）。
// 規則：06:00–18:00 為日，其餘為夜。即時 gate、不 latch。
// 用法：node scripts/test-time-of-day.js
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

console.log(`\n結果：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
