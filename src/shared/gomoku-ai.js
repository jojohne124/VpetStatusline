'use strict';
/**
 * gomoku-ai.js — 五子棋的電腦（docs/plaza-gomoku-spec.md「跟電腦玩」）
 *
 * 目標是「盡可能強」（2026-10-20），在瀏覽器裡一手約一秒內想完：
 *   1. 能連五就連五
 *   2. 對方下一手能連五 → 一定擋
 *   3. 自己能做活四（兩頭都能連五）→ 下（贏定）
 *   4. 「連續衝四」找殺（VCF）：自己一路衝四、對方只能擋，最後做出活四或雙四 → 贏定
 *   5. 對方有 VCF → 先擋（從對方的殺法第一手、與擋掉後對方的威脅裡挑）
 *   6. 其他：棋型評分排出前幾名，往下看幾步（極大極小＋剪枝），挑最好的
 * 棋型評分：每個方向取 9 格成一串，比對五、活四、衝四、活三、眠三、活二…，加上雙四、四三、雙三的組合分。
 *
 * ⚠️ 這支會被塞進 daemon.js 的 template literal（頁面）：不能有反引號、錢字號接大括號、反斜線。
 *
 * 棋盤：長度 N*N 的陣列，0 空、1 黑、2 白（頁面上的字串 '0'/'1'/'2' 先轉成數字）。
 */

const N = 15;
let AI_DEPTH = 3;            // 一般局面往下看幾步（根之後）；調強度用
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

// 棋型（以「自己」為 1、空為 0、對方或牆為 x）→ 分數。比對時窗口必須蓋到剛下的那一子（中間第 4 格）
const PATTERNS = [
    ['11111', 1000000, 'five'],
    ['011110', 100000, 'open4'],
    ['11110', 12000, 'four'], ['01111', 12000, 'four'], ['10111', 12000, 'four'], ['11011', 12000, 'four'], ['11101', 12000, 'four'],
    ['001110', 4000, 'open3'], ['011100', 4000, 'open3'], ['010110', 3600, 'open3'], ['011010', 3600, 'open3'],
    ['11100', 500, 'three'], ['00111', 500, 'three'], ['11010', 450, 'three'], ['01011', 450, 'three'], ['10110', 450, 'three'],
    ['01101', 450, 'three'], ['10011', 400, 'three'], ['11001', 400, 'three'], ['10101', 400, 'three'],
    ['001100', 260, 'open2'], ['011000', 220, 'open2'], ['000110', 220, 'open2'], ['010100', 200, 'open2'], ['001010', 200, 'open2'], ['010010', 160, 'open2'],
    ['11000', 30, 'two'], ['00011', 30, 'two'], ['10100', 25, 'two'], ['00101', 25, 'two'], ['10010', 20, 'two'], ['01001', 20, 'two'],
];

function lineStr(b, x, y, dx, dy, c) {
    let s = '';
    for (let k = -4; k <= 4; k++) {
        const i = x + dx * k, j = y + dy * k;
        if (k === 0) { s += '1'; continue; }
        if (i < 0 || j < 0 || i >= N || j >= N) { s += 'x'; continue; }
        const v = b[j * N + i];
        s += v === 0 ? '0' : v === c ? '1' : 'x';
    }
    return s;
}

/** 這一個方向的棋型（取最好的那一個） */
function shape(s) {
    for (const [p, sc, kind] of PATTERNS) {
        const L = p.length;
        for (let st = Math.max(0, 4 - L + 1); st <= 4 && st + L <= 9; st++) {
            if (s.substr(st, L) === p) return { sc, kind };
        }
    }
    return { sc: 1, kind: 'one' };
}

/** 在 (x,y) 下 c 這一手的價值（不改棋盤）。回傳分數與棋型統計 */
function moveValue(b, x, y, c) {
    let sc = 0, five = 0, open4 = 0, four = 0, open3 = 0;
    for (const [dx, dy] of DIRS) {
        const r = shape(lineStr(b, x, y, dx, dy, c));
        sc += r.sc;
        if (r.kind === 'five') five++;
        else if (r.kind === 'open4') open4++;
        else if (r.kind === 'four') four++;
        else if (r.kind === 'open3') open3++;
    }
    // 組合：雙四、四三 → 幾乎贏定；雙三 → 很強
    if (five) sc += 5000000;
    if (open4 || four >= 2 || (four >= 1 && open3 >= 1)) sc += 80000;
    if (open3 >= 2) sc += 20000;
    return { sc, five, open4, four, open3 };
}

/** 有棋子的旁邊兩格內的空位（空棋盤 → 天元） */
function candidates(b) {
    const out = [], mark = new Uint8Array(N * N);
    let any = false;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        if (!b[j * N + i]) continue;
        any = true;
        for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
            const x = i + di, y = j + dj;
            if (x < 0 || y < 0 || x >= N || y >= N || b[y * N + x] || mark[y * N + x]) continue;
            mark[y * N + x] = 1; out.push(y * N + x);
        }
    }
    if (!any) out.push(7 * N + 7);
    return out;
}

