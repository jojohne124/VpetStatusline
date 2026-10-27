'use strict';
/**
 * commute-sim.js — 廣場小遊戲「上班快遲到」的純邏輯（docs/plaza-commute-spec.md）
 *
 * 廣場伺服器每房一個 50ms 迴圈跑它：車流、紅綠燈、碰撞、玩家互撞都在這裡判定，大家看到的一致。
 * 測試也直接測這支（固定 seed 重播）。前線單機（dev）原樣內嵌進頁面跑：不能有反引號、錢字號接大括號、反斜線。
 *
 * 座標：x 是沿著馬路的距離（點，往右為正），車道 0～3（0 在畫面最上面）。
 * 車子的 x 是車尾，x + len 是車頭。ly 是車道位置（小數：換車道到一半）。
 * 時間：一拍 DT 秒。數值都是草稿，實作後依手感調。
 *
 * 操作（2026-10-27 定）：角色釘在畫面左邊約 30%（daemon 的攝影機跟著自己），前後完全靠油門。
 *   → 油門（X 同）：按住加速到上限，放掉慢慢減速（引擎煞車）。
 *   ← 煞車（Z 同）：← → 一起＝輕煞；只按 ← 看按下那一刻的車速 —— 快（> HARD_V）就是急煞（冒火花，放開或停住為止），
 *     不快就是一般煞車煞到停。
 *   ↑ ↓：自由上下移動（ly 是小數，可以騎在兩道中間）。
 */

const DT = 0.05;
const TICK_MS = DT * 1000;
const LANES = 4;
const DAYS = 5;
const COUNTDOWN_S = 3;         // 開局倒數：這幾秒不能動、時鐘不走
const DAY_S = 120;             // 08:58:00 → 09:00:00（實際 2 分鐘，1:1）
const CLOCK0 = 8 * 3600 + 58 * 60;
const BIKE_LEN = 8;            // 機車長度（點）
const VMAX = 52;               // 最快（點/秒）。2026-10-27 試玩：42 太慢 → 52
const ACC = 30;                // 油門
const DRAG = 6;                // 放掉油門：引擎煞車慢慢掉速
const SOFT = 30;               // Z＋X：輕煞
const BRAKE = 55;              // 只按 Z、車速不快：煞到停
const HARD = 95;               // 只按 Z、車速快：急煞（冒火花）
const HARD_V = 0.6 * VMAX;     // 多快算「快」
const VMOVE = 3;               // 上下移動的速度（車道/秒）
const LANE_V = 5;              // 車子換車道速度（車道/秒）
// 碰撞放寬（2026-10-27 試玩：太容易撞）：上下差 HIT_LY 以內、前後各讓 HIT_PAD 點才算撞到。車流跟車用 FOLLOW_LY（照舊）
const HIT_LY = 0.55;
const HIT_PAD = 1;
const FOLLOW_LY = 0.7;
const START_X = 0;
const VEH = {                  // 種類：長度、速度範圍（點/秒）。2026-10-27：機車旁邊要看起來大台（9／12／18 → 12／15／23）
    car:   { len: 12, v: [18, 26] },
    van:   { len: 15, v: [16, 22] },
    truck: { len: 23, v: [13, 18] },
};
const VEH_NAME = { car: '汽車', van: '貨車', truck: '卡車', island: '圓環', works: '工程車', bike: '上班族' };
const LIGHT = { G: 6, Y: 1.5 };   // 綠燈、黃燈秒數；紅燈看哪一天
const ISLAND_LEN = 90;            // 圓環中央島長度
const WORK_LEN = 34;              // 施工（最下面那道整段擋住：工程車＋三角錐）
const KEY = { thr: 1, brk: 2, up: 16, down: 32 };   // 輸入的按鍵位元（4、8 保留）

// mulberry32：同 stairs-sim
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
// 一週一個 seed，每天從它推出當天的 seed（五天路況都不同，但大家一樣）
const daySeed = (seed, day) => (Math.imul((seed >>> 0) ^ 0x9E3779B9, day + 1) + day * 7919) >>> 0;

