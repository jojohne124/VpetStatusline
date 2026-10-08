'use strict';
/**
 * updater.js — release 自動更新（docs/update-spec.md）
 *
 * 由 supervisor 在**每次啟動 daemon 之前**同步跑一次（獨立行程）：
 *   1. 問廣場伺服器最新版（GET /update/manifest，3 秒逾時；連不上＝跳過，用現在的版本）
 *   2. 版本跟 release 樹的 VERSION 不同 → 下載包（GET /update/bundle）→ 驗大小／雜湊／簽章
 *   3. 解到 release 樹（逐檔寫暫存再改名）→ 重跑 install（同步 ~/.claude/agumon-statusline）
 *   4. 結果寫 state/update.json，頁面據此顯示「已更新」或「自動更新失敗：原因」
 *
 * 結束碼：0 = 沒更新（已是最新／連不上／不是 release），10 = 更新好了，2 = 失敗（舊版照跑）
 * 任何一步失敗都不會讓 daemon 起不來 —— supervisor 只看結束碼決定要不要記一筆，照常啟動。
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const B = require('../shared/update-bundle.js');

const EXIT_NONE = 0, EXIT_UPDATED = 10, EXIT_FAILED = 2;
const MANIFEST_TIMEOUT_MS = 3000;
const BUNDLE_TIMEOUT_MS   = 60000;

const ROOT = path.resolve(__dirname, '..', '..');
const INSTALL_DIR = path.join(os.homedir(), '.claude', 'agumon-statusline');

function baseUrl() {
    if (process.env.VPET_UPDATE_URL) return process.env.VPET_UPDATE_URL;
    if (process.env.VPET_PLAZA_URL) return process.env.VPET_PLAZA_URL;
    return require('./plaza-client.js').DEFAULT_URL;
}

function get(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
            res.on('error', reject);
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error('逾時')));
        req.on('error', reject);
    });
}

/** 伺服器上的最新版 manifest；連不上或沒有 → null */
async function fetchManifest(base, timeoutMs = MANIFEST_TIMEOUT_MS) {
    try {
        const r = await get(new URL('/update/manifest', base).toString(), timeoutMs);
        if (r.status !== 200) return null;
        const m = JSON.parse(r.body.toString('utf8'));
        return m && typeof m.version === 'string' ? m : null;
    } catch (e) { return null; }
}

const localVersion = (root) => { try { return fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim(); } catch (e) { return ''; } };
const isRelease = (root) => fs.existsSync(path.join(root, 'RELEASE'));

/**
 * 檢查＋更新。opts（測試用）：root、base、publicKey、stateDir、installDir、node。
 * 回 { code, from, to, error }
 */
async function run(opts = {}) {
    const root = opts.root || ROOT;
    const stateDir = opts.stateDir || process.env.AGUMON_STATE_DIR || path.join(INSTALL_DIR, 'state');
    const installDir = opts.installDir || INSTALL_DIR;
    const from = localVersion(root);
    const record = (r) => {
        try { fs.mkdirSync(stateDir, { recursive: true });
              fs.writeFileSync(path.join(stateDir, 'update.json'), JSON.stringify({ at: Date.now(), ...r }, null, 2)); }
        catch (e) {}
        return r;
    };
    if (!isRelease(root)) return { code: EXIT_NONE, from, why: '開發版不自動更新' };

    const base = opts.base || baseUrl();
    const m = await fetchManifest(base);
    if (!m) return { code: EXIT_NONE, from, why: '連不上更新來源' };
    if (m.version === from) return { code: EXIT_NONE, from, why: '已是最新' };

    const fail = (error) => record({ ok: false, code: EXIT_FAILED, from, to: m.version, error });
    let buf;
    try {
        const r = await get(new URL('/update/bundle', base).toString(), BUNDLE_TIMEOUT_MS);
        if (r.status !== 200) return fail('下載失敗（' + r.status + '）');
        buf = r.body;
    } catch (e) { return fail('下載失敗：' + e.message); }

    const publicKey = opts.publicKey || require('../shared/update-key.js').PUBLIC_KEY;
    const bad = B.verify(buf, m, publicKey);
    if (bad) return fail(bad);

    let pkg;
    try { pkg = B.unpack(buf); } catch (e) { return fail(e.message); }
    if (pkg.version !== m.version) return fail('包裡的版本跟 manifest 對不上');
    if (!pkg.files.RELEASE || !pkg.files['src/daemon/daemon.js']) return fail('更新包缺少必要檔案');

    // 逐檔寫暫存再改名：寫到一半斷電，頂多是新舊混雜，不會出現半個檔案
    try {
        for (const [rel, data] of Object.entries(pkg.files)) {
            const dst = path.join(root, rel);
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.writeFileSync(dst + '.vpet-tmp', data);
            fs.renameSync(dst + '.vpet-tmp', dst);
        }
    } catch (e) { return fail('寫檔失敗：' + e.message); }

    // install：把新的 runtime 部署到 ~/.claude/agumon-statusline。原本怎麼裝就怎麼裝（daemon-only 與否）
    const args = [path.join(root, 'scripts', 'install.js')];
    if (fs.existsSync(path.join(installDir, 'DAEMON_ONLY'))) args.push('--daemon-only');
    const r = spawnSync(opts.node || process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 120000 });
    if (r.status !== 0) return fail('install 失敗：' + ((r.stderr || r.stdout || '').trim().split('\n').pop() || r.status));

    return record({ ok: true, code: EXIT_UPDATED, from, to: m.version });
}

module.exports = { run, fetchManifest, localVersion, baseUrl, EXIT_NONE, EXIT_UPDATED, EXIT_FAILED };

if (require.main === module) {
    run().then((r) => {
        console.log('   🆕 更新檢查：' + (r.code === EXIT_UPDATED ? `已更新 ${r.from || '?'} → ${r.to}`
            : r.code === EXIT_FAILED ? '失敗：' + r.error : r.why));
        process.exit(r.code);
    }, (e) => { console.log('   🆕 更新檢查失敗：' + e.message); process.exit(EXIT_FAILED); });
}
