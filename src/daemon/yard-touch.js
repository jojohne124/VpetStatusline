'use strict';
/**
 * yard-touch.js — 營地裡每一隻的互動狀態（摸摸 / 抓起放下）
 *
 * 從 daemon.js 抽出來，唯一的理由是**可測試**：daemon.js 在 require 的當下就
 * server.listen，測試沒辦法載入它，於是這段邏輯以前只能靠肉眼在瀏覽器上驗。
 * 停走的拍數會累加、會結清、還要跨反應保管，這種帳最不該只靠肉眼。
 *
 * 純表演，不動心情值、不寫 ranch.json —— 營地是冰箱，裡面的東西不會因為你戳牠
 * 而成長或變壞。所以狀態全在記憶體，daemon 一關就沒了，那正好是它該有的生命週期。
 *
 * ⚠️ 抓起放下的**落點也只在記憶體**：daemon 重開後大家回到各自 seed 決定的起點。
 *    要讓擺位留著就得寫進 ranch.json，那會讓「冰箱不留痕跡」這條原則破例 ——
 *    丟放確實是刻意的擺放（跟隨手戳一下性質不同），所以那個例外可能是合理的，
 *    但那是產品決定，先做不留的版本（可逆），要留再加。
 *
 * 摸摸與抓放放在同一個檔，是因為它們動到**同一條時間線**：兩者都要讓那隻停下來，
 * 而「停了幾拍」跟「從哪裡重新起算」最後會合成同一個 joinStep。拆兩個模組各自
 * 改同一個時間軸，遲早會出現「跳到一半被拿起來，放下後時間對不上」那種帳。
 *
 * 時間一律由外面傳進來（now / stepAt），測試才不用真的等 1.8 秒。
 */

// ── 表演參數 ───────────────────────────────────────────────────────
const REACT_MS = 1800;   // 一次反應演多久
const JUMP_H   = 4;      // 開心時原地跳多高（dot；角色本身 16 dot 高）
// 上、下各多久。**必須 >= 前端的輪詢間隔 POLL_MS**，否則那一下會被取樣漏掉；
// 目前設成相等，也就是騰空剛好佔一個畫面。
const JUMP_MS  = 250;
// 院子的輪詢間隔。**跳躍的騰空時間就是被這個數字綁住的**，所以兩個放在一起：
// 畫面只有 1000/POLL_MS fps，騰空短於一次輪詢就會被取樣漏掉 ——
// 有時候整個看不到牠跳，有時候連續取到的都是最高點、看起來是浮在空中。
// 要再縮短騰空就得連這個一起調小（前端從這裡取值，見 daemon.js 的 pollLoop）。
// 500 → 250：500ms 的騰空看起來太久，像慢動作停在半空。
const POLL_MS  = 250;
// 跳幾下。反應有 1.8 秒，跳完剩下的時間就站著演 HAPPY ——
// 1 下讀起來是「被摸了很高興，蹦一下」；連跳到反應結束比較像在原地蹦跳不停。
const JUMP_HOPS = 1;
// 拿在手上最久多久。超過就自動放回場上 —— 這是**唯一**能救「拖到一半把分頁關掉」的機制：
// 那種情況前端根本沒機會送 yardDrop，伺服器會一直以為牠在你手上，
// 而被拿著的那隻不進合成 → 從畫面上整個消失，重開 daemon 才回得來。
// 30 秒對真的在拖的人來說夠長；真的超過也只是掉回場上，不會弄丟任何東西。
const HELD_MAX_MS = 30000;