// 人多車少（2026-10-27）：玩家自己就是障礙物（車子讓玩家、玩家互撞兩個都出局），每多一個人，車距、圓環匯入間隔各多 CROWD。
// 只動車流，紅綠燈、圓環、施工（地形）不變；同一房大家人數一樣，路況照樣一模一樣
const CROWD = 0.15;
const crowdOf = (n) => 1 + CROWD * (Math.max(1, Math.min(LANES, n | 0 || 1)) - 1);
/** 一天的難度（day：0 = 週一 … 4 = 週五）：越後面越塞、紅燈越長。n：房裡幾個人（人多車少） */
function difficulty(day, n = 1) {
    const d = Math.max(0, Math.min(DAYS - 1, day | 0)), k = crowdOf(n);
    return {
        gap: [(120 - 10 * d) * k, (210 - 18 * d) * k],   // 同一道相鄰兩台車的間距（2026-10-27 試玩：太密，放寬）
        truck: 0.12 + 0.05 * d, van: 0.22,   // 卡車、貨車的比例（其餘汽車）
        red: 3 + 0.75 * d,                   // 紅燈秒數
        merge: (7 - 0.8 * d) * k,            // 圓環支線每幾秒匯入一台
        len: 2500 + 100 * d,                 // 路多長
        works: d === 0 ? 0 : d < 3 ? 1 : 2,  // 施工幾處（週一沒有）
    };
}

/** 地圖：紅綠燈、圓環（照 seed）。features 依 x 排好 */
function makeMap(seed, day) {
    const r = rng(seed), df = difficulty(day);
    const lights = [], islands = [];
    let x = 260;
    while (x < df.len - 200) {
        if (r() < 0.38 && x > 400) {
            islands.push({ x0: Math.round(x), x1: Math.round(x + ISLAND_LEN), mergeX: Math.round(x + ISLAND_LEN * 0.45) });
            x += ISLAND_LEN;
        } else {
            lights.push({ x: Math.round(x), off: Math.round(r() * 8 * 10) / 10 });
        }
        x += 280 + r() * 260;
    }
    // 施工：擺在紅綠燈、圓環中間的空檔（離它們 60 點以上），最下面那道
    const works = [];
    for (let n = 0, tries = 0; n < df.works && tries < 50; tries++) {
        const x0 = Math.round(500 + r() * (df.len - 900));
        const near = (a) => Math.abs(a - x0) < 60 + WORK_LEN;
        if (lights.some(L => near(L.x)) || islands.some(I => x0 + WORK_LEN > I.x0 - 60 && x0 < I.x1 + 60) || works.some(w => near(w.x0) || Math.abs(w.x0 - x0) < 150)) continue;
        works.push({ x0, x1: x0 + WORK_LEN }); n++;
    }
    works.sort((a, b) => a.x0 - b.x0);
    return { len: df.len, lights, islands, works, red: df.red };
}

// 紅綠燈狀態：週期 G → Y → R（off 錯開，每盞不同步）
function lightAt(map, L, t) {
    const cyc = LIGHT.G + LIGHT.Y + map.red;
    const u = ((t + L.off) % cyc + cyc) % cyc;
    return u < LIGHT.G ? 'G' : u < LIGHT.G + LIGHT.Y ? 'Y' : 'R';
}

// 圓環（2026-10-27 改版）：上兩道往上繞、下兩道往下繞，島夾在中間，四道都能騎。
// 判定的島＝中線（1.5 道）附近的扁橢圓：上下半徑 ISLAND_RY 道、前後半徑島長一半 × ISLAND_RX。
// 第 1、2 道（離中線 0.5 道）騎得過去；騎在兩道中間、壓著中線才會撞島
const ISLAND_RY = 0.3, ISLAND_RX = 0.9;
function hitIsland(map, x0, x1, ly) {
    for (const I of map.islands) {
        const cx = (I.x0 + I.x1) / 2, hx = (I.x1 - I.x0) / 2 * ISLAND_RX;
        const nx = Math.max(x0, Math.min(x1, cx));   // 機車上離島中心最近的那一點
        const dx = (nx - cx) / hx, dy = (ly - 1.5) / ISLAND_RY;
        if (dx * dx + dy * dy < 1) return I;
    }
    return null;
}
const inWorks = (map, x0, x1) => (map.works || []).find(w => x1 > w.x0 && x0 < w.x1) || null;
const BOTTOM = (ly) => ly > LANES - 1 - 0.5;     // 最下面那道（施工擋住）

function addCar(g, type, lane, x, v, extra) {
    const c = { id: ++g.nextId, type, len: VEH[type].len, lane, ly: lane, x, v0: v, v, ...extra };
    g.cars.push(c);
    return c;
}

/**
 * 開一天。players：[{ id }]，依序排在車道 0、1、2、3。
 */
