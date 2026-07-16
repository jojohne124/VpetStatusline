'use strict';
// agumon restart —— statusline 整個「卡住 / 凍結」時的重啟工具。
//
// statusline 不是常駐服務：Claude Code 每次刷新才跑一次 render 指令。所謂「卡住」通常兩種：
//   (a) 有 render/hook 行程卡死沒退 → 擋住後續刷新；
//   (b) state 裡某個動畫/睡眠旗標卡住 → 每次 render 都畫同一個凍結畫面。
// 本工具兩者一起處理：
//   1. 強殺「所有」agumon render/hook node 行程（不限齡，比 doctor 更狠；doctor 只清 >20s 孤兒）。
//   2. 清掉 pids/ 追蹤檔。
//   3. 把「會凍結畫面的暫時性旗標」重置為乾淨 idle（battle/evo/drop/card/tree/roar/expr/sleep/pin）。
// 保留：角色身分與進度（characterId / evoHistory / 勝場 / 花費 / freeze・battle 開關 / 各 trigger 時戳）。
// 只碰 agumon 自己的東西，絕不動 Cursor 或其他程式。
//
// 跑完後：回 Claude Code 送一則訊息（或等下次刷新），就會跑出重生的乾淨 render。

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { scanAgumonNodes } = require('./doctor');   // 重用 doctor 的行程掃描

// 獨立跑時 __dirname 不是安裝目錄，故一律從 home 解析（可用 AGUMON_HOME 覆寫）
const INSTALL_ROOT = process.env.AGUMON_HOME || path.join(os.homedir(), '.claude', 'agumon-statusline');
const STATE_DIR    = path.join(INSTALL_ROOT, 'state');
const PIDS_DIR     = path.join(STATE_DIR, 'pids');
const COLOR_STATE  = path.join(STATE_DIR, 'color-state.json');
const FORCE_FILE   = path.join(STATE_DIR, 'force-char.json');

// 確認式收屍：SIGKILL 後回探，拿到 ESRCH 才算死透
function killConfirmed(pid) {
    try { process.kill(pid, 'SIGKILL'); } catch (e) {}
    try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
}

// 把「會凍結畫面的暫時性欄位」重置為 idle，保留身分/進度/刻意開關
function resetWedgedState() {
    let st;
    try { st = JSON.parse(fs.readFileSync(COLOR_STATE, 'utf8')); }
    catch (e) { return { ok: false, reason: '讀不到或壞檔 color-state.json（' + e.message + '）' }; }
    const before = JSON.stringify(st);
    Object.assign(st, {
        // 戰鬥
        battleStartStep: -1, battlePending: false, battleEnemy: null,
        battleShownElapsed: -1, battleNoCount: false,
        // 進化
        evoStartStep: -1, evoNextCharId: null, evoShownElapsed: -1,
        // 空降 / 狀態卡 / 進化樹 / 吼叫 / 表情
        dropStartStep: -1, dropShownElapsed: -1,
        cardStartStep: -1, treeStartStep: -1, roarStartStep: -1, exprStartStep: -1,
        // 睡眠（強制睡 / 閒置睡都解除，回到清醒）
        _forceSleep: false, wasSleeping: false,
        lastActivityAt: Date.now(),
    });
    const changed = JSON.stringify(st) !== before;
    try { fs.writeFileSync(COLOR_STATE, JSON.stringify(st)); }
    catch (e) { return { ok: false, reason: '寫回失敗（' + e.message + '）' }; }
    // 解除「釘住 IDLE 對照」（pin 會把畫面鎖在 idle）
    let unpinned = false;
    try {
        const f = JSON.parse(fs.readFileSync(FORCE_FILE, 'utf8'));
        if (f.pinIdle) { delete f.pinIdle; fs.writeFileSync(FORCE_FILE, JSON.stringify(f)); unpinned = true; }
    } catch (e) {}
    return { ok: true, changed, unpinned };
}

function cleanPids() {
    let n = 0;
    try { for (const f of fs.readdirSync(PIDS_DIR)) { try { fs.unlinkSync(path.join(PIDS_DIR, f)); n++; } catch (e) {} } }
    catch (e) {}
    return n;
}

function run() {
    console.log('=== agumon restart ===');
    console.log('  安裝目錄：' + INSTALL_ROOT);
    if (!fs.existsSync(STATE_DIR))
        console.log('  ⚠️ 找不到 state 目錄，可能尚未安裝或 AGUMON_HOME 設錯；仍會嘗試殺行程。');

    const procs = scanAgumonNodes();
    if (procs === null) {
        console.log('  ⚠️ 無法掃描行程清單（權限或逾時）；仍會清 pids + 重置狀態。');
    } else {
        let killed = 0, survived = 0;
        for (const p of procs) { if (killConfirmed(p.pid)) killed++; else survived++; }
        console.log(`  agumon 行程 ${procs.length} 個 → 殺掉 ${killed}` +
            (survived ? `，${survived} 個當下未死（可再跑一次）` : ''));
    }

    console.log('  清 pids 追蹤檔：' + cleanPids() + ' 個');

    const r = resetWedgedState();
    if (r.ok) console.log('  重置卡住狀態（保留角色/進度）：' + (r.changed ? '已重置' : '本來就乾淨') + (r.unpinned ? '（並解除 pin）' : ''));
    else console.log('  ⚠️ 狀態重置略過：' + r.reason);

    console.log('  ✅ 完成。回 Claude Code 送一則訊息或稍候刷新，桌寵就會重生。');
    return 0;
}

module.exports = { run };

// 直接執行：node restart.js
if (require.main === module) process.exit(run());
