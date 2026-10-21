#!/usr/bin/env node
'use strict';
/**
 * test-peek.js — 廣場「偷看盤」（docs/plaza-peek-spec.md）
 *
 *   1. 報價來源（stock-source.js）：代號格式、盤中判斷（台北時間）、證交所欄位解析
 *   2. 伺服器：躲起來／回座位（系統訊息、別人看到 hidden、躲著不能被邀／不能開房／不能開心）、
 *      查股票（要先躲、格式不對不算次數、每人 1 分鐘一次、查不到不算次數、快取）、
 *      盤中合併更新（大家看的代號一個請求、非交易時間不查、失敗就放慢）
 */
const S  = require('../src/daemon/plaza-server.js');
const C  = require('../src/daemon/plaza-client.js');
const ST = require('../src/daemon/stock-source.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(cond, ms = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(15); }
    return cond();
}

console.log('— 報價來源 —');
{
    ok(ST.validCode('2330') && ST.validCode('00631L') && ST.validCode('006208') && !ST.validCode('AAPL') && !ST.validCode('23') && !ST.validCode('2330;'),
       '台股代號格式判斷不對');
    const tp = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h - 8, mi);   // 台北時間 → 毫秒
    ok(ST.isTradingTime(tp(2026, 10, 21, 10, 0)) && !ST.isTradingTime(tp(2026, 10, 21, 8, 59)) && !ST.isTradingTime(tp(2026, 10, 21, 14, 0)),
       '平日盤中判斷不對（09:00–13:30）');
    ok(!ST.isTradingTime(tp(2026, 10, 24, 10, 0)), '週六也當成盤中');
    const q = ST.parseQuote({ c: '2330', n: '台積電', ex: 'tse', z: '-', y: '1000.0000', o: '1005', h: '1010', l: '995',
                              v: '123', b: '1001.0000_1000.5000_', a: '1002.0000_', t: '10:00:00', d: '20261021' });
    ok(q && q.price === 1001 && q.change === 1 && q.pct === 0.1 && q.bids[0] === 1001 && q.asks[0] === 1002 && q.name === '台積電',
       '這一刻沒成交（z 是 -）時沒有用最佳買價頂著，或漲跌算錯：' + JSON.stringify(q));
    ok(ST.parseQuote({ c: '6488', ex: 'otc', z: '885', y: '844' }).market === 'otc', '上櫃沒標成 otc');
}

(async () => {
    console.log('— 伺服器 —');
    let trading = true, calls = [], failNext = false;
    const fake = (codes) => {
        calls.push(codes.slice().sort().join(','));
        if (failNext) { failNext = false; return Promise.reject(new Error('擋住了')); }
        const out = {};
        for (const c of codes) if (c !== '9999') out[c] = { code: c, name: '股' + c, price: 100 + calls.length, prev: 100 };
        return Promise.resolve(out);
    };
    const ps = S.createPlazaServer({ stockFetch: fake, stockTrading: () => trading, stockQueryGapMs: 400, stockRefreshMs: 150, stockCacheMs: 3000, graceMs: 3000 });
    await new Promise(r => ps.server.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + ps.server.address().port;
    const mk = () => C.create({ url, retryMs: 2000 });
    const prof = (name) => ({ name, char: 'agumon', stage: 'Child', card: { power: 10, train: 0, str: 10 } });
    const a = mk(), b = mk();
    try {
        await a.join(prof('阿張')); await b.join(prof('阿明'));
        await until(() => a.me() && b.me());
        ok(!(await a.stockQuery('2330')).ok, '沒躲起來也能查股票');
        ok((await a.hide()).ok, '躲起來失敗');
        ok(await until(() => (b.roster().find(m => m.id === a.me().id) || {}).hidden === true), '躲起來了，別人那邊沒有變成看不到');
        ok(await until(() => b.chat().some(e => e.sys && e.text === '阿張 不知道躲去哪了...')), '躲起來沒有「XXX 不知道躲去哪了...」');
        ok(!(await b.invite(a.me().id)).ok, '躲起來的人還能被邀請對戰');
        ok(!(await a.stairs('open', { mode: 'endless', kind: 'stairs' })).ok, '躲起來還能開小遊戲的房');
        ok(!(await a.emote()).ok, '躲起來還能按開心');

        // 查股票：格式不對、查不到 → 不算次數；查到了 → 1 分鐘（測試 400ms）內不能再查
        ok(!(await a.stockQuery('AAPL')).ok, '美股代號也收（只做台股）');
        const nf = await a.stockQuery('9999');
        ok(!nf.ok && /查不到/.test(nf.error), '查不到的代號沒有說查不到');
        const q1 = await a.stockQuery('2330');
        ok(q1.ok && q1.quote.code === '2330' && q1.trading === true, '查股票失敗：' + JSON.stringify(q1));
        const q2 = await a.stockQuery('2317');
        ok(!q2.ok && q2.wait > 0, '1 分鐘內可以連查（應該被擋，還要說等幾秒）');
        // 同一檔在快取時間內：不再打證交所
        await b.hide();
        const n0 = calls.length;
        await b.stockQuery('2330');
        ok(calls.length === n0, '同一檔剛查過（快取還新）又打了一次證交所');

        // 盤中合併更新：兩個人各看一檔 → 一個請求帶兩檔；推給各自
        await sleep(450);
        await b.stockQuery('0050');
        calls.length = 0;
        ok(await until(() => calls.length >= 1, 2000), '盤中沒有自動更新');
        ok(calls[0] === '0050,2330', '盤中更新沒有合併成一個請求：' + JSON.stringify(calls));
        ok(await until(() => a.stock() && a.stock().quote.code === '2330' && b.stock() && b.stock().quote.code === '0050'), '盤中更新沒推給在看的人');
        // 非交易時間：不查
        trading = false; await sleep(250); calls.length = 0; await sleep(500);
        ok(calls.length === 0, '收盤後還在自動查證交所');
        // 失敗就放慢：失敗一次後，下一次要等比 30 秒（測試 150ms）更久
        trading = true; failNext = true; calls.length = 0;
        await until(() => calls.length >= 1, 2000);
        const tf = Date.now();
        await until(() => calls.length >= 2, 3000);
        ok(Date.now() - tf >= 250, '證交所失敗後沒有放慢（' + (Date.now() - tf) + 'ms 就再查）');

        // 回座位：系統訊息、別人看得到、不再自動更新
        ok((await a.hide(false)).ok, '回座位失敗');
        ok(await until(() => b.chat().some(e => e.sys && e.text === '阿張 若無其事地回來了')), '回座位沒有「XXX 若無其事地回來了」');
        ok(await until(() => (b.roster().find(m => m.id === a.me().id) || {}).hidden === false), '回座位了，別人那邊還是看不到');
        await b.hide(false);
        await sleep(300); calls.length = 0; await sleep(500);
        ok(calls.length === 0, '沒人在看了還在自動查');
    } catch (e) { fail++; console.log('  ✗ 例外：' + (e && e.stack)); }
    finally {
        for (const x of [a, b]) { try { await x.leave(); } catch (e) {} }
        await ps.close();
    }
    console.log(`\n結果：${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
