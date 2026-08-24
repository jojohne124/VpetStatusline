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
// Codex（OpenAI CLI）的逐輪紀錄：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// 桌寵的「花費」語意是「你在所有 AI 上燒了多少」，所以兩邊都算。傳 false 可停用。
const DEFAULT_CODEX_DIR = path.join(os.homedir(), '.codex', 'sessions');

// 各模型單價（USD / 1M tokens）。以模型名前綴匹配；抓不到用 fallback。
// 這是估算用近似值，非計費權威 —— ccusage 走 LiteLLM 的動態表，我們寫死一份。
//
// ⚠️ 數值出處：LiteLLM 的 model_prices_and_context_window.json（ccusage 的同一份來源）。
//    要更新／檢查有沒有過期，跑 `npm run check-pricing` 會下載對照並印出差異。
//    上次對照：2026-08-13。
//
// ⚠️ 前綴匹配一定要「最長優先」（見 priceFor）：claude-opus-4-8 同時命中
//    'claude-opus-4' 和 'claude-opus-4-8' 兩個鍵，而這兩者價差 3 倍
//    （Opus 4 是 15/75、4.8 降到 5/25）。舊版按 Object.keys 順序取第一個命中的，
//    Opus 4.8 就被當成 Opus 4 收費 → 全部高估 3 倍。
const PRICING = {
    // Claude（Claude Code）
    // Opus 4.5 起全面降到 5/25；4 與 4.1 仍是舊價。每個小版本都要各列一鍵，
    // 只靠 'claude-opus-4' 這個前綴會把 4.5+ 也當成舊價收費（就是先前 3 倍高估的成因）。
    'claude-opus-4-5':  { in: 5,  out: 25, cw5m: 6.25,  cw1h: 10, read: 0.5 },
    'claude-opus-4-6':  { in: 5,  out: 25, cw5m: 6.25,  cw1h: 10, read: 0.5 },
    'claude-opus-4-7':  { in: 5,  out: 25, cw5m: 6.25,  cw1h: 10, read: 0.5 },
    'claude-opus-4-8':  { in: 5,  out: 25, cw5m: 6.25,  cw1h: 10, read: 0.5 },
    'claude-opus-5':    { in: 5,  out: 25, cw5m: 6.25,  cw1h: 10, read: 0.5 },
    'claude-opus-4':    { in: 15, out: 75, cw5m: 18.75, cw1h: 30, read: 1.5 },  // 初代 4 / 4.1，未降價
    'claude-sonnet-5':  { in: 2,  out: 10, cw5m: 2.50,  cw1h: 4,  read: 0.2 },
    'claude-sonnet-4':  { in: 3,  out: 15, cw5m: 3.75,  cw1h: 6,  read: 0.3 },
    'claude-haiku-4':   { in: 1,  out: 5,  cw5m: 1.25,  cw1h: 2,  read: 0.1 },
    'claude-fable-5':   { in: 10, out: 50, cw5m: 12.50, cw1h: 20, read: 1.0 },
    // OpenAI（Codex）。無 prompt-cache 寫入計費 → cw5m/cw1h 為 0，只有 cached input 折扣
    'gpt-5.5':          { in: 5,    out: 30, cw5m: 0, cw1h: 0, read: 0.5   },
    'gpt-5-codex':      { in: 1.25, out: 10, cw5m: 0, cw1h: 0, read: 0.125 },
    'gpt-5-mini':       { in: 0.25, out: 2,  cw5m: 0, cw1h: 0, read: 0.025 },
    'gpt-5':            { in: 1.25, out: 10, cw5m: 0, cw1h: 0, read: 0.125 },
};
// 抓不到型號時的保守估計，取目前最貴的 Claude 檔次（寧可高估也不要讓進化太快）
const PRICING_FALLBACK = { in: 15, out: 75, cw5m: 18.75, cw1h: 30, read: 1.5 };

