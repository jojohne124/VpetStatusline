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
const IS_RELEASE   = fs.existsSync(path.join(INSTALL_ROOT, 'RELEASE'));   // release 版：隱藏/停用開發指令
const ROSTER_FILE  = path.join(INSTALL_ROOT, 'assets', 'roster.json');
const FORCE_FILE   = path.join(INSTALL_ROOT, 'state', 'force-char.json');
const STATE_FILE   = path.join(INSTALL_ROOT, 'state', 'color-state.json');
const PVP_FILE     = path.join(INSTALL_ROOT, 'state', 'pvp.json');   // { endpoint, key, code, name }

const rosterData = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
const roster   = Array.isArray(rosterData) ? rosterData : rosterData.roster;
const starters = Array.isArray(rosterData) ? rosterData : (rosterData.starters || [rosterData.roster[0]]);
const starterWeights = (rosterData && rosterData.starterWeights) || {};   // {id:權重}，缺 = 1

// reset 加權抽選：權重越大越容易被抽到；缺值視為 1，全為 0 時退回均勻。
function weightedPickStarter(list) {
    const ws = list.map(id => Math.max(0, starterWeights[id] ?? 1));
    const total = ws.reduce((a, b) => a + b, 0);
    if (total <= 0) return list[Math.floor(Math.random() * list.length)];
    let r = Math.random() * total;
    for (let i = 0; i < list.length; i++) { r -= ws[i]; if (r < 0) return list[i]; }
    return list[list.length - 1];
}

const args = process.argv.slice(2);

// 指令前綴：vpet pvp == vpet --pvp（可省略 --）。把裸關鍵字補回 --，下方既有邏輯一律不動，
// 舊的 --xxx 寫法也仍相容。角色名稱不在此清單 → 落到角色切換邏輯。
const SUBCMDS = ['pvp-setup','pvp-server','pvp','code','battle','card','sleep','wake','evolve','reset','freeze','unfreeze','tree','pin','unpin','doctor','hide','show'];
if (args[0] && !args[0].startsWith('--') && SUBCMDS.includes(args[0])) args[0] = '--' + args[0];

function printHelp() {
    const dev = !IS_RELEASE;   // 開發指令只在非 release 顯示
    console.log('用法（指令可省略 --，例 vpet pvp）:');
    console.log('  vpet help                   顯示這份指令說明');
    console.log('  vpet card                   顯示狀態卡（角色 / 階級 / 戰力 / 勝率）');
    console.log('  vpet tree                   顯示進化歷程（走過的彩色、未到的黑影問號）');
    console.log('  vpet reset                  重抽一隻起始桌寵');
    console.log('  vpet sleep / wake           強制睡覺 / 喚醒');
    console.log('  vpet freeze / unfreeze      凍結 / 解除進化（凍結時滿足條件也不自動進化）');
    console.log('  vpet battle on / off        恢復 / 停用 prompt 後的自動戰鬥');
    console.log('  vpet pvp-setup <url> <key> [名牌]  一鍵設定 PvP（首次用這個）');
    console.log('  vpet pvp [名牌]             幽靈對戰（隨機 / 指名；配不到真人派固定對手）');
    console.log('  vpet pvp MAJAJA             指名固定練習對手（純本機免連線）');
    console.log('  vpet code [名牌]            查看 / 設定名牌');
    console.log('  vpet doctor [--check]       檢查並清除卡死的 node 孤兒（--check 只診斷不清）');
    console.log('  vpet hide / show            隱藏 / 顯示狀態列的 pet（只留狀態文字；pet 可到獨立介面看）');
    if (dev) {
        console.log('  ── 開發指令（release 版不提供）──');
        console.log('  vpet <index|name>           切換到任意角色');
        console.log('  vpet evolve <next>          立即播進化表演');
        console.log('  vpet battle [enemy] [win|lose]  強制戰鬥 / 指定勝負');
        console.log('  vpet pvp-server <url> [key] 只設後端');
        console.log('  vpet pin / unpin            釘住 / 解除 IDLE 對照');
    }
}

// 顯式 help：vpet help / --help / -h（成功離開 exit 0）
if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') { printHelp(); process.exit(0); }
// 無參數：印用法（視為未給指令，exit 1）
if (!args.length) { printHelp(); process.exit(1); }

