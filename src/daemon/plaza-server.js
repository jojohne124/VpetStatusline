'use strict';
/**
 * plaza-server.js — 廣場伺服器（docs/plaza-spec.md §二、§四）
 *
 * 跑在一台內網主機上，所有人的 daemon 連過來。用法（在主機上）：
 *   npm run plaza-host            （= node src/daemon/plaza-server.js）
 *   VPET_PLAZA_PORT=37373          可改 port
 *
 * 刻意是**獨立程式**，不住在主機自己的 daemon 裡：主機也是玩家，會常常重開 daemon，
 * 伺服器若跟著重開，全場的人每次都會被踢回前線。
 *
 * 設計重點：
 *   - 伺服器**不推進任何位置**。它只發每個人的走路起點（seed / joinStep / 進場的起點與
 *     定位點），各 daemon 用 src/shared/plaza-walk.js 自己算所有人的位置。
 *   - **連線就是在場**：SSE 斷掉超過 graceMs 沒接回來就移出名單。
 *   - 全部存在記憶體，重開 = 清空。內網、小規模，沒有要保存的東西。
 *   - 只用 node 內建的 http（上行 POST、下行 SSE），零相依 —— 這個 repo 沒有 npm 相依，
 *     安裝流程也沒有 npm install。
 */
const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const W      = require('../shared/plaza-walk.js');
const ST     = require('../shared/stairs-sim.js');   // 下樓梯（docs/plaza-stairs-spec.md）
const DN     = require('../shared/dino-sim.js');     // 小恐龍（docs/plaza-dino-spec.md）

const DEFAULT_PORT = 37373;
const CAP          = 20;        // 同時在場上限（畫面可讀性決定，見規格 §九）
const GRACE_MS     = 10000;     // 斷線多久沒接回來就算離場
const PING_MS      = 15000;     // SSE 心跳：讓兩邊都知道連線還活著（也讓中間的設備不要掐掉閒置連線）
const BODY_LIMIT   = 4096;
// 聊天（規格 §七）：只存記憶體、不落地；伺服器重開就清空
const CHAT_KEEP    = 50;        // 保留最近幾則（進場時一併給）
const CHAT_MAX     = 100;       // 一則幾個字
const CHAT_GAP_MS  = 1000;      // 每人每秒最多 1 則
// 開心鈕：一次演 1.8 秒（同營地摸摸的 REACT_MS），演完才能再按 —— 連按只會讓畫面一直抖
const EMOTE_MS     = 1800;
// 對戰（規格 §八）
const INVITE_MS    = 30000;     // 邀請多久沒回就當作拒絕
// 對戰演出多長：前線的戰鬥最長 21 拍（cut-in 版）x 750ms ≈ 15.8 秒，再加上「下一拍才開演」
// 與 daemon 輪詢的延遲。這段期間兩隻停在原地、旁觀的人看到頭上的 ⚔。
const BATTLE_MS    = 18000;
const FIELD        = W.PLAZA_LIVE_FIELD;   // 廣場的走路場地（大小比照營地畫面，見 plaza-walk）
// 管理（踢人、刪聊天）：要帶管理金鑰。金鑰是主機上的一個檔，plaza-host 第一次啟動時產生；
// 開發版 daemon 讀同一個檔（同一台機器）。只留在主機，不進 repo、不出貨。
const ADMIN_KEY_FILE = process.env.VPET_PLAZA_ADMIN_KEY || path.join(os.homedir(), '.vpet', 'plaza-admin.key');
const KICK_BAN_MS  = 5 * 60 * 1000;   // 被踢的名牌多久不能再進來（不然對方馬上又進來，踢了等於沒踢）
// 下樓梯（docs/plaza-stairs-spec.md）：房間、50ms 遊戲迴圈、排行榜
const STAIRS_VER      = 1;       // 協定版本：對不上的 daemon 看不到房間（規格 §六）
const STAIRS_CAP      = 4;       // 一房幾人（規格 §一）
const STAIRS_LOST_MS  = 3000;    // 遊戲中斷線多久算出局（不能讓一個人的網路卡住整局）
const STAIRS_BOARD_N  = 50;      // 排行榜留幾名
const STAIRS_BOARD_FILE = process.env.VPET_STAIRS_BOARD || path.join(os.homedir(), '.vpet', 'stairs-board.json');
// 小恐龍：位置各自算，伺服器只發 seed、轉送位置、收成績（規格 §二）
const DINO_BOARD_FILE = process.env.VPET_DINO_BOARD || path.join(os.homedir(), '.vpet', 'dino-board.json');
const STAIRS_NAMES = { stairs: '🪜 下樓梯', dino: '🦖 小恐龍', volley: '🏐 打排球', gomoku: '⚫ 五子棋' };   // 聊天室系統訊息用
// 五子棋（docs/plaza-gomoku-spec.md）：輪流下，伺服器判定（不吃時機，不用輸入同步）
const GOMOKU_N = 15;
const GOMOKU_END_MS = 2500;      // 連成五子之後，留幾毫秒讓大家看清楚最後一手，再結算
// 打排球（docs/plaza-volley-spec.md）：1 對 1、輸入同步。伺服器只轉送每一格的按鍵、收結果
const VOLLEY_COUNTDOWN_MS = 2000;
const capOf = (r) => (r.kind === 'volley' || r.kind === 'gomoku' ? 2 : STAIRS_CAP);
/** 五子棋：(x,y) 這一子往四個方向連了幾顆（取最長） */
function gomokuLine(board, x, y) {
    const c = board[y * GOMOKU_N + x];
    let best = 1;
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
        let n = 1;
        for (const s of [1, -1]) {
            let i = x + dx * s, j = y + dy * s;
            while (i >= 0 && j >= 0 && i < GOMOKU_N && j < GOMOKU_N && board[j * GOMOKU_N + i] === c) { n++; i += dx * s; j += dy * s; }
        }
        best = Math.max(best, n);
    }
    return best;
}
/**
 * 五子棋的表情（下完一手之後兩邊的 vpet）：
 *   下的人：連成五 → 開心；四 → 攻擊（逼對方）；三 → 開心；其他 → 待機
 *   對手：  被連成四 → 受傷；三 → 生氣；其他 → 待機
 */
function gomokuExpr(len) {
    if (len >= 5) return ['HAPPY', 'SAD'];
    if (len === 4) return ['ATTACK', 'HURT'];
    if (len === 3) return ['HAPPY', 'ANGRY'];
    return ['IDLE', 'IDLE'];
}
const DINO_COUNTDOWN_MS = 2000;  // 出發後幾毫秒才起跑（大家用伺服器時間對齊）
const DINO_STALE_MS     = 5000;  // 多久沒回報就當作撞到了（關分頁、當掉、重新整理）

// 讀管理金鑰；create = 沒有就產生一把（只有 plaza-host 主程式會這樣叫）。讀不到 = null（管理功能關閉）
function loadAdminToken(file = ADMIN_KEY_FILE, create = false) {
    try { const t = fs.readFileSync(file, 'utf8').trim(); if (t) return t; } catch (e) {}
    if (!create) return null;
    const t = crypto.randomBytes(24).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, t + '\n', { mode: 0o600 });
    return t;
}