// 最長前綴優先。先排序一次，之後每次查表直接走這份。
const PRICING_KEYS = Object.keys(PRICING).sort((a, b) => b.length - a.length);
function priceFor(model) {
    if (!model) return PRICING_FALLBACK;
    for (const key of PRICING_KEYS) {
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

// ── 增量掃描 ────────────────────────────────────────────────────────────────
//
// 第一版每次呼叫都把整個 ~/.claude/projects 重讀一遍。實測那是 456 MB / 94 個檔 /
// 103,398 行，單次 2.16 秒，而 daemon 每 5 秒跑一次 —— 等於**持續佔掉 43% 的一顆
// 核心**，而且只會愈來愈糟（jsonl 只進不出）。拆開來看：讀檔 1324ms、split 172ms、
// JSON.parse 640ms，所以 I/O 是大頭，光是少 parse 幾行救不了。
//
// 兩個事實讓增量掃描可行（都是實測，不是假設）：
//   1. 456 MB 裡有 219 MB（90 個檔）是七天以上沒動過的 —— 重讀純屬浪費。
//      其餘 233 MB 集中在當下這 3 個 session，而那些檔是**只往後追加**的。
//   2. 「同一則訊息因串流被寫很多次」實測有 19,668 次，**去重不能省**。
//      去重仍然是**全域**的（跟舊版一樣），只是那份表換成 key -> 哪個檔擁有它，
//      這樣檔案被截斷或刪掉時能把它的 key 一起收回去。
//      曾經想改成「每個檔各自去重」（實測跨檔重複是 0，看起來可以），
//      但那是拿「目前的資料剛好如此」當設計前提 —— 全域表的成本只有 18k 個字串，
//      不值得為它換一個哪天會無聲多算的假設。
//
// 於是每個檔記住「讀到第幾個 byte」與那個檔算出來的小計，下次只讀新追加的部分。
// 沒變的檔完全不碰（連開檔都不用，只 stat）。
//
// 時間分桶（today / last5h / burn10m）不能只留小計，因為視窗會隨 now 移動。
// 但實測近 25 小時只有 290 筆紀錄 —— 把這些逐筆留著重算，成本可以忽略。
// 更舊的紀錄只會進 totals / byModel / bySession，那三個是單調累加的，直接沿用。
//
// 快取只活在記憶體裡：呼叫端（daemon 的 token worker）是長駐的。刻意不落地成檔案，
// 這個模組「純唯讀、零副作用」的性質要保住。
const RECENT_MS = 25 * 3600 * 1000;   // 時間分桶最寬的是 today（跨午夜最多 24h），多留 1h 餘裕

const fileCache = new Map();   // 絕對路徑 -> entry
// 去重表：message.id|requestId -> 擁有它的檔案。全域（跨檔）去重，與舊版同語意；
// 記「哪個檔」而不只是存在與否，是為了在檔案被截斷／刪除時能精準收回它的 key。
const seenOwner = new Map();

/** 這個檔的所有 key 從全域去重表撤掉（檔案被換過或刪掉時）。 */
function releaseIds(file, entry) {
    for (const k of entry.ids) if (seenOwner.get(k) === file) seenOwner.delete(k);
}

function newEntry(kind, file) {
    return {
        kind, file,                             // 'claude' | 'codex'；file 給去重表回查用
        size: 0, mtimeMs: 0,
        carry: null,                            // 尾巴那行還沒收完的 bytes（見 readAppended）
        ids: new Set(),                         // 檔內去重（串流會把同一則寫很多次）
        totals: emptyBucket(), byModel: {}, bySession: {},
        recent: [],                             // [{ts, b}] 近 RECENT_MS 的逐筆小計
        lastTs: 0, rawLines: 0, dupSkipped: 0,
        // codex 專用：total_token_usage 是單調遞增的累計值，要記住上一筆才能取差量
        prev: null, sid: null, model: null,
    };
}

function addBucket(dst, src) {
    dst.input += src.input; dst.output += src.output;
    dst.cacheCreate += src.cacheCreate; dst.cacheRead += src.cacheRead;
    dst.tokens += src.tokens; dst.costUSD += src.costUSD; dst.messages += src.messages;
}
function sessionSlot(map, sid, cwd) {
    if (!map[sid]) map[sid] = Object.assign(emptyBucket(), { lastTs: 0, cwd: cwd || null });
    return map[sid];
}

/**
 * 讀出這個檔從上次之後追加的內容。沒變動回 null（這是省下 456 MB 的那一步）。
 *
 * ⚠️ 兩個容易寫錯的地方：
 *   1. **不能按 byte 直接 toString** —— 讀到的尾端可能切在一個 UTF-8 字元中間
 *      （寫入方正在寫）。所以未結尾的那一行以 **Buffer** 留著，下次接上再解碼。
 *   2. 檔案變小 = 被截斷或換過一份，之前的小計全部作廢，整個重來。
 *      大小一樣但 mtime 變了 = 原地改寫，同樣不能信。
 */
function readAppended(file, entry) {
    let st;
    try { st = fs.statSync(file); } catch (e) { return null; }
    if (st.size < entry.size || (st.size === entry.size && st.mtimeMs !== entry.mtimeMs)) {
        releaseIds(file, entry);           // 舊的 key 要還回去，否則重掃時會被當成重複而漏算
        const fresh = newEntry(entry.kind, file);
        fileCache.set(file, fresh);
        entry = fresh;
    }
    if (st.size === entry.size) return null;      // 沒動過（連開檔都省了）

    let buf;
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        buf = Buffer.allocUnsafe(st.size - entry.size);
        const got = fs.readSync(fd, buf, 0, buf.length, entry.size);
        if (got < buf.length) buf = buf.subarray(0, got);
    } catch (e) { return null; }
    finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} } }

    entry.size += buf.length;
    entry.mtimeMs = st.mtimeMs;

    const all = entry.carry ? Buffer.concat([entry.carry, buf]) : buf;
    let cut = all.length;
    while (cut > 0 && all[cut - 1] !== 0x0A) cut--;          // 退回最後一個換行
    // subarray 是 view，直接留著會把整段 buffer 卡住不放 → 複製一份
    entry.carry = cut < all.length ? Buffer.from(all.subarray(cut)) : null;
    return cut ? all.subarray(0, cut).toString('utf8') : '';
}

