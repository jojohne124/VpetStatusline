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
            if (p.x < W.MIN_X || p.x > W.MAX_X || p.y < W.MIN_Y || p.y > W.MAX_Y) oob++;
        }
    }
    ok(oob === 0, `走出場地邊界 ${oob} 次（y 下限是 MIN_Y=${W.MIN_Y}，頂端要留給名牌）`);
}

// ── 2z. 長時間開機不可以定格 ───────────────────────
// 回報過「牧場的腳色不會移動了」。真因是 MAX_REPLAY 本來寫成
//   target = min(MAX_REPLAY, step - joinStep)
// —— 限制的是【目標拍數】而不是【重播距離】。超過之後 target 不再成長，
// 全場永遠定格而 tick 照跳。院子的 joinStep 是「daemon 這次啟動的時間」，
// daemon 一開就是好幾天，所以這不是理論上碰得到，是必然會碰：
// 實際在開機 63.7 小時（> 41.7h = MAX_REPLAY x STEP_MS）後全員卡住。
{
    const F = W.YARD_FIELD, seed = 646533808;
    const beyond = W.MAX_REPLAY + 1;
    // 有快取就不受上限影響——daemon 輪詢走的就是這條路徑。
    let c = null, prev = null, moves = 0;
    for (let t = beyond; t < beyond + 400; t++) {
        const q = W.posAt({ seed, joinStep: 0 }, t, c, F); c = q.cache;
        if (prev && (q.x !== prev.x || q.y !== prev.y)) moves++;
        prev = q;
    }
    ok(moves > 300, `超過 MAX_REPLAY 之後就不走了（400 拍只動了 ${moves} 拍）`);

    // 冷啟動（沒快取）超過上限 = 「這隻現在才進場」：位置合法、且不重播。
    const cold = W.posAt({ seed, joinStep: 0 }, 2383378291, null, F);
    ok(cold.x >= F.minX && cold.x <= F.maxX && cold.y >= F.minY && cold.y <= F.maxY,
       '冷啟動超過上限時位置跑出場地');
    const t0 = process.hrtime.bigint();
    W.posAt({ seed, joinStep: 0 }, 2383378291, null, F);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    // joinStep 傳錯（實際踩過：yard 把 joinStep 寫死 0，step 是牌鐘的 24 億）
    // 不可以把同步的 event loop 卡死。
    ok(ms < 50, `joinStep 傳錯時 posAt 花了 ${ms.toFixed(1)}ms，會拖垮 daemon`);

    // 上限之內的行為不能變（廣場的 joinStep 是伺服器發的，永遠在射程內）
    ok(W.posAt({ seed, joinStep: 0 }, 50, null, F).x === 31,
       '上限之內的走位被改掉了（決定性必須維持）');
}