function createDay({ seed = 1, day = 0, players = [] } = {}) {
    const s = daySeed(seed, day), r = rng(s ^ 0xA5A5A5A5);
    const n = players.length || 1, df = difficulty(day, n), map = makeMap(s, day);
    const g = { seed: s, day, n, rand: r, map, tick: 0, t: -COUNTDOWN_S, nextId: 0, cars: [], players: [], over: false,
                mergeNext: map.islands.map(() => [df.merge * r(), df.merge * r()]), events: [] };
    // 開局的車流：每一道從前面一點開始往後鋪到終點
    for (let lane = 0; lane < LANES; lane++) {
        let x = 40 + r() * 60;
        while (x < map.len + 200) {
            const k = r(), type = k < df.truck ? 'truck' : k < df.truck + df.van ? 'van' : 'car';
            const [v0, v1] = VEH[type].v;
            // 最下面那道落在施工上的不放（圓環四道都能走，不用避）
            const blocked = lane === LANES - 1 && inWorks(map, x - 30, x + VEH[type].len + 10);
            if (!blocked) addCar(g, type, lane, Math.round(x), v0 + r() * (v1 - v0));
            x += VEH[type].len + df.gap[0] + r() * (df.gap[1] - df.gap[0]);
        }
    }
    players.forEach((p, i) => {
        g.players.push({ id: p.id, x: START_X, ly: i % LANES, v: 0, k: 0, sk: 0,
                         state: 'ride', why: null, hit: null, at: null, outAt: null });
    });
    return g;
}

/** 輸入：按著哪些鍵（KEY 的位元），狀態改變時才送 */
function setInput(g, id, k) {
    const p = g.players.find(q => q.id === id);
    if (p && p.state === 'ride') p.k = (k | 0) & 63;
}

function out(g, p, why, hit, ev) {
    if (p.state !== 'ride') return;
    p.state = 'out'; p.why = why; p.hit = hit || null; p.outAt = g.t; p.v = 0; p.k = 0; p.sk = 0;
    // 帶位置（伺服器的 log 用：哪裡撞的、騎在第幾道）
    ev.push({ type: 'out', id: p.id, why, hit: hit || null, x: Math.round(p.x * 10) / 10, ly: Math.round(p.ly * 100) / 100, t: Math.round(g.t * 10) / 10 });
}

// 車子往前：跟前車保持距離、黃燈紅燈在停止線前停下、中間兩道遇到圓環要換到外側。
// 玩家也算前車（車子不會從後面撞上來、換道不會切進玩家）：撞車一定是玩家自己騎上去的
function stepCars(g) {
    const map = g.map, t = g.t;
    const riders = g.players.filter(p => p.state === 'ride').map(p => ({ x: p.x, len: BIKE_LEN, ly: p.ly }));
    for (const c of g.cars) {
        // 最下面那道快到施工就往上一道換（那道離太近就先停在前面等）。圓環四道都能走，車子照常
        const W = (map.works || []).find(w => c.x + c.len > w.x0 - 40 && c.x < w.x1);
        const block = W && c.lane === LANES - 1 ? [W.x0, LANES - 2] : null;
        if (block) {
            const to = block[1];
            const clear = ![...g.cars, ...riders].some(o => o !== c && Math.abs(o.ly - to) < 1 && o.x < c.x + c.len + 6 && o.x + o.len > c.x - 10);
            if (clear) c.lane = to; else c.hold = block[0] - 2;
        } else c.hold = null;
        if (c.ly !== c.lane) {
            const d = c.lane - c.ly, s = LANE_V * 0.5 * DT;
            c.ly = Math.abs(d) <= s ? c.lane : c.ly + Math.sign(d) * s;
        }
    }
    for (const c of g.cars) {
        let lim = Infinity;
        const front = c.x + c.len;
        if (c.ly < 0 || c.ly > LANES - 1) { c.x += c.v0 * 0.4 * DT; continue; }   // 支線匯入中：慢慢擠進來
        for (const L of map.lights) {
            if (front <= L.x - 0.5 && front > L.x - 60 && lightAt(map, L, t) !== 'G') lim = Math.min(lim, L.x - 1);
        }
        if (c.hold != null && front <= c.hold + 0.5) lim = Math.min(lim, c.hold);
        for (const o of g.cars.concat(riders)) {
            if (o === c || o.x <= c.x || Math.abs(o.ly - c.ly) >= FOLLOW_LY) continue;
            lim = Math.min(lim, o.x - 3);
        }
        const want = front + c.v0 * DT;
        const nf = Math.min(want, Math.max(front, lim));
        c.v = (nf - front) / DT;
        c.x = nf - c.len;
    }
    // 圓環支線：上下兩路各自定時匯入一台（從馬路外面擠進外側車道）
    const df = difficulty(g.day, g.n);
    map.islands.forEach((I, k) => {
        for (const side of [0, 1]) {
            if (g.t < g.mergeNext[k][side]) continue;
            const lane = side ? LANES - 1 : 0;
            // 匯入口有人（車或玩家）就晚一點再進來，不會硬擠到人身上
            if ([...g.cars, ...riders].some(o => Math.abs(o.ly - lane) < 1.2 && o.x < I.mergeX + 16 && o.x + o.len > I.mergeX - 24)) {
                g.mergeNext[k][side] += 0.5; continue;
            }
            g.mergeNext[k][side] += df.merge * (0.7 + g.rand() * 0.6);
            const type = g.rand() < 0.3 ? 'van' : 'car';
            const [v0, v1] = VEH[type].v;
            addCar(g, type, lane, I.mergeX, v0 + g.rand() * (v1 - v0), { ly: side ? LANES - 0.2 : -0.8, merge: 1 });
        }
    });
    g.cars = g.cars.filter(c => c.x < map.len + 400);
}