/** (x,y) 下 c 會不會連成五（只看那一子） */
function makesFive(b, x, y, c) {
    for (const [dx, dy] of DIRS) {
        let n = 1;
        for (const s of [1, -1]) {
            let i = x + dx * s, j = y + dy * s;
            while (i >= 0 && j >= 0 && i < N && j < N && b[j * N + i] === c) { n++; i += dx * s; j += dy * s; }
        }
        if (n >= 5) return true;
    }
    return false;
}

/** c 下一手能連五的所有空位（= 對方必須擋的點） */
function winSpots(b, c, cand) {
    const out = [];
    for (const p of cand || candidates(b)) if (!b[p] && makesFive(b, p % N, Math.floor(p / N), c)) out.push(p);
    return out;
}

/**
 * VCF（連續衝四）：c 每一手都做出「下一手能連五」的威脅，對方只能擋那一點；
 * 做出兩個以上的連五點（活四、雙四）就贏。找到回傳第一手，找不到回傳 -1。
 */
function vcf(b, c, depth, deadline) {
    if (depth <= 0 || Date.now() > deadline) return -1;
    const o = 3 - c, cand = candidates(b);
    if (winSpots(b, o, cand).length) return -1;   // 對方已經有連五點：衝四沒用，先得擋
    for (const p of cand) {
        if (b[p]) continue;
        const x = p % N, y = Math.floor(p / N);
        if (makesFive(b, x, y, c)) return p;
        const v = moveValue(b, x, y, c);
        if (!v.open4 && !v.four) continue;
        b[p] = c;
        const spots = winSpots(b, c, candidates(b));
        let win = false;
        if (spots.length >= 2) win = true;
        else if (spots.length === 1) {
            const q = spots[0];
            if (!makesFive(b, q % N, Math.floor(q / N), o)) {   // 對方擋的那一手不能剛好連五
                b[q] = o;
                win = vcf(b, c, depth - 1, deadline) >= 0;
                b[q] = 0;
            }
        }
        b[p] = 0;
        if (win) return p;
    }
    return -1;
}

/** 局面評估（從 c 的角度）：雙方「最好的幾手」的價值差 */
function evaluate(b, c, cand) {
    const o = 3 - c;
    let my = [], op = [], opFive = 0;
    for (const p of cand) {
        if (b[p]) continue;
        const x = p % N, y = Math.floor(p / N);
        const m = moveValue(b, x, y, c), t = moveValue(b, x, y, o);
        if (m.five) return 8000000;              // 輪到 c、c 能連五 → 贏
        if (t.five) opFive++;
        my.push(m.sc);
        // 對方只有一個連五點：輪到 c，擋得掉 → 不算數（不然一個衝四會被當成贏定，判斷整個歪掉）
        op.push(t.five ? 0 : Math.min(t.sc, 200000));
    }
    if (opFive >= 2) return -8000000;             // 對方兩個連五點，擋不完 → 輸
    my.sort((a, z) => z - a); op.sort((a, z) => z - a);
    // 輪到 c 下：自己最好的一手幾乎一定兌現，對方的威脅打折
    return (my[0] || 0) + (my[1] || 0) * 0.3 - (op[0] || 0) * 0.9 - (op[1] || 0) * 0.3;
}

/** 候選手排序：攻擊＋防守（擋對方好點）都算 */
function ordered(b, c, cand, k) {
    const o = 3 - c, arr = [];
    for (const p of cand) {
        if (b[p]) continue;
        const x = p % N, y = Math.floor(p / N);
        arr.push([p, moveValue(b, x, y, c).sc + moveValue(b, x, y, o).sc * 0.9]);
    }
    arr.sort((a, z) => z[1] - a[1]);
    return arr.slice(0, k).map(a => a[0]);
}

function negamax(b, c, depth, alpha, beta, deadline) {
    const cand = candidates(b);
    if (depth === 0 || Date.now() > deadline) return evaluate(b, c, cand);
    let best = -Infinity;
    for (const p of ordered(b, c, cand, 8)) {
        const x = p % N, y = Math.floor(p / N);
        if (makesFive(b, x, y, c)) return 9000000 + depth;
        b[p] = c;
        const v = -negamax(b, 3 - c, depth - 1, -beta, -alpha, deadline);
        b[p] = 0;
        if (v > best) best = v;
        if (v > alpha) alpha = v;
        if (alpha >= beta) break;
    }
    return best === -Infinity ? 0 : best;
}

/**
 * 挑一手。board：長度 N*N（數字 0/1/2 或字串 '0'/'1'/'2'），c：電腦執的顏色（1 黑、2 白）。
 * opts.timeMs：大約想多久（預設 900ms）。回傳 [x, y]。
 */
