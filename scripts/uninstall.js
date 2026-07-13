#!/usr/bin/env node
'use strict';
/**
 * uninstall.js — 移除 ~/.claude/agumon-statusline/
 *
 * 預設只刪 runtime + assets（保留 state/）。
 * 加 --purge 連同 state 一起刪。
 *
 * 不會動 settings.json，會提示使用者手動清理。
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const INSTALL_DIR = path.join(CLAUDE_HOME, 'agumon-statusline');
const STATE_DIR   = path.join(INSTALL_DIR, 'state');

const PURGE = process.argv.includes('--purge');

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
        return;
    }

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

    console.log('\n— settings.json 提醒（uninstall 不動它）—');
    console.log('  請至 ~/.claude/settings.json 自行移除：');
    console.log('    - statusLine.command（agumon-statusline 路徑）');
    console.log('    - hooks.UserPromptSubmit 內呼叫 agumon-hook.js 的 entry');

    console.log('\n解除安裝完成。');
}

if (require.main === module) main();
