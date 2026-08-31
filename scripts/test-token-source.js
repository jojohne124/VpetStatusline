#!/usr/bin/env node
'use strict';
/**
 * test-token-source.js — JSONL 用量資料源的增量掃描
 *
 * 為什麼需要這支：computeUsage 從「每次重讀 456 MB」改成「只讀新追加的 byte」之後，
 * 正確性不再是「讀了就算」那麼直觀 —— 快取要處理串流重複、UTF-8 被切一半、
 * 檔案被截斷、檔案被刪掉。這些全都是**只有在第二次呼叫時才會出錯**的東西，
 * 用真的 transcript 手動看是看不出來的。
 *
 * 所有資料都是現場合成的小檔（temp 目錄，跑完刪掉），不碰 ~/.claude/projects。
 *
 * 判準只有一條，其餘都是它的特例：**增量掃出來的結果，必須等於整份重掃。**
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const TS   = require('../src/daemon/token-source.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vpet-tok-'));
const DIR  = path.join(ROOT, 'projects');
fs.mkdirSync(DIR, { recursive: true });
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {} });

const T0 = 1787000000000;   // 固定基準時間
const iso = (ms) => new Date(ms).toISOString();

/** 一行 assistant transcript。同一個 id 重複寫 = 模擬串流。 */
function line(id, { ts = T0, out = 100, model = 'claude-opus-5', sid = 's1', req = 'r' } = {}) {
    return JSON.stringify({
        type: 'assistant', sessionId: sid, requestId: req + id, cwd: '/w',
        timestamp: iso(ts),
        message: { id, model, usage: { input_tokens: 10, output_tokens: out } },
    }) + '\n';
}
const file = (name) => path.join(DIR, name);
const append = (name, s) => fs.appendFileSync(file(name), s);

/** 增量結果 vs 整份重掃。這是本檔的核心判準。 */
function sameAsFresh(now, label, opts = {}) {
    const base = { projectsDir: DIR, codexDir: false, now, ...opts };
    const inc = TS.computeUsage(base);
    const full = TS.computeUsage({ ...base, fresh: true });
    const a = JSON.stringify(inc), b = JSON.stringify(full);
    ok(a === b, label + '：增量與重掃不一致\n     增量 ' + a.slice(0, 200) + '\n     重掃 ' + b.slice(0, 200));
    return inc;
}

console.log('— 追加：只讀新的，結果要跟重掃一樣 —');
{
    TS.resetCache();
    append('a.jsonl', line('m1') + line('m2'));
    const r1 = TS.computeUsage({ projectsDir: DIR, codexDir: false, now: T0 });
    ok(r1.uniqueMessages === 2, '第一次應該讀到 2 則，得到 ' + r1.uniqueMessages);

    append('a.jsonl', line('m3'));
    const r2 = sameAsFresh(T0, '追加一行');
    ok(r2.uniqueMessages === 3, '追加後應該是 3 則，得到 ' + r2.uniqueMessages);
    ok(r2.totals.output === 300, 'output 應該是 300，得到 ' + r2.totals.output);

    // 完全沒動的那一次也不能算錯（最常見的情況：daemon 每 5 秒問一次，多數時候沒新東西）
    const r3 = sameAsFresh(T0, '沒有任何變動');
    ok(r3.uniqueMessages === 3, '沒變動卻多算了');
}

console.log('— 串流重複跨越讀取邊界 —');
{
    // 同一則訊息在**兩次呼叫之間**被重寫。舊版每次整份重掃、靠一個 Set 就好；
    // 增量版必須把已經看過的 key 記著，不然邊界後面那次會被當成新的一則。
    TS.resetCache();
    fs.rmSync(file('a.jsonl'));
    append('b.jsonl', line('x1', { out: 50 }));
    TS.computeUsage({ projectsDir: DIR, codexDir: false, now: T0 });
    append('b.jsonl', line('x1', { out: 50 }) + line('x2', { out: 50 }));
    const r = sameAsFresh(T0, '串流重複');
    ok(r.uniqueMessages === 2, '同一則被重寫卻算了兩次：' + r.uniqueMessages + ' 則');
    ok(r.totals.output === 100, 'output 膨脹了：' + r.totals.output);
    ok(r.dupSkipped === 1, 'dupSkipped 應該是 1，得到 ' + r.dupSkipped);
}