/** 一筆用量進帳：同時更新這個檔的小計，以及（夠新的話）逐筆清單。 */
function record(entry, usage, model, sid, cwd, ts, now) {
    const b = emptyBucket();
    addUsage(b, usage, priceFor(model));
    addBucket(entry.totals, b);
    addBucket(entry.byModel[model || 'unknown'] = entry.byModel[model || 'unknown'] || emptyBucket(), b);
    const slot = sessionSlot(entry.bySession, sid || 'unknown', cwd);
    addBucket(slot, b);
    if (ts) {
        if (ts > entry.lastTs) entry.lastTs = ts;
        if (ts > slot.lastTs) slot.lastTs = ts;
        if (ts >= now - RECENT_MS) entry.recent.push({ ts, b });
    }
}

/** Claude Code 的 transcript：assistant 行的 message.usage 才有 token。 */
function scanClaude(entry, text, now) {
    for (const raw of text.split('\n')) {
        const line = raw.charCodeAt(raw.length - 1) === 13 ? raw.slice(0, -1) : raw;
        if (!line) continue;
        let o; try { o = JSON.parse(line); } catch (e) { continue; }
        const msg = o.message;
        if (o.type !== 'assistant' || !msg || !msg.usage) continue;
        entry.rawLines++;
        // 同一則訊息因串流會被寫很多次（實測 103,398 行裡有 19,668 次重複）
        const key = (msg.id || '') + '|' + (o.requestId || '');
        if (seenOwner.has(key)) { entry.dupSkipped++; continue; }
        seenOwner.set(key, entry.file);
        entry.ids.add(key);
        record(entry, msg.usage, msg.model, o.sessionId, o.cwd,
               o.timestamp ? Date.parse(o.timestamp) : 0, now);
    }
}