// ── 2a. 貼牆的時候不可以在原地抖 ─────────────────────────────────────
// 回報過「牧場滿有機會卡在邊界」。真因是「幾乎與牆平行、但帶一點朝外分量」的方向
// 會被截成 1~2 拍，角色每一兩拍就重抽方向，看起來像在原地抖。
// 牧場場地小（可走範圍只有 37x25），這件事特別明顯。
{
    for (const [nm, F] of [['廣場', W.PLAZA_FIELD], ['牧場', W.YARD_FIELD]]) {
        let shortest = Infinity, legs = 0;
        const heat = new Map();
        let tot = 0;
        for (let seed = 1; seed <= 24; seed++) {
            let st = { ...W.startPos(seed, F), k: 0 };
            for (let i = 0; i < 400; i++) {
                const leg = W.legAt(seed, st.k, st.x, st.y, F);
                if (!leg.stay) { shortest = Math.min(shortest, leg.len); legs++; }
                const [ox, oy] = W.offsetAt(leg.vx, leg.vy, leg.len);
                st.x += ox; st.y += oy; st.k += 1;
            }
            let c = null;
            for (let s = 0; s < 3000; s++) {
                const p = W.posAt({ seed, joinStep: 0 }, s, c, F); c = p.cache;
                const k = p.x + ',' + p.y;
                heat.set(k, (heat.get(k) || 0) + 1); tot++;
            }
        }
        ok(shortest >= W.MIN_LEG,
           `${nm}：最短的移動段只有 ${shortest} 拍（應 >= MIN_LEG=${W.MIN_LEG}，否則貼牆時會抖）`);
        // 集中度。門檻是量出來的，不是憑感覺挑：
        //   一開始 廣場 4.8 / 牧場 4.3 倍
        //   → 加了 MIN_LEG（貼牆不再原地抖）廣場 4.0 / 牧場 3.3
        //   → 加了「撞牆一定往離開牆的方向走」廣場 2.6 / 牧場 2.0
        // 抓在 3.5 擋得住退回前兩版。哪天這條紅了，先確認是真的變差，
        // 而不是換了場地尺寸或方向表之後的正常抖動。
        const cells = (F.maxX - F.minX + 1) * (F.maxY - F.minY + 1);
        const hottest = Math.max(...heat.values()) / tot;
        ok(hottest < 3.5 / cells,
           `${nm}：最熱的一格是平均值的 ${(hottest * cells).toFixed(1)} 倍（應 < 3.5 倍）`);

        // 撞牆就往外走：不沿著牆滑、也不在牆邊發呆。
        // 「卡在邊界」的體感主要來自這兩件事，光看最熱格看不出來。
        let edge = 0, stayOnEdge = 0, n2 = 0;
        for (let seed = 1; seed <= 24; seed++) {
            let c = null;
            for (let s2 = 0; s2 < 3000; s2++) {
                const q = W.posAt({ seed, joinStep: 0 }, s2, c, F); c = q.cache;
                const onEdge = q.x <= F.minX || q.x >= F.maxX || q.y <= F.minY || q.y >= F.maxY;
                n2++; if (onEdge) edge++;
                if (onEdge && !q.moving) stayOnEdge++;
            }
        }
        ok(stayOnEdge === 0,
           `${nm}：有 ${stayOnEdge} 拍站在牆邊發呆（貼牆時不該抽到「停」）`);
        // 均勻分布下貼邊本來就有 8.8%（廣場）/ 13%（牧場）——
        // 現在遠低於那個值，因為角色一碰到牆就往裡面走。
        ok(edge / n2 < 0.08,
           `${nm}：貼邊時間 ${(edge / n2 * 100).toFixed(1)}%（撞牆應該立刻離開，實測約 3~5%）`);
    }
}

// ── 2b. 場地常數本身要自洽 ───────────────────────────────────────────
console.log('— 場地常數 —');
{
    ok(W.PLAZA_H % 2 === 0, `PLAZA_H ${W.PLAZA_H} 必須是偶數（1 cell = 2 dot）`);
    ok(W.MAX_X > 0 && W.MAX_Y > 0, `場地放不下一隻 ${W.SPRITE}x${W.SPRITE} 的角色`);
    // v3 的段長會截短到牆邊，所以不再有「最長段 <= 場地」的隱形限制；
    // 但至少要走得動一步，否則 legAt 會退化成永遠在停。
    ok(W.RUN_MIN >= 1 && W.RUN_MAX >= W.RUN_MIN, 'RUN_MIN/RUN_MAX 設定不合理');
    // 方向向量必須互質（不互質 = 重複角度，白佔權重）
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const bad = W.DIR_VECTORS.filter(([a, b]) => gcd(Math.abs(a), Math.abs(b)) !== 1);
    ok(bad.length === 0, `方向向量有 ${bad.length} 個不互質（重複角度）`);
    ok(W.DIR_VECTORS.length >= 16, `方向只有 ${W.DIR_VECTORS.length} 種，軌跡會太規律`);
    // 名牌固定標在腳下，所以底部一定要留得下一列，否則最底的角色名牌會掉到畫面外
    ok(W.MAX_Y + W.SPRITE + W.LABEL_RESERVE <= W.PLAZA_H,
       `底部沒留下名牌的位置（MAX_Y=${W.MAX_Y} + 角色 ${W.SPRITE} + 保留 ${W.LABEL_RESERVE} > ${W.PLAZA_H}）`);
    ok(W.MAX_Y > W.MIN_Y, `扣掉名牌保留區後沒有可走空間`);
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
    const area = (W.MAX_X - W.MIN_X + 1) * (W.MAX_Y - W.MIN_Y + 1);
    ok(seen.size > area * 0.4, `一小時只走訪 ${seen.size} / ${area} 格（疑似卡住或活動範圍太小）`);
    const stayPct = stay / 3600 * 100;
    // 設計值約 12%（見 plaza-walk.js STAY_CHANCE 附近的算式）。
    // 太高 = 一群角色在發呆（v1 的 37% 就是這樣）；太低 = 從不休息，也不自然。
    ok(stayPct > 6 && stayPct < 20, `停留時間佔比 ${stayPct.toFixed(1)}% 落在合理區間外`);
}

