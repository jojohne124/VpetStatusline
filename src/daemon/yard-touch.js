'use strict';
/**
 * yard-touch.js — 牧場裡每一隻的互動狀態（摸摸 / 抓起放下）
 *
 * 從 daemon.js 抽出來，唯一的理由是**可測試**：daemon.js 在 require 的當下就
 * server.listen，測試沒辦法載入它，於是這段邏輯以前只能靠肉眼在瀏覽器上驗。
 * 停走的拍數會累加、會結清、還要跨反應保管，這種帳最不該只靠肉眼。
 *
 * 純表演，不動心情值、不寫 ranch.json —— 牧場是冰箱，裡面的東西不會因為你戳牠
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

    return { pet, react, grab, drop, touches };
}

module.exports = { create, settleHold, newTouch, REACT_MS, JUMP_H, JUMP_MS, JUMP_HOPS, POLL_MS, HELD_MAX_MS };
