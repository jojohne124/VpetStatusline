/*
 * evo-rules.js — 進化路線的共用規則：win% 建議公式、分歧 tie-break、死路檢查。
 *
 * 原本散在 scripts/apply-new-routes.js，抽出來讓「進化路線編輯器」與批次腳本共用同一套邏輯，
 * 兩邊永不分叉。純函數、無 IO。
 *
 * 設計依據：docs/agent-memory/evo-winrate-default.md（win% 由目標 power 決定）
 *   + tie-break：相鄰 power 的兄弟分支若取整後打平，讓 checkEvolution（取目標 power 強者）
 *     下每條分支都「可達」（win% 隨 power 嚴格遞增）。
 */

// ── 各階段預設值 / 公式常數 ──────────────────────────────────────────────
const STAGE_COST = { Child: 10, Adult: 15, Perfect: 20, Ultimate: 20, 'Super-Ultimate': 20 };
const STAGE_MINB = { Child: 5,  Adult: 8,  Perfect: 12, Ultimate: 12, 'Super-Ultimate': 12 };
// ⚠️ BAND 蓄意不含 Super-Ultimate：BAND 專供 stageForPower() 由 power 反推階段，而 SU 的 power
// 與 Ultimate 同區間（我方 SU power 不變、敵方暫定 200）→ 放進來只會把一般 Ultimate 誤判成 SU。
// SU 是隱藏階，一律由 config.stage 明寫，不從 power 推導。
const BAND = { Child: [10, 30], Adult: [55, 80], Perfect: [110, 130], Ultimate: [160, 190] };
const FC   = { Child: [45, 60], Adult: [50, 70], Perfect: [55, 80] };

const r5  = x => Math.round(x / 5) * 5;
const pos = (p, s) => { const b = BAND[s]; if (!b) return 0.5; return Math.max(0, Math.min(1, (p - b[0]) / (b[1] - b[0]))); };
const gn  = g => Math.max(0, Math.min(1, (g - 40) / 30));

// 依「來源階段 + 來源/目標 power」建議 win% 門檻（0-100，取整到 5）
function suggestPct(srcStage, srcPower, tgtPower) {
    const fc = FC[srcStage] || [50, 70];
    return r5(fc[0] + (fc[1] - fc[0]) * (0.7 * gn(tgtPower - srcPower) + 0.3 * pos(srcPower, srcStage)));
}

function costFor(stage) { return STAGE_COST[stage] ?? 15; }
function minBattlesFor(stage) { return STAGE_MINB[stage] ?? 8; }

// ── 從一組 children 算最終 pct（含 tie-break）────────────────────────────
// kids: [{ tgt, power, pct, isNew, time }]（pct 可為 null → 用 suggestPct 補）
// srcStage/srcPower：來源角色；回傳同陣列、pct 已定案，依 power 由小到大排序。
function resolvePcts(kids, srcStage, srcPower) {
    let a = kids.map(k => ({
        ...k,
        pct: k.pct != null ? k.pct : suggestPct(srcStage, srcPower, k.power),
    })).sort((x, y) => x.power - y.power);

    // 日夜／tag／戰力門檻的分歧不需要 win% 遞增：它們靠別的軸區分，不是「取強者」的競爭關係。
    // （powerGate = 邊上的 power_at_least 門檻，不要跟 k.power ＝目標角色戰力搞混）
    const altGated = a.some(k => k.time || k.tag || k.powerGate != null || k.altGate);
    if (!altGated) {
        for (let i = 1; i < a.length; i++) {
            if (a[i].power > a[i - 1].power && a[i].pct <= a[i - 1].pct) {
                if (a[i].isNew)        a[i].pct     = a[i - 1].pct + 5;   // 強分支(新)升
                else if (a[i - 1].isNew) a[i - 1].pct = a[i].pct - 5;     // 弱分支(新)降
                else                   a[i].pct     = a[i - 1].pct + 5;   // 兩既有：強的升
            }
        }
    }
    return a;
}

// ── 死路檢查 ──────────────────────────────────────────────────────────────
// graph: { nodes: [{id, stage, power}], edges: [{from, to, pct, time}] }
// 回傳死路清單 [{ from, weakTgt, weakPct, weakPow, strongTgt, strongPct, strongPow }]
// 死路定義：同一 parent 下，目標 power 較高的分支 win% <= 較低者 → 取強者永遠選不到弱的。
function findDeadPaths(graph) {
    const nodeById = {};
    for (const n of graph.nodes) nodeById[n.id] = n;
    const byParent = {};
    for (const e of graph.edges) (byParent[e.from] = byParent[e.from] || []).push(e);

    const dead = [];
    for (const from in byParent) {
        const kids = byParent[from];
        if (kids.length < 2) continue;
        // 日夜／tag／戰力門檻的分歧不需遞增（靠別的軸區分，非「取強者」競爭）
        if (kids.some(k => k.time || k.tag || k.powerGate != null || k.altGate)) continue;
        const a = kids
            .map(k => ({ tgt: k.to, pct: k.pct, pow: (nodeById[k.to] || {}).power ?? 0 }))
            .sort((x, y) => x.pow - y.pow);
        for (let i = 1; i < a.length; i++) {
            if (a[i].pow > a[i - 1].pow && a[i].pct <= a[i - 1].pct) {
                dead.push({
                    from,
                    weakTgt: a[i - 1].tgt, weakPct: a[i - 1].pct, weakPow: a[i - 1].pow,
                    strongTgt: a[i].tgt,   strongPct: a[i].pct,   strongPow: a[i].pow,
                });
            }
        }
    }
    return dead;
}

