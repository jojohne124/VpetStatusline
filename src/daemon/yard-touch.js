'use strict';
/**
 * yard-touch.js — 牧場裡「摸摸」的狀態機
 *
 * 從 daemon.js 抽出來，唯一的理由是**可測試**：daemon.js 在 require 的當下就
 * server.listen，測試沒辦法載入它，於是這段邏輯以前只能靠肉眼在瀏覽器上驗。
 * 停走的拍數會累加、會結清、還要跨反應保管，這種帳最不該只靠肉眼。
 *
 * 純表演，不動心情值、不寫 ranch.json —— 牧場是冰箱，裡面的東西不會因為你戳牠
 * 而成長或變壞。所以狀態全在記憶體，daemon 一關就沒了，那正好是它該有的生命週期。
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
             holdSteps: 0 };    // 累計停走了幾拍
}

/**
 * @param windowMs/limit/sulkMs 連戳門檻。跟現役那隻共用同一組數字，
 *        但計數**每隻各自獨立** —— 戳 A 五下不該讓 B 也生氣。
 * @param stepAt  毫秒 → 第幾拍（plaza-walk 的 stepAt）
 */
function create({ windowMs, limit, sulkMs, stepAt,
                  reactMs = REACT_MS, jumpH = JUMP_H, jumpMs = JUMP_MS,
                  jumpHops = JUMP_HOPS } = {}) {
    const touches = new Map();   // ranchId -> newTouch()

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
     * @param alive 還在牧場裡的 id（Set）。不傳就不回收 —— 只有 /yard 那條路徑知道名單。
     */
    function react(alive, now = Date.now()) {
        const nowStep = stepAt(now);
        const out = new Map();
        for (const [id, t] of touches) {
            if (alive && !alive.has(id)) { touches.delete(id); continue; }   // 已經不在牧場了
            if (t.until > now) {
                // 相位從**這次反應開始**起算，所以按下去的第一幀就是騰空的，點了立刻有反應。
                // 第 n 下佔用相位 2n（上）與 2n+1（下）；跳完就落地站著把反應演完。
                const phase = Math.floor((now - t.start) / jumpMs);
                const up = phase < jumpHops * 2 && phase % 2 === 0;
                out.set(id, {
                    frame: t.frame,
                    jump:  (t.holdFrom != null && up) ? jumpH : 0,
                    holdSteps: t.holdSteps
                             + (t.holdFrom != null ? Math.max(0, nowStep - t.holdFrom) : 0),
                });
                continue;
            }
            settleHold(t, stepAt(t.until));
            // 反應演完了，但只要曾經停過走就得繼續回報 holdSteps（見 settleHold）。
            if (t.holdSteps) out.set(id, { frame: null, jump: 0, holdSteps: t.holdSteps });
            // 連戳窗口與鬧脾氣都過去了，也沒有時間位移要保管 → 這筆沒有資訊了，回收
            else if (now > t.sulkUntil && !t.times.length) touches.delete(id);
        }
        return out;
    }

    return { pet, react, touches };
}

module.exports = { create, settleHold, newTouch, REACT_MS, JUMP_H, JUMP_MS, JUMP_HOPS, POLL_MS };