// doctor：檢查並清除 node 孤兒。放在 release gate 之前 → 維護指令一律可用。
// （真正卡死時建議用獨立包直接跑 doctor.js，不必經這裡；見 tools/agumon-doctor/）
if (args[0] === '--doctor') {
    const check = args.includes('--check') || args[1] === 'check';
    process.exit(require('./doctor').run({ fix: !check }));
}

// ── release 版 gate：部署目錄有 RELEASE 標記檔時，停用開發／作弊指令 ──
// 移除：直接切換任意角色、evolve <角色>、battle <敵人>/win/lose、pvp-server、pin/unpin。
// 保留：help/card/pvp/pvp-setup/code/sleep/wake/tree/reset/freeze/unfreeze、battle on/off。
if (IS_RELEASE) {
    const a0 = args[0];
    const blockedCmd    = ['--evolve', '--pvp-server', '--pin', '--unpin'].includes(a0);
    const blockedBattle = a0 === '--battle' && !(args[1] === 'on' || args[1] === 'off');  // 保留 battle on/off
    const blockedSwitch = a0 && !a0.startsWith('--');   // 裸角色名/index（--reset 有 -- 前綴不受影響）
    if (blockedCmd || blockedBattle || blockedSwitch) {
        console.log('此版本未提供此指令。輸入 vpet help 看可用指令。');
        process.exit(1);
    }
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
// 名牌（顯示名＝指名 ID 合一）：1-16 字、中文或英數、不可空白/符號；ASCII 自動轉大寫（指名不分大小寫）
function normId(raw) { return String(raw || '').trim().toUpperCase(); }
function validId(s)  { return /^[\p{L}\p{N}]{1,16}$/u.test(s); }
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
        code: p.code, name: p.code,   // 合併：顯示名＝名牌（=code）
        character: char,
        power: core.getCharacterPower(char),
        train: st.trainingBonus || 0,
        stage: core.getCharacterStage(char),
    };
}

