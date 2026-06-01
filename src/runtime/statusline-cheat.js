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
const STATE_FILE   = path.join(INSTALL_ROOT, 'state', 'color-state.json');
const PVP_FILE     = path.join(INSTALL_ROOT, 'state', 'pvp.json');   // { endpoint, key, code, name }

const rosterData = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
const roster   = Array.isArray(rosterData) ? rosterData : rosterData.roster;
const starters = Array.isArray(rosterData) ? rosterData : (rosterData.starters || [rosterData.roster[0]]);

const args = process.argv.slice(2);

// 指令前綴：vpet pvp == vpet --pvp（可省略 --）。把裸關鍵字補回 --，下方既有邏輯一律不動，
// 舊的 --xxx 寫法也仍相容。角色名稱不在此清單 → 落到角色切換邏輯。
const SUBCMDS = ['pvp-setup','pvp-server','pvp','code','battle','card','sleep','wake','evolve','reset','freeze','unfreeze'];
if (args[0] && !args[0].startsWith('--') && SUBCMDS.includes(args[0])) args[0] = '--' + args[0];

if (!args.length) {
    console.log('用法（指令可省略 --，例 vpet pvp）:');
    console.log('  vpet <index|name>           切換角色');
    console.log('  vpet reset                  reset 到隨機 starter');
    console.log('  vpet battle [enemy]         立即觸發戰鬥（可加 win / lose 強制勝負）');
    console.log('  vpet battle on / off        恢復 / 停用 prompt 後的自動戰鬥');
    console.log('  vpet evolve <next>          立即播進化表演');
    console.log('  vpet freeze / unfreeze      凍結 / 解除進化（凍結時滿足條件也不自動進化）');
    console.log('  vpet pvp-setup <url> <key> [name]  一鍵設定 PvP（首次用這個）');
    console.log('  vpet pvp [code]             幽靈對戰（隨機 / 指名 friend code）');
    console.log('  vpet code [name]            查看 / 設定 friend code 與名稱');
    console.log('  vpet pvp-server <url> [key] 只設後端（進階）');
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

// ── 幽靈對戰（--pvp）helpers ─────────────────────────────────────
// 結算重用 agumon-core 的戰力/階級函式，保證跟本機演出一致。
const core = require('./agumon-core.js');

function readPvp()  { try { return JSON.parse(fs.readFileSync(PVP_FILE, 'utf8')); } catch(e) { return {}; } }
function writePvp(o){ fs.mkdirSync(path.dirname(PVP_FILE), { recursive: true }); fs.writeFileSync(PVP_FILE, JSON.stringify(o, null, 2)); }
function genCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 去掉易混 I/O/0/1
    let s = ''; for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
    return s;
}
function ensureIdentity() {
    const p = readPvp();
    if (!p.code) { p.code = genCode(); writePvp(p); }
    return p;
}
function myCard() {
    const st   = core.loadState(STATE_FILE);
    const char = st.characterId || 'agumon';
    const p    = ensureIdentity();
    return {
        code: p.code, name: p.name || p.code,
        character: char,
        power: core.getCharacterPower(char),
        train: st.trainingBonus || 0,
        rank:  core.getCharacterRank(char),
    };
}
async function pvpFetch(method, urlPath, body) {
    const p = readPvp();
    if (!p.endpoint) throw new Error('尚未設定 server，請先：vpet pvp-setup <url> <key> [名字]');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
        const res = await fetch(p.endpoint.replace(/\/$/, '') + urlPath, {
            method, signal: ctrl.signal,
            headers: { 'Content-Type': 'application/json', ...(p.key ? { 'X-Pvp-Key': p.key } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        const txt = await res.text();
        let data; try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error || txt}`);
        return data;
    } finally { clearTimeout(timer); }
}

// ── --pvp-setup <url> <key> [name]：一鍵上手（server + 密鑰 + 名稱，並印出 friend code）──
if (args[0] === '--pvp-setup') {
    const url = args[1], key = args[2];
    if (!url || !key) {
        console.log('用法：vpet pvp-setup <url> <key> [name]');
        console.log('  url / key 由 PvP server 架設者(host)提供');
        process.exit(1);
    }
    const p = readPvp();
    p.endpoint = url;
    p.key      = key;
    if (args[3]) p.name = args.slice(3).join(' ').slice(0, 24);
    if (!p.code) p.code = genCode();
    writePvp(p);
    console.log('✓ PvP 設定完成');
    console.log(`  server     ：${p.endpoint}`);
    console.log(`  friend code：${p.code}  ← 貼給朋友讓他指名你`);
    console.log(`  顯示名稱   ：${p.name || '(未設定，預設用 code)'}`);
    console.log('  開打：vpet pvp（隨機同階） / vpet pvp <code>（指名）');
    process.exit(0);
}

// ── --pvp-server <url> [key]：設定後端 ───────────────────────────
if (args[0] === '--pvp-server') {
    const url = args[1];
    if (!url) { console.log('用法：vpet pvp-server <url> [key]'); process.exit(1); }
    const p = readPvp();
    p.endpoint = url;
    if (args[2]) p.key = args[2];
    if (!p.code) p.code = genCode();
    writePvp(p);
    console.log(`✓ PvP server 已設定：${url}${args[2] ? '（含密鑰）' : ''}`);
    console.log(`  你的 friend code：${p.code}`);
    process.exit(0);
}

// ── --code [name]：查看 / 設定身分 ──────────────────────────────
if (args[0] === '--code') {
    const p = ensureIdentity();
    if (args[1]) {
        p.name = args.slice(1).join(' ').slice(0, 24);
        writePvp(p);
        console.log(`✓ 顯示名稱已設定：${p.name}`);
    } else {
        console.log(`friend code：${p.code}`);
        console.log(`顯示名稱   ：${p.name || '(未設定，預設用 code)'}`);
        console.log(`server     ：${p.endpoint || '(未設定，vpet pvp-setup <url> <key>)'}`);
    }
    process.exit(0);
}

// ── --pvp [code]：幽靈對戰（隨機 / 指名）─────────────────────────
if (args[0] === '--pvp') {
    (async () => {
        try {
            const me = myCard();
            await pvpFetch('PUT', `/card/${me.code}`, me);   // 順手更新自己的卡

            const target = args[1];
            const opp = target
                ? await pvpFetch('GET', `/card/${encodeURIComponent(target)}`)
                : await pvpFetch('GET', `/random?rank=${encodeURIComponent(me.rank)}&exclude=${me.code}`);

            if (!roster.includes(opp.character)) {
                console.log(`✗ 對手角色「${opp.character}」本機沒有資產，無法演出（雙方需同一套角色）`);
                process.exit(1);
            }

            // 戰力加權隨機：winProb = 我戰力 / (我+敵戰力)，戰力 = min(power+train, 階級 cap)
            const myStr  = Math.min(me.power  + (me.train  || 0), core.getTierCap(me.rank));
            const oppStr = Math.min(opp.power + (opp.train || 0), core.getTierCap(opp.rank));
            const denom  = myStr + oppStr;
            const winProb = denom > 0 ? myStr / denom : 0.5;

            // seed：雙方 code + 當下時間 → 每次挑戰結果會變，但用 core 的決定性擲骰
            const seedStr = `${me.code}:${opp.code}:${Date.now()}`;
            let h = 0; for (const ch of seedStr) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
            const win = core.seedRand01(h) < winProb;

            // 寫進跟 --battle 完全一樣的 force 欄位 → statusline 照原流程演出
            const force = readForce();
            force.battleTriggerTs  = Date.now();
            force.forceBattleEnemy = opp.character;
            force.forceBattleWin   = win;
            writeForce(force);

            console.log(`✓ 幽靈對戰：vs ${opp.name || opp.code} (${opp.character}) → ${win ? '勝利 🏆' : '失敗'}　勝率 ${Math.round(winProb * 100)}%（下次 refresh 演出）`);
            process.exitCode = 0;   // 不用 process.exit()：fetch keep-alive socket 還在關閉時硬退會觸發
                                    // Windows libuv UV_HANDLE_CLOSING assertion。設 exitCode 讓事件迴圈自然排空。
        } catch (e) {
            console.log('✗ 幽靈對戰失敗：' + e.message);
            process.exitCode = 1;
        }
    })();
    return;   // 不要往下掉到切角色邏輯（CommonJS 允許 top-level return）
}

// ── --battle 模式 ────────────────────────────────────────────────
if (args[0] === '--battle') {
    // 持久開關：vpet battle off / on（停用 / 恢復 prompt 後自動戰鬥；手動測試不受影響）
    if (args[1] === 'off' || args[1] === 'on') {
        const force = readForce();
        if (args[1] === 'off') {
            force.autoBattleOff = true;
            writeForce(force);
            console.log('🛡 已停用自動戰鬥（prompt 後不會自動開打；vpet battle 仍可手動測試、vpet battle on 恢復）');
        } else {
            delete force.autoBattleOff;
            writeForce(force);
            console.log('⚔ 已恢復自動戰鬥');
        }
        process.exit(0);
    }
    let enemy = null;
    let win   = null;  // null = 隨機
    for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (a === '--win' || a === 'win')        win = true;
        else if (a === '--lose' || a === 'lose') win = false;
        else if (!a.startsWith('--') && a !== 'win' && a !== 'lose' && !enemy) enemy = a;
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
    const enemyLabel = enemy || '同階隨機敵人';
    const winLabel   = win === null ? '依 trigger 決定' : (win ? '勝利' : '失敗');
    console.log(`✓ 已排入戰鬥：vs ${enemyLabel}，勝負 ${winLabel}（下次 refresh 生效）`);
    process.exit(0);
}

// ── --card 模式（顯示狀態卡 5 秒，自動隱藏）──────────────────────
if (args[0] === '--card') {
    const force = readForce();
    force.cardTriggerTs = Date.now();
    writeForce(force);
    console.log('✓ 已排入狀態卡（下次 refresh 顯示 5 秒，淡入淡出）');
    process.exit(0);
}

// ── --sleep / --wake 模式（強制睡覺開關，持續到手動喚醒）──────────
if (args[0] === '--sleep' || args[0] === '--wake') {
    const force = readForce();
    if (args[0] === '--sleep') {
        force.forceSleep = true;
        writeForce(force);
        console.log('✓ 已強制睡覺（持續到 vpet wake；發訊息不會喚醒）');
    } else {
        delete force.forceSleep;
        writeForce(force);
        console.log('✓ 已喚醒（解除強制睡覺）');
    }
    process.exit(0);
}

// ── --freeze / --unfreeze：凍結進化開關 ──────────────────────────
// 凍結後即使滿足進化條件也不會自動進化（手動 vpet evolve 仍可）。持續到 unfreeze。
if (args[0] === '--freeze' || args[0] === '--unfreeze') {
    const force = readForce();
    let on;
    if (args[0] === '--unfreeze' || args[1] === 'off') on = false;
    else if (args[1] === 'on')                          on = true;
    else                                                on = !force.freezeEvolve;   // 無參數 → 切換
    if (on) {
        force.freezeEvolve = true;
        writeForce(force);
        console.log('🧊 已凍結進化（滿足條件也不會自動進化；vpet evolve 仍可手動、vpet unfreeze 解除）');
    } else {
        delete force.freezeEvolve;
        writeForce(force);
        console.log('☀ 已解除進化凍結');
    }
    process.exit(0);
}

// ── --evolve 模式 ────────────────────────────────────────────────
if (args[0] === '--evolve') {
    const target = args[1];
    if (!target) {
        console.log('用法：vpet evolve <next-char>');
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
// 清掉殘留的進化 trigger，避免「切角色 + 之前還沒消費掉的 --evolve」同次 refresh 一起觸發
delete force.evolveTriggerTs;
delete force.evolveTarget;
writeForce(force);
console.log(`✓ 已切換至 ${target}（下次 refresh 生效）`);