// ── 4. 走路：面向與水平移動一致 ─────────────────────────────────────
console.log('— 面向 —');
{
    // 只有左右兩種幀（美術限制）：垂直/停一律維持前一個面向。
    // 改用軌跡判定而不是問演算法要方向 —— 測試該驗「看起來對不對」，
    // 不該跟著內部實作（初版問 dirAt，改成分段走法後那個函式就沒了）。
    const tr = [];
    let c = null;
    for (let s = 0; s < 4000; s++) { const p = W.posAt({ seed: 99, joinStep: 0 }, s, c); c = p.cache; tr.push(p); }

    let mismatch = 0;
    for (let i = 1; i < tr.length; i++) {
        const dx = tr[i].x - tr[i - 1].x;
        if (dx > 0 && tr[i].facing !== 'right') mismatch++;
        if (dx < 0 && tr[i].facing !== 'left')  mismatch++;
    }
    ok(mismatch === 0, `水平移動方向與面向不符 ${mismatch} 次`);

    // 翻面只能發生在「正要開始水平移動」的那一拍 —— 站著或垂直移動時不該亂轉。
    let spin = 0;
    for (let i = 1; i < tr.length - 1; i++) {
        if (tr[i].facing === tr[i - 1].facing) continue;
        if (tr[i + 1].x === tr[i].x && tr[i].x === tr[i - 1].x) spin++;
    }
    ok(spin === 0, `沒有水平移動卻翻面 ${spin} 次`);
}