console.log('— UTF-8 字元被切在讀取邊界上 —');
{
    // 追加是可能讀到「寫到一半」的：最後幾個 byte 可能是一個多位元組字元的前半。
    // 直接 buf.toString() 會把它變成替代字元，那一行就 parse 失敗、整筆用量消失。
    TS.resetCache();
    fs.rmSync(file('b.jsonl'));
    const whole = Buffer.from(line('u1', { out: 77, sid: '中文專案' }), 'utf8');
    // 找第一個多位元組字元的首 byte（>= 0x80 且不是 continuation），切在它後面一格
    // —— 這樣第一塊的結尾就是半個字元。
    let lead = 0;
    while (lead < whole.length && ((whole[lead] & 0x80) === 0 || (whole[lead] & 0xC0) === 0x80)) lead++;
    ok(lead < whole.length, '測試資料裡沒有多位元組字元，這條測不到東西');
    const cut = lead;   // 只寫到 lead（含），後面的 continuation byte 留到下一次
    fs.appendFileSync(file('c.jsonl'), whole.subarray(0, cut + 1));   // 故意留半個字
    const mid = TS.computeUsage({ projectsDir: DIR, codexDir: false, now: T0 });
    ok(mid.uniqueMessages === 0, '半行不該被當成完整的一筆（得到 ' + mid.uniqueMessages + '）');
    fs.appendFileSync(file('c.jsonl'), whole.subarray(cut + 1));
    const r = sameAsFresh(T0, 'UTF-8 邊界');
    ok(r.uniqueMessages === 1, '接回來之後那一筆不見了');
    ok(r.totals.output === 77, 'output 應該是 77，得到 ' + r.totals.output);
    ok(Object.keys(r.byModel).length === 1, 'byModel 髒掉了');
}

console.log('— 檔案被截斷／原地改寫 —');
{
    // log rotate、手動清檔、或工具重寫。舊的小計整份作廢，而且它佔用的去重 key
    // 必須還回去，否則重掃時會被當成「看過了」而整批漏算。
    TS.resetCache();
    fs.rmSync(file('c.jsonl'));
    append('d.jsonl', line('t1') + line('t2') + line('t3'));
    const before = TS.computeUsage({ projectsDir: DIR, codexDir: false, now: T0 });
    ok(before.uniqueMessages === 3, '前置條件不成立');

    fs.writeFileSync(file('d.jsonl'), line('t1'));      // 截短
    const r = sameAsFresh(T0, '截斷');
    ok(r.uniqueMessages === 1, '截斷後應該只剩 1 則，得到 ' + r.uniqueMessages);
    ok(r.totals.output === 100, '截斷後 output 應該是 100，得到 ' + r.totals.output);

    // 大小一樣但內容換掉（mtime 會變）—— 只看 size 的話會完全漏掉這種改動。
    // ⚠️ 內容一定要在**輸出看得到的地方**不同（這裡是 output 100 -> 200）。
    //    第一版只換了 message id、筆數前後都是 1，摘要裡分毫不差 ——
    //    拿掉 mtime 判斷照樣全綠，那條等於沒測到。
    const other = line('t9', { out: 200 });
    ok(Buffer.byteLength(other) === Buffer.byteLength(line('t1', { out: 100 })),
       '測試資料長度不同，這條測不到東西');
    fs.writeFileSync(file('d.jsonl'), other);
    // ⚠️ 一定要把 mtime 明確推開。兩次 writeFileSync 常常落在同一個 mtime tick
    //    （Windows 的解析度比較粗），mtime 沒變 → 增量讀不會重讀 → 這條隨機紅。
    //    實測連跑三次會紅兩次，而它紅的時候看起來像產品壞了，其實是測試自己不穩。
    //    產品的契約是「大小一樣但 mtime 變了就重讀」（token-source.js 的 isStale），
    //    所以把 mtime 推開才是真的在測那一條，不是繞過它。
    { const t = new Date(Date.now() + 2000); fs.utimesSync(file('d.jsonl'), t, t); }
    const r2 = sameAsFresh(T0, '同大小改寫');
    ok(r2.uniqueMessages === 1, '同大小改寫後筆數不對：' + r2.uniqueMessages);
    ok(r2.totals.output === 200, '同大小改寫沒被偵測到（還是舊內容）：' + r2.totals.output);
}

console.log('— 檔案被刪掉 —');
{
    TS.resetCache();
    fs.rmSync(file('d.jsonl'));
    append('e1.jsonl', line('k1'));
    append('e2.jsonl', line('k2'));
    ok(TS.computeUsage({ projectsDir: DIR, codexDir: false, now: T0 }).uniqueMessages === 2, '前置條件不成立');
    fs.rmSync(file('e2.jsonl'));
    const r = sameAsFresh(T0, '刪檔');
    ok(r.uniqueMessages === 1, '刪掉的檔還算在裡面：' + r.uniqueMessages);
    ok(r.scannedFiles === 1, 'scannedFiles 沒跟著減：' + r.scannedFiles);
    // 同名檔重新出現、內容是同一則 → key 已經還回去了，應該重新算得到
    append('e2.jsonl', line('k2'));
    const r2 = sameAsFresh(T0, '刪掉又回來');
    ok(r2.uniqueMessages === 2, '刪掉的 key 沒還回去，重新出現時被漏算了：' + r2.uniqueMessages);
}