// ── 列隊（2026-10-29）：按一下，大家快步排到畫面那一頁，站好 10 秒再散開 ──
// 節奏分四段（從按下去算）：
//   1. 聽到口令：原地蹦一下（HAPPY），讓人看出「收到了」，不是直接滑走
//   2. 快步走位：**大家同時出發、同時到** —— 每隻的速度依距離調，整齊感就是靠這個；
//      頭尾放慢（ease-in-out），不然 4fps 的輪詢下看起來像瞬移
//   3. 立正：到位後一起再蹦一下，面向統一
//   4. 站好：待機呼吸，直到 LINEUP_MS 才散開
const LINEUP_MS       = 10000;   // 按下去到散開（含走位）
const LINEUP_CUE_MS   = 350;     // 1. 聽到口令
const LINEUP_MARCH_MS = 1200;    // 2. 走位
const LINEUP_SALUTE_MS = 400;    // 3. 立正
const LINEUP_FACING   = 'right'; // 站好時大家朝同一邊

/**
 * 「原地」不能只是把畫的位置釘住 —— 走路演算法照跑的話，落地會瞬移回它算出來的
 * 位置（1.8 秒約 2~3 dot，每摸一次閃一下）。所以把停走的拍數累加起來，
 * 之後一律從 joinStep 扣掉：對走路演算法而言這隻的時間在跳躍期間是停的，
 * 落地後無縫接回。
 *
 * ⚠️ holdSteps 是這隻的**永久時間位移**，反應演完也要一直帶著。
 * 丟掉就等於把停走那幾拍還回去，畫面上就是瞬移 —— 也就是這整段想避免的事。
 */
function settleHold(t, untilStep) {
    if (t.holdFrom == null) return;
    t.holdSteps += Math.max(0, untilStep - t.holdFrom);
    t.holdFrom = null;
}

function newTouch() {
    return { times: [], sulkUntil: 0, until: 0, frame: null,
             start: 0,          // 這次反應何時開始（算跳躍相位用）
             holdFrom: null,    // 從第幾拍開始停走（null = 沒在停）
             holdSteps: 0,      // 累計停走了幾拍
             held: false,       // 正被拿在手上（畫面由前端跟著游標畫，合成時要略過）
             heldAt: 0,         // 什麼時候被拿起來的（給上面那個逾時用）
             anchor: null };    // 放下的落點 { origin:{x,y,facing}, step }
}

/**
 * @param windowMs/limit/sulkMs 連戳門檻。跟現役那隻共用同一組數字，
 *        但計數**每隻各自獨立** —— 戳 A 五下不該讓 B 也生氣。
 * @param stepAt  毫秒 → 第幾拍（plaza-walk 的 stepAt）
 */