// ── 4.5 客製右向幀 ───────────────────────────────────────────────────
// Mastemon 左半天使（白／銀／金髮／水藍）、右半惡魔（紫黑／黃綠／粉），這個
// 左右分色是設計本身、不是視角 —— 純鏡射會把黑白兩半互換，看起來像換了一隻。
// 所以她自帶 _r 幀（config.rightOffset），輪廓照鏡射、顏色留在原本的螢幕半邊。
// 產生方式見 scripts/gen-mastemon-right.js。
console.log('— 客製右向幀 —');
{
    const fs = require('fs');
    const CHARS = path.join(__dirname, '..', 'characters');
    const TWO_TONE = ['Mastemon'];     // 左右分色、不能靠純鏡射的角色

    // 4.5-a 全體：有 rightOffset 就必須真的有那麼多幀，否則 runtime 會抓到 undefined
    const bad = [];
    for (const name of fs.readdirSync(CHARS)) {
        const cfgP = path.join(CHARS, name, 'config.json');
        const artP = path.join(CHARS, name, 'art.json');
        if (!fs.existsSync(cfgP) || !fs.existsSync(artP)) continue;
        const cfg = JSON.parse(fs.readFileSync(cfgP, 'utf8'));
        if (cfg.rightOffset == null) continue;
        const art = JSON.parse(fs.readFileSync(artP, 'utf8'));
        if (art.frames.length !== cfg.rightOffset + cfg.frameCount)
            bad.push(`${name}: art ${art.frames.length} 幀 ≠ rightOffset ${cfg.rightOffset} + frameCount ${cfg.frameCount}`);
    }
    ok(bad.length === 0, '幀數與 rightOffset 不符：' + bad.join('；'));

    for (const name of TWO_TONE) {
        const cfg = JSON.parse(fs.readFileSync(path.join(CHARS, name, 'config.json'), 'utf8'));
        ok(cfg.rightOffset != null, `${name} 缺 rightOffset，右向會被鏡射（黑白兩半互換）`);
        if (cfg.rightOffset == null) continue;   // 後面每一條都要用它，沒有就別再往下炸

        // 4.5-b 這才是真正要守住的性質：專屬色階不能換邊。
        // 用左向幀統計每個顏色的左右偏向，bias ≥ .7 算天使專屬、≤ -.7 算惡魔專屬，
        // 然後看右向幀裡這兩群色的平均 x —— 天使必須還在左半、惡魔還在右半。
        const px = JSON.parse(fs.readFileSync(path.join(CHARS, name, 'pixels.json'), 'utf8'));
        const N  = px.width;
        const st = new Map();
        for (const f of px.frames.slice(0, cfg.frameCount))
            for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
                const c = f[y * N + x]; if (!c) continue;
                const k = c.join(','), e = st.get(k) || { L: 0, R: 0 };
                if (x < N / 2) e.L++; else e.R++; st.set(k, e);
            }
        const side = c => {
            if (!c) return null;
            const e = st.get(c.join(',')); if (!e) return null;
            const b = (e.L - e.R) / (e.L + e.R);
            return b >= 0.7 ? 'A' : b <= -0.7 ? 'D' : null;
        };
        const meanX = (from, to) => {
            let ax = 0, an = 0, dx = 0, dn = 0;
            for (let i = from; i < to; i++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
                const t = side(px.frames[i][y * N + x]);
                if (t === 'A') { ax += x; an++; } else if (t === 'D') { dx += x; dn++; }
            }
            return { a: ax / an, d: dx / dn };
        };
        const L = meanX(0, cfg.frameCount);
        const R = meanX(cfg.rightOffset, cfg.rightOffset + cfg.frameCount);
        ok(R.a < N / 2, `${name} 右向幀的天使專屬色跑到右半了（平均 x=${R.a.toFixed(2)}）`);
        ok(R.d > N / 2, `${name} 右向幀的惡魔專屬色跑到左半了（平均 x=${R.d.toFixed(2)}）`);
        // 容差放到 2.5：換色表是多對一（天使 10 階併進惡魔 4 階），兩群的
        // 像素數會失衡，重心因此會位移一格多，那是正常的、不是換錯邊。
        ok(Math.abs(R.a - L.a) < 2.5 && Math.abs(R.d - L.d) < 2.5,
           `${name} 右向幀的分色位置與左向差太多（天使 ${L.a.toFixed(2)}→${R.a.toFixed(2)}，惡魔 ${L.d.toFixed(2)}→${R.d.toFixed(2)}）`);

        // 4.5-c 輪廓要真的鏡射過，而且不能只是純鏡射（那就是現在要修的 bug）
        if (!core || !core.getFacingRows) { skip++; console.log('  – 讀不到 agumon-core，跳過輪廓檢查'); }
        else {
            let shapeDiff = 0, plainFlip = 0, identical = 0;
            for (let i = 0; i < cfg.frameCount; i++) {
                const l = px.frames[i], r = px.frames[cfg.rightOffset + i];
                for (let y = 0; y < N; y++) for (let x = 0; x < N; x++)
                    if (!!l[y * N + (N - 1 - x)] !== !!r[y * N + x]) shapeDiff++;
                const art = JSON.parse(fs.readFileSync(path.join(CHARS, name, 'art.json'), 'utf8'));
                const a = JSON.stringify(core.getFacingRows(art, i, 'left',  cfg.rightOffset));
                const b = JSON.stringify(core.getFacingRows(art, i, 'right', cfg.rightOffset));
                if (b === JSON.stringify(core.flipRows(JSON.parse(a)))) plainFlip++;
                if (b === a) identical++;
            }
            ok(shapeDiff === 0, `${name} 右向幀的輪廓沒有照鏡射（差 ${shapeDiff} 格）`);
            ok(plainFlip === 0, `${name} 有 ${plainFlip} 幀的右向就是純鏡射，等於沒修`);
            ok(identical === 0, `${name} 有 ${identical} 幀的右向直接等於左向原圖（沒鏡射）`);
        }

        // 4.5-d cut-in 同理：runtime 沒有 frames[1] 就會翻轉 frames[0]
        const cut = JSON.parse(fs.readFileSync(path.join(CHARS, name, 'cutin-art.json'), 'utf8'));
        ok(cut.frames.length === 2, `${name} 的 cutin-art.json 只有 ${cut.frames.length} 幀，我方 cut-in 會被翻轉`);
        if (cut.frames.length === 2 && core && core.flipRows)
            ok(JSON.stringify(cut.frames[1]) !== JSON.stringify(core.flipRows(cut.frames[0])),
               `${name} 的 cut-in 右向幀就是純鏡射`);
    }
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

