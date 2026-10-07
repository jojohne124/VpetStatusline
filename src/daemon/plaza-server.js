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
const W      = require('../shared/plaza-walk.js');

const DEFAULT_PORT = 37373;
const CAP          = 20;        // 同時在場上限（畫面可讀性決定，見規格 §九）
const GRACE_MS     = 10000;     // 斷線多久沒接回來就算離場
const PING_MS      = 15000;     // SSE 心跳：讓兩邊都知道連線還活著（也讓中間的設備不要掐掉閒置連線）
const BODY_LIMIT   = 4096;
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

    const members = new Map();   // id -> { id, name, char, stage, card, walk, stream, lostAt }

    const pub = (m) => ({ id: m.id, name: m.name, color: m.color, char: m.char, stage: m.stage, walk: m.walk });
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
        broadcast('leave', { id, reason });
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
        const card = { power: numOr(c.power, 0), train: numOr(c.train, 0) };
        const id   = crypto.randomBytes(8).toString('hex');
        const seed = crypto.randomBytes(4).readUInt32BE(0) >>> 1;
        // 跟 daemon 端 plaza.js 的 PLAZA_LIVE_FIELD 是同一塊，兩邊必須一致
        const e    = W.entryWalk(seed, FIELD);
        const walk = { seed, joinStep: W.stepAt(now()), origin: e.origin, anchor: e.anchor };
        // lostAt = now：join 之後要在 graceMs 內接上 SSE，不然一樣當作離場
        // （join 成功但 daemon 當場死掉的情況，不能留一隻幽靈在場上）。
        const color = validColor(body.color) ? body.color.toLowerCase() : null;
        const m = { id, name, color, char, stage, card, walk, stream: null, lostAt: now() };
        members.set(id, m);
        broadcast('enter', pub(m), id);
        log(`進場：${name}（${char}）。在場 ${members.size} 人`);
        return { status: 200, body: { ok: true, id, me: pub(m), roster: roster() } };
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
        if (name === m.name && c === m.color) return { status: 200, body: { ok: true } };
        if (name !== m.name) log(`改名：${m.name} → ${name}`);
        m.name = name; m.color = c;
        broadcast('profile', { id, name: m.name, color: m.color });
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
        broadcast('walk', { id, walk });
        return { status: 200, body: { ok: true, walk } };
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
        send(m, 'hello', { roster: roster() });
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

    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        if (req.method === 'GET' && u.pathname === '/events') return openEvents(req, res, u.searchParams.get('id'));
        if (req.method === 'GET' && u.pathname === '/roster') return reply(res, 200, { ok: true, roster: roster() });
        if (req.method === 'POST' && u.pathname === '/join') {
            return readBody(req, (j) => { const r = join(j); reply(res, r.status, r.body); });
        }
        if (req.method === 'POST' && u.pathname === '/update') {
            return readBody(req, (j) => { const r = update(j); reply(res, r.status, r.body); });
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
        for (const m of members.values()) { if (m.stream) { try { m.stream.end(); } catch (e) {} } }
        members.clear();
        return new Promise((r) => server.close(() => r()));
    }

    return { server, roster, members, close };
}

module.exports = { createPlazaServer, DEFAULT_PORT, CAP, GRACE_MS, PING_MS, validName, validColor };

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
