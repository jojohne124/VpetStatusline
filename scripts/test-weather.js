#!/usr/bin/env node
'use strict';
/**
 * test-weather.js — 天氣模型 + 天氣來源
 *
 * 這裡**不打真的網路**。要驗的是「拿到資料之後怎麼解讀」和「拿不到時會不會壞」，
 * 那兩件事都跟 Open-Meteo 今天下不下雨無關 —— 綁真連線只會讓測試在斷網／擋 proxy
 * 的機器上紅掉，然後大家開始習慣性忽略它。
 */
const WX  = require('../src/shared/weather.js');
const SRC = require('../src/daemon/weather-source.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（得到 ${JSON.stringify(a)}）`);

console.log('— WMO 對照 —');
eq(WX.classify(0,  25).sky, WX.SKY.CLEAR,  '碼 0 應為晴');
eq(WX.classify(1,  25).sky, WX.SKY.CLEAR,  '碼 1 應為晴');
eq(WX.classify(3,  25).sky, WX.SKY.CLOUDY, '碼 3（陰）應為陰');
eq(WX.classify(45, 25).sky, WX.SKY.CLOUDY, '碼 45（霧）歸到陰');
eq(WX.classify(61, 25).sky, WX.SKY.RAIN,   '碼 61（小雨）應為雨');
eq(WX.classify(65, 25).sky, WX.SKY.STORM,  '碼 65（大雨）應為大雨');
eq(WX.classify(82, 25).sky, WX.SKY.STORM,  '碼 82（強陣雨）應為大雨');
eq(WX.classify(95, 25).sky, WX.SKY.THUNDER, '碼 95（雷雨）應為雷雨');
eq(WX.classify(99, 25).sky, WX.SKY.THUNDER, '碼 99（強雷雨）應為雷雨');
// 雷雨是第五個天空狀態，不是旗標：打雷一定伴隨下雨，跟雨是同一個軸上更嚴重的一格。
// 寒流不一樣（晴天也會冷），所以那個才是旗標。
ok(WX.SKY_ORDER[WX.SKY_ORDER.length - 1] === WX.SKY.THUNDER, '雷雨應排在嚴重度階梯最後');
{
    const seen = new Set();
    for (const sky of WX.SKY_ORDER) for (const c of WX.WMO[sky]) {
        ok(!seen.has(c), `WMO 碼 ${c} 被分到兩個天空狀態`);
        seen.add(c);
    }
    ok(WX.SKY_ORDER.every(s => WX.SKY_LABEL[s]), '有天空狀態少了顯示文字');
}
// 沒看過的碼不能爆 —— WMO 之後加碼、或 API 回了奇怪的值，寧可少演也不要壞掉
eq(WX.classify(999, 25).sky, WX.SKY.CLOUDY, '未知碼應退回陰天');
eq(WX.classify(null, null).sky, WX.SKY.CLEAR, '沒有資料應退回晴天');

console.log('— 寒流是獨立旗標 —');
ok(WX.classify(0, 8).cold === true,   '8°C 應判定寒流');
ok(WX.classify(0, 25).cold === false, '25°C 不該是寒流');
ok(WX.classify(0, null).cold === false, '沒有溫度時不該亂判寒流');
// 這是拆成 sky + cold 而不是五選一的全部理由：台灣冬天很常同時發生
const both = WX.classify(65, 9);
ok(both.sky === WX.SKY.STORM && both.cold === true, '大雨與寒流必須能同時成立');
ok(WX.classify(0, 8,  { coldBelowC: 5 }).cold === false, 'coldBelowC 應可覆寫');

console.log('— 顯示文字 —');
eq(WX.describe(WX.classify(3, 20)).label, '陰', '陰天標籤');
eq(WX.describe(WX.classify(3, 8)).label, '陰・寒流', '寒流是加註不是取代');
eq(WX.describe(WX.classify(95, 8)).label, '雷雨・寒流', '雷雨與寒流要能同時成立');
// ⛈ 讓給雷雨（它才是「有閃電的雨」），大雨改用 ☔ —— 兩者不可以同圖示

// 每個圖示都必須接 U+FE0F（VS16）。少了它，Emoji_Presentation=No 的碼點會用**文字呈現**
// ＝黑白線稿，而看板字型是 ui-monospace 更會往文字那邊倒。
// 實際發生過：大雨 ☔(2614, Yes) 是彩色的、雷雨 ⛈(26C8, No) 是黑白的，看起來毫無道理。
{
    const icons = [...Object.values(WX.SKY_LABEL).map(v => v.icon),
                   WX.describe({ sky: WX.SKY.CLEAR, cold: true }).icon];
    for (const i of icons)
        ok(i.endsWith('️'),
           `圖示 ${JSON.stringify(i)} 少了 VS16，會被畫成黑白線稿`);
}
ok(WX.SKY_LABEL[WX.SKY.STORM].icon !== WX.SKY_LABEL[WX.SKY.THUNDER].icon,
   '大雨與雷雨用了同一個圖示，看板上分不出來');
eq(WX.describe(WX.classify(3, 20.4)).temp, '20°C', '溫度四捨五入');
eq(WX.describe(WX.classify(3, null)).temp, '', '沒有溫度就給空字串，不要顯示假數字');
ok(WX.describe(null).label === '晴', 'describe(null) 不該爆');

// 色調層已移除：做過「依天氣把角色調色」，實際看了拿掉 —— 16x16 的點陣圖顏色本來
// 就少，一染就分不出誰是誰。這個模組現在不含任何繪圖，畫面全在前端。
console.log('— 不含繪圖 —');
ok(WX.tintDots === undefined, 'tintDots 應已移除（角色不隨天氣變色）');
ok(WX.GRADE === undefined,    'GRADE 應已移除');

console.log('— 來源解析 —');
{
    const cfg = { ...SRC.DEFAULTS };
    // parse 只留**原始觀測**，不做判定 —— 快取存判定的話，改了對照表就要等 30 分鐘
    // 才生效，而且快取會落地、重開也救不回來。真的踩過（見下一段）。
    const raw = SRC.parse({ current: { weather_code: 61, temperature_2m: 9.2 } });
    eq(raw.code, 61, 'parse 應保留原始 WMO 碼');
    eq(raw.tempC, 9.2, 'parse 應保留原始氣溫');
    ok(raw.at > 0, '應蓋上取得時間');
    ok(raw.sky === undefined, 'parse 不該做判定（那是 view 的事）');

    const w = SRC.view(raw, cfg);
    ok(w.sky === WX.SKY.RAIN && w.cold === true, '原始觀測應判定成雨＋寒流');
    eq(w.city, '台北', '城市應沿用設定');

    // 回應形狀跑掉（API 改版、被 proxy 換成錯誤頁）也不能 throw
    ok(SRC.view(SRC.parse({}), cfg).sky === WX.SKY.CLEAR, '空回應應退回晴天');
    ok(SRC.view(SRC.parse(null), cfg).sky === WX.SKY.CLEAR, 'null 回應應退回晴天');

    // ⚠️ 這條是本體：同一份觀測，換了設定就要立刻換答案。
    // 存判定的版本會在這裡失敗 —— 而症狀是「程式改了、畫面沒變」，最難查。
    ok(SRC.view(raw, { ...cfg, coldBelowC: 5 }).cold === false,
       '改了 coldBelowC，同一份觀測應立刻重新判定');
    ok(SRC.view({ code: 95, tempC: 27, at: Date.now() }, cfg).sky === WX.SKY.THUNDER,
       'WMO 95 應判成雷雨（改對照表時舊快取不可以卡住舊答案）');
}

console.log('— 快取存的是觀測不是判定 —');
{
    const os = require('os'), fsp = require('path'), fs = require('fs');
    const dir = fs.mkdtempSync(fsp.join(os.tmpdir(), 'wx2-'));
    const state = fsp.join(dir, 'state');
    fs.mkdirSync(state, { recursive: true });
    // 模擬「加雷雨之前」寫下的舊快取：判定是 storm，但原始碼是 95
    fs.writeFileSync(fsp.join(state, 'weather-cache.json'),
        JSON.stringify({ sky: 'storm', cold: false, tempC: 27.1, code: 95, at: Date.now() }));
    fs.writeFileSync(fsp.join(dir, 'weather.json'), JSON.stringify({ enabled: false, city: '五股' }));
    const src = SRC.create({ installRoot: dir, stateDir: state });
    eq(src.get().sky, WX.SKY.THUNDER,
       '舊快取應該用新的對照表重新判定（存判定的話會卡在 storm 直到下次抓取）');
    ok(src.get().stale !== true, '有效的快取不該被標成 stale');
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log('— 離線行為 —');
{
    const os = require('os'), fsp = require('path'), fs = require('fs');
    const dir = fs.mkdtempSync(fsp.join(os.tmpdir(), 'wx-'));
    // enabled:false = 完全不連網。天氣是裝飾，必須能整個關掉。
    fs.writeFileSync(fsp.join(dir, 'weather.json'), JSON.stringify({ enabled: false, city: '離線' }));
    const src = SRC.create({ installRoot: dir, stateDir: fsp.join(dir, 'state') });
    const w = src.get();
    ok(w.sky === WX.SKY.CLEAR, '關掉連線時應給晴天');
    ok(w.stale === true, '關掉連線時應標記 stale，讓前端知道這是猜的');
    // 舊版這裡驗的是「同一個物件」（identity）。get() 現在每次都用原始觀測重新判定，
    // 本來就會回新物件 —— 用 identity 當代理已經不對了。真正要驗的是**內容不變**、
    // 而且沒有偷偷去抓網路（raw 的時戳一直是 0）。
    eq(src.get(), w, '關掉連線時 get() 的內容不該變動');
    ok(src.raw().at === 0, '關掉連線時不該有任何抓取發生');
    eq(src.cfg.city, '離線', 'weather.json 應覆寫預設值');
    ok(SRC.loadConfig(fsp.join(dir, 'nope')).city === '台北', '沒有設定檔應退回台北');
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n結果：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
