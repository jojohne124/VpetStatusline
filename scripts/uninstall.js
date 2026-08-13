#!/usr/bin/env node
'use strict';
/**
 * uninstall.js — 移除 ~/.claude/agumon-statusline/
 *
 * 預設只刪 runtime + assets（保留 state/）。
 * 加 --purge 連同 state 一起刪。
 * 加 --keep-settings 則不動 settings.json（只印提示）。
 *
 * settings.json 清理原則：**只移除指向 agumon-statusline 的項目**。
 *   statusLine.command 指向別處（使用者自己的 statusline，daemon-only 安裝就是這種）
 *   → 一律不碰。舊版是印一段「請自行移除 statusLine.command」的提示，對 daemon-only
 *   使用者等於叫他把自己的東西砍掉，所以改成程式自己判斷、按路徑比對。
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const INSTALL_DIR = path.join(CLAUDE_HOME, 'agumon-statusline');
const STATE_DIR   = path.join(INSTALL_DIR, 'state');

const PURGE         = process.argv.includes('--purge');
const KEEP_SETTINGS = process.argv.includes('--keep-settings');

// 判斷一段 command 字串是不是「我們裝的」。比對部署目錄，不比對檔名 ——
// 使用者自己的 statusline 也可能叫 statusline.js，只有路徑才分得出來。
const INSTALL_MARK = 'agumon-statusline';
const isOurs = (cmd) => typeof cmd === 'string'
    && cmd.replace(/\\/g, '/').includes(INSTALL_MARK);

// 只拆掉指向 agumon-statusline 的設定；其餘原封不動。
function cleanSettings(wasDaemonOnly) {
    console.log('\n— 清理 ~/.claude/settings.json —');
    const settingsPath = path.join(CLAUDE_HOME, 'settings.json');
    if (!fs.existsSync(settingsPath)) { console.log('  [skip] 找不到 settings.json'); return; }

    const raw = fs.readFileSync(settingsPath, 'utf8');
    let cur;
    try { cur = JSON.parse(raw); } catch (e) {
        console.log(`  [skip] 解析失敗（${e.message}），請自行檢查`);
        return;
    }

    let changed = false;

    // statusLine：只有指向我們的才移除
    const slCmd = cur.statusLine && cur.statusLine.command;
    if (slCmd && isOurs(slCmd)) {
        delete cur.statusLine;
        console.log(`  [rm]     statusLine（原本指向 agumon-statusline）`);
        changed = true;
    } else if (slCmd) {
        console.log(`  [keep]   statusLine 指向別處，不是我們裝的 → 保留：${slCmd}`);
        if (wasDaemonOnly) console.log('           （daemon-only 安裝本來就沒接管 statusLine）');
    }

    // hooks.UserPromptSubmit：抽掉呼叫 agumon-hook 的 entry，空掉的 block 一併移除
    const ups = cur.hooks && cur.hooks.UserPromptSubmit;
    if (Array.isArray(ups)) {
        let removed = 0;
        for (const block of ups) {
            if (!block || !Array.isArray(block.hooks)) continue;
            const before = block.hooks.length;
            block.hooks = block.hooks.filter(h => !(h && (isOurs(h.command) || /agumon[-_]?hook/i.test(h.command || ''))));
            removed += before - block.hooks.length;
        }
        cur.hooks.UserPromptSubmit = ups.filter(b => b && Array.isArray(b.hooks) && b.hooks.length);
        if (removed) {
            console.log(`  [rm]     hooks.UserPromptSubmit x${removed}（agumon-hook）`);
            changed = true;
        }
        if (!cur.hooks.UserPromptSubmit.length) delete cur.hooks.UserPromptSubmit;
        if (cur.hooks && !Object.keys(cur.hooks).length) delete cur.hooks;
    }

    if (!changed) { console.log('  -> 沒有屬於 agumon-statusline 的設定，無需變更'); return; }
    const bak = settingsPath + '.before-agumon-uninstall.bak';
    fs.writeFileSync(bak, raw);
    fs.writeFileSync(settingsPath, JSON.stringify(cur, null, 2));
    console.log(`  -> 已更新（備份至 ${path.basename(bak)}）`);
}

function rmIfExists(p) {
    if (!fs.existsSync(p)) { console.log(`  [skip] ${path.relative(os.homedir(), p)}`); return false; }
    const st = fs.statSync(p);
    if (st.isDirectory()) {
        fs.rmSync(p, { recursive: true, force: true });
        console.log(`  [rmdir] ${path.relative(os.homedir(), p)}/`);
    } else {
        fs.unlinkSync(p);
        console.log(`  [rm]    ${path.relative(os.homedir(), p)}`);
    }
    return true;
}

function main() {
    console.log('agumon-cli uninstall');
    console.log(`  install : ${INSTALL_DIR}`);
    console.log(`  purge   : ${PURGE ? '是（連 state 一起刪）' : '否（保留 state/）'}`);

    if (!fs.existsSync(INSTALL_DIR)) {
        console.log('\n沒有偵測到 agumon-statusline/，無需解除安裝。');
        if (!KEEP_SETTINGS) cleanSettings(false);   // 資料夾沒了但設定可能還殘留
        return;
    }

    // 刪掉資料夾之前先記下模式（標記檔就在裡面）
    const wasDaemonOnly = fs.existsSync(path.join(INSTALL_DIR, 'DAEMON_ONLY'));
    if (wasDaemonOnly) console.log('  模式    : daemon-only（不曾接管 statusLine）');

    if (PURGE) {
        rmIfExists(INSTALL_DIR);
    } else {
        // 暫時把 state/ 搬出來，刪整個資料夾，再搬回去
        const tmpStateBackup = path.join(CLAUDE_HOME, '.agumon-statusline-state-tmp');
        const hasState = fs.existsSync(STATE_DIR);
        if (hasState) {
            if (fs.existsSync(tmpStateBackup)) fs.rmSync(tmpStateBackup, { recursive: true, force: true });
            fs.renameSync(STATE_DIR, tmpStateBackup);
        }
        rmIfExists(INSTALL_DIR);
        if (hasState) {
            fs.mkdirSync(INSTALL_DIR, { recursive: true });
            fs.renameSync(tmpStateBackup, STATE_DIR);
            console.log(`  [keep]  state/（已保留：${fs.readdirSync(STATE_DIR).join(', ') || '空'}）`);
        }
    }

    // 移除全域 vpet 指令（npm link 註冊的）；後備 ~/bin 薄殼一併清掉
    console.log('\n— 移除 vpet 全域指令 —');
    const unlinked = spawnSync('npm', ['unlink', '-g', 'agumon-cli'], { stdio: 'inherit', shell: true });
    if (!unlinked.error && unlinked.status === 0) {
        console.log('  [npm unlink] 已移除全域 vpet');
    } else {
        console.log('  [skip] npm unlink 未成功（可能本來就沒 link）');
    }
    for (const fn of ['vpet', 'vpet.bat']) {
        rmIfExists(path.join(os.homedir(), 'bin', fn));
    }

    if (KEEP_SETTINGS) {
        console.log('\n— settings.json（--keep-settings：不動它）—');
        console.log('  若要手動清，只移除「指向 agumon-statusline 路徑」的項目：');
        console.log('    - statusLine.command');
        console.log('    - hooks.UserPromptSubmit 內呼叫 agumon-hook.js 的 entry');
        if (wasDaemonOnly) console.log('  ⚠️ 你是 daemon-only 安裝，statusLine 是你自己的，別動它。');
    } else {
        cleanSettings(wasDaemonOnly);
    }

    console.log('\n解除安裝完成。');
}

if (require.main === module) main();