/** 推進一拍。回傳這一拍發生的事（出局、到公司）。 */
function step(g) {
    if (g.over) return [];
    const ev = [];
    g.tick++; g.t += DT;
    if (g.t <= 0) return ev;   // 倒數中
    stepCars(g);
    const map = g.map;
    for (const p of g.players) {
        if (p.state !== 'ride') continue;
        const k = p.k, thr = k & KEY.thr, brk = k & KEY.brk;
        const my = (k & KEY.down ? 1 : 0) - (k & KEY.up ? 1 : 0);
        let a;
        if (brk && thr) { a = -SOFT; p.sk = 0; }
        else if (brk) {
            // 急煞看按下去那一刻的車速：快才急煞，一路急煞到放開或停住
            if (!p.sk && p.v > HARD_V && !p.braking) p.sk = 1;
            a = p.sk ? -HARD : -BRAKE;
        } else { a = thr ? ACC : -DRAG; p.sk = 0; }
        p.braking = !!brk;
        p.v = Math.max(0, Math.min(VMAX, p.v + a * DT));
        if (!p.v) p.sk = 0;
        const f0 = p.x + BIKE_LEN;
        p.x += p.v * DT;
        p.ly = Math.max(0, Math.min(LANES - 1, p.ly + my * VMOVE * DT));
        const f1 = p.x + BIKE_LEN;
        // 闖紅燈：紅燈時車頭越過停止線（黃燈不算）
        for (const L of map.lights) {
            if (f0 < L.x && f1 >= L.x && lightAt(map, L, g.t) === 'R') { out(g, p, 'red', null, ev); break; }
        }
        if (p.state !== 'ride') continue;
        // 撞到圓環中央島
        const h0 = p.x + HIT_PAD, h1 = f1 - HIT_PAD;   // 碰撞用的車身（前後各讓一點）
        if (hitIsland(map, h0, h1, p.ly)) { out(g, p, 'crash', 'island', ev); continue; }
        if (BOTTOM(p.ly) && inWorks(map, h0, h1)) { out(g, p, 'crash', 'works', ev); continue; }
        // 撞車
        const c = g.cars.find(c => Math.abs(c.ly - p.ly) < HIT_LY && h1 > c.x && h0 < c.x + c.len);
        if (c) { out(g, p, 'crash', c.type, ev); continue; }
        // 到公司
        if (f1 >= map.len) {
            p.state = 'done'; p.at = Math.round(g.t * 100) / 100; p.v = 0; p.k = 0; p.sk = 0;
            ev.push({ type: 'arrive', id: p.id, at: p.at });
        }
    }
    // 玩家互撞：雙方都出局（規格：A）
    const ride = g.players.filter(p => p.state === 'ride');
    for (let i = 0; i < ride.length; i++) for (let j = i + 1; j < ride.length; j++) {
        const a = ride[i], b = ride[j];
        if (Math.abs(a.ly - b.ly) < HIT_LY && a.x + BIKE_LEN - HIT_PAD > b.x + HIT_PAD && b.x + BIKE_LEN - HIT_PAD > a.x + HIT_PAD) {
            out(g, a, 'crash', 'bike', ev); out(g, b, 'crash', 'bike', ev);
            ev[ev.length - 1].pair = ev[ev.length - 2].pair = [a.id, b.id];
        }
    }
    // 09:00:00 還沒到 = 遲到
    if (g.t >= DAY_S) for (const p of g.players) if (p.state === 'ride') out(g, p, 'late', null, ev);
    for (const e of ev) g.events.push(e);
    if (g.players.every(p => p.state !== 'ride')) { g.over = true; ev.push({ type: 'over' }); }
    return ev;
}

