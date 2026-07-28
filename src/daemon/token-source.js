'use strict';
// ── PoC 第一步：讀 JSONL 的 token 資料源（ccusage 法）──────────────────────
//
// 目的：不依賴 Claude Code 呼叫 statusLine，直接讀 Claude Code 自己寫的逐輪
//       transcript（~/.claude/projects/**/*.jsonl），自行算出 token / cost。
//       這是「獨立資料源」，之後給 daemon 當時鐘的燃料，也可回頭升級現有 statusLine。
//
// ⚠️ 純唯讀、零副作用：不寫任何檔、不碰 hook、不碰 state。可單獨驗證後再決定去留。
//
// 關鍵發現（實測 b54b9750 這份 transcript）：
//   1. assistant 行的 message.usage 才有 token；欄位：
//      input_tokens / output_tokens / cache_creation_input_tokens /
//      cache_read_input_tokens，另 cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens。
//   2. transcript 沒有現成 cost → 要用「token × 各模型單價」自算。
//   3. 同一則訊息因串流會被寫很多次（2062 行 → 837 unique）。
//      **必須用 message.id|requestId 去重**，否則 token 會膨脹 2~3 倍。
//
// 用法：node src/daemon/token-source.js            → 印全域摘要
//       node src/daemon/token-source.js --json     → 輸出 JSON
//       node src/daemon/token-source.js --session <id>
//
// API：require('./token-source').computeUsage({ projectsDir?, now? }) → summary 物件

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// 各模型單價（USD / 1M tokens）。以模型名前綴匹配；抓不到用 fallback。
// 註：這是估算用近似值，非計費權威；ccusage 走 LiteLLM 動態表，PoC 先寫死。
const PRICING = {
    'claude-opus-4':    { in: 15, out: 75, cw5m: 18.75, cw1h: 30, read: 1.5 },
    'claude-sonnet-5':  { in: 3,  out: 15, cw5m: 3.75,  cw1h: 6,  read: 0.3 },
    'claude-sonnet-4':  { in: 3,  out: 15, cw5m: 3.75,  cw1h: 6,  read: 0.3 },
    'claude-haiku-4':   { in: 1,  out: 5,  cw5m: 1.25,  cw1h: 2,  read: 0.1 },
    'claude-fable-5':   { in: 3,  out: 15, cw5m: 3.75,  cw1h: 6,  read: 0.3 },
};
const PRICING_FALLBACK = { in: 15, out: 75, cw5m: 18.75, cw1h: 30, read: 1.5 };

function priceFor(model) {
    if (!model) return PRICING_FALLBACK;
    for (const key of Object.keys(PRICING)) {
        if (model.indexOf(key) === 0) return PRICING[key];
    }
    return PRICING_FALLBACK;
}

// 遞迴收集所有 *.jsonl（含 subagents/ 子目錄）
function collectJsonlFiles(dir) {
    const out = [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return out; }
    for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) out.push(...collectJsonlFiles(full));
        else if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push(full);
    }
    return out;
}

function emptyBucket() {
    return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, tokens: 0, costUSD: 0, messages: 0 };
}
function addUsage(bucket, u, price) {
    const inTok   = u.input_tokens || 0;
    const outTok  = u.output_tokens || 0;
    const cc      = u.cache_creation || {};
    const cw5m    = cc.ephemeral_5m_input_tokens || 0;
    const cw1h    = cc.ephemeral_1h_input_tokens || 0;
    // 若沒有細分 5m/1h，就整包 cache_creation_input_tokens 當 5m 計
    const ccTotal = (cw5m + cw1h) || (u.cache_creation_input_tokens || 0);
    const cw5mEff = (cw5m + cw1h) ? cw5m : (u.cache_creation_input_tokens || 0);
    const cw1hEff = cw1h;
    const readTok = u.cache_read_input_tokens || 0;
    const cost = (inTok * price.in + outTok * price.out
                + cw5mEff * price.cw5m + cw1hEff * price.cw1h
                + readTok * price.read) / 1e6;
    bucket.input       += inTok;
    bucket.output      += outTok;
    bucket.cacheCreate += ccTotal;
    bucket.cacheRead   += readTok;
    bucket.tokens      += inTok + outTok + ccTotal + readTok;
    bucket.costUSD     += cost;
    bucket.messages    += 1;
}

