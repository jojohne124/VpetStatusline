#!/usr/bin/env node
'use strict';
/**
 * 驗證廣場的走路演算法與合成器。
 *
 * 這裡驗的是「所有人看到同一畫面」這條**整個廣場設計賴以成立的性質**
 * （docs/plaza-spec.md §二）—— 伺服器只存名單、不推進位置，所以只要任何一個
 * client 算出不同的結果，畫面就會分歧，而且分歧會隨時間累積、無法自我修正。
 * 光靠肉眼看動畫看不出來，只能用測試守住。
 *
 * 用法：node scripts/test-plaza.js
 *
 * 注意：合成需要真實美術 → 優先用已安裝的那份（~/.claude/agumon-statusline）；
 * 沒安裝就跳過需要資產的幾節（不算失敗），純演算法的部分照跑。
 */
const os   = require('os');
const path = require('path');

const W = require('../src/shared/plaza-walk.js');
const P = require('../src/daemon/plaza.js');

let core = null;
try { core = require(path.join(os.homedir(), '.claude', 'agumon-statusline', 'agumon-core.js')); }
catch (e) { try { core = require('../src/runtime/agumon-core.js'); } catch (e2) {} }
const hasArt = (() => { try { return !!P.loadArt(core, 'agumon'); } catch (e) { return false; } })();

let pass = 0, fail = 0, skip = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };

// ── 1. 走路：決定性 ───────────────────────────────────────────────────
console.log('— 走路決定性 —');
{
    const occ = { seed: 123456, joinStep: 0 };
    let cache = null, bad = 0;
    for (let s = 0; s <= 3000; s++) {
        const a = W.posAt(occ, s, cache); cache = a.cache;
        const b = W.posAt(occ, s, null);              // 冷啟動重播
        if (a.x !== b.x || a.y !== b.y || a.facing !== b.facing) bad++;
    }
    ok(bad === 0, `有快取與冷啟動重播結果不一致（${bad} 拍）`);

    // 中途才開視窗的 client 必須追得上（快取從任意時間點建立都要對）
    let mid = null, bad2 = 0;
    for (let s = 500; s <= 1500; s++) {
        const a = W.posAt(occ, s, mid); mid = a.cache;
        const b = W.posAt(occ, s, null);
        if (a.x !== b.x || a.y !== b.y) bad2++;
    }
    ok(bad2 === 0, `中途加入的 client 與重播不一致（${bad2} 拍）`);
}

// ── 2. 走路：永不出界 ─────────────────────────────────────────────────
console.log('— 邊界 —');
{
    let oob = 0;
    for (let seed = 1; seed <= 60; seed++) {
        let c = null;
        for (let s = 0; s < 1200; s++) {
            const p = W.posAt({ seed, joinStep: 0 }, s, c); c = p.cache;
            if (p.x < 0 || p.x > W.MAX_X || p.y < 0 || p.y > W.MAX_Y) oob++;
        }
    }
    ok(oob === 0, `走出場地邊界 ${oob} 次`);
}

// ── 3. 走路：起點分散 + 會走遍場地 ────────────────────────────────────
console.log('— 分布 —');
{
    const starts = new Set();
    for (let seed = 1; seed <= 20; seed++) {
        const s0 = W.startPos(seed);
        starts.add(s0.x + ',' + s0.y);
    }
    ok(starts.size === 20, `20 個 seed 只產生 ${starts.size} 個相異起點（會疊在一起）`);

    // 單一角色一小時內應該走訪夠多格子 —— 卡在角落是走路演算法最容易出的錯，
    // 而那種錯用肉眼看幾十秒的動畫看不出來。
    const seen = new Set();
    let c = null, stay = 0;
    for (let s = 0; s < 3600; s++) {
        const p = W.posAt({ seed: 7, joinStep: 0 }, s, c); c = p.cache;
        seen.add(p.x + ',' + p.y);
        if (!p.moving) stay++;
    }
    ok(seen.size > 200, `一小時只走訪 ${seen.size} 格（疑似卡住）`);
    const stayPct = stay / 3600 * 100;
    // 設計值 1/3；撞牆也算停所以實際偏高，但不該高到「幾乎不動」
    ok(stayPct > 20 && stayPct < 55, `停留比例 ${stayPct.toFixed(1)}% 落在合理區間外`);
}