// ── 6b. 軌跡角度要夠多樣 ─────────────────────────────────────────────
// v2 只有 8 種角度（上下左右 + 四斜向），放久了整張圖是水平/垂直/45 度線疊出來的
// 網格，看起來像在走既定路線。這是使用者實際回報的問題，用測試釘住不要退回去。
console.log('— 軌跡多樣性 —');
{
    const dirs = new Set();
    for (const seed of [7, 42, 1000, 31337]) {
        let c = null, prevK = -1;
        for (let s = 0; s < 8000; s++) {
            const p = W.posAt({ seed, joinStep: 0 }, s, c); c = p.cache;
            if (p.k !== prevK) {
                prevK = p.k;
                const l = W.legAt(seed, p.k, c.x, c.y);
                if (!l.stay) dirs.add(l.vx + ':' + l.vy);
            }
        }
    }
    ok(dirs.size >= 16, `實際只走過 ${dirs.size} 種方向（太規律，會看出網格）`);

    // 段長要有奇數 —— v2 全是偶數，導致轉彎點永遠落在同一個奇偶晶格上
    const lens = [];
    let c = null, prevK = -1;
    for (let s = 0; s < 8000; s++) {
        const p = W.posAt({ seed: 7, joinStep: 0 }, s, c); c = p.cache;
        if (p.k !== prevK) { prevK = p.k; const l = W.legAt(7, p.k, c.x, c.y); if (!l.stay) lens.push(l.len); }
    }
    const odd = lens.filter(n => n % 2).length / lens.length;
    ok(odd > 0.2 && odd < 0.8, `段長奇偶失衡（奇數佔 ${(odd * 100).toFixed(0)}%）`);
}

// ── 6c. NPC（無主的野生 vpet）─────────────────────────────────────────
console.log('— NPC —');
if (!hasArt) { skip++; console.log('  – 讀不到角色美術，跳過'); }
else {
    const occ = [{ code: '阿張', char: 'agumon', seed: 111, joinStep: 0 }];
    const r = P.composePlaza(core, occ, 300, { caches: new Map() });
    ok(r.placed.length === occ.length + P.NPCS.length,
       `場上應有 ${occ.length + P.NPCS.length} 隻（玩家 + NPC），實際 ${r.placed.length}`);

    // NPC 沒有 code -> 不該有名牌。這是「一眼分得出誰是玩家的寵物」的唯一依據。
    const codes = new Set();
    for (const [, list] of r.labels) for (const it of list) codes.add(it.code);
    ok(![...codes].some(c => c === undefined || String(c).startsWith('npc:')),
       'NPC 出現了名牌');
    ok(codes.has('阿張'), '玩家的名牌不見了');

    // NPC 的快取要各自獨立 —— 用 code 當 key 的話兩隻 NPC 會共用一格而互相汙染，
    // 症狀是「NPC 會瞬移」，而且只有長時間開著才看得出來。
    const warm = new Map(); const diff = [];
    for (let s = 0; s <= 400; s++) {
        const a = P.composePlaza(core, occ, s, { caches: warm });
        if (s % 97 === 0) {
            const b = P.composePlaza(core, occ, s, { caches: new Map() });
            if (JSON.stringify(a.placed.map(p => [p.key, p.x, p.y]))
             !== JSON.stringify(b.placed.map(p => [p.key, p.x, p.y]))) diff.push(s);
        }
    }
    ok(diff.length === 0, `NPC 位置在有無快取時不一致於 step ${diff.join(',')}（快取槽撞號）`);

    // NPC 走的是同一套演算法 -> 一樣不能出界
    let oob = 0;
    for (let s = 0; s < 600; s++) {
        for (const p of P.composePlaza(core, [], s, { caches: new Map() }).placed) {
            if (p.x < W.MIN_X || p.x > W.MAX_X || p.y < W.MIN_Y || p.y > W.MAX_Y) oob++;
        }
    }
    ok(oob === 0, `NPC 走出邊界 ${oob} 次`);

    // 要關得掉：個人空間之類的場合不見得想要野生 vpet
    const none = P.composePlaza(core, occ, 300, { caches: new Map(), npc: false });
    ok(none.placed.length === occ.length, 'opts.npc=false 沒有把 NPC 關掉');
}