// 輸入一律不信任。名牌沿用 `vpet code` 的規則（statusline-cheat 的 validId），
// 角色 id 是檔名那一套字元。
const validName  = (s) => typeof s === 'string' && /^[\p{L}\p{N}]{1,16}$/u.test(s);
const validChar  = (s) => typeof s === 'string' && /^[A-Za-z0-9_\-]{1,48}$/.test(s);
const validStage = (s) => typeof s === 'string' && /^[A-Za-z\-]{1,20}$/.test(s);
// 名牌顏色：#rrggbb。沒給 = null（前端用預設：自己黃、別人白）
const validColor = (s) => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
const numOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function createPlazaServer(opts = {}) {
    const cap     = opts.cap     ?? CAP;
    const graceMs = opts.graceMs ?? GRACE_MS;
    const pingMs  = opts.pingMs  ?? PING_MS;
    const now     = opts.now     || Date.now;
    const log     = opts.log     || (() => {});
    const inviteMs = opts.inviteMs ?? INVITE_MS;
    const battleMs = opts.battleMs ?? BATTLE_MS;
    const rand     = opts.rand     || Math.random;   // 測試可以固定勝負
    const adminToken = opts.adminToken || null;      // null = 管理功能關閉
    const kickBanMs  = opts.kickBanMs ?? KICK_BAN_MS;
    const banned = new Map();    // 名牌（小寫）-> 解禁時間
    const stairsBoardFile = opts.stairsBoardFile || STAIRS_BOARD_FILE;
    const stairsTickMs    = opts.stairsTickMs ?? ST.TICK_MS;
    const stairsLostMs    = opts.stairsLostMs ?? STAIRS_LOST_MS;
    const dinoBoardFile   = opts.dinoBoardFile || DINO_BOARD_FILE;
    const dinoStaleMs     = opts.dinoStaleMs ?? DINO_STALE_MS;
    const dinoCountdownMs = opts.dinoCountdownMs ?? DINO_COUNTDOWN_MS;

    const members = new Map();   // id -> { id, name, char, stage, card, walk, stream, lostAt, chatAt }
    const chat = [];             // 最近 CHAT_KEEP 則：{ seq, at, from, name, color, text } 或 { seq, at, sys:true, text }
    let chatSeq = 0;
    function pushChat(entry) {
        const e = { seq: ++chatSeq, at: now(), ...entry };
        chat.push(e);
        if (chat.length > CHAT_KEEP) chat.splice(0, chat.length - CHAT_KEEP);
        broadcast('chat', e);
        return e;
    }
    const sys = (text) => pushChat({ sys: true, text });

    // mode：自動／手動（對戰中 walk 會被暫時改成原地不動，所以模式要另外記）
    // battle：正在對戰（旁觀的人在頭上畫 ⚔）
    // costume：要不要讓別人看到我的節日造型（本人決定，大家看到的一樣）。
    // 伺服器只轉送這個旗標，不管今天是不是節日 —— 那由各台 daemon 用伺服器時間判斷。
    const pub = (m) => ({ id: m.id, name: m.name, color: m.color, char: m.char, stage: m.stage, walk: m.walk,
                          mode: m.mode || 'auto', battle: !!m.battle, costume: m.costume !== false });
    const roster = () => [...members.values()].map(pub);

    function send(m, event, data) {
        if (!m.stream) return;
        try { m.stream.write(`event: ${event}\ndata: ${JSON.stringify({ ...data, serverNow: now() })}\n\n`); }
        catch (e) { /* 寫不進去就等 close 事件收尾 */ }
    }
    function broadcast(event, data, exceptId) {
        for (const m of members.values()) if (m.id !== exceptId) send(m, event, data);
    }
    function remove(id, reason) {
        const m = members.get(id);
        if (!m) return;
        members.delete(id);
        stairsLeave({ id }, true);
        if (m.stream) { try { m.stream.end(); } catch (e) {} m.stream = null; }
        // 邀請中的人走了 → 邀請作廢（對戰中的那場照常演完，另一邊不受影響）
        for (const inv of [...invites.values()]) if (inv.from === id || inv.to === id) closeInvite(inv, 'left');
        broadcast('leave', { id, reason });
        // 同名取代＝同一個人換了一台 daemon 進來，不是真的離開，不報
        if (reason !== 'replaced' && reason !== 'kicked') sys(`${m.name} 離開了`);
        log(`離場：${m.name}（${reason}）。在場 ${members.size} 人`);
    }

    function join(body) {
        const { name, char, stage } = body || {};
        if (!validName(name))  return { status: 400, body: { ok: false, error: '名牌不合法（1~16 個中英數字）' } };
        if (!validChar(char))  return { status: 400, body: { ok: false, error: '角色 id 不合法' } };
        if (!validStage(stage)) return { status: 400, body: { ok: false, error: '階級不合法' } };
        const ban = banned.get(name.toLowerCase());
        if (ban && ban > now()) {
            return { status: 403, body: { ok: false, error: `你被管理員移出廣場，${Math.ceil((ban - now()) / 60000)} 分鐘後再來` } };
        }
        // 同名：後進的取代先進的（同一個人開了兩個 daemon 也是這樣）。
        // 先進的那個要被明確告知，否則它會以為只是斷線、一直重連。
        for (const m of [...members.values()]) {
            if (m.name === name) { send(m, 'kicked', { reason: 'replaced' }); remove(m.id, 'replaced'); }
        }
        if (members.size >= cap) {
            return { status: 409, body: { ok: false, error: `廣場人太多了（${cap} 人），晚點再來` } };
        }
        const c = body.card || {};
        // str = 對戰用的戰力（daemon 端算好：min(基礎 + 訓練值, 階級上限)，跟幽靈對戰同一套）
        const card = { power: numOr(c.power, 0), train: numOr(c.train, 0) };
        card.str = numOr(c.str, card.power + card.train);
        const id   = crypto.randomBytes(8).toString('hex');
        const seed = crypto.randomBytes(4).readUInt32BE(0) >>> 1;
        // 跟 daemon 端 plaza.js 的 PLAZA_LIVE_FIELD 是同一塊，兩邊必須一致
        const e    = W.entryWalk(seed, FIELD);
        const walk = { seed, joinStep: W.stepAt(now()), origin: e.origin, anchor: e.anchor };
        // lostAt = now：join 之後要在 graceMs 內接上 SSE，不然一樣當作離場
        // （join 成功但 daemon 當場死掉的情況，不能留一隻幽靈在場上）。
        const color = validColor(body.color) ? body.color.toLowerCase() : null;
        const costume = body.costume !== false;   // 沒帶（舊版 daemon）= 預設給看
        // 玩家代號：每台 daemon 自己產生、固定不變（排行榜靠它認人，改名才會跟著換）。舊版 daemon 沒帶 = null
        const pid = typeof body.pid === 'string' && /^[0-9a-f]{16,32}$/.test(body.pid) ? body.pid : null;
        const m = { id, name, color, costume, char, stage, card, walk, mode: 'auto', battle: null, stream: null, lostAt: now(), pid };
        members.set(id, m);
        boardsSync(m);   // 在廣場外改過名（vpet code）也要跟上；舊紀錄（沒有代號）名字對得上就綁給他
        broadcast('enter', pub(m), id);
        sys(`${name} 進入廣場`);
        log(`進場：${name}（${char}）。在場 ${members.size} 人`);
        return { status: 200, body: { ok: true, id, me: pub(m), roster: roster(), chat } };
    }

    // 改名牌／名牌顏色：在場上隨時可以改（兩個欄位都可省略，只改有給的）。
    // 跟別人撞名就拒絕 —— 進場時的「後進取代先進」是為了同一個人開兩個 daemon；
    // 場上改名撞到的一定是別人，不能因此把對方踢出去。
    function update(body) {
        const { id } = body || {};
        const m = members.get(id);
        if (!m) return { status: 404, body: { ok: false, error: '不在廣場名單裡' } };
        const name  = body.name  !== undefined ? body.name  : m.name;
        const color = body.color !== undefined ? body.color : m.color;
        if (!validName(name)) return { status: 400, body: { ok: false, error: '名牌不合法（1~16 個中英數字）' } };
        if (color !== null && !validColor(color)) return { status: 400, body: { ok: false, error: '顏色不合法（#rrggbb）' } };
        // 不分大小寫：Kai 跟 KAI 在廣場上看起來是同一個人
        if (name !== m.name && [...members.values()].some(o => o.id !== id && o.name.toLowerCase() === name.toLowerCase())) {
            return { status: 409, body: { ok: false, error: `廣場上已經有人叫「${name}」了` } };
        }
        const c = color ? color.toLowerCase() : null;
        const costume = body.costume !== undefined ? body.costume !== false : m.costume;
        if (name === m.name && c === m.color && costume === m.costume) return { status: 200, body: { ok: true } };
        const old = m.name;
        if (name !== m.name) log(`改名：${m.name} → ${name}`);
        m.name = name; m.color = c; m.costume = costume;
        if (name !== old) { sys(`${old} 改名為 ${name}`); boardsSync(m); }
        broadcast('profile', { id, name: m.name, color: m.color, costume: m.costume });
        return { status: 200, body: { ok: true } };
    }

    // 自動／手動切換與 WASD（手動模式）。位置由**伺服器**依目前的走法算出當下在哪，
    // 再以那一點當新的起點 —— 不收 client 報的座標：各台的時間差一點點，
    // 報上來的座標就會跟別人算的對不上，而伺服器算的才是大家共同的版本。
    //   { mode:'manual' }          自動 → 手動：停在當下的位置
    //   { mode:'auto' }            手動 → 自動：從當下的位置接著隨機走（新的 seed）
    //   { vx, vy }  (-1/0/1)       手動模式下改方向；0,0 = 停
    function move(body) {
        const { id } = body || {};
        const m = members.get(id);
        if (!m) return { status: 404, body: { ok: false, error: '不在廣場名單裡' } };
        if (m.battle) return { status: 409, body: { ok: false, error: '對戰中，打完才能動' } };
        const t = now();
        const cur = W.walkPos(m.walk, t, null, FIELD);
        const facingOf = (vx, prev) => (vx < 0 ? 'left' : vx > 0 ? 'right' : prev);
        const dir = (v) => (v === -1 || v === 0 || v === 1);
        let walk;
        if (body.mode === 'auto') {
            if (m.walk.mode !== 'manual') return { status: 200, body: { ok: true, walk: m.walk } };
            const seed = crypto.randomBytes(4).readUInt32BE(0) >>> 1;
            walk = { seed, joinStep: W.stepAt(t), origin: { x: cur.x, y: cur.y, facing: cur.facing }, anchor: null };
        } else if (body.mode === 'manual') {
            if (m.walk.mode === 'manual') return { status: 200, body: { ok: true, walk: m.walk } };
            walk = { mode: 'manual', x: cur.x, y: cur.y, facing: cur.facing, vx: 0, vy: 0, at: t };
        } else {
            if (m.walk.mode !== 'manual') return { status: 409, body: { ok: false, error: '先切到手動模式' } };
            if (!dir(body.vx) || !dir(body.vy)) return { status: 400, body: { ok: false, error: '方向不合法' } };
            walk = { mode: 'manual', x: cur.x, y: cur.y, facing: facingOf(body.vx, cur.facing),
                     vx: body.vx, vy: body.vy, at: t };
        }
        m.walk = walk;
        m.mode = walk.mode === 'manual' ? 'manual' : 'auto';
        broadcast('member', pub(m));
        return { status: 200, body: { ok: true, walk } };
    }

    // ── 對戰（規格 §八）────────────────────────────────────────────────
    // 邀請 → 對方同意 → 伺服器決定勝負並廣播 → 兩邊各自播前線的戰鬥演出（疊在廣場上）。
    // 勝負由伺服器擲：兩台的 state 不一定同步，各算各的會出現「兩邊都贏」。
    const invites = new Map();   // inviteId -> { inviteId, from, to, at, timer }
    const battleTimers = new Set();
    const busyIn = (id) => [...invites.values()].some(v => v.from === id || v.to === id);
    function closeInvite(inv, reason) {
        if (!invites.has(inv.inviteId)) return;
        invites.delete(inv.inviteId);
        clearTimeout(inv.timer);
        for (const who of [inv.from, inv.to]) {
            const m = members.get(who);
            if (m) send(m, 'invite-closed', { inviteId: inv.inviteId, reason });
        }
        const A = members.get(inv.from), B = members.get(inv.to);
        if (A && B && reason === 'declined') sys(`${B.name} 拒絕了 ${A.name} 的對戰邀請`);
        if (A && B && reason === 'timeout')  sys(`${B.name} 沒有回應 ${A.name} 的對戰邀請`);
    }
    function invite(body) {
        const { id, to } = body || {};
        const A = members.get(id), B = members.get(to);
        if (!A) return { status: 404, body: { ok: false, error: '不在廣場名單裡' } };
        if (!B) return { status: 404, body: { ok: false, error: '對方已經不在廣場了' } };
        if (A.id === B.id) return { status: 400, body: { ok: false, error: '不能跟自己對戰' } };
        if (A.battle || busyIn(A.id)) return { status: 409, body: { ok: false, error: '你已經有一場邀請或對戰了' } };
        if (B.battle || busyIn(B.id)) return { status: 409, body: { ok: false, error: `${B.name} 正在對戰或有別的邀請` } };
        if (stairsRoomOf(A.id)) return { status: 409, body: { ok: false, error: '你在下樓梯的房間裡' } };
        if (stairsRoomOf(B.id)) return { status: 409, body: { ok: false, error: `${B.name} 正在玩下樓梯` } };
        const inv = { inviteId: crypto.randomBytes(6).toString('hex'), from: A.id, to: B.id, at: now() };
        inv.timer = setTimeout(() => closeInvite(inv, 'timeout'), inviteMs);
        if (inv.timer.unref) inv.timer.unref();
        invites.set(inv.inviteId, inv);
        send(B, 'invite', { inviteId: inv.inviteId, from: A.id, fromName: A.name, expiresAt: inv.at + inviteMs });
        sys(`${A.name} 邀請 ${B.name} 對戰`);
        return { status: 200, body: { ok: true, inviteId: inv.inviteId, expiresAt: inv.at + inviteMs } };
    }
    function answer(body) {
        const { id, inviteId, accept } = body || {};
        const inv = invites.get(inviteId);
        if (!inv || inv.to !== id) return { status: 404, body: { ok: false, error: '邀請已經失效了' } };
        if (!accept) { closeInvite(inv, 'declined'); return { status: 200, body: { ok: true } }; }
        const A = members.get(inv.from), B = members.get(inv.to);
        invites.delete(inviteId); clearTimeout(inv.timer);
        if (!A || !B) return { status: 404, body: { ok: false, error: '對方已經不在廣場了' } };
        startBattle(A, B);
        return { status: 200, body: { ok: true } };
    }
    // A 的勝率 = 50 + (A 戰力 - B 戰力) %，夾在 5~95%（跟幽靈對戰、前線同一條公式，見 core.winProbFromStr）
    function winProbA(A, B) {
        return Math.max(0.05, Math.min(0.95, (50 + (A.card.str - B.card.str)) / 100));
    }
    function startBattle(A, B) {
        const t = now();
        const battleId = crypto.randomBytes(6).toString('hex');
        const winner = rand() < winProbA(A, B) ? A.id : B.id;
        // 兩隻停在原地（用手動模式的「停著」表示，大家算出來的位置一致）。
        // 原本的模式記在 m.mode，打完照它恢復。
        for (const m of [A, B]) {
            const cur = W.walkPos(m.walk, t, null, FIELD);
            m.walk = { mode: 'manual', x: cur.x, y: cur.y, facing: cur.facing, vx: 0, vy: 0, at: t };
            m.battle = battleId;
            broadcast('member', pub(m));
        }
        const fighter = (m) => ({ id: m.id, name: m.name, char: m.char });
        broadcast('battle', { battleId, a: fighter(A), b: fighter(B), winner, at: t });
        sys(`${A.name} 對 ${B.name} 開打！`);
        log(`對戰：${A.name} vs ${B.name} → ${winner === A.id ? A.name : B.name} 勝`);
        const timer = setTimeout(() => { battleTimers.delete(timer); endBattle(battleId, [A.id, B.id], winner); }, battleMs);
        if (timer.unref) timer.unref();
        battleTimers.add(timer);
    }
    function endBattle(battleId, ids, winner) {
        const t = now();
        for (const id of ids) {
            const m = members.get(id);
            if (!m || m.battle !== battleId) continue;
            const cur = W.walkPos(m.walk, t, null, FIELD);
            m.walk = m.mode === 'manual'
                ? { mode: 'manual', x: cur.x, y: cur.y, facing: cur.facing, vx: 0, vy: 0, at: t }
                : { seed: crypto.randomBytes(4).readUInt32BE(0) >>> 1, joinStep: W.stepAt(t),
                    origin: { x: cur.x, y: cur.y, facing: cur.facing }, anchor: null };
            m.battle = null;
            broadcast('member', pub(m));
        }
        broadcast('battle-end', { battleId, winner });
        const w = members.get(winner);
        if (w) sys(`${w.name} 贏了！`);
    }

    // 發言。字數、頻率都在這裡擋 —— 不信任 client。
    function say(body) {
        const { id } = body || {};
        const m = members.get(id);
        if (!m) return { status: 404, body: { ok: false, error: '不在廣場名單裡' } };
        const text = typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
        if (!text) return { status: 400, body: { ok: false, error: '沒有內容' } };
        if ([...text].length > CHAT_MAX) return { status: 400, body: { ok: false, error: `一則最多 ${CHAT_MAX} 字` } };
        const t = now();
        if (m.chatAt && t - m.chatAt < CHAT_GAP_MS) return { status: 429, body: { ok: false, error: '說太快了，等一下再說' } };
        m.chatAt = t;
        const e = pushChat({ from: id, name: m.name, color: m.color, text });
        return { status: 200, body: { ok: true, seq: e.seq } };
    }

    // 開心：大家在同一刻看到這隻跳一下（HAPPY 幀 + 原地跳）。伺服器只蓋時間戳、廣播，
    // 怎麼演由各台 daemon 依時間戳自己算（跟走路同一個道理：給起點，不給畫面）。
    function emote(body) {
        const { id } = body || {};
        const m = members.get(id);
        if (!m) return { status: 404, body: { ok: false, error: '不在廣場名單裡' } };
        if (m.battle) return { status: 409, body: { ok: false, error: '對戰中' } };
        const t = now();
        if (m.emoteAt && t - m.emoteAt < EMOTE_MS) return { status: 429, body: { ok: false, error: '還在開心中' } };
        m.emoteAt = t;
        broadcast('emote', { id, at: t });
        return { status: 200, body: { ok: true, at: t } };
    }

    // ── 管理（dev）──────────────────────────────────────────────────────
    // 金鑰比對用固定時間比較（先雜湊成同長度）。沒設金鑰 = 整組關掉。
    const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
    function authed(body) {
        if (!adminToken) return { status: 403, body: { ok: false, error: '這台廣場沒有開管理功能（沒有管理金鑰）' } };
        if (!body || typeof body.token !== 'string' || !crypto.timingSafeEqual(sha(body.token), sha(adminToken))) {
            return { status: 403, body: { ok: false, error: '管理金鑰不對' } };
        }
        return null;
    }
    // 踢人：通知本人（它就不會當成斷線一直重連）→ 移出名單 → 名牌 kickBanMs 內不能再進
    function adminKick(body) {
        const deny = authed(body); if (deny) return deny;
        const m = members.get(body.target);
        if (!m) return { status: 404, body: { ok: false, error: '對方已經不在廣場了' } };
        banned.set(m.name.toLowerCase(), now() + kickBanMs);
        send(m, 'kicked', { reason: 'admin' });
        remove(m.id, 'kicked');
        sys(`${m.name} 被管理員移出廣場`);
        log(`管理：踢出 ${m.name}`);
        return { status: 200, body: { ok: true } };
    }
    // 刪一則（seq）或清空全部（all:true）。大家的聊天室跟著刪，進場／重連拿到的也是刪過的
    function adminChat(body) {
        const deny = authed(body); if (deny) return deny;
        if (body.all === true) {
            chat.length = 0;
            broadcast('chat-clear', {});
            sys('聊天記錄已被管理員清除');
            log('管理：清空聊天');
            return { status: 200, body: { ok: true } };
        }
        const i = chat.findIndex(e => e.seq === body.seq);
        if (i < 0) return { status: 404, body: { ok: false, error: '找不到這則（可能已經被洗掉了）' } };
        const [e] = chat.splice(i, 1);
        broadcast('chat-del', { seq: e.seq });
        log(`管理：刪除聊天 #${e.seq}（${e.sys ? '系統' : e.name}）`);
        return { status: 200, body: { ok: true } };
    }

    // ── 下樓梯（docs/plaza-stairs-spec.md）─────────────────────────────────
    // 跟走路不同：位置由伺服器統一算（每房一個 stairsTickMs 的迴圈），每拍把狀態推給房裡的人。
    // 第一期（規格 §八）：單人無限制。房間、模式、生存制的欄位先備好，加入／生存制是第二期。
    const rooms = new Map();     // roomId -> { id, host, mode, ids:[], state:'lobby'|'play', game, timer, ver }
    const stairsRoomOf = (id) => [...rooms.values()].find(r => r.ids.includes(id)) || null;
    const roomPub = (r) => ({ id: r.id, host: r.host, hostName: (members.get(r.host) || {}).name || '?',
                              kind: r.kind || 'stairs',
                              dino: r.dino ? { seed: r.dino.seed, startAt: r.dino.startAt } : null,
                              mode: r.mode, n: r.ids.length, cap: capOf(r), state: r.state, ver: STAIRS_VER,
                              volley: r.volley ? { startAt: r.volley.startAt, sides: r.volley.sides } : null,
                              gomoku: r.gomoku ? { board: r.gomoku.board.join(''), turn: r.gomoku.turn, sides: r.gomoku.sides,
                                                   last: r.gomoku.last, expr: r.gomoku.expr, exprAt: r.gomoku.exprAt,
                                                   winner: r.gomoku.winner, n: GOMOKU_N } : null,
                              ids: r.ids.slice(),
                              names: r.ids.map(i => (members.get(i) || {}).name || '?'),
                              chars: r.ids.map(i => (members.get(i) || {}).char || null) });
    const stairsRooms = () => [...rooms.values()].map(roomPub);
    const roomsChanged = () => broadcast('stairs:rooms', { rooms: stairsRooms() });
    function roomSend(r, event, data) { for (const i of r.ids) { const m = members.get(i); if (m) send(m, event, data); } }

    function stairsOpen(body) {
        const m = members.get(body && body.id);
        if (!m) return { status: 404, body: { ok: false, error: '不在廣場名單裡' } };
        if (m.battle || busyIn(m.id)) return { status: 409, body: { ok: false, error: '對戰中或有邀請，先處理完' } };
        if (stairsRoomOf(m.id)) return { status: 409, body: { ok: false, error: '你已經在一個房間裡了' } };
        const mode = body.mode === 'survival' ? 'survival' : 'endless';
        if (mode === 'survival') return { status: 400, body: { ok: false, error: '生存制還沒開放（第二期）' } };
        const kind = ['dino', 'volley', 'gomoku'].includes(body.kind) ? body.kind : 'stairs';   // 哪個小遊戲（房間、等待、排行榜共用）
        const r = { id: crypto.randomBytes(5).toString('hex'), host: m.id, kind, mode, ids: [m.id], state: 'lobby',
                    game: null, timer: null, ver: STAIRS_VER };
        rooms.set(r.id, r);
        roomsChanged();
        // 廣場上的人才知道有人開房：聊天室一則系統訊息，帶房號 → 前端在旁邊畫「加入」鈕
        pushChat({ sys: true, text: `${m.name} 開了 ${STAIRS_NAMES[kind]} 的房間，快來一起玩！`, stairsRoom: r.id, kind });
        return { status: 200, body: { ok: true, room: roomPub(r) } };
    }

    // 加入房間：只能加入等待中、沒滿的；對戰中／有邀請／已經在別間的不行
    function stairsJoin(body) {
        const m = members.get(body && body.id);
        if (!m) return { status: 404, body: { ok: false, error: '不在廣場名單裡' } };
        if (m.battle || busyIn(m.id)) return { status: 409, body: { ok: false, error: '對戰中或有邀請，先處理完' } };
        if (stairsRoomOf(m.id)) return { status: 409, body: { ok: false, error: '你已經在一個房間裡了' } };
        const r = rooms.get(body.room);
        if (!r) return { status: 404, body: { ok: false, error: '房間已經解散了' } };
        if (r.state !== 'lobby') return { status: 409, body: { ok: false, error: '這一局已經開始了，等下一局' } };
        if (r.ids.length >= capOf(r)) return { status: 409, body: { ok: false, error: `房間滿了（${capOf(r)} 人）` } };
        r.ids.push(m.id);
        roomSend(r, 'stairs:lobby', { room: roomPub(r) });
        roomsChanged();
        return { status: 200, body: { ok: true, room: roomPub(r) } };
    }

    function stairsStart(body) {
        const id = body && body.id, r = stairsRoomOf(id);
        if (!r) return { status: 404, body: { ok: false, error: '不在房間裡' } };
        if (r.host !== id) return { status: 403, body: { ok: false, error: '只有房主能出發' } };
        if (r.state === 'play') return { status: 409, body: { ok: false, error: '已經開始了' } };
        if (r.mode === 'survival' && r.ids.length < 2) return { status: 409, body: { ok: false, error: '生存制至少要 2 人' } };
        const seed = crypto.randomBytes(4).readUInt32BE(0);
        if (r.kind === 'dino') return dinoStart(r, seed);
        if (r.kind === 'volley') return volleyStart(r);
        if (r.kind === 'gomoku') return gomokuStart(r);
        r.game = ST.createGame({ seed, mode: r.mode, players: r.ids.map(i => ({ id: i })) });
        r.state = 'play'; r.startedAt = now();
        roomSend(r, 'stairs:start', { room: roomPub(r), seed });
        roomsChanged();
        r.timer = setInterval(() => stairsTick(r), stairsTickMs);
        if (r.timer.unref) r.timer.unref();
        return { status: 200, body: { ok: true } };
    }

    function stairsTick(r) {
        const g = r.game;
        if (!g) return;
        // 遊戲中斷線太久 = 出局（規格 §六）
        for (const p of g.players) {
            const m = members.get(p.id);
            if (p.alive && (!m || (!m.stream && m.lostAt != null && now() - m.lostAt > stairsLostMs))) {
                p.alive = false; p.diedAt = g.tick; p.why = 'lost';
            }
        }
        const ev = ST.step(g);
        roomSend(r, 'stairs:tick', { s: ST.snapshot(g), ev: ev.length ? ev : undefined });
        if (g.over) stairsEnd(r);
    }

    // 一局結束就解散房間、大家回廣場（2026-10-20：不再開房；要再玩就重新從小遊戲開一間）
    function closeRoom(r) {
        if (r.timer) { clearInterval(r.timer); r.timer = null; }
        rooms.delete(r.id);
        roomsChanged();
    }

    function stairsEnd(r) {
        clearInterval(r.timer); r.timer = null;
        const g = r.game;
        const result = g.players.map(p => ({ id: p.id, name: (members.get(p.id) || {}).name || '?',
                                             char: (members.get(p.id) || {}).char || null,
                                             floor: p.floor, rank: p.rank, why: p.why || null }));
        let records = [];
        if (r.mode === 'endless') records = stairsRecord(result);
        r.state = 'lobby'; r.game = null;
        roomSend(r, 'stairs:end', { room: roomPub(r), result, records, board: boardPub(stairsBoard().slice(0, 10)) });
        closeRoom(r);
        const best = result.slice().sort((a, b) => a.rank - b.rank)[0];
        if (best) log(`下樓梯結束：${result.map(x => x.name + ' ' + x.floor + ' 層').join('、')}`);
    }

    // 排行榜：主機上的檔案（規格 §五）。只記無限制。每人（名牌）只留最好的一筆，留前 STAIRS_BOARD_N 名
    // 排行榜：下樓梯記層數（floor）、小恐龍記分數（score），各一個檔。同一個人只留最好的一筆
    // 排行榜跟著玩家代號同步名字：同一個代號的紀錄換成現在的名字；沒有代號的舊紀錄名字對得上就綁給他
    // 送出去的排行榜拿掉玩家代號：代號等於身分，別人拿到就能冒名改你的紀錄
    const boardPub = (board) => board.map(({ pid, ...b }) => { void pid; return b; });
    function boardsSync(m) {
        if (!m || !m.pid) return;
        for (const file of [stairsBoardFile, dinoBoardFile]) {
            let j; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { continue; }
            if (!Array.isArray(j.board)) continue;
            let changed = false;
            const mine = j.board.some(b => b.pid === m.pid);
            for (const b of j.board) {
                if (b.pid === m.pid && b.name !== m.name) { b.name = m.name; changed = true; }
                else if (!b.pid && !mine && String(b.name).toLowerCase() === m.name.toLowerCase()) { b.pid = m.pid; changed = true; }
            }
            if (changed) {
                try { fs.writeFileSync(file, JSON.stringify(j, null, 1)); }
                catch (e) { log('排行榜寫不進去：' + e.message); }
            }
        }
    }
    function boardRead(file, key) {
        try {
            const j = JSON.parse(fs.readFileSync(file, 'utf8'));
            // 依分數排（檔案可能被手動改過），同分先達成的在前
            return Array.isArray(j.board) ? j.board.slice().sort((a, b) => (b[key] - a[key]) || (a.at - b.at)) : [];
        } catch (e) { return []; }
    }
    const stairsBoard = () => boardRead(stairsBoardFile, 'floor');
    const stairsRecord = (result) => boardRecord(stairsBoardFile, 'floor', result);
    function boardRecord(file, key, result) {
        const board = boardRead(file, key), out = [];
        for (const x of result) {
            if (!x[key]) continue;
            // 認人：有玩家代號就用代號（改名也是同一個人）；沒有（舊版 daemon）才用名字
            const pid = (members.get(x.id) || {}).pid || null, nm = String(x.name).toLowerCase();
            const i = board.findIndex(b => pid ? b.pid === pid : (!b.pid && String(b.name).toLowerCase() === nm));
            if (i >= 0 && board[i][key] >= x[key]) { if (board[i].name !== x.name) board[i].name = x.name; continue; }
            if (i >= 0) board.splice(i, 1);
            board.push({ name: x.name, char: x.char, [key]: x[key], at: now(), ...(pid ? { pid } : {}) });
            out.push(x.id);
        }
        board.sort((a, b) => (b[key] - a[key]) || (a.at - b.at));
        const top = board.slice(0, STAIRS_BOARD_N);
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify({ v: 1, board: top }, null, 1));
        } catch (e) { log('排行榜寫不進去：' + e.message); }
        // 回傳：誰破了個人紀錄（而且還在榜上）、全服第一是誰
        return out.filter(id => {
            const n = (members.get(id) || {}).name; return n && top.some(b => b.name === n);
        }).map(id => ({ id, top1: top[0] && top[0].name === (members.get(id) || {}).name }));
    }

    // ── 小恐龍（docs/plaza-dino-spec.md）：不開伺服器迴圈，只發 seed 與起跑時間、轉送位置、收成績 ──
    function dinoStart(r, seed) {
        const startAt = now() + dinoCountdownMs;
        r.dino = { seed, startAt, players: new Map(r.ids.map(i => [i, { dist: 0, y: 0, alive: true, at: startAt }])) };
        r.state = 'play'; r.startedAt = now();
        roomSend(r, 'stairs:start', { room: roomPub(r), seed, startAt });
        roomsChanged();
        // 有人一直沒回報（關分頁、當掉）→ 當作撞到，不然整局結束不了
        r.timer = setInterval(() => {
            const t = now();
            for (const p of r.dino.players.values()) if (p.alive && t - p.at > dinoStaleMs) p.alive = false;
            dinoCheck(r);
        }, Math.max(50, Math.min(1000, dinoStaleMs / 4)));
        if (r.timer.unref) r.timer.unref();
        return { status: 200, body: { ok: true, seed, startAt } };
    }
    function dinoReport(body) {
        const id = body && body.id, r = stairsRoomOf(id);
        if (!r || !r.dino) return { status: 409, body: { ok: false, error: '不在遊戲中' } };
        const p = r.dino.players.get(id);
        if (!p) return { status: 409, body: { ok: false, error: '這一局沒有你' } };
        const dist = Number(body.dist), y = Number(body.y);
        if (!Number.isFinite(dist) || dist < 0 || dist > 1e7 || !Number.isFinite(y) || y < 0 || y > 100) {
            return { status: 400, body: { ok: false, error: '回報的數字不合理' } };
        }
        if (p.alive) {
            p.dist = Math.max(p.dist, dist); p.y = y; p.at = now();
            if (body.alive === false || body.alive === 0) p.alive = false;
        }
        roomSend(r, 'dino:ghost', { id, dist: p.dist, y: p.y, alive: p.alive });
        dinoCheck(r);
        return { status: 200, body: { ok: true } };
    }
    // 大家都撞到了 → 名次（跑最遠的第一）、寫排行榜、回到等待畫面
    function dinoCheck(r) {
        if (!r.dino || r.state !== 'play') return;
        const ps = r.ids.map(i => [i, r.dino.players.get(i)]).filter(([, p]) => p);
        if (ps.some(([, p]) => p.alive)) return;
        clearInterval(r.timer); r.timer = null;
        const result = ps.map(([i, p]) => ({ id: i, name: (members.get(i) || {}).name || '?', char: (members.get(i) || {}).char || null,
                                             score: DN.score(p.dist) }))
            .sort((a, b) => b.score - a.score).map((x, k) => ({ ...x, rank: k + 1 }));
        const records = boardRecord(dinoBoardFile, 'score', result);
        r.state = 'lobby'; r.dino = null;
        roomSend(r, 'stairs:end', { room: roomPub(r), result, records, board: boardPub(boardRead(dinoBoardFile, 'score').slice(0, 10)) });
        closeRoom(r);
        log(`小恐龍結束：${result.map(x => x.name + ' ' + x.score).join('、')}`);
    }

    // ── 打排球（docs/plaza-volley-spec.md）：輸入同步。伺服器不算球，只轉送按鍵、收結果 ──
    function volleyStart(r) {
        if (r.ids.length !== 2) return { status: 409, body: { ok: false, error: '打排球要剛好 2 個人' } };
        const startAt = now() + (opts.volleyCountdownMs ?? VOLLEY_COUNTDOWN_MS);
        r.volley = { startAt, sides: r.ids.slice(), last: new Map(r.ids.map(i => [i, now()])) };
        r.state = 'play'; r.startedAt = now();
        roomSend(r, 'stairs:start', { room: roomPub(r), startAt });
        roomsChanged();
        // 有人斷線太久 → 另一個人贏（不然對方一直等按鍵，整局卡住）
        r.timer = setInterval(() => {
            for (const i of r.volley.sides) {
                const m = members.get(i);
                if (!m || (!m.stream && m.lostAt != null && now() - m.lostAt > stairsLostMs)) {
                    return volleyEnd(r, r.volley.sides.find(x => x !== i), 'lost');
                }
            }
        }, Math.max(50, Math.min(1000, stairsLostMs / 4)));
        if (r.timer.unref) r.timer.unref();
        return { status: 200, body: { ok: true, startAt } };
    }
    // 一格的按鍵：{ f: 第幾格, k: 按鍵位元 }，原樣轉給對手（自己不用，自己本來就知道）
    function volleyInput(body) {
        const id = body && body.id, r = stairsRoomOf(id);
        if (!r || !r.volley) return { status: 409, body: { ok: false, error: '不在比賽中' } };
        const f = Number(body.f), k = Number(body.k);
        if (!Number.isInteger(f) || f < 0 || f > 1e7 || !Number.isInteger(k) || k < 0 || k > 15) {
            return { status: 400, body: { ok: false, error: '按鍵格式不對' } };
        }
        for (const i of r.ids) if (i !== id) { const m = members.get(i); if (m) send(m, 'volley:in', { id, f, k }); }
        return { status: 200, body: { ok: true } };
    }
    // 結果：兩台算的一樣，誰先報都可以（報的只能是房裡的人、贏家要是房裡的人）
    function volleyReport(body) {
        const id = body && body.id, r = stairsRoomOf(id);
        if (!r || !r.volley) return { status: 409, body: { ok: false, error: '不在比賽中' } };
        if (!r.ids.includes(body.winner)) return { status: 400, body: { ok: false, error: '贏家不對' } };
        const sc = Array.isArray(body.score) ? body.score.map(Number) : null;
        volleyEnd(r, body.winner, 'done', sc && sc.length === 2 && sc.every(Number.isInteger) ? sc : null);
        return { status: 200, body: { ok: true } };
    }
    function volleyEnd(r, winner, why, score) {
        if (!r.volley) return;
        const sides = r.volley.sides;
        const result = sides.map((i, k) => ({ id: i, name: (members.get(i) || {}).name || '?', char: (members.get(i) || {}).char || null,
                                             rank: i === winner ? 1 : 2, score: score ? score[k] : null, why: i === winner ? null : why }));
        r.volley = null; r.state = 'lobby';
        roomSend(r, 'stairs:end', { room: roomPub(r), result, records: [], board: [] });
        closeRoom(r);
        log(`打排球結束：${result.map(x => x.name + (x.rank === 1 ? ' 勝' : ' 敗')).join('、')}（${why}）`);
    }

    // ── 五子棋（docs/plaza-gomoku-spec.md）：輪流下，伺服器判定。黑子（房主）先下 ──
    function gomokuStart(r) {
        if (r.ids.length !== 2) return { status: 409, body: { ok: false, error: '五子棋要剛好 2 個人' } };
        r.gomoku = { board: new Array(GOMOKU_N * GOMOKU_N).fill(0), turn: 0, sides: r.ids.slice(), last: null,
                     expr: ['IDLE', 'IDLE'], exprAt: now(), winner: null, moves: 0 };
        r.state = 'play'; r.startedAt = now();
        roomSend(r, 'stairs:start', { room: roomPub(r) });
        roomsChanged();
        // 有人斷線太久 → 另一個人贏
        r.timer = setInterval(() => {
            if (!r.gomoku || r.gomoku.winner != null) return;
            for (const i of r.gomoku.sides) {
                const m = members.get(i);
                if (!m || (!m.stream && m.lostAt != null && now() - m.lostAt > stairsLostMs)) {
                    return gomokuEnd(r, r.gomoku.sides.find(x => x !== i), 'lost');
                }
            }
        }, Math.max(50, Math.min(1000, stairsLostMs / 4)));
        if (r.timer.unref) r.timer.unref();
        return { status: 200, body: { ok: true } };
    }
    function gomokuMove(body) {
        const id = body && body.id, r = stairsRoomOf(id), gm = r && r.gomoku;
        if (!gm || gm.winner != null) return { status: 409, body: { ok: false, error: '不在對局中' } };
        if (gm.sides[gm.turn] !== id) return { status: 409, body: { ok: false, error: '還沒輪到你' } };
        const x = Number(body.x), y = Number(body.y);
        if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= GOMOKU_N || y >= GOMOKU_N) {
            return { status: 400, body: { ok: false, error: '位置不對' } };
        }
        if (gm.board[y * GOMOKU_N + x]) return { status: 409, body: { ok: false, error: '那裡已經有棋子了' } };
        const me = gm.turn;
        gm.board[y * GOMOKU_N + x] = me + 1; gm.moves++;
        gm.last = { x, y, c: me };
        const len = gomokuLine(gm.board, x, y), [mine, theirs] = gomokuExpr(len);
        gm.expr = me === 0 ? [mine, theirs] : [theirs, mine]; gm.exprAt = now();
        if (len >= 5) gm.winner = me;
        else if (gm.moves >= GOMOKU_N * GOMOKU_N) gm.winner = -1;   // 下滿了：平手
        else gm.turn = 1 - me;
        roomSend(r, 'gomoku:move', { x, y, c: me, len });
        roomsChanged();
        if (gm.winner != null) {
            // 留一下讓大家看清楚最後一手（連成的五顆），再結算
            const t = setTimeout(() => gomokuEnd(r, gm.winner >= 0 ? gm.sides[gm.winner] : null, 'done'), opts.gomokuEndMs ?? GOMOKU_END_MS);
            if (t.unref) t.unref();
        }
        return { status: 200, body: { ok: true, len } };
    }
    function gomokuResign(body) {
        const id = body && body.id, r = stairsRoomOf(id), gm = r && r.gomoku;
        if (!gm || gm.winner != null) return { status: 409, body: { ok: false, error: '不在對局中' } };
        gomokuEnd(r, gm.sides.find(x => x !== id), 'resign');
        return { status: 200, body: { ok: true } };
    }
    function gomokuEnd(r, winner, why) {
        if (!r.gomoku || !rooms.has(r.id)) return;
        const sides = r.gomoku.sides, moves = r.gomoku.moves;
        const result = sides.map(i => ({ id: i, name: (members.get(i) || {}).name || '?', char: (members.get(i) || {}).char || null,
                                         rank: winner == null ? 1 : i === winner ? 1 : 2, draw: winner == null,
                                         why: winner != null && i !== winner ? why : null, moves }));
        r.gomoku = null; r.state = 'lobby';
        roomSend(r, 'stairs:end', { room: roomPub(r), result, records: [], board: [] });
        closeRoom(r);
        log(`五子棋結束：${result.map(x => x.name + (x.draw ? ' 和' : x.rank === 1 ? ' 勝' : ' 敗')).join('、')}（${why}，${moves} 手）`);
    }

    function stairsInput(body) {
        const id = body && body.id, r = stairsRoomOf(id);
        if (!r || !r.game) return { status: 409, body: { ok: false, error: '不在遊戲中' } };
        const dir = Number(body.dir);
        if (![-1, 0, 1].includes(dir)) return { status: 400, body: { ok: false, error: '方向只能是 -1／0／1' } };
        ST.setInput(r.game, id, dir);
        return { status: 200, body: { ok: true } };
    }

    // 離開房間（silent = 離開廣場時順手做，不另外回應）。房主走了交給最早加入的人；沒人就解散
    function stairsLeave(body, silent) {
        const id = body && body.id, r = stairsRoomOf(id);
        if (!r) return { status: 200, body: { ok: true } };
        r.ids = r.ids.filter(i => i !== id);
        if (r.game) { const p = r.game.players.find(q => q.id === id); if (p && p.alive) { p.alive = false; p.diedAt = r.game.tick; p.why = 'left'; } }
        if (r.dino) { const p = r.dino.players.get(id); if (p && p.alive) { p.alive = false; p.at = now(); } }
        if (!r.ids.length) {
            if (r.timer) clearInterval(r.timer);
            rooms.delete(r.id);
        } else {
            if (r.host === id) r.host = r.ids[0];
            roomSend(r, 'stairs:lobby', { room: roomPub(r) });
            if (r.dino) dinoCheck(r);   // 走掉的是最後一個還在跑的 → 結束
            if (r.volley) volleyEnd(r, r.ids[0], 'left');   // 打到一半有人走了 → 留下來的贏
            // 已經分出勝負（等著結算）的照原本的結果；還在下的 → 留下來的贏
            if (r.gomoku) { const gw = r.gomoku.winner; gomokuEnd(r, gw == null ? r.ids[0] : gw >= 0 ? r.gomoku.sides[gw] : null, gw == null ? 'left' : 'done'); }
        }
        roomsChanged();
        void silent;
        return { status: 200, body: { ok: true } };
    }

    function openEvents(req, res, id) {
        const m = members.get(id);
        if (!m) {
            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: '不在廣場名單裡', serverNow: now() }));
            return;
        }
        // 舊的串流還在（重連比斷線偵測快）→ 換成新的，舊的不再寫
        if (m.stream) { try { m.stream.end(); } catch (e) {} }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
                             'Connection': 'keep-alive' });
        m.stream = res; m.lostAt = null;
        // 重連時把整份名單再給一次：斷線期間錯過的 enter / leave 就補回來了
        send(m, 'hello', { roster: roster(), chat, stairs: stairsRooms() });   // 斷線期間錯過的聊天也一併補上
        req.on('close', () => {
            if (m.stream === res) { m.stream = null; m.lostAt = now(); }
        });
    }

    function readBody(req, cb) {
        let s = '';
        req.on('data', (c) => { s += c; if (s.length > BODY_LIMIT) req.destroy(); });
        req.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) {} cb(j); });
    }
    function reply(res, status, body) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ...body, serverNow: now() }));
    }

    // 自動更新（docs/update-spec.md）：發版時 publish-release 把簽好的包放進 updateDir，
    // 這裡只負責原樣送出（每次現讀，發版不用重開伺服器）。驗章在 daemon 那邊做，伺服器不用被信任。
    const updateDir = opts.updateDir || process.env.VPET_UPDATE_DIR || path.join(__dirname, '..', '..', 'dist', 'update');
    function serveUpdate(res, file, type) {
        fs.readFile(path.join(updateDir, file), (err, buf) => {
            if (err) return reply(res, 404, { ok: false, error: '沒有更新包' });
            res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
            res.end(buf);
        });
    }

    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        if (req.method === 'GET' && u.pathname === '/update/manifest') return serveUpdate(res, 'manifest.json', 'application/json; charset=utf-8');
        if (req.method === 'GET' && u.pathname === '/update/bundle') return serveUpdate(res, 'bundle.bin', 'application/octet-stream');
        if (req.method === 'GET' && u.pathname === '/events') return openEvents(req, res, u.searchParams.get('id'));
        if (req.method === 'GET' && u.pathname === '/roster') return reply(res, 200, { ok: true, roster: roster() });
        if (req.method === 'POST' && u.pathname === '/join') {
            return readBody(req, (j) => { const r = join(j); reply(res, r.status, r.body); });
        }
        if (req.method === 'POST' && u.pathname === '/update') {
            return readBody(req, (j) => { const r = update(j); reply(res, r.status, r.body); });
        }
        if (req.method === 'POST' && u.pathname === '/chat') {
            return readBody(req, (j) => { const r = say(j); reply(res, r.status, r.body); });
        }
        if (req.method === 'POST' && u.pathname === '/emote') {
            return readBody(req, (j) => { const r = emote(j); reply(res, r.status, r.body); });
        }
        if (req.method === 'POST' && u.pathname === '/invite') {
            return readBody(req, (j) => { const r = invite(j); reply(res, r.status, r.body); });
        }
        if (req.method === 'POST' && u.pathname === '/answer') {
            return readBody(req, (j) => { const r = answer(j); reply(res, r.status, r.body); });
        }
        if (req.method === 'POST' && u.pathname === '/move') {
            return readBody(req, (j) => { const r = move(j); reply(res, r.status, r.body); });
        }
        if (req.method === 'POST' && u.pathname === '/admin/kick') {
            return readBody(req, (j) => { const r = adminKick(j); reply(res, r.status, r.body); });
        }
        if (req.method === 'POST' && u.pathname === '/admin/chat') {
            return readBody(req, (j) => { const r = adminChat(j); reply(res, r.status, r.body); });
        }
        if (req.method === 'GET' && u.pathname === '/stairs/board') {
            return reply(res, 200, { ok: true, board: boardPub(u.searchParams.get('kind') === 'dino' ? boardRead(dinoBoardFile, 'score') : stairsBoard()) });
        }
        const SR = { '/stairs/open': stairsOpen, '/stairs/start': stairsStart, '/stairs/input': stairsInput,
                     '/stairs/report': dinoReport, '/stairs/join': stairsJoin, '/stairs/leave': (j) => stairsLeave(j),
                     '/stairs/vin': volleyInput, '/stairs/vend': volleyReport,
                     '/stairs/gmove': gomokuMove, '/stairs/gresign': gomokuResign };
        if (req.method === 'POST' && SR[u.pathname]) {
            return readBody(req, (j) => { const r = SR[u.pathname](j); reply(res, r.status, r.body); });
        }
        if (req.method === 'POST' && u.pathname === '/leave') {
            return readBody(req, (j) => { if (j && typeof j.id === 'string') remove(j.id, 'leave'); reply(res, 200, { ok: true }); });
        }
        reply(res, 404, { ok: false, error: 'not found' });
    });

    // 斷線清理 + 心跳。unref：不要因為這兩個計時器讓測試或行程結束不了。
    const reaper = setInterval(() => {
        const t = now();
        for (const m of [...members.values()]) {
            if (!m.stream && m.lostAt != null && t - m.lostAt > graceMs) remove(m.id, 'lost');
        }
    }, Math.min(1000, Math.max(50, graceMs / 4)));
    reaper.unref();
    const pinger = setInterval(() => broadcast('ping', {}), pingMs);
    pinger.unref();

    function close() {
        clearInterval(reaper); clearInterval(pinger);
        for (const r of rooms.values()) if (r.timer) clearInterval(r.timer);
        for (const inv of invites.values()) clearTimeout(inv.timer);
        for (const t of battleTimers) clearTimeout(t);
        for (const m of members.values()) { if (m.stream) { try { m.stream.end(); } catch (e) {} } }
        members.clear();
        return new Promise((r) => server.close(() => r()));
    }

    return { server, roster, members, chat, close, rooms };
}