// ── Codex（OpenAI CLI）的用量紀錄 ────────────────────────────────────────────
// 逐輪會寫一筆 event_msg / token_count，裡面同時有 last_token_usage（本輪）與
// total_token_usage（本 session 累計）。
//
// ⚠️ 去重不能用 last_token_usage 加總 —— 實測 73 筆事件加起來是 4,957,942 input，
//    但最後的 total 只有 4,861,006，差 ~97k（同一輪會重複寫）。改成「取 total 的
//    正向差量」：total 是單調遞增的，累加每次的增量就等於最後的 total（實測完全相符、
//    0 次遞減）。比 Claude 那套 message.id 去重還穩，而且保留了每筆的時間戳，
//    today / last5h / burn10m 的時間分桶照樣算得出來。
//
// 欄位語意（照 OpenAI 慣例）：input_tokens 已含 cached_input_tokens，
// 所以計價要拆成「未快取 input」× in 價 +「cached」× read 價；output_tokens 已含 reasoning。
// OpenAI 沒有 prompt-cache「寫入」計費 → cw5m/cw1h 恆為 0。
//
// 增量讀的額外要求：差量是跟「上一筆」比出來的，所以 prev / sid / model 這些檔案層級的
// 狀態必須跟著快取一起留著，不能每次從頭推。
function scanCodex(entry, text, now, file) {
    if (!entry.prev) entry.prev = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
    if (!entry.sid) entry.sid = path.basename(file, '.jsonl');
    for (const raw of text.split('\n')) {
        const line = raw.charCodeAt(raw.length - 1) === 13 ? raw.slice(0, -1) : raw;
        if (!line) continue;
        let o; try { o = JSON.parse(line); } catch (e) { continue; }
        const pl = o.payload;
        if (!pl) continue;
        if (o.type === 'session_meta' && pl.id) { entry.sid = pl.id; continue; }
        if (o.type === 'turn_context' && pl.model) { entry.model = pl.model; continue; }
        if (o.type !== 'event_msg' || pl.type !== 'token_count') continue;
        const tot = pl.info && pl.info.total_token_usage;
        if (!tot) continue;
        const d = {};
        for (const k of Object.keys(entry.prev)) {
            d[k] = Math.max(0, (tot[k] || 0) - entry.prev[k]);   // 只取正向差量
            entry.prev[k] = tot[k] || 0;
        }
        if (!(d.input_tokens || d.output_tokens)) continue;
        record(entry, {
            input_tokens: Math.max(0, d.input_tokens - d.cached_input_tokens),
            output_tokens: d.output_tokens,
            cache_read_input_tokens: d.cached_input_tokens,
        }, entry.model || 'gpt-5', entry.sid, null,
           o.timestamp ? Date.parse(o.timestamp) : 0, now);
    }
}

/** 把這個檔追上最新狀態，回傳它的 entry。 */
function syncFile(file, kind, now) {
    let entry = fileCache.get(file);
    if (!entry) { entry = newEntry(kind, file); fileCache.set(file, entry); }
    const text = readAppended(file, entry);
    entry = fileCache.get(file);            // readAppended 可能因為檔案被換過而重建
    if (text) {
        if (kind === 'codex') scanCodex(entry, text, now, file);
        else scanClaude(entry, text, now);
    }
    return entry;
}

/** 丟掉所有快取。測試用（也讓「重算一次確認沒漂移」變得可能）。 */
function resetCache() { fileCache.clear(); seenOwner.clear(); }