// ── 7. 名牌不穿透 ────────────────────────────────────────────────────
// ── 牧場摸摸的反應幀 ───────────────────────────────────────────────
// 牧場的摸摸是**純表演**：只換一幀表情，不動心情值、不寫 ranch.json。
// 這裡驗的是換幀這件事本身，「不寫檔」由 test-ranch.js 那邊的契約保證
// （反應只活在 daemon 的 Map 裡，根本沒有寫入路徑）。
console.log('— 摸摸反應幀 —');
{
    const idle0 = P.spriteDots(core, 'agumon', 0, 'right');
    const idle1 = P.spriteDots(core, 'agumon', 1, 'right');
    const happy = P.spriteDots(core, 'agumon', 0, 'right', 'HAPPY');
    const ser = (d) => JSON.stringify(d);
    ok(happy && ser(happy) !== ser(idle0) && ser(happy) !== ser(idle1),
       'HAPPY 反應幀應該與兩張待機幀都不同');
    // 同一個 react 不該再受 step 影響 —— 不然反應期間還會跟著待機動畫閃
    ok(ser(P.spriteDots(core, 'agumon', 1, 'right', 'HAPPY')) === ser(happy),
       '反應期間不該再跟著 step 交替（會閃）');
    ok(ser(P.spriteDots(core, 'agumon', 0, 'right', 'REFUSE')) !== ser(happy),
       'REFUSE 應與 HAPPY 不同');
    // 有些角色的美術不完整 → 查不到那個幀時要退回待機，不能畫出錯幀或炸掉
    ok(ser(P.spriteDots(core, 'agumon', 0, 'right', 'NO_SUCH_FRAME')) === ser(idle0),
       '查不到的幀名應退回待機');
    // 沒傳 react 的行為完全不變（廣場與 NPC 都走這條）
    ok(ser(P.spriteDots(core, 'agumon', 0, 'right', null)) === ser(idle0),
       'react 為空時不該影響原本的待機動畫');
}

console.log('— 顯示名稱 —');
{
    // 底線是資料夾名的產物（Agumon_Black / GodZilla_1954），不是名字的一部分。
    // 卡片、tree、牧場右鍵、statusline 清單全都走 getDisplayName，所以只改那一個地方。
    //
    // 斷言只驗「輸出沒有底線」而不是驗某個確切字串 —— 因為 config.name 讀不讀得到
    // 取決於載入的是安裝版還是 repo 版（repo 版的 ASSETS_DIR 指向不存在的路徑，
    // 會走 fallback）。兩種情況下「不該有底線」都必須成立。
    const g = core && core.getDisplayName;
    if (!g) { skip++; console.log('  – core 沒有 getDisplayName，跳過'); }
    else {
        for (const id of ['agumon_black', 'godzilla_1954', 'zephagamon_ace', 'mothra_leo']) {
            const out = core.getDisplayName(id);
            ok(!out.includes('_'), `${id} 的顯示名還有底線：${JSON.stringify(out)}`);
            // 長度必須一樣 —— 卡片那欄是「補滿或截斷到 TEXT_W」，
            // 換成多字元的東西會把整列撐寬、右邊的 CutIn 看起來像歪掉
            ok(out.length === id.length,
               `${id} 的顯示名長度變了（${id.length} -> ${out.length}），卡片排版會跑掉`);
        }
        // 沒有底線的照舊
        ok(core.getDisplayName('agumon') === 'Agumon', '沒有底線的名字被動到了');
        // 空值不能爆
        ok(core.getDisplayName('') === '' && core.getDisplayName(null) === '',
           '空值應該回空字串');
    }
}

