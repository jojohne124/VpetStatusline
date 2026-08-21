'use strict';
/**
 * weather.js — 天氣模型（純函式，不碰網路、不碰檔案）
 *
 * 放在 shared/ 而不是 daemon/ 的理由跟 plaza-walk.js 一樣：牧場之後要長成廣場，
 * 那時候「今天什麼天氣」必須由伺服器統一發、每個 client 用同一份對照表解讀，
 * 否則同一場雨在你這邊是大雨、在別人那邊是陰天。現在先擺對位置，之後不用搬。
 *
 * ── 為什麼不是「晴／陰／雨／大雨／寒流」五選一 ────────────────────────────
 * 寒流是**氣溫**，不是天空狀態 —— 台灣冬天「寒流 + 下雨」是常態。做成五選一的話，
 * 那天只能二選一，而且之後要加「颱風」「起霧」都得回頭改結構。
 * 所以拆成 sky（天空：晴/陰/雨/大雨）+ cold（冷不冷，布林），表演可以疊。
 */

// 天空狀態。順序有意義：越後面越「糟」，前端做強度插值時可以直接比大小。
const SKY = {
    CLEAR:  'clear',    // 晴
    CLOUDY: 'cloudy',   // 陰
    RAIN:   'rain',     // 雨
    STORM:  'storm',    // 大雨
};
const SKY_ORDER = [SKY.CLEAR, SKY.CLOUDY, SKY.RAIN, SKY.STORM];

// 低於這個溫度就算「寒流」。
// 中央氣象署的寒流定義是台北測站最低溫 ≤ 10°C，但那一年只有幾天，做了幾乎看不到；
// 12°C 大約落在「強烈大陸冷氣團」，一個冬天會出現個幾次 —— 夠特別又不會永遠見不到。
const COLD_C = 12;

// WMO 天氣碼 → 天空狀態。這是 Open-Meteo 回傳的標準碼表。
// 沒列到的碼一律當陰天（見 classify）—— 寧可少演一點，也不要因為碰到沒看過的碼就爆掉。
const WMO = {
    clear:  [0, 1],
    cloudy: [2, 3, 45, 48],                                  // 多雲 / 陰 / 霧
    rain:   [51, 53, 56, 61, 66, 71, 73, 80, 85],            // 毛毛雨 / 小雨 / 雪 / 陣雨
    storm:  [55, 57, 63, 65, 67, 75, 77, 81, 82, 86, 95, 96, 99],
};
const CODE_TO_SKY = (() => {
    const m = new Map();
    for (const sky of SKY_ORDER) for (const c of WMO[sky]) m.set(c, sky);
    return m;
})();

/**
 * 原始觀測 → 天氣狀態。
 * @param {number|null} code  WMO 天氣碼
 * @param {number|null} tempC 攝氏氣溫
 * @returns {{sky:string, cold:boolean, tempC:number|null, code:number|null}}
 */
function classify(code, tempC, opts = {}) {
    const coldBelow = opts.coldBelowC == null ? COLD_C : opts.coldBelowC;
    const c = Number.isFinite(code) ? Math.round(code) : null;
    const t = Number.isFinite(tempC) ? tempC : null;
    return {
        sky:   c == null ? SKY.CLEAR : (CODE_TO_SKY.get(c) || SKY.CLOUDY),
        cold:  t != null && t <= coldBelow,
        tempC: t,
        code:  c,
    };
}

const SKY_LABEL = {
    [SKY.CLEAR]:  { label: '晴',   icon: '☀' },
    [SKY.CLOUDY]: { label: '陰',   icon: '☁' },
    [SKY.RAIN]:   { label: '雨',   icon: '🌧' },
    [SKY.STORM]:  { label: '大雨', icon: '⛈' },
};

/** 給右上角那一行用的文字。寒流是**加註**在天空狀態後面，不是取代它。 */
function describe(w) {
    const base = SKY_LABEL[w && w.sky] || SKY_LABEL[SKY.CLEAR];
    const cold = !!(w && w.cold);
    return {
        icon:  cold ? '🥶' : base.icon,     // 冷的時候氣溫才是主角，圖示讓給它
        label: cold ? base.label + '・寒流' : base.label,
        temp:  w && w.tempC != null ? Math.round(w.tempC) + '°C' : '',
    };
}

// ── 為什麼沒有色調層 ─────────────────────────────────────────────────
// 第一版做過：在 dot 緩衝上依天氣調明暗冷暖，讓陽光照在怪身上、寒流把怪凍得發青。
// 實際看過之後拿掉了 —— 角色的點陣圖只有 16x16、顏色本來就少，一染就分不出誰是誰，
// 而且「我的亞古獸今天是藍的」比氣氛加分更讓人困惑。天氣只做加在畫面上的粒子，
// 不動角色本身的顏色。
//
// 連帶結論：這個模組現在是純粹的「天氣是什麼」，不含任何繪圖。畫面全在前端。

module.exports = {
    SKY, SKY_ORDER, COLD_C, WMO,
    classify, describe, SKY_LABEL,
};
