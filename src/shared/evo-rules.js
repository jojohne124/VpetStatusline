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

    // 日夜／tag 互斥分歧不需要 win% 遞增：它們靠別的軸區分，不是「取強者」的競爭關係。
    const altGated = a.some(k => k.time || k.tag);
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
        // 日夜／tag 互斥分歧不需遞增（靠別的軸區分，非「取強者」競爭）
        if (kids.some(k => k.time || k.tag)) continue;
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
    resolvePcts, findDeadPaths, stageForPower,
};
