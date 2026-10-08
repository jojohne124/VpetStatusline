'use strict';
// release 自動更新的驗章公鑰（scripts/gen-release-key.js 產生；私鑰在發版機器的 ~/.vpet/release-key.pem）。
// 換這把鑰匙＝舊版 daemon 全部不認新包，大家要手動更新一次。
module.exports = { PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA1V7IArb+nij3HkrQfzHC1J583130z0xLz1c9Y0cMVwI=\n-----END PUBLIC KEY-----\n" };
