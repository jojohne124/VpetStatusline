#!/usr/bin/env node
// 作弊碼：強制切換角色 / reset 到隨機 starter / 立即觸發戰鬥 / 強制進化
// 用法：
//   node statusline-cheat.js <index|name>      切換角色
//   node statusline-cheat.js --reset           reset 到隨機 starter
//   node statusline-cheat.js --battle [enemy]  立即觸發戰鬥（敵人可省略，預設 godzilla_1999）
//     可選：--win / --lose 強制勝負
//   node statusline-cheat.js --evolve <next>   立即播進化表演，結束切到 <next>
'use strict';
const fs   = require('fs');
const path = require('path');

const INSTALL_ROOT = __dirname;
const ROSTER_FILE  = path.join(INSTALL_ROOT, 'assets', 'roster.json');
const FORCE_FILE   = path.join(INSTALL_ROOT, 'state', 'force-char.json');

const rosterData = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
const roster   = Array.isArray(rosterData) ? rosterData : rosterData.roster;
const starters = Array.isArray(rosterData) ? rosterData : (rosterData.starters || [rosterData.roster[0]]);

const args = process.argv.slice(2);

if (!args.length) {
    console.log('用法:');
    console.log('  node statusline-cheat.js <index|name>      切換角色');
    console.log('  node statusline-cheat.js --reset           reset 到隨機 starter');
    console.log('  node statusline-cheat.js --battle [enemy]  立即觸發戰鬥');
    console.log('    --win / --lose 強制勝負');
    console.log('  node statusline-cheat.js --evolve <next>   立即播進化表演');
    console.log('\n目前角色列表:');
    roster.forEach((name, i) => console.log(`  #${i + 1} ${name}`));
    console.log('Starters:', starters.join(', '));
    process.exit(1);
}

function readForce() {
    try { return JSON.parse(fs.readFileSync(FORCE_FILE, 'utf8')); }
    catch(e) { return {}; }
}
function writeForce(obj) {
    const tmp = `${FORCE_FILE}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.mkdirSync(path.dirname(FORCE_FILE), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(obj));
        fs.renameSync(tmp, FORCE_FILE);   // atomic：避免 statusline 讀到 partial write
    } catch(e) {
        try { fs.unlinkSync(tmp); } catch(_) {}
        throw e;
    }
}

// ── --battle 模式 ────────────────────────────────────────────────
if (args[0] === '--battle') {
    let enemy = null;
    let win   = null;  // null = 隨機
    for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (a === '--win')       win = true;
        else if (a === '--lose') win = false;
        else if (!a.startsWith('--') && !enemy) enemy = a;
    }
    if (enemy && !roster.includes(enemy)) {
        console.log(`找不到敵人：${enemy}`);
        roster.forEach((name, i) => console.log(`  #${i + 1} ${name}`));
        process.exit(1);
    }
    const force = readForce();
    force.battleTriggerTs = Date.now();   // token：每個視窗各自比對，多視窗都能觸發
    if (enemy)            force.forceBattleEnemy = enemy;
    else                  delete force.forceBattleEnemy;
    if (win !== null)     force.forceBattleWin   = win;
    else                  delete force.forceBattleWin;
    writeForce(force);
    const enemyLabel = enemy || 'godzilla_1999 (預設)';
    const winLabel   = win === null ? '隨機' : (win ? '勝利' : '失敗');
    console.log(`✓ 已排入戰鬥：vs ${enemyLabel}，勝負 ${winLabel}（下次 refresh 生效）`);
    process.exit(0);
}

// ── --evolve 模式 ────────────────────────────────────────────────
if (args[0] === '--evolve') {
    const target = args[1];
    if (!target) {
        console.log('用法：node statusline-cheat.js --evolve <next-char>');
        roster.forEach((name, i) => console.log(`  #${i + 1} ${name}`));
        process.exit(1);
    }
    if (!roster.includes(target)) {
        console.log(`找不到角色：${target}`);
        roster.forEach((name, i) => console.log(`  #${i + 1} ${name}`));
        process.exit(1);
    }
    const force = readForce();
    force.evolveTriggerTs = Date.now();
    force.evolveTarget    = target;
    // 避免下次 refresh 被殘留的 force.character 拉回舊角色
    delete force.character;
    delete force.resetCostBase;
    writeForce(force);
    console.log(`✓ 已排入進化：→ ${target}（下次 refresh 生效）`);
    process.exit(0);
}

// ── 切換角色 / reset ─────────────────────────────────────────────
const arg = args[0];
let target;
if (arg === '--reset') {
    target = starters[Math.floor(Math.random() * starters.length)];
    console.log(`🎲 隨機抽到：${target}`);
} else {
    const idx = parseInt(arg, 10);
    target = isNaN(idx) ? arg : roster[idx - 1];
}

if (!target || !roster.includes(target)) {
    console.log(`找不到角色: ${arg}`);
    roster.forEach((name, i) => console.log(`  #${i + 1} ${name}`));
    process.exit(1);
}

const force = readForce();
force.character     = target;
force.resetCostBase = true;
writeForce(force);
console.log(`✓ 已切換至 ${target}（下次 refresh 生效）`);
