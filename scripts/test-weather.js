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
eq(WX.classify(95, 25).sky, WX.SKY.STORM,  '碼 95（雷雨）應為大雨');
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
    const w = SRC.parse({ current: { weather_code: 61, temperature_2m: 9.2 } }, cfg);
    ok(w.sky === WX.SKY.RAIN && w.cold === true, 'Open-Meteo 回應應解析成雨＋寒流');
    eq(w.city, '台北', '城市應沿用設定');
    ok(w.at > 0, '應蓋上取得時間');
    // 回應形狀跑掉（API 改版、被 proxy 換成錯誤頁）也不能 throw
    ok(SRC.parse({}, cfg).sky === WX.SKY.CLEAR, '空回應應退回晴天');
    ok(SRC.parse(null, cfg).sky === WX.SKY.CLEAR, 'null 回應應退回晴天');
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
    ok(src.get() === w, '關掉連線時 get() 不該每次產生新物件（等於在背景亂抓）');
    eq(src.cfg.city, '離線', 'weather.json 應覆寫預設值');
    ok(SRC.loadConfig(fsp.join(dir, 'nope')).city === '台北', '沒有設定檔應退回台北');
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n結果：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
