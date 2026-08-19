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
 *
 * ── --daemon-only ────────────────────────────────────────────────────────
 * 給「想用自己的 statusline、pet 只在 daemon 網頁看」的人：不接管 statusLine.command，
 * 也不部署那兩支 statusline 顯示程式。daemon 本來就有自己的時鐘與 token 源
 * （token-source 直接讀 ~/.claude/projects 的 JSONL），顯示層完全不依賴 statusLine。
 *
 * ⚠️ 但 hooks.UserPromptSubmit 一定要裝，它不是 statusline 的一部分。decideAgumon 靠它：
 *      訓練值 +1（戰力成長的唯一來源，沒有它進化鏈直接斷）
 *      自動戰鬥武裝 battleArmHookTs
 *      ROAR 表演 + lastActivityAt（沒有它角色閒置後會一直睡，只能靠摸摸叫醒）
 *    所以 daemon-only 只跳過 statusLine，hook 照裝。
 *
 * 會在 INSTALL_DIR 留一個 DAEMON_ONLY 標記檔 → daemon 據此預設進當家模式
 * （沒有 statusLine 在跑，隔離模式寫 daemon-state.json 沒有意義，pet 會不動）。
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

const DAEMON_ONLY      = process.argv.includes('--daemon-only');
const DAEMON_ONLY_FLAG = path.join(INSTALL_DIR, 'DAEMON_ONLY');

// 玩家用的獨立頁面（src/<name>/ 底下一個 server + 一個 html）。
// 刻意不放 src/editor/ —— 那整個資料夾會被 build-release 排除，放錯地方 release 就沒有。
const PLAYER_PAGES = ['album', 'bgedit'];

// statusline 顯示層專屬 —— daemon-only 不需要（daemon 自己 compose 畫面）。
// 注意 statusline-cheat.js 不在此列：它其實是 vpet 指令通道，只是名字誤導，兩種模式都要。
const STATUSLINE_ONLY_FILES = ['statusline-agumon-color.js', 'statusline-agumon.js'];

const RUNTIME_FILES = [
    'agumon-core.js',
    'statusline-agumon-color.js',
    'statusline-agumon.js',
    'statusline-cheat.js',   // = vpet 指令通道（非顯示層），daemon-only 也要
    'agumon-hook.js',        // = 訓練值/自動戰鬥/活動時戳的脈搏，daemon-only 也要
    'doctor.js',             // vpet doctor：檢查/清除 node 孤兒（漏掉會導致 ac doctor 失效）
].filter(f => !(DAEMON_ONLY && STATUSLINE_ONLY_FILES.includes(f)));

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
    console.log(`  -> ${ok}/${RUNTIME_FILES.length} runtime 檔案已安裝`
        + (DAEMON_ONLY ? `（--daemon-only：略過 ${STATUSLINE_ONLY_FILES.join(' / ')}）` : ''));

    // 模式標記 DAEMON_ONLY：daemon 據此預設當家模式。兩個方向都要處理 ——
    // 從一般版切 daemon-only 要新增，從 daemon-only 切回一般版要移除（殘留會讓
    // daemon 在有 statusLine 的環境也硬搶當家，兩邊搶寫同一份 state）。
    if (DAEMON_ONLY) {
        fs.writeFileSync(DAEMON_ONLY_FLAG,
            '此檔存在 = 只裝 daemon、不接管 statusLine。daemon 會預設進當家模式。\n'
            + '切回一般版：重跑 npm run install-runtime（不加 --daemon-only）即會移除。\n');
        console.log(`  [mark]   DAEMON_ONLY`);
        // 切換模式時把顯示層舊檔清掉，免得留著讓人以為 statusLine 還在運作
        for (const f of STATUSLINE_ONLY_FILES) {
            const stale = path.join(INSTALL_DIR, f);
            if (fs.existsSync(stale)) { try { fs.rmSync(stale); console.log(`  [clean]  ${f}`); } catch (e) {} }
        }
    } else if (fs.existsSync(DAEMON_ONLY_FLAG)) {
        try { fs.rmSync(DAEMON_ONLY_FLAG); console.log(`  [clean]  DAEMON_ONLY（切回一般版）`); } catch (e) {}
    }

    // REPO_PATH 指標檔：記下這份是從哪個 clone 裝的。
    // 用途是「指路」—— 部署目錄裡沒有 GUIDE 也沒有 scripts/，使用者（或他叫來幫忙的
    // Claude）在自己的專案目錄裡問「怎麼改成純 daemon」時，唯一能探到的東西是
    // vpet help；有了這個檔，help 才印得出安裝指引在哪、切換指令要在哪裡跑。
    // 靠 npm ls -g 反查也做得到，但那多一層 npm 相依且要人先想到，不如直接寫死。
    try {
        fs.writeFileSync(path.join(INSTALL_DIR, 'REPO_PATH'), REPO_ROOT + '\n');
        console.log(`  [mark]   REPO_PATH -> ${REPO_ROOT}`);
    } catch (e) {
        console.warn(`  [warn]   REPO_PATH 寫入失敗（vpet help 將無法指路）：${e.message}`);
    }

    // 玩家功能的獨立頁面（圖鑑 vpet album、底圖編輯器 vpet bg）：
    // CLI 是從 INSTALL_DIR 執行的，server 必須跟著部署過去才找得到。
    // daemon 不需要這樣做 —— 它是由 repo/release 樹的啟動器直接跑的。
    // 新增這類頁面時只要加進下面這張表，install 與 build-release 兩邊都會帶到。
    for (const sub of PLAYER_PAGES) {
        const src2 = path.join(REPO_ROOT, 'src', sub);
        if (!fs.existsSync(src2)) continue;
        const dst = path.join(INSTALL_DIR, sub);
        fs.mkdirSync(dst, { recursive: true });
        for (const f of fs.readdirSync(src2)) copyFile(path.join(src2, f), path.join(dst, f), sub);
    }
    // release 版標記：repo 根有 RELEASE 就部署到 INSTALL_DIR，讓 statusline-cheat 停用開發指令。
    // main（開發）沒有此檔 → 不部署（開發指令全開）。
    if (fs.existsSync(path.join(REPO_ROOT, 'RELEASE'))) {
        copyFile(path.join(REPO_ROOT, 'RELEASE'), path.join(INSTALL_DIR, 'RELEASE'), 'release');
    } else {
        // source 無 RELEASE（開發版）→ 主動移除已部署的舊標記，
        // 確保由 release 切回 dev 時開發指令全部解禁（否則舊標記殘留會繼續 gate）。
        const stale = path.join(INSTALL_DIR, 'RELEASE');
        if (fs.existsSync(stale)) {
            try { fs.unlinkSync(stale); console.log('  -> 移除殘留 release 標記（開發指令全開）'); } catch (e) {}
        }
    }
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