function choose(board, c, opts = {}) {
    const b = new Int8Array(N * N);
    for (let i = 0; i < N * N; i++) b[i] = Number(board[i]) || 0;
    const o = 3 - c, deadline = Date.now() + (opts.timeMs || 1200);
    const cand = candidates(b);
    const xy = (p) => [p % N, Math.floor(p / N)];
    const why = (w) => { if (opts.why) opts.why.push(w); };   // 偵錯／測試：這一手是哪一條規則決定的
    // 1. 自己連五
    const mine = winSpots(b, c, cand);
    if (mine.length) { why('five'); return xy(mine[0]); }
    // 2. 擋對方連五
    const theirs = winSpots(b, o, cand);
    if (theirs.length) { why('block5'); return xy(theirs[0]); }
    // 3. 活四
    for (const p of cand) { const v = moveValue(b, p % N, Math.floor(p / N), c); if (v.open4) { why('open4'); return xy(p); } }
    // 4. 自己的 VCF
    const kill = vcf(b, c, 12, deadline);
    if (kill >= 0) { why('vcf'); return xy(kill); }
    // 對方下一手能做出活四／雙四／四三的點（= 對方的活三等等）：不擋就輸
    const danger = cand.filter(p => { const v = moveValue(b, p % N, Math.floor(p / N), o); return v.open4 || v.four >= 2 || (v.four && v.open3); });
    // 4b. 自己能做四三、雙三，而對方沒有馬上要贏的點 → 下（下一手就是活四或雙四）
    if (!danger.length) {
        let pick = -1, pv = -1;
        for (const p of cand) {
            const v = moveValue(b, p % N, Math.floor(p / N), c);
            if ((v.four && v.open3) || v.open3 >= 2) { if (v.sc > pv) { pv = v.sc; pick = p; } }
        }
        if (pick >= 0) { why('43'); return xy(pick); }
    }
    // 5. 對方有 VCF 或活三 → 從「能破解的點」裡挑（對方殺法的第一手、對方的危險點、自己的反擊衝四）
    const theirKill = vcf(b, o, 10, deadline);
    let pool = ordered(b, c, cand, 12);
    if (danger.length && theirKill < 0) {
        // 擋活三：只從對方的危險點裡挑（自己衝四只是拖時間 —— 沒有 VCF 的話衝完對方擋掉，活三還在）
        const def = [...danger];
        const safe = [];
        for (const p of [...new Set(def)]) {
            b[p] = c;
            const still = cand.some(q => !b[q] && (() => { const v = moveValue(b, q % N, Math.floor(q / N), o); return v.open4; })());
            if (!still) safe.push(p);
            b[p] = 0;
        }
        pool = safe.length ? safe : [...new Set(def)];
    }
    if (theirKill >= 0) {
        const defend = [theirKill, ...danger];
        for (const p of ordered(b, o, cand, 8)) defend.push(p);
        for (const p of cand) { const v = moveValue(b, p % N, Math.floor(p / N), c); if (v.four) defend.push(p); }
        // 留下「下了之後對方就沒有 VCF」的那些
        const safe = [];
        for (const p of [...new Set(defend)]) { b[p] = c; if (vcf(b, o, 8, deadline) < 0) safe.push(p); b[p] = 0; }
        if (safe.length) pool = safe;
    }
    // 6. 往下看幾步
    // 每一個候選手先做安全檢查：下了之後，對方能不能一手做出雙重威脅（活四、雙四、四三、雙三）或有 VCF？
    // 有的話大扣分 —— 單看棋型分數的電腦最常輸在這裡（對方一手做出兩個威脅，擋一個擋不了另一個）
    const oppThreat = () => {
        const cc = candidates(b);
        for (const q of cc) {
            const v = moveValue(b, q % N, Math.floor(q / N), o);
            if (v.five || v.open4 || v.four >= 2 || (v.four && v.open3) || v.open3 >= 2) {
                // 我馬上能連五就不怕
                return !winSpots(b, c, cc).length;
            }
        }
        return false;
    };
    let best = pool[0], bestV = -Infinity;
    for (const p of pool) {
        b[p] = c;
        let v = -negamax(b, o, AI_DEPTH, -Infinity, Infinity, deadline);
        if (oppThreat()) v -= 3000000;
        else if (Date.now() < deadline && vcf(b, o, 6, deadline) >= 0) v -= 2000000;
        b[p] = 0;
        if (v > bestV) { bestV = v; best = p; }
        if (Date.now() > deadline) break;
    }
    why('search' + (danger.length ? '/danger' : '') + (theirKill >= 0 ? '/theirvcf' : ''));
    return xy(best);
}

module.exports = { setDepth: (d) => { AI_DEPTH = d; }, N, PATTERNS, lineStr, shape, moveValue, candidates, makesFive, winSpots, vcf, evaluate, choose };