// ── 4. 走路：面向只在左右移動時改變 ───────────────────────────────────
console.log('— 面向 —');
{
    // 只有左右兩種幀（美術限制）：上/下/停一律維持前一個面向。
    // 注意「開始走的那一拍」就會轉身 —— 那一拍 x 還沒動，但方向已經定了，
    // 先轉身再邁步才是對的，所以判準是「這次決策的方向」而不是「x 有沒有變」。
    let bad = 0, c = null, prev = null;
    const seed = 99;
    for (let s = 0; s < 3000; s++) {
        const p = W.posAt({ seed, joinStep: 0 }, s, c); c = p.cache;
        if (prev && p.facing !== prev.facing) {
            const [dx] = W.dirAt(seed, p.k);
            if (dx === 0) bad++;              // 這次決策是上/下/停，卻翻了面
        }
        prev = p;
    }
    ok(bad === 0, `上/下/停的決策卻改變面向 ${bad} 次`);

    // 反過來也要成立：往左走時必定 facing=left
    let wrong = 0; c = null;
    for (let s = 0; s < 3000; s++) {
        const p = W.posAt({ seed, joinStep: 0 }, s, c); c = p.cache;
        const [dx] = W.dirAt(seed, p.k);
        if (p.moving && dx < 0 && p.facing !== 'left')  wrong++;
        if (p.moving && dx > 0 && p.facing !== 'right') wrong++;
    }
    ok(wrong === 0, `移動方向與面向不符 ${wrong} 次`);
}

// ── 5. 合成：尺寸、y 排序、跨 client 一致 ─────────────────────────────
console.log('— 合成 —');
if (!hasArt) { skip++; console.log('  – 讀不到角色美術，跳過'); }
else {
    const occ = Array.from({ length: 12 }, (_, i) => ({
        code: 'P' + i, char: 'agumon', seed: 1000 + i * 7919, joinStep: 0,
    }));

    const r = P.composePlaza(core, occ, 300, { caches: new Map() });
    ok(r.lines.length === W.PLAZA_H / 2, `列數應為 ${W.PLAZA_H / 2}，實際 ${r.lines.length}`);
    const cols = r.lines[0].replace(/\x1b\[[0-9;]*m/g, '').length;
    ok(cols === W.PLAZA_W, `欄數應為 ${W.PLAZA_W}，實際 ${cols}`);

    const ys = r.placed.map(p => p.y);
    ok(ys.every((v, i) => i === 0 || v >= ys[i - 1]), 'placed 未依 y 由小到大排序（後畫的要蓋在前面）');

    // 長跑 client vs 冷啟動 client：畫面必須逐字元相同
    const warm = new Map(); const diff = [];
    for (let s = 0; s <= 600; s++) {
        const a = P.composePlaza(core, occ, s, { caches: warm });
        if (s % 137 === 0) {
            const b = P.composePlaza(core, occ, s, { caches: new Map() });
            if (JSON.stringify(a.lines) !== JSON.stringify(b.lines)) diff.push(s);
        }
    }
    ok(diff.length === 0, `長跑 client 與新開 client 畫面不一致於 step ${diff.join(',')}`);

    // 名單順序不該影響畫面（不同 client 拿到的名單順序可能不同）
    const a = P.composePlaza(core, occ, 400, { caches: new Map() });
    const b = P.composePlaza(core, [...occ].reverse(), 400, { caches: new Map() });
    ok(JSON.stringify(a.lines) === JSON.stringify(b.lines), '名單順序改變會讓畫面不同（疊圖順序沒定死）');
}

// ── 6. 合成：本機沒有的角色要退成黑影，不能整個掛掉 ───────────────────
console.log('— 未知角色 fallback —');
if (!hasArt) { skip++; console.log('  – 讀不到角色美術，跳過'); }
else {
    let r = null;
    try {
        r = P.composePlaza(core, [{ code: 'X', char: '__不存在的角色__', seed: 5, joinStep: 0 }],
                           100, { caches: new Map() });
    } catch (e) { /* r 留 null */ }
    ok(r && r.lines.length === W.PLAZA_H / 2, '未知角色讓合成整個失敗（應退成黑影 fallback）');
    const painted = r && r.lines.some(l => l.includes('▀') || l.includes('▄'));
    ok(painted, '未知角色什麼都沒畫出來（黑影 fallback 沒生效）');
}

// ── 7. dot ↔ cell 來回轉換不失真 ──────────────────────────────────────
console.log('— dot/cell 轉換 —');
{
    const rows = [
        [[1, 2, 3, 4, 5, 6], null, [-1, -1, -1, 7, 8, 9]],
        [[10, 11, 12, -1, -1, -1], [13, 14, 15, 16, 17, 18], null],
    ];
    const back = P.dotsToCells(P.cellsToDots(rows), 3);
    ok(JSON.stringify(back) === JSON.stringify(rows), 'cell → dot → cell 來回不等於原值');
}

console.log(`\n結果：${pass} passed, ${fail} failed` + (skip ? `, ${skip} skipped` : ''));
process.exit(fail ? 1 : 0);
