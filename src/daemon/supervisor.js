'use strict';
/**
 * supervisor.js — release 版 daemon 的外殼（docs/update-spec.md）
 *
 * 啟動器（tray／.bat／.sh）跑的還是 daemon.js；release 樹裡 daemon.js 一開頭就交給這裡：
 *   1. 同步跑 updater.js（有新版就裝好）
 *   2. 用（可能是新的）daemon.js 起一個子行程（VPET_CHILD=1）做真正的事，自己在旁邊等
 *   3. 子行程以 RESTART_CODE 結束（頁面上按「有新版本」）→ 回到 1；其他結束碼 → 跟著結束
 *
 * 為什麼要一層外殼、而不是更新完 daemon 自己重開一個新的就走：tray 盯的是**這個** PID，
 * 換一個 PID 它會以為 daemon 掛了、把圖示收掉。外殼的 PID 從頭到尾不變。
 * 子行程每 2 秒確認外殼還在，外殼被砍（tray 的「結束」只殺得到外殼）就自己收掉，不留孤兒。
 */
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const RESTART_CODE = 75;

/** opts（測試用）：daemon、updater、args、env */
function run(opts = {}) {
    const daemon  = opts.daemon  || path.join(__dirname, 'daemon.js');
    const updater = opts.updater || path.join(__dirname, 'updater.js');
    const args = opts.args || process.argv.slice(2);
    const env  = opts.env  || process.env;
    let child = null;

    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => { if (child) child.kill(sig); else process.exit(0); });
    }

    const once = () => {
        // 更新失敗也照常起 daemon（舊版照跑；原因 updater 已經記在 state/update.json）
        spawnSync(process.execPath, [updater], { stdio: 'inherit', env, timeout: 180000 });
        child = spawn(process.execPath, [daemon, ...args],
            { stdio: 'inherit', env: { ...env, VPET_CHILD: '1', VPET_PARENT_PID: String(process.pid) } });
        child.on('exit', (code, signal) => {
            child = null;
            if (code === RESTART_CODE) return once();
            process.exit(code == null ? (signal ? 1 : 0) : code);
        });
    };
    once();
}

/** 子行程這邊：外殼不在了就自己結束（不然 tray 結束後會留一隻佔著 port 的孤兒） */
function watchParent(ppid, onGone) {
    const t = setInterval(() => {
        try { process.kill(ppid, 0); } catch (e) { if (e.code === 'ESRCH') { clearInterval(t); onGone(); } }
    }, 2000);
    t.unref();
    return t;
}

module.exports = { run, watchParent, RESTART_CODE };