function create({ windowMs, limit, sulkMs, stepAt,
                  reactMs = REACT_MS, jumpH = JUMP_H, jumpMs = JUMP_MS,
                  jumpHops = JUMP_HOPS, heldMaxMs = HELD_MAX_MS } = {}) {
    const touches = new Map();   // ranchId -> newTouch()
    // 列隊中：{ start, until, ents: Map<id, {from:{x,y,facing}, to:{x,y}}> }（走路格座標）。只在記憶體，同摸摸
    let lineup = null;

    /** 列隊中這一隻在 now 的位置與動作（見上面的四段節奏） */
    function lineupAt(e, now) {
        const t = now - lineup.start, M0 = LINEUP_CUE_MS, M1 = M0 + LINEUP_MARCH_MS;
        const hop = (t0) => (t - t0 < jumpMs ? jumpH : 0);
        if (t < M0) return { x: e.from.x, y: e.from.y, facing: e.from.facing, moving: false, frame: 'HAPPY', jump: hop(0) };
        if (t < M1) {
            const u = (t - M0) / LINEUP_MARCH_MS, k = u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u);
            const dx = e.to.x - e.from.x;
            return { x: Math.round(e.from.x + dx * k), y: Math.round(e.from.y + (e.to.y - e.from.y) * k),
                     facing: dx < 0 ? 'left' : dx > 0 ? 'right' : e.from.facing, moving: true, frame: null, jump: 0 };
        }
        const salute = t < M1 + LINEUP_SALUTE_MS;
        return { x: e.to.x, y: e.to.y, facing: LINEUP_FACING, moving: false,
                 frame: salute ? 'HAPPY' : null, jump: salute ? hop(M1) : 0 };
    }

    /** 散開：每隻從隊伍裡的位置走一條全新的鏈（跟放下同一套 anchor），時間從列隊結束那一拍起算 */
    function lineupEnd() {
        const step = stepAt(lineup.until);
        for (const [id, e] of lineup.ents) {
            let t = touches.get(id);
            if (!t) { t = newTouch(); touches.set(id, t); }
            if (t.held) continue;
            t.holdFrom = null; t.holdSteps = 0;
            t.anchor = { origin: { x: e.to.x, y: e.to.y, facing: LINEUP_FACING }, step };
        }
        lineup = null;
    }

    /**
     * 開始列隊。ents = [{ id, from:{x,y,facing}, to:{x,y} }]（走路格座標；站位由呼叫端排）。
     * 列隊中再按一次 = 從現在的位置重排一次。
     */
    function lineupStart(ents, now = Date.now()) {
        lineup = { start: now, until: now + LINEUP_MS, ents: new Map(ents.map(e => [e.id, e])) };
        return { until: lineup.until };
    }

    /** 摸一下。回傳 mood：happy / refuse / sulking。 */
    function pet(id, now = Date.now()) {
        const nowStep = stepAt(now);
        let t = touches.get(id);
        if (!t) { t = newTouch(); touches.set(id, t); }
        if (now < t.sulkUntil) return 'sulking';
        t.times = t.times.filter(x => now - x < windowMs);
        t.times.push(now);
        let mood = 'happy';
        if (t.times.length >= limit) { mood = 'refuse'; t.sulkUntil = now + sulkMs; t.times = []; }
        t.frame = (mood === 'refuse') ? 'REFUSE' : 'HAPPY';
        t.until = now + reactMs;
        t.start = now;
        // 開心才原地跳。不爽不跳 —— 被戳到生氣的那隻本來就該走開，
        // 讓牠原地蹦反而像在鬧脾氣的同時很開心。
        // 連摸兩下都是開心 → 不重開 holdFrom，維持同一段停走（重開會少算中間那幾拍）。
        if (mood === 'happy') { if (t.holdFrom == null) t.holdFrom = nowStep; }
        else settleHold(t, nowStep);   // 從開心翻臉成不爽 → 就地結清，之後照常走
        return mood;
    }

    /**
     * 每隻目前的狀態：Map<id, {frame, jump, holdSteps}>。
     * @param alive 還在營地裡的 id（Set）。不傳就不回收 —— 只有 /yard 那條路徑知道名單。
     */
    function react(alive, now = Date.now()) {
        const nowStep = stepAt(now);
        const out = new Map();
        if (lineup && now >= lineup.until) lineupEnd();
        for (const [id, t] of touches) {
            if (alive && !alive.has(id)) { touches.delete(id); continue; }   // 已經不在營地了
            // 拿太久 = 拿的人已經不在了（關分頁 / 重新整理 / 斷線）。放回場上，
            // 讓牠從凍結的那個位置繼續走 —— 沒有落點可以用，也不該憑空指定一個。
            if (t.held && now - t.heldAt > heldMaxMs) {
                t.held = false;
                settleHold(t, nowStep);
            }
            // 拿在手上：時間停著、合成時略過。反應幀不演（手上那隻由前端畫）。
            if (t.held) {
                out.set(id, { frame: null, jump: 0, held: true, anchor: t.anchor,
                              holdSteps: t.holdSteps
                                       + (t.holdFrom != null ? Math.max(0, nowStep - t.holdFrom) : 0) });
                continue;
            }
            if (t.until > now) {
                // 相位從**這次反應開始**起算，所以按下去的第一幀就是騰空的，點了立刻有反應。
                // 第 n 下佔用相位 2n（上）與 2n+1（下）；跳完就落地站著把反應演完。
                const phase = Math.floor((now - t.start) / jumpMs);
                const up = phase < jumpHops * 2 && phase % 2 === 0;
                out.set(id, {
                    frame: t.frame,
                    jump:  (t.holdFrom != null && up) ? jumpH : 0,
                    held: false, anchor: t.anchor,
                    holdSteps: t.holdSteps
                             + (t.holdFrom != null ? Math.max(0, nowStep - t.holdFrom) : 0),
                });
                continue;
            }
            settleHold(t, stepAt(t.until));
            // 反應演完了，但只要曾經停過走就得繼續回報 holdSteps（見 settleHold）。
            if (t.holdSteps || t.anchor)
                out.set(id, { frame: null, jump: 0, held: false,
                              anchor: t.anchor, holdSteps: t.holdSteps });
            // 連戳窗口與鬧脾氣都過去了，也沒有時間位移要保管 → 這筆沒有資訊了，回收
            else if (now > t.sulkUntil && !t.times.length) touches.delete(id);
        }
        // 列隊中：位置由隊形決定（at），走路演算法照算但不採用。摸摸的反應幀、跳躍優先（被摸還是會開心）
        if (lineup) for (const [id, e] of lineup.ents) {
            if (alive && !alive.has(id)) continue;
            const prev = out.get(id) || { frame: null, jump: 0, held: false, anchor: null, holdSteps: 0 };
            if (prev.held) continue;
            const L = lineupAt(e, now);
            out.set(id, { ...prev, frame: prev.frame || L.frame, jump: prev.jump || L.jump,
                          at: { x: L.x, y: L.y, facing: L.facing, moving: L.moving } });
        }
        return out;
    }

    /**
     * 拿起來。回傳 false = 這隻正被拿著（重複的 grab，忽略）。
     * 拿在手上的時候時間要停 —— 沿用摸摸那套 holdFrom/holdSteps，不另外發明一份。
     */
    function grab(id, now = Date.now()) {
        const nowStep = stepAt(now);
        let t = touches.get(id);
        if (!t) { t = newTouch(); touches.set(id, t); }
        if (t.held) return false;
        if (lineup) lineup.ents.delete(id);           // 列隊中被拎走就脫隊（放下後照落點走，散開時不拉回隊伍）
        t.held = true;
        t.heldAt = now;
        t.until = 0;                                   // 拿起來就中斷正在演的反應（含跳到一半）
        t.frame = null; 
        if (t.holdFrom == null) t.holdFrom = nowStep;  // 已經在停就不重開，否則中間那幾拍白扣
        return true;
    }

    /**
     * 放下。落點成為新的起點，joinStep 設成當下 → 從那裡走一條全新的鏈。
     * 停走的帳就地歸零：時間軸已經整個換掉了，之前累計的位移沒有意義。
     * 回傳 false = 根本沒被拿著（例如放開時 daemon 剛重開過）。
     */
    function drop(id, x, y, facing, now = Date.now()) {
        const t = touches.get(id);
        if (!t || !t.held) return false;
        t.held = false;
        t.holdFrom = null;
        t.holdSteps = 0;
        t.anchor = { origin: { x: Math.round(x), y: Math.round(y), facing: facing || 'right' },
                     step: stepAt(now) };
        return true;
    }

    /**
     * 正被拿在手上的 id。合體進化要用：拿著的那隻不能被拿去合體 —— 否則畫面上被抓著的
     * 寵物會突然消失。逾時的不算（拿的人已經不在了，react() 下一輪就會放回場上）。
     */
    function heldIds(now = Date.now()) {
        const out = new Set();
        for (const [id, t] of touches) if (t.held && now - t.heldAt <= heldMaxMs) out.add(id);
        return out;
    }

    return { pet, react, grab, drop, heldIds, touches, lineupStart, lineupInfo: () => lineup };
}

module.exports = { create, settleHold, newTouch, REACT_MS, JUMP_H, JUMP_MS, JUMP_HOPS, POLL_MS, HELD_MAX_MS,
                   LINEUP_MS, LINEUP_CUE_MS, LINEUP_MARCH_MS, LINEUP_SALUTE_MS, LINEUP_FACING };