// ── 固定練習對手（bot）：配不到真人時 fallback，或 `vpet pvp MAJAJA` 指名測試 ──
// ID 一律 MAJAJA，依玩家階級派出對應角色（純本機、不需 server）。
const PVP_BOT_CODE = 'MAJAJA';
const PVP_BOTS = { Child: 'babygodzilla', Adult: 'biollante', Perfect: 'kiryu', Ultimate: 'destoroyah' };
function makeBot(stage) {
    const character = PVP_BOTS[stage] || PVP_BOTS.Child;   // UnStage 等未知 → 退 Child
    return {
        code: PVP_BOT_CODE, name: PVP_BOT_CODE,
        character,
        power: core.getCharacterPower(character),
        train: 0,
        stage,                                             // 用玩家階級，保證同階對戰
    };
}
async function pvpFetch(method, urlPath, body) {
    const p = readPvp();
    if (!p.endpoint) throw new Error('尚未設定 server，請先：vpet pvp-setup <url> <key> [名牌]');
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

// ── --pvp-setup <url> <key> [名牌]：一鍵上手（server + 密鑰 + 名牌）──
if (args[0] === '--pvp-setup') {
    const url = args[1], key = args[2];
    if (!url || !key) {
        console.log('用法：vpet pvp-setup <url> <key> [名牌]');
        console.log('  url / key 由 PvP server 架設者(host)提供；名牌＝顯示名＝指名 ID');
        process.exit(1);
    }
    const p = readPvp();
    p.endpoint = url;
    p.key      = key;
    if (args[3]) {
        const id = normId(args[3]);
        if (!validId(id) || id === PVP_BOT_CODE) {
            console.log('✗ 名牌格式：1-16 字、中文或英數、不可空白/符號，且不可為 MAJAJA');
            process.exit(1);
        }
        p.code = id;
    }
    if (!p.code) p.code = genCode();
    delete p.name;
    writePvp(p);
    console.log('✓ PvP 設定完成');
    console.log(`  server：${p.endpoint}`);
    console.log(`  名牌  ：${p.code}  ← 貼給朋友讓他指名你（＝顯示名＝指名 ID）`);
    console.log('  開打：vpet pvp（隨機同階） / vpet pvp <名牌>（指名）');
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
    console.log(`  你的名牌：${p.code}`);
    process.exit(0);
}

// ── --code [名牌]：查看 / 設定名牌（顯示名＝指名 ID 合一）──────────
if (args[0] === '--code') {
    const p = ensureIdentity();
    // 取值：vpet code <名牌>；相容舊寫法 vpet code id <名牌>
    const val = (args[1] === 'id') ? args[2] : args[1];
    if (val != null) {
        const id = normId(val);
        if (!validId(id)) {
            console.log('✗ 名牌格式：1-16 字、中文或英數、不可有空白與符號。例：vpet code 阿張 / vpet code KAI123');
            process.exit(1);
        }
        if (id === PVP_BOT_CODE) {
            console.log(`✗「${PVP_BOT_CODE}」是內建練習對手保留字，請換一個。`);
            process.exit(1);
        }
        const old = p.code;
        if (old === id) { console.log(`名牌已是 ${id}，未變更。`); process.exit(0); }
        p.code = id;
        delete p.name;            // 合併：不再有獨立顯示名
        writePvp(p);
        console.log(`✓ 名牌已設為：${id}（原 ${old}）`);
        console.log('  這同時是你的顯示名與指名 ID；下次 vpet pvp 會把卡上傳到新名牌。');
        console.log('  ⚠ 同群朋友間別跟人撞名牌（上傳會覆蓋對方卡片）。');
        // 改名 → 順手刪掉 server 上的舊卡（非致命：沒設 server 或刪除失敗都不影響改名）
        if (p.endpoint) {
            (async () => {
                try {
                    await pvpFetch('DELETE', `/card/${encodeURIComponent(old)}`);
                    console.log(`  🧹 已刪除 server 上的舊卡：${old}`);
                } catch (e) {
                    console.log(`  （舊卡 ${old} 未刪除：${e.message}；30 天 TTL 仍會自動過期）`);
                }
                process.exitCode = 0;   // 不用 process.exit()：fetch socket 關閉中硬退會觸發 Windows UV assertion
            })();
            return;
        }
        process.exit(0);
    }
    console.log(`名牌  ：${p.code}　（＝顯示名＝指名 ID）`);
    console.log(`server：${p.endpoint || '(未設定，vpet pvp-setup <url> <key>)'}`);
    console.log(`改名牌：vpet code <新名牌>（中文或英數，例 vpet code 阿張）`);
    process.exit(0);
}

// ── --pvp [code]：幽靈對戰（隨機 / 指名）─────────────────────────
if (args[0] === '--pvp') {
    (async () => {
        try {
            const me = myCard();
            const target = args[1] ? normId(args[1]) : null;   // 指名不分大小寫
            const wantBot = target === PVP_BOT_CODE;

            let opp;
            if (wantBot) {
                // 指名固定練習對手：純本機，不上傳、不連線
                opp = makeBot(me.stage);
            } else {
                await pvpFetch('PUT', `/card/${encodeURIComponent(me.code)}`, me);   // 順手更新自己的卡
                if (target) {
                    opp = await pvpFetch('GET', `/card/${encodeURIComponent(target)}`);
                } else {
                    try {
                        opp = await pvpFetch('GET', `/random?stage=${encodeURIComponent(me.stage)}&exclude=${encodeURIComponent(me.code)}`);
                    } catch (e) {
                        // 配不到同階真人（no_opponent / 404）→ 退回固定練習對手；其他錯誤（403 等）照常拋出
                        if (/no_opponent|HTTP 404/.test(e.message)) {
                            opp = makeBot(me.stage);
                        } else throw e;
                    }
                }
            }

            // 對手角色本機沒有資產（對方新版才加 / 客製角色）→ 不硬擋：
            // 勝負用對手卡片數據（power+train）算，與本機資產無關；渲染端會自動以黑影佔位演出。
            const oppMissing = !roster.includes(opp.character);

            // 差距制線性：勝率% = 50 + (我戰 - 敵戰)，戰力 = min(power+train, 階級 cap)
            // 跟單機共用 core.winProbFromStr；PvP 體驗補正 0 → 零和對稱（A勝率 + B勝率 = 100）
            const myStr  = Math.min(me.power  + (me.train  || 0), core.getTierCap(me.stage));
            const oppStr = Math.min(opp.power + (opp.train || 0), core.getTierCap(opp.stage));
            const winProb = core.winProbFromStr(myStr, oppStr, 0);

            // seed：雙方 code + 當下時間 → 每次挑戰結果會變，但用 core 的決定性擲骰
            const seedStr = `${me.code}:${opp.code}:${Date.now()}`;
            let h = 0; for (const ch of seedStr) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
            const win = core.seedRand01(h) < winProb;

            // 對手 ID label（戰鬥演出時顯示）：合併後名牌＝code
            const oppLabel = opp.code;

            // 跨階對戰不計勝率（指名可跨階，但只有同階戰績影響勝率/進化，防刷）
            const crossStage = opp.stage !== me.stage;

            // 寫進跟 --battle 完全一樣的 force 欄位 → statusline 照原流程演出
            const force = readForce();
            force.battleTriggerTs  = Date.now();
            force.forceBattleEnemy = opp.character;
            force.forceBattleWin   = win;
            force.pvpOppLabel      = String(oppLabel).slice(0, 22);   // 敵方腳下名牌
            force.pvpMeLabel       = String(me.code).slice(0, 22);    // 我方腳下名牌
            if (crossStage) force.battleNoCount = true;               // 跨階 → 這場不計勝率
            else            delete force.battleNoCount;
            writeForce(force);

            // 不印勝負與勝率（避免暴雷）；MAJAJA(bot) 視為一般玩家，log 不透露是練習對手
            const xtag = crossStage ? '（跨階，不計勝率）' : '';
            const shadowTag = oppMissing ? '（本機無此角色資產，以黑影演出）' : '';
            console.log(`✓ 幽靈對戰：vs ${oppLabel} (${opp.character})${xtag}${shadowTag} — 開打！（下次 refresh 演出）`);
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
        else if (!a.startsWith('--') && a !== 'win' && a !== 'lose' && !enemy) enemy = a.toLowerCase();  // 角色名不分大小寫
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
    delete force.pvpOppLabel;             // 手動戰鬥非 PvP，清掉殘留名牌
    delete force.pvpMeLabel;
    delete force.battleNoCount;           // 手動戰鬥照常計入勝率
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

if (args[0] === '--pin' || args[0] === '--unpin') {
    const force = readForce();
    if (args[0] === '--pin') { force.pinIdle = true;  console.log('📌 statusline 已 pin 成 IDLE_1 朝左(對照用)；vpet unpin 解除'); }
    else                     { delete force.pinIdle;   console.log('已解除 pin'); }
    writeForce(force);
    process.exit(0);
}

if (args[0] === '--tree') {
    // 進化歷程改在 statusline 顯示(終端 raw 輸出會劣化 truecolor，statusline 渲染正確)。
    const force = readForce();
    force.treeTriggerTs = Date.now();
    writeForce(force);
    console.log('🌳 進化歷程已排入 statusline(下次 refresh 顯示約 9 秒，淡入淡出)');
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

// ── --hide / --show：隱藏 / 顯示 statusline 的 pet（狀態列照常顯示）──────────
// 給「只想用 statusline 狀態列」或「只在獨立介面看 pet」的人。非作弊，release 也可用。
if (args[0] === '--hide' || args[0] === '--show') {
    const force = readForce();
    if (args[0] === '--hide') {
        force.petHidden = true;
        writeForce(force);
        console.log('✓ 已隱藏 pet（statusline 只顯示狀態列；vpet show 恢復。想看 pet 可用獨立介面）');
    } else {
        delete force.petHidden;
        writeForce(force);
        console.log('✓ 已恢復顯示 pet');
    }
    process.exit(0);
}

// ── --evolve 模式 ────────────────────────────────────────────────
if (args[0] === '--evolve') {
    const target = args[1] ? args[1].toLowerCase() : args[1];   // 角色名不分大小寫
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
    // 只抽「已實裝(在 roster)」的 starter：未實裝的 starter（如子彈未完成的 fujamon）不該被抽到
    const pool = starters.filter(s => roster.includes(s));
    target = weightedPickStarter(pool.length ? pool : starters);
    console.log(`🎲 隨機抽到：${target}`);
} else {
    const idx = parseInt(arg, 10);
    target = isNaN(idx) ? arg.toLowerCase() : roster[idx - 1];   // 角色名不分大小寫
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
if (arg === '--reset') force.dropTriggerTs = Date.now();   // reset 抽 starter → 播空降表演
writeForce(force);
console.log(`✓ 已切換至 ${target}（下次 refresh 生效）`);
