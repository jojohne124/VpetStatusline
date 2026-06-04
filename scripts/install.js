#!/usr/bin/env node
'use strict';
/**
 * install.js — 把 repo 部署到 ~/.claude/agumon-statusline/
 *
 * 目錄結構（部署後）：
 *   ~/.claude/agumon-statusline/
 *   ├── agumon-core.js
 *   ├── statusline-agumon-color.js
 *   ├── statusline-agumon.js
 *   ├── statusline-cheat.js
 *   ├── agumon-hook.js
 *   ├── agumon-art.json                  (v4 黑白)
 *   ├── assets/
 *   │   ├── roster.json
 *   │   ├── <character>/{art.json, config.json, bullet-art.json}
 *   │   └── shared/{manifest.json, art.json}
 *   └── state/                            (使用者資料，install 只新建不覆蓋)
 *       ├── color-state.json
 *       ├── state.json
 *       ├── hook.json
 *       └── force-char.json
 *
 * 額外動作：
 *   - 自動偵測舊版散落在 ~/.claude/ 的 state 檔，遷移到新位置
 *   - 自動更新 ~/.claude/settings.json 的 statusLine.command 與
 *     hooks.UserPromptSubmit 路徑（含備份）
 *   - 清除舊版散落在 ~/.claude/ 的 runtime js 與 agumon-assets/
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT   = path.resolve(__dirname, '..');
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const INSTALL_DIR = path.join(CLAUDE_HOME, 'agumon-statusline');
const ASSETS_DIR  = path.join(INSTALL_DIR, 'assets');
const STATE_DIR   = path.join(INSTALL_DIR, 'state');

const RUNTIME_FILES = [
    'agumon-core.js',
    'statusline-agumon-color.js',
    'statusline-agumon.js',
    'statusline-cheat.js',
    'agumon-hook.js',
];

// 舊版散落在 ~/.claude/ 的檔案 → 新位置
const LEGACY_RUNTIME_FILES = [
    'agumon-core.js',
    'statusline-agumon-color.js',
    'statusline-agumon.js',
    'statusline-cheat.js',
    'agumon-hook.js',
    'agumon-art.json',
    'agumon-happy-debug.log',
];

const LEGACY_STATE_MIGRATIONS = [
    { from: 'agumon-color-state.json', to: 'color-state.json' },
    { from: 'agumon-state.json',       to: 'state.json'       },
    { from: 'agumon-hook.json',        to: 'hook.json'        },
    { from: 'agumon-force-char.json',  to: 'force-char.json'  },
];

const LEGACY_ASSETS_DIR = path.join(CLAUDE_HOME, 'agumon-assets');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function copyFile(src, dst, label) {
    if (!fs.existsSync(src)) { console.warn(`  [skip] 找不到 ${src}`); return false; }
    ensureDir(path.dirname(dst));
    fs.copyFileSync(src, dst);
    console.log(`  ${label ? `[${label}] ` : ''}${path.relative(REPO_ROOT, src)} -> ${path.relative(os.homedir(), dst)}  (${fs.statSync(dst).size}B)`);
    return true;
}

function installRuntime() {
    console.log('\n[1/8] 安裝 runtime js -> ~/.claude/agumon-statusline/');
    const srcDir = path.join(REPO_ROOT, 'src', 'runtime');
    let ok = 0;
    for (const fn of RUNTIME_FILES) {
        if (copyFile(path.join(srcDir, fn), path.join(INSTALL_DIR, fn))) ok++;
    }
    console.log(`  -> ${ok}/${RUNTIME_FILES.length} runtime 檔案已安裝`);
}

function installCharacters() {
    console.log('\n[2/8] 安裝角色資產 -> ~/.claude/agumon-statusline/assets/');
    const charsDir = path.join(REPO_ROOT, 'characters');
    if (!fs.existsSync(charsDir)) { console.warn(`  [skip] 找不到 characters/`); return; }
    const installed = [];
    for (const entry of fs.readdirSync(charsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const srcCharDir = path.join(charsDir, entry.name);
        const dstName    = entry.name.toLowerCase();
        const dstCharDir = path.join(ASSETS_DIR, dstName);
        const art = path.join(srcCharDir, 'art.json');
        const cfg = path.join(srcCharDir, 'config.json');
        const bulletArt = path.join(srcCharDir, 'bullet-art.json');
        const cutinArt  = path.join(srcCharDir, 'cutin-art.json');
        if (!fs.existsSync(art) || !fs.existsSync(cfg)) {
            console.warn(`  [skip] ${entry.name}: 缺 art.json 或 config.json`);
            continue;
        }
        copyFile(art, path.join(dstCharDir, 'art.json'),    dstName);
        copyFile(cfg, path.join(dstCharDir, 'config.json'), dstName);
        if (fs.existsSync(bulletArt)) {
            copyFile(bulletArt, path.join(dstCharDir, 'bullet-art.json'), dstName);
        }
        if (fs.existsSync(cutinArt)) {
            copyFile(cutinArt, path.join(dstCharDir, 'cutin-art.json'), dstName);
        }
        installed.push(dstName);
    }
    console.log(`  -> 已安裝 ${installed.length} 個角色：${installed.join(', ')}`);
}

function installRoster() {
    console.log('\n[3/8] 安裝 roster.json');
    copyFile(path.join(REPO_ROOT, 'characters', 'roster.json'), path.join(ASSETS_DIR, 'roster.json'));
}

function installShared() {
    console.log('\n[4/8] 安裝共用 sprite -> ~/.claude/agumon-statusline/assets/shared/');
    const srcDir = path.join(REPO_ROOT, 'shared');
    const dstDir = path.join(ASSETS_DIR, 'shared');
    const files = ['manifest.json', 'art.json'];
    let ok = 0;
    for (const fn of files) {
        const src = path.join(srcDir, fn);
        if (fs.existsSync(src)) {
            copyFile(src, path.join(dstDir, fn));
            ok++;
        }
    }
    if (ok === 0) console.warn('  [skip] 找不到 shared/manifest.json + art.json（請先執行 npm run gen-shared）');
    else console.log(`  -> ${ok}/${files.length} 共用檔已安裝`);
}

function installV4Art() {
    console.log('\n[5/8] 安裝 v4（黑白）art');
    const src = path.join(REPO_ROOT, 'legacy', 'agumon-source', 'agumon_art.json');
    if (!fs.existsSync(src)) { console.warn('  [skip] 找不到 legacy/agumon-source/agumon_art.json'); return; }
    copyFile(src, path.join(INSTALL_DIR, 'agumon-art.json'));
}

function migrateLegacyState() {
    console.log('\n[6/8] 遷移舊版散落檔');
    ensureDir(STATE_DIR);

    let migrated = 0;
    for (const m of LEGACY_STATE_MIGRATIONS) {
        const oldP = path.join(CLAUDE_HOME, m.from);
        const newP = path.join(STATE_DIR, m.to);
        if (fs.existsSync(oldP)) {
            if (fs.existsSync(newP)) {
                console.log(`  [keep new] ${m.to}（兩處都存在，採用新位置；舊檔刪除）`);
                fs.unlinkSync(oldP);
            } else {
                fs.renameSync(oldP, newP);
                console.log(`  [migrate]  ${m.from} -> agumon-statusline/state/${m.to}`);
            }
            migrated++;
        }
    }
    if (migrated === 0) console.log('  -> 無 state 檔需要遷移');

    let cleaned = 0;
    for (const fn of LEGACY_RUNTIME_FILES) {
        const p = path.join(CLAUDE_HOME, fn);
        if (fs.existsSync(p)) {
            try { fs.unlinkSync(p); console.log(`  [clean]    ~/.claude/${fn}`); cleaned++; }
            catch(e) { console.warn(`  [clean failed] ~/.claude/${fn}: ${e.message}`); }
        }
    }
    if (fs.existsSync(LEGACY_ASSETS_DIR)) {
        try { fs.rmSync(LEGACY_ASSETS_DIR, { recursive: true, force: true }); console.log(`  [clean]    ~/.claude/agumon-assets/`); cleaned++; }
        catch(e) { console.warn(`  [clean failed] ~/.claude/agumon-assets/: ${e.message}`); }
    }
    if (cleaned === 0) console.log('  -> 沒有舊版散落檔需要清理');
}

function updateSettings() {
    console.log('\n[7/8] 更新 ~/.claude/settings.json');
    const settingsPath = path.join(CLAUDE_HOME, 'settings.json');

    const newCmd  = `node ${path.join(INSTALL_DIR, 'statusline-agumon-color.js').replace(/\\/g, '/')}`;
    const newHook = `node ${path.join(INSTALL_DIR, 'agumon-hook.js').replace(/\\/g, '/')}`;

    if (!fs.existsSync(settingsPath)) {
        console.warn('  [skip] 找不到 settings.json，請手動建立並貼入：');
        console.log(JSON.stringify({
            statusLine: { type: 'command', command: newCmd, refreshInterval: 1 },
            hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: newHook }] }] },
        }, null, 2));
        return;
    }

    const raw = fs.readFileSync(settingsPath, 'utf8');
    let cur;
    try { cur = JSON.parse(raw); } catch(e) {
        console.warn(`  [skip] settings.json 解析失敗：${e.message}`);
        return;
    }

    let changed = false;
    cur.statusLine = cur.statusLine || {};
    if (cur.statusLine.command !== newCmd) {
        const old = cur.statusLine.command;
        cur.statusLine.command = newCmd;
        cur.statusLine.type    = cur.statusLine.type || 'command';
        cur.statusLine.refreshInterval = cur.statusLine.refreshInterval || 1;
        console.log(`  [update] statusLine.command:`);
        console.log(`           舊: ${old}`);
        console.log(`           新: ${newCmd}`);
        changed = true;
    }

    cur.hooks = cur.hooks || {};
    if (!Array.isArray(cur.hooks.UserPromptSubmit)) cur.hooks.UserPromptSubmit = [];
    const ups = cur.hooks.UserPromptSubmit;
    let agumonHookFound = false;
    for (const block of ups) {
        if (!block || !Array.isArray(block.hooks)) continue;
        for (const h of block.hooks) {
            if (h && typeof h.command === 'string' && /agumon[-_]?hook/i.test(h.command)) {
                agumonHookFound = true;
                if (h.command !== newHook) {
                    const old = h.command;
                    h.command = newHook;
                    console.log(`  [update] hooks.UserPromptSubmit:`);
                    console.log(`           舊: ${old}`);
                    console.log(`           新: ${newHook}`);
                    changed = true;
                }
            }
        }
    }
    if (!agumonHookFound) {
        ups.push({ hooks: [{ type: 'command', command: newHook }] });
        console.log(`  [add]    hooks.UserPromptSubmit:`);
        console.log(`           新增: ${newHook}`);
        changed = true;
    }

    if (changed) {
        const bak = settingsPath + '.before-agumon-statusline.bak';
        fs.writeFileSync(bak, raw);
        fs.writeFileSync(settingsPath, JSON.stringify(cur, null, 2));
        console.log(`  -> settings.json 已更新（備份至 ${path.basename(bak)}）`);
    } else {
        console.log('  -> settings.json 已是最新，無需更新');
    }
}

function installLauncher() {
    console.log('\n[8/8] 註冊 vpet 全域指令');
    // 首選：npm link —— npm 會把 vpet shim 放進它在 PATH 上的 global bin
    // （Windows 自動產生 vpet.cmd / vpet.ps1），不需碰使用者 PATH，可攜到任何電腦。
    const linked = spawnSync('npm', ['link'], { cwd: REPO_ROOT, stdio: 'inherit', shell: true });
    if (!linked.error && linked.status === 0) {
        console.log('  -> 已透過 npm link 註冊 vpet 到全域（npm 自動處理 PATH 與 Windows shim）');
        console.log('     重開終端後即可用 vpet（或 Claude Code 內 ! vpet ...）');
        return;
    }
    console.warn(`  [npm link 失敗${linked.error ? '：' + linked.error.message : '，exit ' + linked.status}] → 改用 ~/bin 後備方案`);
    installLauncherFallback();
}

// 後備：npm link 不可用時，複製薄殼到 ~/bin（需使用者自行確保 ~/bin 在 PATH）
function installLauncherFallback() {
    const binDir = path.join(os.homedir(), 'bin');
    ensureDir(binDir);
    let ok = 0;
    for (const fn of ['vpet', 'vpet.bat']) {
        const src = path.join(REPO_ROOT, 'bin', fn);
        const dst = path.join(binDir, fn);
        if (copyFile(src, dst)) {
            ok++;
            if (fn === 'vpet') { try { fs.chmodSync(dst, 0o755); } catch(_) {} }  // bash 薄殼需可執行（unix）
        }
    }
    if (ok === 0) { console.warn('  [skip] 找不到 repo bin/ 的 vpet 啟動器'); return; }

    // PATH 檢查：~/bin 不在 PATH 就提示加入
    const sep = process.platform === 'win32' ? ';' : ':';
    const onPath = (process.env.PATH || '').split(sep).some(p => {
        try { return p && path.resolve(p) === path.resolve(binDir); } catch(_) { return false; }
    });
    if (onPath) {
        console.log('  -> ~/bin 已在 PATH，重開終端後即可用 vpet（或 Claude Code 內 ! vpet ...）');
    } else {
        console.log('  ⚠ ~/bin 不在 PATH，請加入後重開終端：');
        if (process.platform === 'win32') {
            console.log(`     PowerShell: [Environment]::SetEnvironmentVariable('PATH', "$env:PATH;${binDir}", 'User')`);
            console.log(`     或把 ${binDir} 加進「使用者環境變數 PATH」`);
        } else {
            console.log(`     echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc`);
        }
    }
}

function reportStateFiles() {
    console.log('\n— state 檔現況 —');
    if (!fs.existsSync(STATE_DIR)) { console.log('  state/ 尚未建立（執行 statusline 後會自動產生）'); return; }
    for (const fn of fs.readdirSync(STATE_DIR)) {
        const p = path.join(STATE_DIR, fn);
        const sz = fs.statSync(p).size;
        console.log(`  O ${fn} (${sz}B)`);
    }
}

function main() {
    console.log('agumon-cli install (方案 A：統一資料夾)');
    console.log(`  repo    : ${REPO_ROOT}`);
    console.log(`  install : ${INSTALL_DIR}`);

    ensureDir(INSTALL_DIR);
    ensureDir(ASSETS_DIR);
    ensureDir(STATE_DIR);

    installRuntime();
    installCharacters();
    installRoster();
    installShared();
    installV4Art();
    migrateLegacyState();
    updateSettings();
    installLauncher();
    reportStateFiles();

    console.log('\n安裝完成。重新整理 Claude CLI（送一個訊息或重開）即可生效。');
}

if (require.main === module) main();
