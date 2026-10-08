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
const path   = require('path');
const W      = require('../shared/plaza-walk.js');

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
        if (m.stream) { try { m.stream.end(); } catch (e) {} m.stream = null; }
        // 邀請中的人走了 → 邀請作廢（對戰中的那場照常演完，另一邊不受影響）
        for (const inv of [...invites.values()]) if (inv.from === id || inv.to === id) closeInvite(inv, 'left');
        broadcast('leave', { id, reason });
        // 同名取代＝同一個人換了一台 daemon 進來，不是真的離開，不報
        if (reason !== 'replaced') sys(`${m.name} 離開了`);
        log(`離場：${m.name}（${reason}）。在場 ${members.size} 人`);
    }

    function join(body) {
        const { name, char, stage } = body || {};
        if (!validName(name))  return { status: 400, body: { ok: false, error: '名牌不合法（1~16 個中英數字）' } };
        if (!validChar(char))  return { status: 400, body: { ok: false, error: '角色 id 不合法' } };
        if (!validStage(stage)) return { status: 400, body: { ok: false, error: '階級不合法' } };
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
        const m = { id, name, color, costume, char, stage, card, walk, mode: 'auto', battle: null, stream: null, lostAt: now() };
        members.set(id, m);
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
        if (name !== old) sys(`${old} 改名為 ${name}`);
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
        send(m, 'hello', { roster: roster(), chat });   // 斷線期間錯過的聊天也一併補上
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
        for (const inv of invites.values()) clearTimeout(inv.timer);
        for (const t of battleTimers) clearTimeout(t);
        for (const m of members.values()) { if (m.stream) { try { m.stream.end(); } catch (e) {} } }
        members.clear();
        return new Promise((r) => server.close(() => r()));
    }

    return { server, roster, members, chat, close };
}

module.exports = { createPlazaServer, DEFAULT_PORT, CAP, GRACE_MS, PING_MS, validName, validColor,
                   CHAT_KEEP, CHAT_MAX, CHAT_GAP_MS, EMOTE_MS };

if (require.main === module) {
    const port = parseInt(process.env.VPET_PLAZA_PORT || String(DEFAULT_PORT), 10);
    const ts = () => new Date().toTimeString().slice(0, 8);
    const p = createPlazaServer({ log: (m) => console.log(`[${ts()}] ${m}`) });
    p.server.listen(port, '0.0.0.0', () => {
        const os = require('os');
        const ips = Object.values(os.networkInterfaces()).flat()
            .filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
        console.log(`🏛 廣場伺服器已啟動  port ${port}`);
        console.log(`   主機名稱：${os.hostname()}　IP：${ips.join(', ') || '-'}`);
        console.log(`   其他人的 daemon 預設連 http://${os.hostname()}:${port}`);
        console.log('   （防火牆要放行這個 port 的 inbound TCP；Ctrl+C 結束 = 全場回前線）');
    });
    p.server.on('error', (e) => { console.log('廣場伺服器起不來：' + e.message); process.exit(1); });
}
