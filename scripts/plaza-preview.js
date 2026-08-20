#!/usr/bin/env node
'use strict';
/**
 * plaza-preview.js — 廣場的離線預覽（不需要後端、不改任何 state）
 *
 * 存在的理由：廣場第一期真正要驗的只有兩件事 —— 多人走動看起來對不對、
 * y 排序的畫面好不好看（docs/plaza-spec.md §一）。這兩件事跟後端、跟「不在家」
 * 狀態、跟 daemon 整合全都無關，所以先用假名單在終端機跑起來看，
 * 比先把整套接完再看便宜太多。走路節奏（段長 / 停留權重）也預期要靠這支微調。
 *
 * 用法：
 *   node scripts/plaza-preview.js                 # 5 人，即時播放
 *   node scripts/plaza-preview.js 20              # 20 人（規格上限）
 *   node scripts/plaza-preview.js 8 --fast        # 8 倍速（快速看走位分布）
 *   node scripts/plaza-preview.js 8 --step 500    # 只印第 500 拍的靜態畫面
 *   node scripts/plaza-preview.js 8 --heat 3600   # 印 1 小時的走訪熱度圖（不畫角色）
 *
 * Ctrl-C 離開。
 *
 * 注意：core 的 ASSETS_DIR 是相對它自己的位置算的 —— repo 樹下的 src/runtime/ 沒有
 * assets/，所以優先用已安裝的那份（~/.claude/agumon-statusline）取得真實美術。
 */
const os   = require('os');
const path = require('path');

const INSTALLED = path.join(os.homedir(), '.claude', 'agumon-statusline', 'agumon-core.js');
let core;
try { core = require(INSTALLED); }
catch (e) { core = require('../src/runtime/agumon-core.js'); }

const W = require('../src/shared/plaza-walk.js');
const P = require('../src/daemon/plaza.js');

// ── 參數 ─────────────────────────────────────────────────────────────
const argv  = process.argv.slice(2);
const num   = Math.max(1, Math.min(20, parseInt(argv.find(a => /^\d+$/.test(a)) || '5', 10)));
const flag  = (name, dflt) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : dflt;
};
const fast     = argv.includes('--fast');
const oneStep  = flag('step', null);
const heatSpan = flag('heat', null);

// ── 假名單 ───────────────────────────────────────────────────────────
// 角色從 roster 隨機挑（挑不到就退回 agumon），名牌用中英混合，
// 因為名牌是文字層、中文佔兩欄，寬度處理要一起驗到。
const NAMES = ['阿張', 'MAJAJA', '小明', 'Kai', '喵喵', 'Riku', '大雄', 'Zed',
               '阿翰', 'Nova', '皮蛋', 'Ash', '小美', 'Lyn', '老王', 'Rex',
               '嘟嘟', 'Sol', '花花', 'Ivy'];

function pickChars(n) {
    let pool = [];
    try {
        const roster = require(path.join(core.ASSETS_DIR, 'roster.json'));
        pool = (roster.characters || roster.roster || Object.keys(roster))
            .map(c => (typeof c === 'string' ? c : c.id || c.name))
            .filter(Boolean);
    } catch (e) { /* 沒有 roster 就退回單一角色 */ }
    if (!pool.length) pool = ['agumon'];
    // 固定取樣（不用 Math.random）→ 每次跑同一組角色，比較得出差異
    return Array.from({ length: n }, (_, i) => pool[(i * 7 + 3) % pool.length]);
}

const chars     = pickChars(num);
const occupants = Array.from({ length: num }, (_, i) => ({
    code:      NAMES[i % NAMES.length],
    char:      chars[i],
    seed:      1000 + i * 7919,      // 質數間隔，避免相鄰 seed 走出相似路徑
    joinStep:  0,
}));

// ── 熱度圖模式：不畫角色，只統計走訪分布 ─────────────────────────────
// 用來檢查走路演算法會不會黏在角落 —— 靠肉眼看動畫看不出這種偏差。
if (heatSpan) {
    const span = parseInt(heatSpan, 10) || 3600;
    const heat = Array.from({ length: W.PLAZA_H }, () => new Array(W.PLAZA_W).fill(0));
    let stayCnt = 0, total = 0;
    for (const o of occupants) {
        let cache = null;
        for (let s = 0; s < span; s++) {
            const p = W.posAt(o, s, cache); cache = p.cache;
            heat[p.y][p.x]++;
            total++; if (!p.moving) stayCnt++;
        }
    }
    const max = Math.max(...heat.flat());
    const SHADES = ' .:-=+*#%@';
    console.log(`走訪熱度圖（${num} 人 × ${span} 拍；左上角為原點，只統計 sprite 左上角座標）`);
    for (let y = 0; y <= W.MAX_Y; y++) {
        let line = '';
        for (let x = 0; x <= W.MAX_X; x++) {
            const v = heat[y][x];
            line += v === 0 ? ' ' : SHADES[Math.min(SHADES.length - 1, Math.ceil(v / max * (SHADES.length - 1)))];
        }
        console.log(line);
    }
    console.log(`\n停留時間佔比 ${(stayCnt / total * 100).toFixed(1)}%（設計值約 12%）`);
    console.log(`最熱格 ${max} 次 / 平均 ${(total / ((W.MAX_X + 1) * (W.MAX_Y + 1))).toFixed(1)} 次`);
    process.exit(0);
}

// ── 畫面 ─────────────────────────────────────────────────────────────
const caches = new Map();

function frame(step) {
    const { lines, placed } = P.composePlaza(core, occupants, step, { caches, me: occupants[0].code });
    const moving = placed.filter(p => p.moving).length;
    const head = `廣場預覽  ${W.PLAZA_W}x${W.PLAZA_H} dot  |  ${num} 人（走動 ${moving}）  |  step ${step}（${W.STEP_MS}ms/拍）`
               + `  |  你是 \x1b[38;2;247;198;49m${occupants[0].code}\x1b[0m`;
    return [head, '─'.repeat(W.PLAZA_W), ...lines].join('\n');
}

if (oneStep) {
    console.log(frame(parseInt(oneStep, 10) || 0));
    process.exit(0);
}

// 即時播放：清畫面後重印。48 列 + 表頭，一般終端機高度不夠會滾動 ——
// 縮小字級（Ctrl+-）到看得完整為止，這是終端機預覽的先天限制，daemon 頁面沒這問題。
const TICK = fast ? Math.round(W.STEP_MS / 8) : W.STEP_MS;
let step = 0;
process.stdout.write('\x1b[?25l');                        // 藏游標
const stop = () => { process.stdout.write('\x1b[?25h\n'); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

setInterval(() => {
    process.stdout.write('\x1b[H\x1b[2J' + frame(step));
    step += fast ? 8 : 1;
}, TICK);