console.log('— 名牌遮擋 —');
if (!hasArt) { skip++; console.log('  – 讀不到角色美術，跳過'); }
else {
    // 手動擺兩隻重疊：後排 back 的腳下名牌位置正好被前排 front 的身體蓋住。
    // 用 joinStep = 大於 step 的值把人釘在起點（elapsed 夾在 0），
    // 才能精準構造重疊，不必去猜走路會走到哪。
    const at = (code, x, y) => ({ code, char: 'agumon', seed: 1, joinStep: 999999, _x: x, _y: y });
    // posAt 會用 startPos(seed) 決定位置 → 改用直接餵 placed 的路徑不方便，
    // 所以改成驗函式本身：owner 緩衝裡有比我前面的人 → occluded 要回 true。
    const owner = Array.from({ length: W.PLAZA_H }, () => new Array(W.PLAZA_W).fill(-1));
    ok(P.occluded(owner, 10, 5, 4, 0) === false, '空白處不該判定為被遮擋');
    owner[20][6] = 3;                                    // 第 10 列（dot 20）被 z=3 佔住
    ok(P.occluded(owner, 10, 5, 4, 0) === true,  '被前排（z 較大）蓋住卻沒判定為遮擋');
    ok(P.occluded(owner, 10, 5, 4, 5) === false, '被後排（z 較小）壓到不該算遮擋');
    ok(P.occluded(owner, 10, 8, 4, 0) === false, '不重疊的欄位不該算遮擋');

    // 名牌一律標在腳下（慣例，PvP 也是），且位置固定 —— 不會隨走動忽上忽下。
    const mk = (code, x, y, z) => ({ code, x, y, z });
    const rowOf = (y) => {
        const m = P.buildLabels([mk('ME', 40, y, 0)], core, 'ME', null);
        for (const [r, list] of m) if (list.some(i => i.code === 'ME')) return r;
        return -1;
    };
    const lastRow = W.PLAZA_H / 2 - 1;
    let bad = 0, missing = 0;
    for (let y = W.MIN_Y; y <= W.MAX_Y; y++) {
        const r = rowOf(y);
        if (r < 0) { missing++; continue; }
        if (r > lastRow) { bad++; continue; }                        // 掉到畫面外
        if (r !== Math.floor((y + W.SPRITE) / 2)) bad++;             // 位置不固定
    }
    ok(missing === 0, `有 ${missing} 個 y 位置名牌不見（含最底那一排）`);
    ok(bad === 0, `有 ${bad} 個 y 位置名牌沒有固定在腳下那一列`);

    // 遮擋要逐「字」判斷：被蓋住的字不畫，沒被蓋住的仍要畫出來。
    // 整條一起消失的話，只被蓋到一個字也會整個名牌不見。
    const ow = Array.from({ length: W.PLAZA_H }, () => new Array(W.PLAZA_W).fill(-1));
    const y0 = 10, lrow = Math.floor((y0 + W.SPRITE) / 2);
    const li = P.buildLabels([mk('ABCD', 40, y0, 0)], core, null, ow);
    let before = 0; for (const [, l] of li) before += l.length;
    ow[lrow * 2][li.get(lrow)[0].col] = 5;                            // 蓋住第一個字
    const after = P.buildLabels([mk('ABCD', 40, y0, 0)], core, null, ow);
    let n2 = 0; for (const [, l] of after) n2 += l.length;
    ok(before === 4, `名牌應拆成 4 個字，實際 ${before}`);
    ok(n2 === 3, `蓋住一個字應剩 3 個，實際 ${n2}（0 = 整條一起消失）`);

    // 端對端：兩隻疊在一起時，名牌總數不會超過人數，且不會出現在被蓋住的位置
    const occ = Array.from({ length: 8 }, (_, i) => ({
        code: 'N' + i, char: 'agumon', seed: 200 + i, joinStep: 0,
    }));
    let over = 0, everHidden = 0;
    for (let s = 0; s < 400; s++) {
        const r = P.composePlaza(core, occ, s, { caches: new Map() });
        const codes = new Set();
        for (const [, list] of r.labels) for (const it of list) codes.add(it.code);
        if (codes.size > occ.length) over++;
        if (codes.size < occ.length) everHidden++;
    }
    ok(over === 0, `名牌對應到的人數超過在場人數 ${over} 次`);
    // 反過來也要成立：擠在一起時**必須**有人的名牌被擋掉，否則就是穿透了
    ok(everHidden > 0, '從來沒有名牌被遮擋 —— 遮擋判斷可能沒生效（會穿透）');
}

// ── 8. dot ↔ cell 來回轉換不失真 ──────────────────────────────────────
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
