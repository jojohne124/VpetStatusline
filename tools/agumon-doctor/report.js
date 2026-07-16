'use strict';
// agumon report —— 卡住時「輸出現況」給開發者診斷用（唯讀，不改任何東西）。
//
// 蒐集：安裝資訊 / 最後一次 render・hook 的時間差（判斷 Claude Code 是否還在呼叫指令）/
//       目前 agumon 行程與 pids 登記 / state 關鍵旗標 / settings 的 statusLine 設定 /
//       執行環境（node・OS・記憶體）。全部寫成一份純文字檔並印在畫面，方便貼回來。
//
// 用法：雙擊 agumon-report.bat / .command，或 `node report.js`。

const fs   = require('fs');
const os   = require('os');
const path = require('path');
let scanAgumonNodes = null;
try { ({ scanAgumonNodes } = require('./doctor')); } catch (e) {}

const INSTALL_ROOT = process.env.AGUMON_HOME || path.join(os.homedir(), '.claude', 'agumon-statusline');
const STATE_DIR    = path.join(INSTALL_ROOT, 'state');
const PIDS_DIR     = path.join(STATE_DIR, 'pids');
const CLAUDE_HOME  = path.join(os.homedir(), '.claude');

const now = Date.now();
const L = [];
const p = s => { L.push(s); };
const ago = ms => (ms == null || isNaN(ms)) ? '?' : `${Math.round((now - ms) / 1000)}s 前`;
function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function fileInfo(f) {
    try { const s = fs.statSync(f); return { exists: true, size: s.size, mtime: s.mtimeMs }; }
    catch (e) { return { exists: false }; }
}

p('==================== agumon report ====================');
p('產生時間：' + new Date(now).toString());
p('安裝目錄：' + INSTALL_ROOT + (fs.existsSync(INSTALL_ROOT) ? '' : '  ⚠️ 不存在'));
p('release 標記：' + (fs.existsSync(path.join(INSTALL_ROOT, 'RELEASE')) ? '有（release 版）' : '無（dev 版）'));

// ── 最關鍵：距離「上一次 render / hook」多久 → 判斷 Claude Code 還有沒有在呼叫指令 ──
p('\n--- 最後執行訊號（判斷 statusline 指令是否還被呼叫）---');
const stFile = path.join(STATE_DIR, 'color-state.json');
const fi = fileInfo(stFile);
if (fi.exists) {
    p('color-state.json 最後寫入：' + ago(fi.mtime) + `（每次 render 都會寫；若很久 = Claude Code 已停止呼叫指令）`);
    const st = readJSON(stFile) || {};
    const lastStepMs = typeof st.lastStepSeen === 'number' ? st.lastStepSeen * 1000 : null;
    p('lastStepSeen（上次 render）：' + ago(lastStepMs));
    p('lastActivityAt：' + ago(st.lastActivityAt));
    p('lastHookTs（上次送訊息 hook）：' + ago(st.lastHookTs));
    p('\n--- state 關鍵旗標 ---');
    p('characterId：' + st.characterId);
    const flags = ['battleStartStep', 'evoStartStep', 'dropStartStep', 'cardStartStep', 'treeStartStep',
        'roarStartStep', 'exprStartStep', '_forceSleep', '_freezeEvolve', '_noAutoBattle', 'wasSleeping',
        'battleTotalCount', 'battleWinCount', 'trainingBonus'];
    p(flags.map(k => `${k}=${JSON.stringify(st[k])}`).join('  '));
} else {
    p('⚠️ 找不到 color-state.json（' + stFile + '）');
}
const hookFi = fileInfo(path.join(STATE_DIR, 'hook.json'));
p('hook.json 最後寫入：' + (hookFi.exists ? ago(hookFi.mtime) : '無檔') + '  內容=' + JSON.stringify(readJSON(path.join(STATE_DIR, 'hook.json'))));
const corrupt = fileInfo(path.join(STATE_DIR, 'color-state.json.corrupt.log'));
p('corrupt.log：' + (corrupt.exists ? `${corrupt.size}B，最後寫 ${ago(corrupt.mtime)}（render 崩潰才會寫）` : '無（無崩潰紀錄）'));

// ── 目前 agumon 行程 + pids 登記 ──
p('\n--- 目前 agumon node 行程 ---');
if (scanAgumonNodes) {
    const procs = scanAgumonNodes();
    if (procs === null) p('⚠️ 無法掃描行程（權限/逾時）');
    else if (!procs.length) p('0 個（此刻沒有 statusline/hook 在跑——正常 render 只活 1~3 秒，屬正常；但若畫面凍住又長期 0 個，通常代表 Claude Code 沒在呼叫指令）');
    else procs.forEach(x => p(`  pid ${x.pid}  ${x.kind}  齡 ${x.ageSec}s  執行緒 ${x.threads}`));
} else p('（doctor.js 掃描模組載入失敗，略過）');
let pidFiles = [];
try { pidFiles = fs.readdirSync(PIDS_DIR); } catch (e) {}
p('pids/ 登記檔 ' + pidFiles.length + ' 個' + (pidFiles.length ? '：' + pidFiles.map(f => {
    const ts = parseInt((() => { try { return fs.readFileSync(path.join(PIDS_DIR, f), 'utf8'); } catch (e) { return '0'; } })(), 10);
    return `${f}(${ago(ts)})`;
}).join(' ') : ''));

// ── settings.json 的 statusLine 設定 ──
p('\n--- settings.json statusLine / hook ---');
const settings = readJSON(path.join(CLAUDE_HOME, 'settings.json'));
if (settings) {
    p('statusLine：' + JSON.stringify(settings.statusLine));
    const cmd = settings.statusLine && settings.statusLine.command;
    if (cmd) p('  指令是否指向本安裝：' + (cmd.includes('agumon-statusline') ? '是' : '⚠️ 否，路徑可能不對'));
    const up = settings.hooks && settings.hooks.UserPromptSubmit;
    p('UserPromptSubmit hook：' + (up ? JSON.stringify(up).includes('agumon-hook') ? '有掛 agumon-hook' : '有 hook 但非 agumon' : '無'));
} else p('⚠️ 讀不到 settings.json');

// ── 執行環境 ──
p('\n--- 執行環境 ---');
p(`node ${process.version}  platform=${process.platform}  os=${os.release()}`);
const totMB = Math.round(os.totalmem() / 1048576), freeMB = Math.round(os.freemem() / 1048576);
p(`記憶體：free ${freeMB}MB / total ${totMB}MB（free 很低 = 記憶體壓力，可能讓 render 被換頁凍住）`);
p(`CPU ${os.cpus().length} 核  系統 uptime ${Math.round(os.uptime() / 3600)}h`);
p('=======================================================');

const text = L.join('\n');
console.log(text);
const outFile = path.join(os.homedir(), 'agumon-report.txt');
try { fs.writeFileSync(outFile, text); console.log('\n📄 已存到：' + outFile + '\n請把這個檔（或上面整段文字）貼回給開發者。'); }
catch (e) { console.log('\n（寫檔失敗：' + e.message + '，請直接複製上面文字）'); }