// 判斷一段 command 是不是「我們裝的」。比對部署目錄而非檔名 —— 使用者自己的
// statusline 也可能叫 statusline.js，只有路徑分得出來。與 uninstall.js 同一套判準。
const isOurs = (cmd) => typeof cmd === 'string'
    && cmd.replace(/\\/g, '/').includes('agumon-statusline');

function updateSettings() {
    console.log('\n[7/8] 更新 ~/.claude/settings.json');
    const settingsPath = path.join(CLAUDE_HOME, 'settings.json');

    const newCmd  = `node ${path.join(INSTALL_DIR, 'statusline-agumon-color.js').replace(/\\/g, '/')}`;
    const newHook = `node ${path.join(INSTALL_DIR, 'agumon-hook.js').replace(/\\/g, '/')}`;

    if (!fs.existsSync(settingsPath)) {
        console.warn('  [skip] 找不到 settings.json，請手動建立並貼入：');
        const sample = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: newHook }] }] } };
        if (!DAEMON_ONLY) sample.statusLine = { type: 'command', command: newCmd, refreshInterval: 1 };
        console.log(JSON.stringify(sample, null, 2));
        return;
    }

    const raw = fs.readFileSync(settingsPath, 'utf8');
    let cur;
    try { cur = JSON.parse(raw); } catch(e) {
        console.warn(`  [skip] settings.json 解析失敗：${e.message}`);
        return;
    }

    let changed = false;
    if (DAEMON_ONLY) {
        // 使用者「自己的」statusline 原封不動保留；但「我們裝的」那條必須移除 ——
        // 因為 --daemon-only 剛把 statusline-agumon-color.js 刪掉了（STATUSLINE_ONLY_FILES），
        // 留著設定等於叫 Claude Code 每秒去執行一個不存在的檔案。
        // 一般版 → daemon-only 的轉換就是走這條路，判準與 uninstall 的 isOurs() 一致：比路徑不比檔名。
        const mine = cur.statusLine && cur.statusLine.command;
        if (mine && isOurs(mine)) {
            delete cur.statusLine;
            console.log('  [rm]     statusLine（原本指向 agumon-statusline，檔案已隨 --daemon-only 移除）');
            console.log('           桌寵改在獨立視窗看；想換回自己的 statusline 請自行填回這一段。');
            changed = true;
        } else {
            console.log('  [skip]   statusLine（--daemon-only）'
                + (mine ? `，保留你現有的：${mine}` : '，settings 目前也沒設'));
        }
    } else {
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
