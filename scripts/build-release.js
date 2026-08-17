#!/usr/bin/env node
/*
 * build-release.js — 從 main 產出「一般使用者」用的輕量 release 樹。
 *
 * 用法：
 *   node scripts/build-release.js            # 產到 dist/release
 *   node scripts/build-release.js <out-dir>  # 產到指定目錄
 *
 * 產物只含執行 vpet statusline 所需：runtime js、部署用角色 json、shared json、
 * install/uninstall、bin 薄殼、package.json、tools/agumon-doctor 自救包，並放一個
 * RELEASE 標記檔（install 後 statusline-cheat 會據此停用開發／作弊指令）。
 *
 * 移除（開發資產）：角色原圖 PNG、pixels.json/bullet.json 中介檔、*.bak、
 *   src/editor（含進化路線編輯器）、src/tools、legacy/、server/、docs/、
 *   scripts/ 內開發工具（只留 install/uninstall）、shared 的 sprites.json、
 *   characters/evo-layout.json。
 *
 * 發布：驗證 dist/release 後，可用 git worktree 推到 release 分支，或直接打包。
 *   （見結尾印出的提示）
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(REPO, 'dist', 'release');

const SHELL_SHIMS = new Set(['vpet']);   // 無副檔名的 bash 薄殼
const isShell = f => SHELL_SHIMS.has(path.basename(f)) || /\.(sh|command)$/.test(f);

let files = 0, chars = 0, skippedPng = 0, savedBytes = 0;

function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
function copyRel(rel) {
    const src = path.join(REPO, rel), dst = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (isShell(src)) {
        // shell 薄殼強制 LF，避免 CRLF 讓 shebang 在 unix/mac 壞掉
        fs.writeFileSync(dst, fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n'));
    } else {
        fs.copyFileSync(src, dst);
    }
    files++;
}

rmrf(OUT);
fs.mkdirSync(OUT, { recursive: true });

// bin/（vpet 薄殼）
for (const f of fs.readdirSync(path.join(REPO, 'bin'))) copyRel(path.join('bin', f));

// package.json（npm link 的 bin 欄位需要）
copyRel('package.json');

// runtime js
for (const f of fs.readdirSync(path.join(REPO, 'src', 'runtime')))
    if (f.endsWith('.js')) copyRel(path.join('src', 'runtime', f));

// daemon（獨立介面）：常駐時鐘 + JSONL token 源 + 內建網頁。
// 屬選配：不跑它就完全是原本的 CLI 行為（statusline 偵測不到 heartbeat → 自寫）。
const daemonDir = path.join(REPO, 'src', 'daemon');
if (fs.existsSync(daemonDir))
    for (const f of fs.readdirSync(daemonDir))
        if (f.endsWith('.js')) copyRel(path.join('src', 'daemon', f));

// 玩家用的獨立頁面（圖鑑 vpet album、底圖編輯器 vpet bg）：都是玩家功能，必須出貨。
// 放 src/<name>/ 而非 src/editor/ 就是為了這個 —— src/editor 整個被排除，
// 放錯地方 release 使用者就沒得用。判準是「改的是使用者的檔還是 repo 資產」：
// 底圖寫 ~/.claude/agumon-statusline/bg.png（使用者的），所以是玩家功能；
// 進化路線／CutIn／點陣編輯器改的是 repo 資產，維持 dev-only。
for (const sub of ['album', 'bgedit']) {
    const d = path.join(REPO, 'src', sub);
    if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) copyRel(path.join('src', sub, f));
}

// 只留 install / uninstall
for (const f of ['install.js', 'uninstall.js'])
    if (fs.existsSync(path.join(REPO, 'scripts', f))) copyRel(path.join('scripts', f));

// 根目錄雙擊啟動器（免打指令）：安裝 + 獨立介面
//   .vbs = Windows 免小黑窗（收進工作列 tray），.bat = 保留 console 版（看得到錯誤訊息）
//   .command/.sh 由 isShell() 強制 LF
for (const f of ['install.bat', 'install.command',
                 'vpet-standalone.bat', 'vpet-standalone.sh', 'vpet-standalone.vbs',
                 'album.bat', 'album.sh', 'album.command',
                 // 底圖編輯器：玩家功能（改的是使用者自己的 bg.png），要出貨
                 'bg-editor.bat', 'bg-editor.sh', 'bg-editor.command',
                 // 只裝 daemon（不接管 statusLine）+ 解除安裝，兩者都要出貨：
                 // 前者是「想用自己 statusline」的人的唯一入口，後者沒有的話
                 // 非開發者只能手動編 settings.json。
                 'install-daemon-only.bat', 'install-daemon-only.sh', 'install-daemon-only.command',
                 'uninstall.bat', 'uninstall.sh', 'uninstall.command'])
    if (fs.existsSync(path.join(REPO, f))) copyRel(f);

// tray：PowerShell 腳本 + 圖示（零 npm 相依，用 Windows 內建 NotifyIcon）
for (const f of ['vpet-tray.ps1', 'vpet.ico'])
    if (fs.existsSync(path.join(REPO, 'tools', f))) copyRel(path.join('tools', f));

// characters：roster + 每角色 4 個部署用 json（跳過 PNG / pixels / bullet.json / .bak / evo-layout）
copyRel(path.join('characters', 'roster.json'));
const KEEP_CHAR = new Set(['art.json', 'config.json', 'bullet-art.json', 'cutin-art.json']);
for (const d of fs.readdirSync(path.join(REPO, 'characters'), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join('characters', d.name);
    if (!fs.existsSync(path.join(REPO, dir, 'config.json'))) continue;
    chars++;
    for (const f of fs.readdirSync(path.join(REPO, dir))) {
        if (KEEP_CHAR.has(f)) copyRel(path.join(dir, f));
        else if (/\.png$/i.test(f)) { skippedPng++; savedBytes += fs.statSync(path.join(REPO, dir, f)).size; }
    }
}

// shared：runtime 只讀 manifest + art（sprites.json 是編輯器來源，不含）
for (const f of ['manifest.json', 'art.json'])
    if (fs.existsSync(path.join(REPO, 'shared', f))) copyRel(path.join('shared', f));

// tools/agumon-doctor：桌寵卡死自救的獨立包（雙擊 .bat/.command + doctor.js + README）。
// 一般使用者卡死時可直接在 release 樹裡雙擊自救，不必另外索取 zip。
const doctorDir = path.join(REPO, 'tools', 'agumon-doctor');
if (fs.existsSync(doctorDir))
    for (const f of fs.readdirSync(doctorDir)) copyRel(path.join('tools', 'agumon-doctor', f));

// RELEASE 標記（install 會部署到 ~/.claude/agumon-statusline/RELEASE → 停用開發指令）
fs.writeFileSync(path.join(OUT, 'RELEASE'), '1\n');

// 新手指南當 README（clone release 就看到安裝指引）
const guide = path.join(REPO, 'GUIDE.md');
if (fs.existsSync(guide)) { fs.copyFileSync(guide, path.join(OUT, 'README.md')); files++; }
else console.warn('  [warn] 找不到 GUIDE.md，release 少了 README');

const mb = (savedBytes / 1048576).toFixed(1);
console.log(`\n✅ release 已產出：${path.relative(REPO, OUT) || OUT}`);
console.log(`   檔案 ${files} 個、角色 ${chars} 隻；略過原圖 PNG ${skippedPng} 個（省下約 ${mb} MB）。`);
console.log(`\n發布到 release 分支：node scripts/publish-release.js（一鍵 build+更新+push，無變更會跳過）`);
