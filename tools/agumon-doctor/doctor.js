'use strict';
// agumon doctor —— 手動掃描並清除 statusline / hook 的 node 孤兒。
//
// statusline 內建的跨行程收屍（reapStale）平時就會自動清孤兒；本工具是「手動補刀 + 診斷」：
// 隨時用 `vpet doctor` 就能得到權威答案（現在有幾隻孤兒）並一鍵清除，不必再手刻 PowerShell。
//
// 判定：掃 OS 上所有 node，只認命令列含 statusline-agumon-color / agumon-hook 的行程。
//   齡 > ORPHAN_AGE_SEC 視為孤兒（健康 render 1~3 秒就結束；留超過 20 秒＝卡死/凍結）。
//   只收 agumon 自己的行程，絕不碰 Cursor / 其他 node。
//   誤殺代價極低：頂多中止某一幀 render，下一幀自動重生。
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const INSTALL_ROOT   = __dirname;
const PIDS_DIR       = path.join(INSTALL_ROOT, 'state', 'pids');
const ORPHAN_AGE_SEC = 20;   // 與 statusline-agumon-color.js 的 REAP_AGE 對齊

// 掃 OS 上的 agumon node → [{ pid, ageSec, threads, kind }]；kind ∈ 'statusline'|'hook'
// 掃描失敗回 null（與「掃到 0 隻」區分開）。
function scanAgumonNodes() {
    return process.platform === 'win32' ? scanWin() : scanUnix();
}

function scanWin() {
    // 只對每個 node 逐一查 CommandLine（per-PID CIM 快又穩；整表查 CommandLine 在高負載會逾時）。
    // 分類在 PowerShell 端完成，只回傳 agumon 相關，node 端拿到的清單很小。
    const psScript = [
        "$ErrorActionPreference='SilentlyContinue'",
        "$now=Get-Date",
        "Get-Process node | ForEach-Object {",
        "  $p=$_; $st=$null; try{$st=$p.StartTime}catch{}",
        "  $age= if($st){[int]($now-$st).TotalSeconds}else{-1}",
        "  $cl=(Get-CimInstance Win32_Process -Filter \"ProcessId=$($p.Id)\").CommandLine",
        "  $k= if($cl -match 'statusline-agumon-color'){'statusline'} elseif($cl -match 'agumon-hook'){'hook'} else {'other'}",
        "  if($k -ne 'other'){ \"$($p.Id)|$age|$($p.Threads.Count)|$k\" }",
        "}",
    ].join('\n');
    let out;
    try {
        out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript],
            { encoding: 'utf8', timeout: 25000 });
    } catch (e) { return null; }
    return out.trim().split(/\r?\n/).filter(Boolean).map(line => {
        const [pid, age, threads, kind] = line.split('|');
        return { pid: +pid, ageSec: +age, threads: +threads, kind };
    });
}

function scanUnix() {
    // ps 一次列出 pid / 已運行秒數 / 完整命令列，grep 出 agumon 相關。
    let out;
    try { out = execFileSync('ps', ['-eo', 'pid=,etimes=,args='], { encoding: 'utf8', timeout: 15000 }); }
    catch (e) { return null; }
    const res = [];
    for (const line of out.split(/\r?\n/)) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (!m) continue;
        const args = m[3];
        if (!/\bnode\b/.test(args)) continue;
        const kind = /statusline-agumon-color/.test(args) ? 'statusline'
                   : /agumon-hook/.test(args)             ? 'hook' : 'other';
        if (kind === 'other') continue;
        res.push({ pid: +m[1], ageSec: +m[2], threads: 0, kind });
    }
    return res;
}

// 確認式收屍：送 SIGKILL 後回探，唯有拿到 ESRCH（確認死亡）才算成功。
function killConfirmed(pid) {
    try { process.kill(pid, 'SIGKILL'); } catch (e) {}
    try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
}

// 清 pids/ 裡「行程已死」的殘留登記檔，回傳清掉幾個。
function cleanDeadPidFiles() {
    let names = [];
    try { names = fs.readdirSync(PIDS_DIR); } catch (e) { return 0; }
    let cleaned = 0;
    for (const name of names) {
        const pid = parseInt(name, 10);
        if (!pid) continue;
        let dead = false;
        try { process.kill(pid, 0); } catch (e) { dead = (e.code === 'ESRCH'); }
        if (dead) { try { fs.unlinkSync(path.join(PIDS_DIR, name)); cleaned++; } catch (e) {} }
    }
    return cleaned;
}

// fix=true 收屍；fix=false 只診斷。回傳 exit code（0=沒孤兒或已清乾淨；2=掃描失敗）。
function run({ fix = true } = {}) {
    console.log('=== agumon doctor ===');
    const procs = scanAgumonNodes();
    if (procs === null) {
        console.log('  ⚠️ 無法掃描行程清單（權限或逾時）；改看 pids/ 追蹤檔。');
        const cleaned = cleanDeadPidFiles();
        let tracked = [];
        try { tracked = fs.readdirSync(PIDS_DIR); } catch (e) {}
        console.log(`  pids/ 目前追蹤 ${tracked.length} 個、清掉死檔 ${cleaned} 個`);
        return 2;
    }

    const healthy = procs.filter(p => p.ageSec >= 0 && p.ageSec <= ORPHAN_AGE_SEC);
    const orphans = procs.filter(p => p.ageSec > ORPHAN_AGE_SEC);

    console.log(`  agumon node 共 ${procs.length} 個：健康 transient ${healthy.length}、孤兒(齡>${ORPHAN_AGE_SEC}s) ${orphans.length}`);
    for (const o of orphans) {
        const mm = Math.floor(o.ageSec / 60);
        console.log(`  [孤兒] pid ${o.pid}  ${o.kind}  齡 ${o.ageSec}s(${mm}分)  執行緒 ${o.threads}`);
    }

    let killed = 0, survived = 0;
    if (fix && orphans.length) {
        for (const o of orphans) {
            if (killConfirmed(o.pid)) { killed++; try { fs.unlinkSync(path.join(PIDS_DIR, o.pid + '.pid')); } catch (e) {} }
            else survived++;
        }
        console.log(`  收屍：殺掉 ${killed} 個` + (survived ? `，${survived} 個當下未死（下次 doctor 或 render 會再殺）` : ''));
    } else if (orphans.length) {
        console.log('  （--check 模式，只診斷不收屍）');
    }

    const cleaned = cleanDeadPidFiles();
    if (cleaned) console.log(`  另清掉 pids/ 死檔 ${cleaned} 個`);

    const remaining = orphans.length - killed;
    console.log(remaining > 0 ? `  結果：仍有 ${remaining} 個孤兒` : '  結果：無孤兒 ✅');
    return 0;
}

module.exports = { run, scanAgumonNodes, ORPHAN_AGE_SEC };

// 允許直接執行：node doctor.js [--check]
if (require.main === module) {
    const check = process.argv.slice(2).includes('--check');
    process.exit(run({ fix: !check }));
}
