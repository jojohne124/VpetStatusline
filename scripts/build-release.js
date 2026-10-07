#!/usr/bin/env node
/*
 * build-release.js — 從 main 產出「一般使用者」用的輕量 release 樹。
 *
 * 用法：
 *   node scripts/build-release.js            # 產到 dist/release
 *   node scripts/build-release.js <out-dir>  # 產到指定目錄
 *
 * 預設的安裝是**純 daemon**（獨立視窗，不碰使用者的 statusline）：release 根目錄的
 * install.* 就是 main 的 install-daemon-only.*（打包時改名）。接管 statusline 的安裝
 * 不放啟動檔，GUIDE 的附錄寫成一行指令（node scripts/install.js）。
 *
 * 產物只含執行 vpet 所需：runtime js、daemon js、src/shared 共用模組、
 * 部署用角色 json 與 characters/ 的資料 json、shared 美術 json、install/uninstall、
 * bin 薄殼、package.json、tools/agumon-doctor 自救包，並放一個
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
// asRel：出貨時換個名字（release 根目錄的 install.* 來自 main 的 install-daemon-only.*）
function copyRel(rel, asRel) {
    const src = path.join(REPO, rel), dst = path.join(OUT, asRel || rel);
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

// src/shared/：出貨的程式在**樹內**就 require 得到的共用模組。兩條路都要它，
// 而且漏掉都是無聲死掉：
//   1. daemon 是直接從 release 樹跑的 → src/daemon/plaza.js 的
//      require('../shared/plaza-walk.js') 解析到 <樹>/src/shared/，缺檔＝daemon 一起動
//      就 MODULE_NOT_FOUND，獨立介面（安裝指引推薦的模式）整個開不起來。
//   2. install.js 會再把這幾支複製到部署樹的 shared/ 給圖鑑用（見那邊的 SHARED_MODULES）。
const sharedSrc = path.join(REPO, 'src', 'shared');
if (fs.existsSync(sharedSrc))
    for (const f of fs.readdirSync(sharedSrc))
        if (f.endsWith('.js')) copyRel(path.join('src', 'shared', f));

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

// 根目錄雙擊啟動器（免打指令）。刻意只放三件事：安裝、打開桌寵、解除安裝 ——
// 每件事三個平台各一份（.bat／.command／.sh），再多根目錄就是一整排看不出先按哪個。
//   .vbs = Windows 免小黑窗（收進工作列 tray），.bat = 保留 console 版（看得到錯誤訊息）
//   .command/.sh 由 isShell() 強制 LF
//
// 安裝：預設是純 daemon（不接管 statusLine）。來源是 main 的 install-daemon-only.*，
//   出貨時改名成 install.* —— 一般使用者只該看到一個「安裝」。那幾支只靠自己所在的
//   資料夾找路徑（cd "%~dp0" / dirname "$0"），跟自己叫什麼名字無關，改名安全。
// 不出貨：main 的 install.*（接管 statusline，GUIDE 附錄寫成一行指令）、
//   album.* / bg-editor.*（網頁上已經有按鈕，也有 vpet album / vpet bg 指令）。
for (const [from, to] of [['install-daemon-only.bat', 'install.bat'],
                          ['install-daemon-only.command', 'install.command'],
                          ['install-daemon-only.sh', 'install.sh']])
    if (fs.existsSync(path.join(REPO, from))) copyRel(from, to);
for (const f of ['vpet-standalone.bat', 'vpet-standalone.sh', 'vpet-standalone.vbs',
                 'vpet-standalone.command',
                 // 解除安裝要出貨：沒有的話非開發者只能手動編 settings.json
                 'uninstall.bat', 'uninstall.sh', 'uninstall.command'])
    if (fs.existsSync(path.join(REPO, f))) copyRel(f);

// macOS 免小黑窗啟動器的來源：install.js 會在 mac 上用 osacompile 編成 .app
// （不出貨編譯後的 .app —— 它是二進位 bundle，且 release 可能在 Windows 打包）
copyRel(path.join('tools', 'vpet-standalone.applescript'));

// tray：PowerShell 腳本 + 圖示（零 npm 相依，用 Windows 內建 NotifyIcon）
for (const f of ['vpet-tray.ps1', 'vpet.ico'])
    if (fs.existsSync(path.join(REPO, 'tools', f))) copyRel(path.join('tools', f));

// characters：roster + 每角色 4 個部署用 json（跳過 PNG / pixels / bullet.json / .bak / evo-layout）
copyRel(path.join('characters', 'roster.json'));
// characters/ 底下的「資料」檔 —— 不屬於任何角色資料夾，所以下面那個迴圈掃不到，
// 要單獨帶（install.js 那邊也是分開處理的）。缺了不會報錯，只會安靜地少功能：
//   special-evolutions.json 沒了 → 規則型特殊進化（營地時效那類）永遠不會發生
//   yard-layouts.json 沒了 → 營地走動範圍退回內建切法，編輯器調過的分區不算
// evo-layout.json 刻意不出貨：那是進化路線編輯器的版面，只有 dev 用得到。
//   jogress.json 沒了 → 合體進化的候選永遠是空的，零錯誤訊息
for (const f of ['special-evolutions.json', 'yard-layouts.json', 'jogress.json'])
    if (fs.existsSync(path.join(REPO, 'characters', f))) copyRel(path.join('characters', f));
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
// HTML 註解不出貨：那是寫給開發者的備註（例如 release 的 install.* 對應 main 的哪個檔），
// 畫面上看不到，但會留在使用者的 README.md 原始檔裡。
if (fs.existsSync(guide)) {
    const text = fs.readFileSync(guide, 'utf8').replace(/<!--[\s\S]*?-->\s*/g, '');
    fs.writeFileSync(path.join(OUT, 'README.md'), text); files++;
}
else console.warn('  [warn] 找不到 GUIDE.md，release 少了 README');

const mb = (savedBytes / 1048576).toFixed(1);
console.log(`\n✅ release 已產出：${path.relative(REPO, OUT) || OUT}`);
console.log(`   檔案 ${files} 個、角色 ${chars} 隻；略過原圖 PNG ${skippedPng} 個（省下約 ${mb} MB）。`);
console.log(`\n發布到 release 分支：node scripts/publish-release.js（一鍵 build+更新+push，無變更會跳過）`);