/** 新聞走馬燈：只寫人數不寫名字。互撞算一起事件（兩名） */
const NUM = ['零', '一', '兩', '三', '四'];
function news(events) {
    const by = {}, lines = [];
    let pairs = 0;
    for (const e of events) {
        if (e.type !== 'out' || e.why !== 'crash') continue;
        if (e.hit === 'bike') { pairs++; continue; }
        by[e.hit] = (by[e.hit] || 0) + 1;
    }
    for (const k of ['works', 'truck', 'van', 'car', 'island']) {
        if (by[k]) lines.push('今日稍早' + (NUM[by[k]] || by[k]) + '名上班族於通勤途中與' + VEH_NAME[k] + '發生撞擊，不幸……');
    }
    pairs = Math.floor(pairs / 2);
    for (let i = 0; i < pairs; i++) lines.push('今日稍早兩名上班族於通勤途中互撞，不幸……');
    return lines;
}

/** 時鐘字串：08:58:00 起算 */
function clock(t) {
    const s = CLOCK0 + Math.max(0, Math.min(DAY_S, Math.floor(t)));
    const p2 = (n) => String(n).padStart(2, '0');
    return p2(Math.floor(s / 3600)) + ':' + p2(Math.floor(s / 60) % 60) + ':' + p2(s % 60);
}

/** 一週的成績：先比出勤天數，再比準時那幾天的總時間（少的前面） */
function rankWeek(rows) {
    return rows.slice().sort((a, b) => (b.days - a.days) || (a.total - b.total))
        .map((x, i) => ({ ...x, rank: i + 1 }));
}

/**
 * 傳給 daemon 的精簡狀態（每拍一包）。車子只送玩家附近的（整條路幾百台，全送太大）。
 * 紅綠燈直接送每盞現在的燈號（一個字一盞）。
 */
const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;
const VIEW_BACK = 60, VIEW_FWD = 160;
function snapshot(g) {
    const xs = g.players.filter(p => p.state === 'ride').map(p => p.x);
    const all = xs.length ? xs : g.players.map(p => p.x);
    const lo = Math.min(...all) - VIEW_BACK, hi = Math.max(...all) + VIEW_FWD;
    const TY = { car: 0, van: 1, truck: 2 };
    return {
        k: g.tick, t: r1(g.t), over: g.over,
        lt: g.map.lights.map(L => lightAt(g.map, L, g.t)).join(''),
        c: g.cars.filter(c => c.x + c.len > lo && c.x < hi).map(c => [c.id, r1(c.x), r1(c.ly), TY[c.type]]),
        // 玩家：id、x、ly、車速、狀態（0 騎／1 到了／2 出局）、原因、抵達時間、急煞中、按鍵
        p: g.players.map(p => [p.id, r2(p.x), r2(p.ly), r2(p.v), p.state === 'ride' ? 0 : p.state === 'done' ? 1 : 2,
                               p.why || 0, p.at || 0, p.sk, p.k]),
    };
}
/** 開一天時送一次的地圖（燈、圓環、路長） */
const mapPub = (g) => ({ day: g.day, len: g.map.len, lights: g.map.lights.map(L => L.x),
                         islands: g.map.islands.map(I => [I.x0, I.x1, I.mergeX]), works: (g.map.works || []).map(w => [w.x0, w.x1]) });

module.exports = {
    DT, TICK_MS, LANES, DAYS, COUNTDOWN_S, DAY_S, CLOCK0, BIKE_LEN, VMAX, ACC, DRAG, SOFT, BRAKE, HARD, HARD_V, VMOVE, LANE_V, HIT_LY, HIT_PAD, FOLLOW_LY, ISLAND_RY, ISLAND_RX, VEH, VEH_NAME, LIGHT, ISLAND_LEN, WORK_LEN, KEY,
    CROWD, hitIsland, rng, daySeed, difficulty, makeMap, lightAt, createDay, setInput, step, news, clock, rankWeek, snapshot, mapPub,
};
