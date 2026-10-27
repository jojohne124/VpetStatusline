#!/usr/bin/env node
/*
 * pack-prerelease.js — 搶先版：把 main 打成一個 zip，給特定同事手動裝來幫忙測（2026-10-27）。
 *
 * 用法：node scripts/pack-prerelease.js
 *   → dist/prerelease/vpet-pre-<commit>.zip
 *
 * 跟 publish-release 的差別：不推 GitHub、不產自動更新包、不檢查更新紀錄（只有拿到 zip 的人會裝）。
 * 包裡多一個 PRERELEASE（打包時間）：自動更新看到它，就等正式版「比這包新」才換回正式版
 * （不然下次開 vpet 就被更新回舊的正式版，見 src/daemon/updater.js）。
 *
 * 金鑰檢查跟 publish-release 一樣嚴：檔名、內容都不能出現發版私鑰、廣場管理金鑰、CWA 金鑰。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO  = path.resolve(__dirname, '..');
const DIST  = path.join(REPO, 'dist', 'release');
const OUT   = path.join(REPO, 'dist', 'prerelease');
const STAGE = path.join(OUT, 'stage');

const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();

// 給同事看的說明（放進 zip 根目錄）
const GUIDE = `vpet 搶先版（測試用）

這是還沒正式發布的測試版，請先不要外流。

安裝：
1. 先關掉 vpet（系統匣的 vpet 圖示按右鍵 → 結束；小視窗也關掉）
2. 把這個 zip 裡的所有檔案，解壓縮「覆蓋」到你原本的 vpet 資料夾
   （就是有 install.bat、vpet-standalone.vbs 的那個資料夾）
3. 雙擊 install.bat
4. 雙擊 vpet-standalone.vbs 重新打開 vpet

之後：
- 正式版出了比這包更新的版本，vpet 會自動換回正式版，不用做什麼。
- 遇到問題直接跟我說（哪個畫面、做了什麼、看到什麼），能附截圖最好。
`;

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
}

// 金鑰不能進包：檔名，以及內容裡出現金鑰本身（讀本機的金鑰檔來比，比對完不留）
function checkSecrets(dir) {
    const bad = [];
    const NAME = /\.pem$|admin\.key|plaza-admin|release-key|cwa\.key/i;
    const secrets = [];
    for (const f of ['release-key.pem', 'plaza-admin.key', 'cwa.key']) {
        try {
            const s = fs.readFileSync(path.join(os.homedir(), '.vpet', f), 'utf8').trim();
            // pem 取中間一段（頭尾的 BEGIN/END 是公開格式字樣）；其他整串比
            const key = f.endsWith('.pem') ? s.split(/\r?\n/).filter(l => l && !l.startsWith('-----')).join('').slice(8, 48) : s;
            if (key.length >= 8) secrets.push(key);
        } catch (e) { /* 這台沒有這個金鑰 */ }
    }
    for (const p of walk(dir)) {
        const rel = path.relative(dir, p);
        if (NAME.test(rel)) { bad.push(rel + '（檔名）'); continue; }
        let text;
        try { text = fs.readFileSync(p, 'latin1'); } catch (e) { continue; }
        const flat = text.replace(/\r?\n/g, '');
        if (secrets.some(k => text.includes(k) || flat.includes(k))) bad.push(rel + '（內容有金鑰）');
    }
    return bad;
}

function zip(dir, file) {
    try { fs.unlinkSync(file); } catch (e) {}
    if (process.platform === 'win32') {
        execFileSync('powershell.exe', ['-NoProfile', '-Command',
            `Compress-Archive -Path '${dir.replace(/'/g, "''")}\\*' -DestinationPath '${file.replace(/'/g, "''")}' -Force`], { stdio: 'inherit' });
    } else {
        execFileSync('zip', ['-qr', file, '.'], { cwd: dir, stdio: 'inherit' });
    }
}

function main() {
    if (git(['status', '--porcelain'])) {
        console.warn('⚠ 工作區有未提交變動 → 搶先版會包工作區的內容（不是最後一個 commit）。\n');
    }
    console.log('[1/4] 產出 dist/release …');
    execFileSync(process.execPath, [path.join(REPO, 'scripts', 'build-release.js')], { cwd: REPO, stdio: 'inherit' });

    // 在複本上改（dist/release 是正式版 publish 用的，不能留下 PRERELEASE）
    console.log('\n[2/4] 準備搶先版內容 …');
    fs.rmSync(STAGE, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    fs.cpSync(DIST, STAGE, { recursive: true });
    const ref = git(['rev-parse', '--short', 'HEAD']);
    const version = ref + '-pre';
    const builtAt = Date.now();
    fs.writeFileSync(path.join(STAGE, 'VERSION'), version + '\n');
    fs.writeFileSync(path.join(STAGE, 'PRERELEASE'), JSON.stringify({ builtAt, base: ref }) + '\n');
    fs.writeFileSync(path.join(STAGE, '搶先版說明.txt'), GUIDE.replace(/\n/g, '\r\n'));

    console.log('[3/4] 檢查金鑰 …');
    const bad = checkSecrets(STAGE);
    if (bad.length) {
        fs.rmSync(STAGE, { recursive: true, force: true });
        console.error('✗ 搶先版裡有不能外流的東西，不打包：\n  ' + bad.join('\n  '));
        process.exit(1);
    }

    console.log('[4/4] 打包 zip …');
    const file = path.join(OUT, 'vpet-pre-' + ref + '.zip');
    zip(STAGE, file);
    fs.rmSync(STAGE, { recursive: true, force: true });
    const mb = (fs.statSync(file).size / 1048576).toFixed(1);
    console.log(`\n✅ 搶先版：${version}（${mb} MB）\n   ${file}\n   傳給要幫忙測的同事；安裝方式寫在 zip 裡的「搶先版說明.txt」。`);
}

try { main(); }
catch (e) { try { fs.rmSync(STAGE, { recursive: true, force: true }); } catch (_) {} console.error('\n✗ 打包失敗：' + (e.message || e)); process.exit(1); }