// 主計算：掃 → 去重 → 聚合（全域 / 各模型 / 各 session / 今日 / 近 5h / 近 10m burn）
function computeUsage(opts) {
    opts = opts || {};
    const projectsDir = opts.projectsDir || DEFAULT_PROJECTS_DIR;
    const now = opts.now || Date.now();
    const files = collectJsonlFiles(projectsDir);

    const seen = new Set();               // message.id|requestId 去重
    const totals   = emptyBucket();
    const byModel  = {};
    const bySession = {};
    const today    = emptyBucket();
    const last5h   = emptyBucket();
    const last10m  = emptyBucket();
    let lastActivityTs = 0;
    let rawLines = 0, dupSkipped = 0;

    const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
    const todayMs = startOfToday.getTime();
    const fiveHMs = now - 5 * 3600 * 1000;
    const tenMMs  = now - 10 * 60 * 1000;

    for (const file of files) {
        let content;
        try { content = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
        for (const line of content.split(/\r?\n/)) {
            if (!line) continue;
            let o; try { o = JSON.parse(line); } catch (e) { continue; }
            const msg = o.message;
            if (o.type !== 'assistant' || !msg || !msg.usage) continue;
            rawLines++;
            const key = (msg.id || '') + '|' + (o.requestId || '');
            if (seen.has(key)) { dupSkipped++; continue; }
            seen.add(key);

            const price = priceFor(msg.model);
            addUsage(totals, msg.usage, price);

            const m = msg.model || 'unknown';
            (byModel[m] = byModel[m] || emptyBucket()) && addUsage(byModel[m], msg.usage, price);

            const sid = o.sessionId || 'unknown';
            (bySession[sid] = bySession[sid] || Object.assign(emptyBucket(), { lastTs: 0, cwd: o.cwd })) ;
            addUsage(bySession[sid], msg.usage, price);

            const ts = o.timestamp ? Date.parse(o.timestamp) : 0;
            if (ts) {
                if (ts > lastActivityTs) lastActivityTs = ts;
                if (ts > bySession[sid].lastTs) bySession[sid].lastTs = ts;
                if (ts >= todayMs) addUsage(today,  msg.usage, price);
                if (ts >= fiveHMs) addUsage(last5h, msg.usage, price);
                if (ts >= tenMMs)  addUsage(last10m, msg.usage, price);
            }
        }
    }

    // 找「最近活躍」的 session（daemon 沒有 statusLine 那種 per-session 輸入，用最新時間戳推定）
    let activeSession = null, activeTs = 0;
    for (const [sid, b] of Object.entries(bySession)) {
        if (b.lastTs > activeTs) { activeTs = b.lastTs; activeSession = sid; }
    }

    return {
        projectsDir, now,
        scannedFiles: files.length,
        rawUsageLines: rawLines,
        uniqueMessages: seen.size,
        dupSkipped,
        totals,
        byModel,
        sessions: Object.keys(bySession).length,
        activeSession,
        activeSessionUsage: activeSession ? bySession[activeSession] : null,
        today,
        last5h,
        burn10m: last10m,          // 近 10 分鐘 → 給 daemon 當「活躍度 / 掉落」訊號
        lastActivityTs,
        lastActivityAgoSec: lastActivityTs ? Math.round((now - lastActivityTs) / 1000) : null,
    };
}

// ── CLI ──
function fmt(n) { return n.toLocaleString('en-US'); }
function usd(n) { return '$' + n.toFixed(4); }
function printSummary(s) {
    const L = [];
    L.push('==================== token-source (JSONL) ====================');
    L.push('projectsDir : ' + s.projectsDir);
    L.push('掃描檔案     : ' + s.scannedFiles + ' 個 .jsonl');
    L.push('usage 行     : ' + fmt(s.rawUsageLines) + ' 原始 → ' + fmt(s.uniqueMessages) + ' unique（去重 ' + fmt(s.dupSkipped) + '）');
    L.push('sessions    : ' + s.sessions);
    L.push('最近活躍     : ' + (s.lastActivityAgoSec == null ? '?' : s.lastActivityAgoSec + 's 前') + '  session=' + s.activeSession);
    const row = (name, b) => `  ${name.padEnd(12)} tokens ${fmt(b.tokens).padStart(14)}  cost ${usd(b.costUSD).padStart(11)}  (in ${fmt(b.input)} / out ${fmt(b.output)} / cw ${fmt(b.cacheCreate)} / read ${fmt(b.cacheRead)})`;
    L.push('\n--- 全域累計 ---');
    L.push(row('TOTAL', s.totals));
    L.push('\n--- 分模型 ---');
    for (const [m, b] of Object.entries(s.byModel)) L.push(row(m.replace('claude-', ''), b));
    L.push('\n--- 時間窗 ---');
    L.push(row('今日', s.today));
    L.push(row('近 5h', s.last5h));
    L.push(row('近 10m burn', s.burn10m));
    if (s.activeSessionUsage) {
        L.push('\n--- 最近活躍 session（≈ statusLine 的 per-session cost）---');
        L.push(row(s.activeSession.slice(0, 8), s.activeSessionUsage));
        L.push('  cwd: ' + s.activeSessionUsage.cwd);
    }
    L.push('=============================================================');
    console.log(L.join('\n'));
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const s = computeUsage({});
    if (args.includes('--json')) {
        console.log(JSON.stringify(s, null, 2));
    } else if (args.includes('--session')) {
        const sid = args[args.indexOf('--session') + 1];
        console.log(JSON.stringify(s, null, 2));  // PoC：先整包，之後可過濾
    } else {
        printSummary(s);
    }
}

module.exports = { computeUsage, priceFor, PRICING };
