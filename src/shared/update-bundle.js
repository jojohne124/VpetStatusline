'use strict';
/**
 * update-bundle.js — release 自動更新的打包／簽章（docs/update-spec.md）
 *
 * 一包 = gzip(JSON { v, version, files: { 相對路徑: base64 } })。只用 Node 內建（zlib、crypto），
 * release 樹沒有 node_modules。
 *
 * 簽章：Ed25519。私鑰只在發版的那台機器（~/.vpet/release-key.pem，不進 repo），
 * 公鑰寫在 update-key.js 跟著 release 出貨。daemon 下載後先驗章，不對就不裝 ——
 * 同一個區網裡誰都能冒充廣場伺服器，沒有簽章等於讓任何人在大家的電腦上跑程式。
 */
const zlib   = require('zlib');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const FORMAT = 1;

/** 把 dir 底下所有檔案打成一包（Buffer）。version 一起包進去，跟 manifest 的對得上才裝 */
function pack(dir, version) {
    const files = {};
    (function walk(rel) {
        for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
            const r = rel ? rel + '/' + d.name : d.name;
            if (d.isDirectory()) walk(r);
            else if (d.isFile()) files[r] = fs.readFileSync(path.join(dir, r)).toString('base64');
        }
    })('');
    return zlib.gzipSync(Buffer.from(JSON.stringify({ v: FORMAT, version, files })), { level: 9 });
}

/** 合法的相對路徑：不能是絕對路徑、不能有 ..（不然一包就能寫到 release 樹外面） */
function safeRel(rel) {
    if (typeof rel !== 'string' || !rel || rel.includes('\0')) return false;
    if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('/') || rel.startsWith('\\')) return false;
    return !rel.split(/[\\/]/).some(p => p === '..' || p === '');
}

/** 解開一包 → { version, files: { rel: Buffer } }；格式不對或路徑不安全就丟例外 */
function unpack(buf) {
    const j = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
    if (!j || j.v !== FORMAT || typeof j.version !== 'string' || !j.files) throw new Error('更新包格式不對');
    const files = {};
    for (const [rel, b64] of Object.entries(j.files)) {
        if (!safeRel(rel)) throw new Error('更新包裡有不安全的路徑：' + rel);
        files[rel] = Buffer.from(b64, 'base64');
    }
    return { version: j.version, files };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 用私鑰（PEM）簽一包，回 manifest：{ version, size, sha256, sig } */
function sign(buf, version, privatePem) {
    const sig = crypto.sign(null, buf, crypto.createPrivateKey(privatePem)).toString('base64');
    return { version, size: buf.length, sha256: sha256(buf), sig };
}

/** 驗 manifest 跟下載回來的包：大小、雜湊、簽章都要對。回 null＝通過，否則回原因 */
function verify(buf, manifest, publicPem) {
    if (!manifest || typeof manifest.sig !== 'string') return 'manifest 沒有簽章';
    if (buf.length !== manifest.size) return `大小不對（${buf.length} ≠ ${manifest.size}）`;
    if (sha256(buf) !== manifest.sha256) return '雜湊不對（下載不完整或被改過）';
    let ok = false;
    try { ok = crypto.verify(null, buf, crypto.createPublicKey(publicPem), Buffer.from(manifest.sig, 'base64')); }
    catch (e) { return '驗章失敗：' + e.message; }
    return ok ? null : '簽章不對（不是發版機器簽的）';
}

module.exports = { pack, unpack, sign, verify, safeRel, sha256, FORMAT };
