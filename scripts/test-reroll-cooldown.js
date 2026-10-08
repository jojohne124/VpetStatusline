#!/usr/bin/env node
// 重抽冷卻：reset / keep 共用一個冷卻，冷卻中擋下、不寫 force；冷卻 0（dev）不限。
// 跑的是部署樹的 CLI（要先 npm run install-runtime），state 一律導到暫存目錄，不碰真存檔。
'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(os.homedir(), '.claude', 'agumon-statusline', 'statusline-cheat.js');
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('  ✗ ' + msg); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpet-reroll-'));
const FORCE  = path.join(dir, 'force-char.json');
const REROLL = path.join(dir, 'reroll.json');
const run = (cmd, cooldown) => spawnSync(process.execPath, [CLI, cmd], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, AGUMON_STATE_DIR: dir, AGUMON_REROLL_COOLDOWN_MS: String(cooldown) },
});
const clear = () => { for (const f of [FORCE, REROLL]) try { fs.unlinkSync(f); } catch (e) {} };

try {
    // 1. 第一次 reset 放行並記下時戳
    let r = run('reset', 3600000);
    ok(r.status === 0, '第一次 reset 應該放行：' + r.stdout);
    ok(fs.existsSync(REROLL), 'reset 成功後應該寫 reroll.json');

    // 2. 冷卻內再 reset 被擋，force 不被改
    fs.writeFileSync(FORCE, '{}');
    r = run('reset', 3600000);
    ok(r.status === 1 && /冷卻中/.test(r.stdout), '冷卻內 reset 應該被擋：' + r.stdout);
    ok(fs.readFileSync(FORCE, 'utf8') === '{}', '被擋時不該寫 force');

    // 3. reset 的冷卻也擋 keep（共用）
    r = run('keep', 3600000);
    ok(r.status === 1 && /冷卻中/.test(r.stdout), '冷卻內 keep 應該被擋：' + r.stdout);

    // 4. 冷卻過了就放行
    fs.writeFileSync(REROLL, JSON.stringify({ at: Date.now() - 3600001 }));
    r = run('reset', 3600000);
    ok(r.status === 0, '冷卻過後 reset 應該放行：' + r.stdout);

    // 5. keep 成功也會起算冷卻
    clear();
    r = run('keep', 3600000);
    ok(r.status === 0, '第一次 keep 應該放行：' + r.stdout);
    r = run('reset', 3600000);
    ok(r.status === 1 && /冷卻中/.test(r.stdout), 'keep 之後 reset 應該被擋：' + r.stdout);

    // 6. 冷卻 0（dev）不限
    clear();
    ok(run('reset', 0).status === 0 && run('reset', 0).status === 0, '冷卻 0 時應該可以連抽');
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}

if (fails) { console.log(`test-reroll-cooldown：${fails} 項失敗`); process.exit(1); }
console.log('test-reroll-cooldown：全部通過');