// 主計算：增量掃 → 合併各檔小計 → 時間分桶（今日 / 近 5h / 近 10m burn）
function computeUsage(opts) {
    opts = opts || {};
    const projectsDir = opts.projectsDir || DEFAULT_PROJECTS_DIR;
    const codexDir = opts.codexDir === false ? null : (opts.codexDir || DEFAULT_CODEX_DIR);
    const now = opts.now || Date.now();
    if (opts.fresh) resetCache();

    const claudeFiles = collectJsonlFiles(projectsDir);
    const codexFiles  = codexDir ? collectJsonlFiles(codexDir) : [];

    // 檔案被刪掉／專案資料夾被清掉 → 快取也要跟著收，不然 daemon 開整天會一直長
    const live = new Set([...claudeFiles, ...codexFiles]);
    for (const k of [...fileCache.keys()]) {
        if (live.has(k)) continue;
        releaseIds(k, fileCache.get(k));
        fileCache.delete(k);
    }

    const totals    = emptyBucket();
    const byModel   = {};
    const bySession = {};
    const today     = emptyBucket();
    const last5h    = emptyBucket();
    const last10m   = emptyBucket();
    const bySource  = { claude: emptyBucket() };
    let lastActivityTs = 0, rawLines = 0, dupSkipped = 0;

    const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
    const todayMs = startOfToday.getTime();
    const fiveHMs = now - 5 * 3600 * 1000;
    const tenMMs  = now - 10 * 60 * 1000;
    const keepMs  = now - RECENT_MS;

    if (codexDir) bySource.codex = emptyBucket();

    const merge = (file, kind) => {
        const entry = syncFile(file, kind, now);
        addBucket(totals, entry.totals);
        addBucket(bySource[kind], entry.totals);
        for (const [m, b] of Object.entries(entry.byModel))
            addBucket(byModel[m] = byModel[m] || emptyBucket(), b);
        for (const [sid, b] of Object.entries(entry.bySession)) {
            const slot = sessionSlot(bySession, sid, b.cwd);
            addBucket(slot, b);
            if (b.lastTs > slot.lastTs) slot.lastTs = b.lastTs;
            if (!slot.cwd && b.cwd) slot.cwd = b.cwd;
        }
        if (entry.lastTs > lastActivityTs) lastActivityTs = entry.lastTs;
        rawLines += entry.rawLines; dupSkipped += entry.dupSkipped;

        // 逐筆的只留在視窗內的；過期的就地丟掉，這份清單才不會無限長
        if (entry.recent.length) {
            let live = 0;
            for (const r of entry.recent) {
                if (r.ts < keepMs) continue;
                entry.recent[live++] = r;
                if (r.ts >= todayMs) addBucket(today,  r.b);
                if (r.ts >= fiveHMs) addBucket(last5h, r.b);
                if (r.ts >= tenMMs)  addBucket(last10m, r.b);
            }
            entry.recent.length = live;
        }
    };

    for (const f of claudeFiles) merge(f, 'claude');
    for (const f of codexFiles)  merge(f, 'codex');

    // 找「最近活躍」的 session（daemon 沒有 statusLine 那種 per-session 輸入，用最新時間戳推定）
    let activeSession = null, activeTs = 0;
    for (const [sid, b] of Object.entries(bySession)) {
        if (b.lastTs > activeTs) { activeTs = b.lastTs; activeSession = sid; }
    }

    return {
        projectsDir, codexDir, now,
        bySource,                          // { claude, codex } 各自的小計（totals 是合計）
        scannedFiles: claudeFiles.length + codexFiles.length,
        rawUsageLines: rawLines,
        uniqueMessages: seenOwner.size,
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
    L.push('\n--- 全域累計（所有 AI 合計）---');
    L.push(row('TOTAL', s.totals));
    if (s.bySource) {
        for (const [src, b] of Object.entries(s.bySource)) L.push(row('  └ ' + src, b));
    }
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

module.exports = { computeUsage, priceFor, PRICING, resetCache, RECENT_MS };
