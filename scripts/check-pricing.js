#!/usr/bin/env node
'use strict';
/**
 * check-pricing.js — 對照 LiteLLM 的價目表，檢查 token-source.js 寫死的 PRICING 有沒有過期。
 *
 * 為什麼不在 runtime 抓：桌寵要能離線跑，加上公司代理、1.7MB 下載、啟動延遲，
 * 換來的只是「金額準一點」，不划算。改成開發時手動跑的檢查腳本，零 runtime 風險。
 * 價格變動頻率是幾個月一次，發版前跑一次就夠，不需要排程。
 *
 * 來源：LiteLLM 的 model_prices_and_context_window.json —— ccusage 用的同一份。
 *
 * 用法：npm run check-pricing
 *       node scripts/check-pricing.js --url <自訂網址>   （離線時可指向本機檔案路徑）
 *
 * 離開碼：0 = 全部相符；1 = 有差異或抓不到表（給日後接 CI 用）
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const https = require('https');

const { PRICING } = require('../src/daemon/token-source.js');

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/'
                  + 'model_prices_and_context_window.json';
const M = 1_000_000;

// 我們的欄位 → LiteLLM 的欄位
const FIELDS = [
    ['in',   'input_cost_per_token'],
    ['out',  'output_cost_per_token'],
    ['cw5m', 'cache_creation_input_token_cost'],
    ['cw1h', 'cache_creation_input_token_cost_above_1hr'],
    ['read', 'cache_read_input_token_cost'],
];

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        // 允許指向本機檔案，離線也能跑
        if (!/^https?:/i.test(url)) {
            try { return resolve(JSON.parse(fs.readFileSync(url, 'utf8'))); }
            catch (e) { return reject(e); }
        }
        https.get(url, res => {
            if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', c => buf += c);
            res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
        }).on('error', reject).setTimeout(30000, function () { this.destroy(new Error('逾時')); });
    });
}

// 掃本機 transcript，找出「實際在用、但我們表裡沒有」的型號（那些會掉進 fallback）
function modelsInUse() {
    const seen = new Map();
    const roots = [
        path.join(os.homedir(), '.claude', 'projects'),
        path.join(os.homedir(), '.codex', 'sessions'),
    ];
    const walk = (dir) => {
        let ents = [];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of ents) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            if (!e.name.endsWith('.jsonl')) continue;
            let txt = '';
            try { txt = fs.readFileSync(p, 'utf8'); } catch (e2) { continue; }
            for (const m of txt.matchAll(/"model"\s*:\s*"([^"]+)"/g)) {
                seen.set(m[1], (seen.get(m[1]) || 0) + 1);
            }
        }
    };
    roots.forEach(walk);
    return seen;
}

const KEYS = Object.keys(PRICING).sort((a, b) => b.length - a.length);
const longestPrefix = (model) => KEYS.find(k => model.indexOf(k) === 0) || null;

(async () => {
    const url = (() => {
        const i = process.argv.indexOf('--url');
        return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : LITELLM_URL;
    })();

    console.log('對照 LiteLLM 價目表（ccusage 的同一份來源）');
    console.log(`  來源：${url}\n`);

    let table;
    try { table = await fetchJson(url); }
    catch (e) {
        console.log(`✗ 抓不到價目表：${e.message}`);
        console.log('  離線時可先手動下載，再用 --url <本機檔案路徑> 對照。');
        process.exit(1);
    }
    console.log(`  取得 ${Object.keys(table).length} 個模型\n`);

    // ── 1. 我們表裡的每一筆，跟 LiteLLM 對 ──────────────────────────────
    // 我們的鍵是「前綴」不是型號，所以同名找不到時要展開所有以它開頭的模型一起看。
    // 這一步是關鍵：'claude-opus-4' 底下同時有 15/75（4、4.1）和 5/25（4.5 起）兩種價，
    // 光看同名鍵永遠對不出來，而那正是先前全部高估 3 倍的成因。
    const cmp = (ours, ref) => {
        const bad = [];
        for (const [mine, theirs] of FIELDS) {
            const a = ours[mine];
            const b = (ref[theirs] || 0) * M;
            // cw1h 常常沒定義；我們填了值而對方沒有時不算錯（多半是同族沿用）
            if (b === 0 && mine === 'cw1h') continue;
            if (Math.abs(a - b) > 1e-6) bad.push(`${mine} 我們 ${a} → 應為 ${Number(b.toFixed(4))}`);
        }
        return bad;
    };
    let diffs = 0, missing = 0;
    console.log('— 我們的 PRICING vs LiteLLM —');
    for (const key of Object.keys(PRICING)) {
        const ours = PRICING[key];
        if (table[key]) {
            const bad = cmp(ours, table[key]);
            if (bad.length) { console.log(`  ✗ ${key.padEnd(18)} ${bad.join('；')}`); diffs++; }
            else            { console.log(`  ✓ ${key.padEnd(18)}`); }
            continue;
        }
        // 同名沒有 → 展開前綴。只看沒有 provider 前綴（不含 '/'）的乾淨型號，
        // 且排除「已被更長的鍵接手」的那些，否則會拿別人負責的型號來罵這一鍵。
        const owned = Object.keys(table).filter(m =>
            m.indexOf(key) === 0 && !m.includes('/') && longestPrefix(m) === key);
        if (!owned.length) { console.log(`  ? ${key.padEnd(18)} LiteLLM 查無此鍵、也沒有它負責的型號`); missing++; continue; }
        const offenders = owned.map(m => [m, cmp(ours, table[m])]).filter(([, b]) => b.length);
        if (offenders.length) {
            console.log(`  ✗ ${key.padEnd(18)} 負責 ${owned.length} 個型號，其中 ${offenders.length} 個對不上：`);
            for (const [m, b] of offenders.slice(0, 4)) console.log(`      ${m}：${b.join('；')}`);
            if (offenders.length > 4) console.log(`      …另外 ${offenders.length - 4} 個`);
            console.log('      → 價格分歧的話要為它們各補一個明確鍵（最長前綴優先）');
            diffs++;
        } else {
            console.log(`  ✓ ${key.padEnd(18)} 負責 ${owned.length} 個型號，全部相符`);
        }
    }

    // ── 2. 本機實際用過、但會掉進 fallback 的型號 ─────────────────────────
    console.log('\n— 本機 transcript 實際出現的模型 —');
    const used = modelsInUse();
    if (!used.size) {
        console.log('  (沒有 transcript，跳過)');
    } else {
        for (const [model, n] of [...used].sort((a, b) => b[1] - a[1])) {
            if (model === '<synthetic>') continue;
            const hit = longestPrefix(model);
            if (hit) {
                console.log(`  ✓ ${model.padEnd(30)} ${String(n).padStart(6)} 筆 → 命中 '${hit}'`);
            } else {
                const ref = table[model];
                const hint = ref ? `（LiteLLM 有：in=${(ref.input_cost_per_token || 0) * M}／out=${(ref.output_cost_per_token || 0) * M}）` : '（LiteLLM 也查無）';
                console.log(`  ✗ ${model.padEnd(30)} ${String(n).padStart(6)} 筆 → 沒有對應鍵，會用 fallback ${hint}`);
                diffs++;
            }
        }
    }

    console.log('');
    if (diffs) {
        console.log(`✗ 有 ${diffs} 項要處理 —— 更新 src/daemon/token-source.js 的 PRICING，`);
        console.log('  並把檔頭註解的「上次對照」日期改掉。');
        process.exit(1);
    }
    console.log(`✓ 價目表與 LiteLLM 相符${missing ? `（${missing} 筆無法對照）` : ''}`);
})().catch(e => { console.log('✗ ' + e.message); process.exit(1); });