console.log('— 去重是全域的（跨檔）—');
{
    // 舊版用一個全域 Set，所以同一個 key 出現在兩個檔只算一次。實測跨檔重複是 0，
    // 但那是「目前的資料剛好如此」，不是保證 —— 改成每個檔各自去重就會無聲多算。
    TS.resetCache();
    for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f));
    append('f1.jsonl', line('same'));
    append('f2.jsonl', line('same'));
    const r = sameAsFresh(T0, '跨檔重複');
    ok(r.uniqueMessages === 1, '同一個 key 出現在兩個檔卻算了兩次：' + r.uniqueMessages);
    ok(r.totals.output === 100, 'output 被算了兩次：' + r.totals.output);
}

console.log('— 時間分桶會跟著 now 移動 —');
{
    // 小計（totals）是單調累加、可以直接沿用；today / last5h / burn10m 不行，
    // 視窗會滑走。所以近期的紀錄要逐筆留著重算 —— 這條就是在守那件事。
    TS.resetCache();
    for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f));
    const now = T0;
    append('g.jsonl', line('n1', { ts: now - 60 * 1000, out: 10 })          // 1 分鐘前
                    + line('n2', { ts: now - 2 * 3600 * 1000, out: 20 })    // 2 小時前
                    + line('n3', { ts: now - 20 * 3600 * 1000, out: 40 })); // 20 小時前
    const r = TS.computeUsage({ projectsDir: DIR, codexDir: false, now });
    ok(r.burn10m.output === 10, 'burn10m 應該只含 1 分鐘前那筆，得到 ' + r.burn10m.output);
    ok(r.last5h.output === 30, 'last5h 應該含前兩筆，得到 ' + r.last5h.output);
    ok(r.totals.output === 70, 'totals 應該含全部，得到 ' + r.totals.output);

    // 同一份資料、時間往前走 3.5 小時：小計不動，視窗要縮。
    // 刻意避開邊界剛好相等的情況（視窗是 >=，落在端點上算「有」，那不是這條要測的）。
    const ahead = now + 3.5 * 3600 * 1000;
    const later = TS.computeUsage({ projectsDir: DIR, codexDir: false, now: ahead });
    ok(later.totals.output === 70, '時間前進後 totals 不該變：' + later.totals.output);
    ok(later.burn10m.output === 0, '3.5 小時後 burn10m 應該空了：' + later.burn10m.output);
    ok(later.last5h.output === 10, '3.5 小時後 last5h 應該只剩 1 分鐘前那筆：' + later.last5h.output);
    sameAsFresh(ahead, '時間前進後');
}

console.log('— Codex 的差量在增量讀之下要接得上 —');
{
    // Codex 記的是 session 累計值，用「正向差量」還原每輪用量。
    // 那個差量是跟上一筆比出來的 → 上一筆的值必須跟著快取一起留著，
    // 不然邊界後的第一筆會拿 0 當基準，整包累計值被當成一輪的用量。
    const CDIR = path.join(ROOT, 'codex');
    fs.mkdirSync(CDIR, { recursive: true });
    const cline = (inTok, outTok, ts) => JSON.stringify({
        type: 'event_msg', timestamp: iso(ts),
        payload: { type: 'token_count', info: { total_token_usage: {
            input_tokens: inTok, cached_input_tokens: 0, output_tokens: outTok } } },
    }) + '\n';
    TS.resetCache();
    const cf = path.join(CDIR, 'roll.jsonl');
    fs.appendFileSync(cf, cline(100, 10, T0));
    const c1 = TS.computeUsage({ projectsDir: DIR, codexDir: CDIR, now: T0 });
    ok(c1.bySource.codex.output === 10, 'codex 第一筆不對：' + c1.bySource.codex.output);

    fs.appendFileSync(cf, cline(250, 30, T0));      // 累計值 → 這輪是 +150 / +20
    const c2 = TS.computeUsage({ projectsDir: DIR, codexDir: CDIR, now: T0 });
    ok(c2.bySource.codex.output === 30, 'codex 差量算錯（output 應為 30）：' + c2.bySource.codex.output);
    ok(c2.bySource.codex.input === 250, 'codex 差量算錯（input 應為 250）：' + c2.bySource.codex.input);
    const full = TS.computeUsage({ projectsDir: DIR, codexDir: CDIR, now: T0, fresh: true });
    ok(JSON.stringify(c2.bySource.codex) === JSON.stringify(full.bySource.codex),
       'codex 增量與重掃不一致');
}

console.log(`\n結果：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