module.exports = { createPlazaServer, DEFAULT_PORT, CAP, GRACE_MS, PING_MS, validName, validColor,
                   STAIRS_VER, STAIRS_CAP, STAIRS_LOST_MS, STAIRS_BOARD_N, STAIRS_BOARD_FILE,
                   DINO_BOARD_FILE, DINO_COUNTDOWN_MS, DINO_STALE_MS, GOMOKU_N, gomokuLine, gomokuExpr,
                   CHAT_KEEP, CHAT_MAX, CHAT_GAP_MS, EMOTE_MS, ADMIN_KEY_FILE, KICK_BAN_MS, loadAdminToken };

if (require.main === module) {
    const port = parseInt(process.env.VPET_PLAZA_PORT || String(DEFAULT_PORT), 10);
    const ts = () => new Date().toTimeString().slice(0, 8);
    let adminToken = null;
    try { adminToken = loadAdminToken(ADMIN_KEY_FILE, true); }
    catch (e) { console.log('管理金鑰讀寫失敗，管理功能關閉：' + e.message); }
    const p = createPlazaServer({ log: (m) => console.log(`[${ts()}] ${m}`), adminToken });
    p.server.listen(port, '0.0.0.0', () => {
        const os = require('os');
        const ips = Object.values(os.networkInterfaces()).flat()
            .filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
        console.log(`🏛 廣場伺服器已啟動  port ${port}`);
        console.log(`   主機名稱：${os.hostname()}　IP：${ips.join(', ') || '-'}`);
        console.log(`   其他人的 daemon 預設連 http://${os.hostname()}:${port}`);
        console.log('   （防火牆要放行這個 port 的 inbound TCP；Ctrl+C 結束 = 全場回前線）');
        if (adminToken) console.log(`   管理金鑰：${ADMIN_KEY_FILE}（開發版 daemon 讀這個檔才能踢人／管聊天；不要外流）`);
    });
    p.server.on('error', (e) => { console.log('廣場伺服器起不來：' + e.message); process.exit(1); });
}
