'use strict';
/**
 * stock-source.js — 偷看盤（docs/plaza-peek-spec.md）的台股報價來源
 *
 * 只做台股：證交所即時看盤的公開接口（mis.twse.com.tw，證交所網頁自己在用的那支，不用金鑰）。
 * 上市（tse_）、上櫃（otc_）一次一起問，哪邊有資料就是哪邊。
 *
 * 不被擋的做法（2026-10-21 定）：
 *   - 全部由 plaza-host 代查（大家共用一個出口），同一時間只有一個請求在飛
 *   - 盤中每 30 秒合併查一次「大家正在看的」所有代號（一個請求，人數多寡都一樣）
 *   - 非交易時間（平日 09:00–13:30 以外、週末）不自動更新，只顯示最後一筆
 *   - 失敗就放慢：30 秒 → 1 分 → 2 分 … 最多 5 分，成功一次就回到 30 秒
 */
const https = require('https');

const MIS_URL = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp';
const TIMEOUT_MS = 8000;

// 台股代號：4～6 碼數字，ETF／特別股可能帶一個英文字尾（例如 00631L、2881A）
const validCode = (s) => typeof s === 'string' && /^[0-9]{4,6}[A-Z]?$/.test(s);

/** 現在（台北時間）是不是盤中：週一～五 09:00–13:30（多留 5 分鐘收最後一筆） */
function isTradingTime(ms) {
    const t = new Date(ms + 8 * 3600e3);           // 換成台北時間再用 UTC 欄位讀
    const day = t.getUTCDay(), min = t.getUTCHours() * 60 + t.getUTCMinutes();
    return day >= 1 && day <= 5 && min >= 9 * 60 && min <= 13 * 60 + 35;
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
/** 證交所一筆 → 我們要的欄位。成交價 z 盤中常是 '-'（這一刻沒成交）→ 用最佳買價頂著 */
function parseQuote(o) {
    if (!o || !o.c) return null;
    const bids = String(o.b || '').split('_').map(num).filter(x => x != null);
    const asks = String(o.a || '').split('_').map(num).filter(x => x != null);
    const prev = num(o.y);
    const price = num(o.z) ?? bids[0] ?? asks[0] ?? null;
    return {
        code: o.c, name: o.n || o.c, market: o.ex === 'otc' ? 'otc' : 'tse',
        price, prev, open: num(o.o), high: num(o.h), low: num(o.l),
        change: price != null && prev != null ? Math.round((price - prev) * 100) / 100 : null,
        pct: price != null && prev ? Math.round((price - prev) / prev * 10000) / 100 : null,
        volume: num(o.v),                          // 累積成交量（張）
        bids: bids.slice(0, 5), asks: asks.slice(0, 5),
        time: o.t || null, date: o.d || null,
    };
}

/** 真的去證交所問。codes 一次多檔；回傳 { 代號: 報價 }，問不到的不在裡面 */
function fetchMis(codes) {
    const ex = codes.flatMap(c => ['tse_' + c + '.tw', 'otc_' + c + '.tw']).join('|');
    const url = MIS_URL + '?ex_ch=' + encodeURIComponent(ex) + '&json=1&delay=0&_=' + Date.now();
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }, (res) => {
            let d = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); });
            res.on('end', () => {
                if (res.statusCode !== 200) return reject(new Error('證交所回應 ' + res.statusCode));
                let j; try { j = JSON.parse(d.trim()); } catch (e) { return reject(new Error('證交所回傳的不是 JSON')); }
                const out = {};
                for (const o of j.msgArray || []) { const q = parseQuote(o); if (q) out[q.code] = q; }
                resolve(out);
            });
        });
        req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('證交所沒回應')));
        req.on('error', reject);
    });
}

module.exports = { validCode, isTradingTime, parseQuote, fetchMis, MIS_URL };
