#!/usr/bin/env node
'use strict';
/**
 * import-names-zh.js — 把繁中名對照表（CSV）灌進各角色的 characters/<id>/config.json（nameZh）
 *
 * 一次性的匯入工具（2026-10-27）：對照表是先上網查好、給人校對用的；匯入之後就在 route-editor 的
 * 「🈶 名稱總表」維護，不再回頭改 CSV。
 *
 * CSV 欄位（表頭名稱對上就好，順序不拘）：id、繁中譯名、你的修改（留空＝照用繁中譯名）。
 * 「（找不到）」開頭、或兩欄都空的不寫（留給人工補）。只改有變的檔，沿用原檔的換行（CRLF／LF）。
 *
 * 用法：node scripts/import-names-zh.js <對照表.csv> [--dry]
 */
const fs = require('fs');
const path = require('path');

const CHARS = path.join(__dirname, '..', 'characters');

// 最小 CSV 解析：支援引號欄位、欄位裡的逗號／換行／雙引號（""）
function parseCsv(text) {
    const rows = []; let row = [], cur = '', q = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
            if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
            else if (c === '"') q = false;
            else cur += c;
        } else if (c === '"') q = true;
        else if (c === ',') { row.push(cur); cur = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(cur); rows.push(row); row = []; cur = '';
        } else cur += c;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(r => r.some(x => x !== ''));
}

function pick(rows) {
    const [head, ...body] = rows;
    const col = (name) => head.findIndex(h => h.trim().startsWith(name));
    const iId = col('id'), iZh = col('繁中譯名'), iMine = col('你的修改');
    if (iId < 0 || iZh < 0) throw new Error('CSV 表頭要有「id」與「繁中譯名」');
    const out = new Map();
    for (const r of body) {
        const id = (r[iId] || '').trim(); if (!id) continue;
        const mine = iMine >= 0 ? (r[iMine] || '').trim() : '';
        const zh = mine || (r[iZh] || '').trim();
        if (!zh || zh.startsWith('（找不到')) continue;
        out.set(id, zh);
    }
    return out;
}

function apply(names, { dry = false, charsDir = CHARS } = {}) {
    const res = { written: [], same: [], missing: [] };
    for (const [id, zh] of names) {
        const p = path.join(charsDir, id, 'config.json');
        if (!fs.existsSync(p)) { res.missing.push(id); continue; }
        const raw = fs.readFileSync(p, 'utf8');
        const cfg = JSON.parse(raw);
        if (cfg.nameZh === zh) { res.same.push(id); continue; }
        cfg.nameZh = zh;
        const eol = raw.includes('\r\n') ? '\r\n' : '\n';
        if (!dry) fs.writeFileSync(p, (JSON.stringify(cfg, null, 2) + '\n').replace(/\n/g, eol));
        res.written.push(id);
    }
    return res;
}

if (require.main === module) {
    const file = process.argv[2];
    const dry = process.argv.includes('--dry');
    if (!file) { console.log('用法：node scripts/import-names-zh.js <對照表.csv> [--dry]'); process.exit(1); }
    const names = pick(parseCsv(fs.readFileSync(file, 'utf8')));
    const r = apply(names, { dry });
    console.log(`${dry ? '（試跑，沒寫檔）' : ''}寫入 ${r.written.length}、沒變 ${r.same.length}、找不到角色資料夾 ${r.missing.length}`
        + (r.missing.length ? '：' + r.missing.join(', ') : ''));
    console.log('之後在 route-editor 的「🈶 名稱總表」維護；按 💾 儲存會順便部署到安裝版。');
}

module.exports = { parseCsv, pick, apply };
