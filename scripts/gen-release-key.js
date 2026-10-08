#!/usr/bin/env node
/*
 * gen-release-key.js — 產生 release 自動更新用的簽章金鑰（一次性，docs/update-spec.md）
 *
 *   node scripts/gen-release-key.js
 *
 * 私鑰 → ~/.vpet/release-key.pem（只留在發版這台；不進 repo、不出貨，弄丟就只能換一組
 *        再請大家手動更新一次，外流的話別人就能發「合法」的更新）
 * 公鑰 → src/shared/update-key.js（跟著 release 出貨，daemon 拿它驗章）
 *
 * 已經有私鑰就拒絕覆蓋（換金鑰＝舊版 daemon 全部不認新包，要大家手動更新一次）。
 * 真的要換：加 --force。
 */
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');

const KEY_FILE = process.env.VPET_RELEASE_KEY || path.join(os.homedir(), '.vpet', 'release-key.pem');
const PUB_FILE = path.join(__dirname, '..', 'src', 'shared', 'update-key.js');

if (fs.existsSync(KEY_FILE) && !process.argv.includes('--force')) {
    console.log('已經有私鑰：' + KEY_FILE);
    console.log('換金鑰會讓所有人的 daemon 不認新的更新包（要手動更新一次）。真的要換請加 --force。');
    process.exit(1);
}
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
fs.writeFileSync(KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const pub = publicKey.export({ type: 'spki', format: 'pem' }).trim();
fs.writeFileSync(PUB_FILE,
`'use strict';
// release 自動更新的驗章公鑰（scripts/gen-release-key.js 產生；私鑰在發版機器的 ~/.vpet/release-key.pem）。
// 換這把鑰匙＝舊版 daemon 全部不認新包，大家要手動更新一次。
module.exports = { PUBLIC_KEY: ${JSON.stringify(pub + '\n')} };
`);
console.log('私鑰：' + KEY_FILE + '（請備份，不要外流）');
console.log('公鑰：' + path.relative(process.cwd(), PUB_FILE));
