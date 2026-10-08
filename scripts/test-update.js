#!/usr/bin/env node
'use strict';
/**
 * release 自動更新（docs/update-spec.md）：
 *   1. 打包／簽章：來回一致；改一個 byte、換一把鑰匙、路徑想跳出 release 樹 → 都擋
 *   2. 廣場伺服器發包：/update/manifest、/update/bundle；沒有包 → 404
 *   3. updater：已是最新 → 不動；新版 → 寫檔＋跑 install（daemon-only 照舊）＋記結果；
 *      簽章不對 → 一個檔都不寫、記失敗；開發樹 → 不更新；伺服器沒開 → 很快跳過
 *   4. supervisor：子行程要求重開（75）→ 再跑一次 updater、再起一次；其他結束碼 → 跟著結束
 *
 * 全部在暫存資料夾、用臨時產生的金鑰，不碰真的 release 樹、~/.claude 或發版私鑰。
 *
 * 用法：node scripts/test-update.js
 */
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const B  = require('../src/shared/update-bundle.js');
const U  = require('../src/daemon/updater.js');
const PS = require('../src/daemon/plaza-server.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), 'vpet-upd-' + p + '-'));
const keys = () => {
    const k = crypto.generateKeyPairSync('ed25519');
    return { pub: k.publicKey.export({ type: 'spki', format: 'pem' }), priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
};
const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

(async () => {
    console.log('— 打包／簽章 —');
    const K = keys(), K2 = keys();
    const src = tmp('src');
    put(src, 'RELEASE', '1\n'); put(src, 'VERSION', 'v2\n');
    put(src, 'src/daemon/daemon.js', '// new daemon\n');
    put(src, 'scripts/install.js', "require('fs').writeFileSync(require('path').join(__dirname,'..','installed.txt'), process.argv.slice(2).join(' ') || '(none)');\n");
    const buf = B.pack(src, 'v2');
    const m = B.sign(buf, 'v2', K.priv);
    const un = B.unpack(buf);
    ok(un.version === 'v2' && un.files['src/daemon/daemon.js'].toString() === '// new daemon\n', '打包再解開，內容不一致');
    ok(B.verify(buf, m, K.pub) === null, '正確的包驗章沒過');
    const bad = Buffer.from(buf); bad[bad.length - 5] ^= 1;
    ok(B.verify(bad, m, K.pub) !== null, '改了一個 byte 還是驗過了');
    ok(/簽章/.test(B.verify(buf, m, K2.pub) || ''), '換一把鑰匙（別人簽的）還是驗過了');
    ok(/雜湊|大小/.test(B.verify(buf, { ...m, sha256: '0'.repeat(64) }, K.pub) || ''), '雜湊對不上沒擋');
    for (const p of ['../evil.js', '/etc/x', 'C:/x', 'a/../../b', 'a//b'])
        ok(!B.safeRel(p), '不安全的路徑沒擋：' + p);
    ok(B.safeRel('src/daemon/daemon.js'), '正常路徑被擋了');
    const evil = require('zlib').gzipSync(Buffer.from(JSON.stringify({ v: 1, version: 'x', files: { '../evil.js': 'eA==' } })));
    let threw = false; try { B.unpack(evil); } catch (e) { threw = true; }
    ok(threw, '包裡有 ../ 的路徑，解包沒丟例外');

    console.log('— 廣場伺服器發包 —');
    const updDir = tmp('serve');
    const ps = PS.createPlazaServer({ updateDir: updDir });
    await new Promise(r => ps.server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + ps.server.address().port;
    ok((await U.fetchManifest(base)) === null, '還沒放包時 manifest 應該是沒有');
    fs.writeFileSync(path.join(updDir, 'bundle.bin'), buf);
    fs.writeFileSync(path.join(updDir, 'manifest.json'), JSON.stringify(m));
    const got = await U.fetchManifest(base);
    ok(got && got.version === 'v2' && got.sig === m.sig, '伺服器沒把 manifest 原樣送出');

    console.log('— updater —');
    const mkTree = (ver) => { const d = tmp('tree'); put(d, 'RELEASE', '1\n'); put(d, 'VERSION', ver + '\n'); put(d, 'src/daemon/daemon.js', '// old daemon\n'); return d; };
    const sd = tmp('state'), inst = tmp('inst');
    fs.writeFileSync(path.join(inst, 'DAEMON_ONLY'), '');
    const opts = (root, extra) => ({ root, base, publicKey: K.pub, stateDir: sd, installDir: inst, ...extra });
    const readRes = () => JSON.parse(fs.readFileSync(path.join(sd, 'update.json'), 'utf8'));

    let t = mkTree('v2');
    let r = await U.run(opts(t));
    ok(r.code === U.EXIT_NONE && fs.readFileSync(path.join(t, 'src/daemon/daemon.js'), 'utf8') === '// old daemon\n', '已是最新版還是動了檔案');

    t = mkTree('v1');
    r = await U.run(opts(t));
    ok(r.code === U.EXIT_UPDATED, '有新版卻沒更新：' + JSON.stringify(r));
    ok(fs.readFileSync(path.join(t, 'src/daemon/daemon.js'), 'utf8') === '// new daemon\n', '新版的檔案沒寫進 release 樹');
    ok(U.localVersion(t) === 'v2', '更新後 VERSION 沒變成新版');
    ok(fs.existsSync(path.join(t, 'installed.txt')) && fs.readFileSync(path.join(t, 'installed.txt'), 'utf8') === '--daemon-only',
       '更新後沒跑 install，或沒照原本的 daemon-only 裝法');
    ok(readRes().ok === true && readRes().to === 'v2' && readRes().from === 'v1', '更新結果沒記到 state/update.json');
    ok(!fs.readdirSync(path.join(t, 'src/daemon')).some(f => f.endsWith('.vpet-tmp')), '留下了寫到一半的暫存檔');

    // 簽章不對：別人冒充伺服器發的包
    t = mkTree('v1');
    r = await U.run(opts(t, { publicKey: K2.pub }));
    ok(r.code === U.EXIT_FAILED && /簽章/.test(readRes().error), '簽章不對沒擋下來：' + JSON.stringify(r));
    ok(fs.readFileSync(path.join(t, 'src/daemon/daemon.js'), 'utf8') === '// old daemon\n', '簽章不對還是寫了檔案');
    ok(U.localVersion(t) === 'v1', '簽章不對，VERSION 卻被改了');

    // 開發樹（沒有 RELEASE）絕對不能自己更新
    t = mkTree('v1'); fs.unlinkSync(path.join(t, 'RELEASE'));
    r = await U.run(opts(t));
    ok(r.code === U.EXIT_NONE && U.localVersion(t) === 'v1', '開發樹被自動更新了');

    // install 失敗：記失敗、結束碼是失敗（daemon 照常用寫進來的檔起來）
    const failSrc = tmp('src2');
    fs.cpSync(src, failSrc, { recursive: true });
    put(failSrc, 'scripts/install.js', 'process.exit(3);\n');
    const fbuf = B.pack(failSrc, 'v3');
    fs.writeFileSync(path.join(updDir, 'bundle.bin'), fbuf);
    fs.writeFileSync(path.join(updDir, 'manifest.json'), JSON.stringify(B.sign(fbuf, 'v3', K.priv)));
    t = mkTree('v1');
    r = await U.run(opts(t));
    ok(r.code === U.EXIT_FAILED && /install/.test(readRes().error), 'install 失敗沒有記成失敗');

    await ps.close();
    // 伺服器沒開：要很快跳過，不能卡住 daemon 啟動
    const t0 = Date.now();
    r = await U.run(opts(mkTree('v1'), { base: base }));
    ok(r.code === U.EXIT_NONE && Date.now() - t0 < 4000, `伺服器沒開時沒有很快跳過（${Date.now() - t0}ms）`);

    console.log('— supervisor —');
    {
        const d = tmp('sup');
        const log = path.join(d, 'log.txt');
        // 假 updater：每跑一次記一行；假 daemon：第一次要求重開（75），第二次正常結束（0）
        fs.writeFileSync(path.join(d, 'upd.js'), `require('fs').appendFileSync(${JSON.stringify(log)}, 'U\\n');`);
        fs.writeFileSync(path.join(d, 'dmn.js'),
            `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)}, 'D'+process.env.VPET_CHILD+(process.env.VPET_PARENT_PID?'p':'')+'\\n');` +
            `const n=fs.readFileSync(${JSON.stringify(log)},'utf8').split('\\n').filter(l=>l[0]==='D').length;process.exit(n===1?75:0);`);
        const sup = path.join(__dirname, '..', 'src', 'daemon', 'supervisor.js');
        const res = spawnSync(process.execPath, ['-e',
            `require(${JSON.stringify(sup)}).run({daemon:${JSON.stringify(path.join(d, 'dmn.js'))},updater:${JSON.stringify(path.join(d, 'upd.js'))},args:[]})`],
            { encoding: 'utf8', timeout: 20000 });
        const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
        ok(lines.join(',') === 'U,D1p,U,D1p', '子行程要求重開時，沒有「再更新一次、再起一次」：' + lines.join(','));
        ok(res.status === 0, '子行程正常結束，外殼沒有跟著結束（status ' + res.status + '）');
    }
    {
        // 子行程那邊：外殼不在了要跟著收掉
        const S = require('../src/daemon/supervisor.js');
        const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
        let gone = false;
        const tm = S.watchParent(Number(dead.stdout), () => { gone = true; });
        await new Promise(r => setTimeout(r, 2300));
        clearInterval(tm);
        ok(gone, '外殼已經不在了，子行程沒發現（會變成佔著 port 的孤兒）');
    }

    console.log('— daemon 實跑（外殼 + 按「有新版本」重開）—');
    {
        const { spawn } = require('child_process');
        const http = require('http');
        const DAEMON = path.join(__dirname, '..', 'src', 'daemon', 'daemon.js');
        const call = (port, method, p, body) => new Promise((res) => {
            const b = body ? JSON.stringify(body) : null;
            const rq = http.request({ host: '127.0.0.1', port, path: p, method,
                headers: b ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } : {} },
                (s) => { let d = ''; s.on('data', c => d += c); s.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res(null); } }); });
            rq.on('error', () => res(null)); if (b) rq.write(b); rq.end();
        });
        const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 200)); } return null; };
        const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
        // 更新來源指到一個沒人聽的 port：updater 很快跳過，daemon 照常起來
        const env = (port) => ({ ...process.env, AGUMON_DAEMON_PORT: String(port), AGUMON_STATE_DIR: tmp('dstate'),
                                 VPET_UPDATE_URL: 'http://127.0.0.1:1', VPET_PLAZA_URL: 'http://127.0.0.1:1' });

        // 沒有外殼（開發版、舊啟動器）：不能假裝會重開
        const P0 = 3180 + Math.floor(Math.random() * 50);
        const plain = spawn(process.execPath, [DAEMON, '--isolated'], { env: env(P0), stdio: 'ignore' });
        try {
            const u0 = await waitFor(() => call(P0, 'GET', '/update'), 15000);
            ok(u0 && u0.supervised === false && u0.available === null, '沒有外殼的 daemon 不該說自己可以更新：' + JSON.stringify(u0));
            const r0 = await call(P0, 'POST', '/cmd', { action: 'selfUpdate', args: {} });
            ok(r0 && r0.ok === false && /手動重啟/.test(r0.error || ''), '沒有外殼時按更新應該說要手動重啟：' + JSON.stringify(r0));
            // 頁面：有新版才亮鈕；按了之後等版本號變了就重新整理（新版的頁面也要重載）
            const html = await new Promise((res) => http.get({ host: '127.0.0.1', port: P0, path: '/' }, (s) => {
                let d = ''; s.on('data', c => d += c); s.on('end', () => res(d)); }).on('error', () => res('')));
            ok(/<button id="selfupdate"[^>]*style="display:none"/.test(html), '頁面沒有（預設藏著的）「有新版本」鈕');
            ok(/b\.style\.display = \(u\.available && !updating\)/.test(html), '「有新版本」鈕沒有跟著 available 顯示');
            ok(/if\(updating && u\.version!==myVersion\)\{ location\.reload\(\)/.test(html), '更新完頁面不會自己重新整理');
        } finally { plain.kill(); }

        const P1 = P0 + 60;
        const sup = spawn(process.execPath, [DAEMON, '--isolated'], { env: { ...env(P1), VPET_SUPERVISE: '1' }, stdio: 'ignore' });
        try {
            const u1 = await waitFor(() => call(P1, 'GET', '/update'), 15000);
            ok(u1 && u1.supervised === true && u1.pid !== sup.pid, '外殼起的 daemon 應該是子行程（supervised、pid 不是外殼）：' + JSON.stringify(u1));
            const r1 = await call(P1, 'POST', '/cmd', { action: 'selfUpdate', args: {} });
            ok(r1 && r1.ok, '按更新失敗：' + JSON.stringify(r1));
            const u2 = await waitFor(async () => { const u = await call(P1, 'GET', '/update'); return u && u1 && u.pid !== u1.pid ? u : null; }, 20000);
            ok(!!u2, '按了更新，daemon 沒有重開（pid 沒換）');
            ok(alive(sup.pid), '重開時外殼也跟著結束了（tray 會以為 daemon 掛了）');
            // 外殼被砍（tray 的「結束」）→ 子行程要跟著收掉，不能佔著 port
            sup.kill();
            const freed = await waitFor(async () => !(await call(P1, 'GET', '/update')), 8000);
            ok(!!freed && !(u2 && alive(u2.pid)), '外殼被砍之後，子行程還活著佔著 port');
        } finally { try { sup.kill(); } catch (e) {} }

        // daemon 自己這邊的「外殼不在就收掉」：Windows 上砍外殼時系統會連子行程一起結束
        // （Node 的 job object），上面那條在 Windows 測不到這段；mac／Linux 只能靠它。
        // 直接起一隻 daemon，告訴它外殼是一個已經結束的行程。
        const P2 = P1 + 60;
        const deadPid = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
        const orphan = spawn(process.execPath, [DAEMON, '--isolated'],
            { env: { ...env(P2), VPET_CHILD: '1', VPET_PARENT_PID: String(deadPid) }, stdio: 'ignore' });
        try {
            const exited = await new Promise((r) => { orphan.on('exit', () => r(true)); setTimeout(() => r(false), 12000); });
            ok(exited, '外殼已經不在了，daemon 沒有自己結束（mac／Linux 上會變成佔著 port 的孤兒）');
        } finally { try { orphan.kill(); } catch (e) {} }
    }

    console.log(`\n結果：${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  ✗ 例外：' + e.stack); process.exit(1); });
