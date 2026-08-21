'use strict';
/**
 * weather-source.js — 去哪裡問「現在什麼天氣」
 *
 * ⚠️ 這是 daemon **第一個對外的連線**（在此之前只有 localhost）。所以規則寫死：
 *   1. 只打 Open-Meteo 一個網址，免 API key、免註冊、不需要帳號。
 *   2. **不做 IP 定位。** 座標寫在設定檔，預設台北。為了猜位置而把 IP 送去第三方，
 *      為了一個天氣效果不值得。
 *   3. 抓不到就沉默退回晴天。天氣是裝飾，絕不能因為公司擋 proxy 或斷網就讓牧場開不起來。
 *   4. 30 分鐘才抓一次，而且是背景抓 —— /yard 這條路徑永遠不等網路。
 *
 * 設定檔：<INSTALL_ROOT>/weather.json
 *   { "lat": 25.038, "lon": 121.565, "city": "台北", "coldBelowC": 12, "enabled": true }
 * 檔案不存在就用預設值（台北）；"enabled": false 可以整個關掉連線。
 */
const fs   = require('fs');
const path = require('path');
const WX   = require('../shared/weather.js');

const REFRESH_MS = 30 * 60 * 1000;   // 30 分鐘。天氣不會每分鐘變，抓太勤只是在騷擾人家的免費服務
const TIMEOUT_MS = 5000;
const RETRY_MS   = 5 * 60 * 1000;    // 失敗後多久才重試（不要一直重打）

const DEFAULTS = { lat: 25.038, lon: 121.565, city: '台北', coldBelowC: WX.COLD_C, enabled: true };

function loadConfig(installRoot) {
    const f = path.join(installRoot, 'weather.json');
    try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(f, 'utf8')) }; }
    catch (e) { return { ...DEFAULTS }; }
}

// 快取也落地：daemon 重開不該馬上再打一次網路，尤其是開發時反覆重啟。
function cacheFile(stateDir) { return path.join(stateDir, 'weather-cache.json'); }

function readCache(stateDir) {
    try { return JSON.parse(fs.readFileSync(cacheFile(stateDir), 'utf8')); }
    catch (e) { return null; }
}
function writeCache(stateDir, data) {
    try {
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(cacheFile(stateDir), JSON.stringify(data));
    } catch (e) { /* 寫不進去就算了，記憶體裡那份還在 */ }
}

function url(cfg) {
    return 'https://api.open-meteo.com/v1/forecast'
         + `?latitude=${encodeURIComponent(cfg.lat)}&longitude=${encodeURIComponent(cfg.lon)}`
         + '&current=temperature_2m,weather_code';
}

/** 把 Open-Meteo 的回應轉成我們的天氣狀態。抽出來是為了測試不用真的連網。 */
function parse(json, cfg) {
    const cur = (json && json.current) || {};
    const w = WX.classify(cur.weather_code, cur.temperature_2m, { coldBelowC: cfg.coldBelowC });
    return { ...w, city: cfg.city, at: Date.now() };
}

/**
 * 建一個天氣來源。get() 永遠**立刻**回傳（可能是快取或預設值），
 * 需要更新時在背景抓，抓完下一次 get() 才看得到新的。
 */
function create({ installRoot, stateDir, log = () => {} }) {
    const cfg = loadConfig(installRoot);
    let cur = readCache(stateDir);
    let inflight = false;
    let nextTry = 0;

    // 沒有快取先給一個「晴、沒溫度」的預設，這樣第一次開頁面不會空白。
    // stale 旗標讓前端知道「這是猜的」—— 溫度會是空字串，不會顯示假數字。
    if (!cur) cur = { ...WX.classify(null, null), city: cfg.city, at: 0, stale: true };

    async function refresh() {
        if (!cfg.enabled || inflight || Date.now() < nextTry) return;
        inflight = true;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
        try {
            const res = await fetch(url(cfg), { signal: ac.signal });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            cur = parse(await res.json(), cfg);
            writeCache(stateDir, cur);
            log(`天氣：${cfg.city} ${WX.describe(cur).label} ${WX.describe(cur).temp}`);
        } catch (e) {
            // 沉默降級。不 throw、不改 cur —— 上一次抓到的比「什麼都沒有」有用。
            nextTry = Date.now() + RETRY_MS;
            if (cur.at === 0) cur = { ...cur, stale: true };
            log('天氣抓取失敗（不影響其他功能）：' + e.message);
        } finally {
            clearTimeout(timer);
            inflight = false;
        }
    }

    return {
        cfg,
        /** 現在的天氣。順手判斷要不要在背景更新 —— 不 await，這條路徑不等網路。 */
        get() {
            if (cfg.enabled && Date.now() - (cur.at || 0) > REFRESH_MS) refresh();
            return cur;
        },
        refresh,
    };
}

module.exports = { create, parse, loadConfig, DEFAULTS, REFRESH_MS, RETRY_MS };
