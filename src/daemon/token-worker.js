'use strict';
// Worker thread：把「掃 JSONL 算 token」這件重活（實測 ~1.3s）搬離 daemon 主迴圈，
// 避免它阻塞每秒的 render tick 造成走路跳幀。主執行緒送 {now} → 這裡算完 postMessage 回去。
const { parentPort } = require('worker_threads');
const { computeUsage } = require('./token-source');

parentPort.on('message', (msg) => {
    try {
        const usage = computeUsage({ now: (msg && msg.now) || undefined });
        parentPort.postMessage({ ok: true, usage });
    } catch (e) {
        parentPort.postMessage({ ok: false, error: e.message });
    }
});