// ── 可達性：從 starter 走得到嗎 ────────────────────────────────────────────
// graph: { nodes: [{id, stage}], edges: [{from, to}] }
// starters: id 陣列
// specialRules: characters/special-evolutions.json 的 rules（可省略）
//
// 走不到 = 純敵人。這是**算出來的**而不是一份人工名單 —— 名單會過期，
// 而新增敵役、換掉某條鏈之後，可達性自己會跟上。
//
// ⚠️ 特殊進化不在 evolvesTo 裡（大便獸走 special-evolutions.json），
//    純看 evolvesTo 會把牠判成敵人而從圖鑑上消失 —— 而牠明明是玩家養出來的。
//    所以規則的 to 也要算進來：只要有任何一隻可達的角色符合 fromStage，那個 to 就拿得到。
//
// starters 是空的就回 null（＝不知道，別過濾）。跟 roster 讀不到時 fail-open 同樣的理由：
// 資料缺一角不該讓整本圖鑑變空的。
//
// jogress（合體進化）：[{front, camp, to}]，用 expandJogress 展開過的。to 可達 ⇔ front 與 camp
// **都**可達 —— 兩隻都要養得出來才湊得齊。只有一方可達就不算（那是半條線）。
// 不吃這個的話，以合體為唯一入口的角色（Mastemon）會被圖鑑當成純敵人藏起來。
function reachableFrom(graph, starters, specialRules, jogress) {
    if (!Array.isArray(starters) || !starters.length) return null;
    const nodeById = {};
    for (const n of graph.nodes) nodeById[n.id] = n;
    const next = {};
    for (const e of graph.edges) (next[e.from] = next[e.from] || []).push(e.to);

    const seen = new Set();
    const stack = starters.filter(id => nodeById[id]);
    const rules = Array.isArray(specialRules) ? specialRules.slice() : [];
    const pairs = Array.isArray(jogress) ? jogress.slice() : [];
    let grew = true;
    while (grew) {
        grew = false;
        while (stack.length) {
            const id = stack.pop();
            if (!id || seen.has(id) || !nodeById[id]) continue;
            seen.add(id);
            grew = true;
            for (const nx of (next[id] || [])) stack.push(nx);
        }
        // 每輪結束後看看有沒有特殊進化的條件被滿足了（可能又帶出新的一段鏈）
        for (let i = rules.length - 1; i >= 0; i--) {
            const r = rules[i];
            if (!r || !r.to || !nodeById[r.to]) { rules.splice(i, 1); continue; }
            const okFrom = !r.fromStage
                || [...seen].some(id => (nodeById[id] || {}).stage === r.fromStage);
            if (!okFrom) continue;
            rules.splice(i, 1);
            if (!seen.has(r.to)) { stack.push(r.to); grew = true; }
        }
        // 合體：雙親都已可達才成立。同樣放在每輪結束後 —— 雙親可能要等別條線先走到。
        for (let i = pairs.length - 1; i >= 0; i--) {
            const j = pairs[i];
            if (!j || !j.to || !nodeById[j.to]) { pairs.splice(i, 1); continue; }
            if (!(seen.has(j.front) && seen.has(j.camp))) continue;
            pairs.splice(i, 1);
            if (!seen.has(j.to)) { stack.push(j.to); grew = true; }
        }
    }
    return seen;
}

// ── 合體進化（Jogress）的組合表 ────────────────────────────────────────────
// characters/jogress.json 的原始內容 → { pairs: [{front, camp, to}], dupes: [...] }。
//
// 兩種寫法：
//   { "pair": [x, y], "to": z }        兩個方向同結果，展開成 (x,y) 與 (y,x)
//   { "front": a, "camp": b, "to": c } 有序單筆（A+B=A1、B+A=B1 那種）
//
// 對稱組一定要用 pair 簡寫 —— 手寫兩筆總有一天只改到一筆。
//
// 同一組 (front, camp) 出現第二次 → 取先出現的，後面那筆放進 dupes。
// 靜靜地後蓋前會讓「改了沒生效」變成無頭案件；但這裡是純函數、core 又跑在 statusline
// 裡（stdout 就是狀態列本身，印一行就插進狀態列），所以只回傳，由 CLI 負責講出來。
function expandJogress(raw) {
    const pairs = [], dupes = [], seen = new Set();
    const id = (x) => (x == null ? '' : String(x).trim().toLowerCase());
    const add = (front, camp, to) => {
        front = id(front); camp = id(camp); to = id(to);
        if (!front || !camp || !to) return;
        const k = front + '+' + camp;
        if (seen.has(k)) { dupes.push({ front, camp, to }); return; }
        seen.add(k);
        pairs.push({ front, camp, to });
    };
    const list = raw && Array.isArray(raw.pairs) ? raw.pairs : [];
    for (const e of list) {
        if (!e || !e.to) continue;
        if (Array.isArray(e.pair) && e.pair.length === 2) {
            add(e.pair[0], e.pair[1], e.to);
            // A+A：同一個方向，展開一次就好，不然自己會撞成自己的重複
            if (id(e.pair[0]) !== id(e.pair[1])) add(e.pair[1], e.pair[0], e.to);
        } else {
            add(e.front, e.camp, e.to);
        }
    }
    return { pairs, dupes };
}

// power → stage band（給新角色推 stage 用）
function stageForPower(p) {
    if (p == null) return 'Child';
    for (const [stage, [lo, hi]] of Object.entries(BAND)) {
        if (p >= lo - 5 && p <= hi + 10) return stage;
    }
    if (p < BAND.Child[0]) return 'Child';
    return 'Ultimate';
}

module.exports = {
    STAGE_COST, STAGE_MINB, BAND, FC,
    suggestPct, costFor, minBattlesFor,
    resolvePcts, findDeadPaths, reachableFrom, expandJogress, stageForPower,
};
