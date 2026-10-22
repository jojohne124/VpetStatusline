'use strict';
/**
 * cwa-source.js — 中央氣象署開放資料：自動氣象站的實測天氣（2026-10-21）
 *
 * Open-Meteo 是模型推算的格點，局部陣雨、雲量常常跟窗外對不上。氣象署的自動站是**實測**，
 * 而且直接給「天氣」文字（晴／多雲／陰／有雨／有雷雨…），所以有它就以它為準。
 *
 * ⚠️ 授權碼只放在 plaza-host 那台：~/.vpet/cwa.key（或環境變數 VPET_CWA_KEY_FILE 指的檔）。
 *    由 plaza-host 統一抓、再用 /weather 發給大家；授權碼不進 repo、不出貨、不送給任何 daemon。
 *
 * 預設測站：五股（C0AI00，新北市五股區）。
 */
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WX = require('../shared/weather.js');

const KEY_FILE = process.env.VPET_CWA_KEY_FILE || path.join(os.homedir(), '.vpet', 'cwa.key');
const STATION = 'C0AI00';   // 五股
const API = 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0001-001';
const TIMEOUT_MS = 8000;

function loadKey(file = KEY_FILE) {
    try { const k = fs.readFileSync(file, 'utf8').trim(); return /^CWA-[0-9A-F-]{20,}$/i.test(k) ? k : null; }
    catch (e) { return null; }
}

/**
 * 氣象署的「天氣」文字 → 我們的天空。對不上的（-99、空字串、沒看過的字）回 null → 呼叫端退回 Open-Meteo。
 * 順序有意義：「有雷雨」同時有「雷」跟「雨」，要先判雷。
 */
function classifyText(text) {
    const t = String(text || '').trim();
    if (!t || t === '-99') return null;
    if (/雷/.test(t)) return WX.SKY.THUNDER;
    if (/大雨|豪雨/.test(t)) return WX.SKY.STORM;
    if (/雨|雪|冰雹/.test(t)) return WX.SKY.RAIN;
    if (/陰|多雲|霧|靄|霾|煙/.test(t)) return WX.SKY.CLOUDY;
    if (/晴/.test(t)) return WX.SKY.CLEAR;
    return null;
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > -90 ? n : null; };   // -99 = 沒資料
/** API 回應 → { sky, text, tempC, obsAt, station }；不完整就 null */
function parse(json) {
    const st = json && json.records && Array.isArray(json.records.Station) ? json.records.Station[0] : null;
    if (!st || !st.WeatherElement) return null;
    const text = st.WeatherElement.Weather;
    const obsAt = Date.parse((st.ObsTime && st.ObsTime.DateTime) || '') || null;
    return { sky: classifyText(text), text: text || null, tempC: num(st.WeatherElement.AirTemperature), obsAt, station: st.StationName || null };
}

function fetchStation(key, station = STATION) {
    const url = API + '?Authorization=' + encodeURIComponent(key) + '&format=JSON&StationId=' + encodeURIComponent(station);
    return new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
            let d = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); });
            res.on('end', () => {
                if (res.statusCode !== 200) return reject(new Error('氣象署回應 ' + res.statusCode));
                let j; try { j = JSON.parse(d); } catch (e) { return reject(new Error('氣象署回傳的不是 JSON')); }
                const r = parse(j);
                if (!r) return reject(new Error('氣象署沒有這個測站的資料'));
                resolve(r);
            });
        });
        req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('氣象署沒回應')));
        req.on('error', reject);
    });
}

module.exports = { KEY_FILE, STATION, loadKey, classifyText, parse, fetchStation };
