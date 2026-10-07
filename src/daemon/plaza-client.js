'use strict';
/**
 * plaza-client.js — daemon 連廣場伺服器的那一端（docs/plaza-spec.md §二、§四、§六）
 *
 * 只有 daemon 連伺服器，瀏覽器不直連：daemon 是唯一能改 state 的人（在廣場、場景鎖都要寫），
 * 而且關掉瀏覽器分頁不該等於離場。
 *
 * 上行用 POST、下行用 SSE，只用 node 內建的 http。
 * 斷線時在 retryMs 內不斷重連；超過就呼叫 onLost —— daemon 收到就把人帶回前線。
 */
const http = require('http');
const W    = require('../shared/plaza-walk.js');

// 位址內建，使用者不用設定（規格 §十）。用電腦名稱而不是 IP：公司換 IP 不用重發 release。
// VPET_PLAZA_URL 給開發／換主機用。
const DEFAULT_URL = 'http://KAIHSIANGCHANG:37373';
const RETRY_MS    = 10000;
const REQ_TIMEOUT = 4000;

const UNREACHABLE = '連不上廣場（主機沒開，或你不在公司內網）';

function create(opts = {}) {
    const base    = new URL(opts.url || process.env.VPET_PLAZA_URL || DEFAULT_URL);
    const retryMs = opts.retryMs ?? RETRY_MS;
    const onLost  = opts.onLost || (() => {});
    // 對戰：我是其中一方時呼叫（daemon 據此開演前線的戰鬥）；邀請結束時也通知（給頁面顯示原因）
    const onBattle      = opts.onBattle      || (() => {});
    const onInviteClose = opts.onInviteClose || (() => {});
    const log     = opts.log    || (() => {});

    let me = null;              // { id, name, ... }
    let members = new Map();    // id -> { id, name, char, stage, walk }
    let chat = [];              // 最近的聊天（伺服器保留 50 則，進場／重連時整份給）
    const CHAT_KEEP = 50;
    let incoming = null;        // 別人邀我：{ inviteId, from, fromName, expiresAt }
    let outgoing = null;        // 我邀別人：{ inviteId, to, toName, expiresAt }
    let skew = 0;               // serverNow - localNow
    let stream = null;          // 目前的 SSE 回應（http.IncomingMessage）
    let streamReq = null;
    let lostSince = null;       // 斷線開始的時間；null = 連線中
    let retryTimer = null;
    let gen = 0;                // 每次 join 換一代：舊連線的遲到事件不能動到新的這一場

    const active = () => !!me;
    const syncClock = (serverNow, sentAt) => {
        if (typeof serverNow !== 'number') return;
        // 有往返時間就取中點：內網是毫秒級，這只是讓數字乾淨一點
        const local = sentAt != null ? (sentAt + Date.now()) / 2 : Date.now();
        skew = serverNow - local;
    };

    function request(method, p, body) {
        return new Promise((resolve) => {
            const data = body ? JSON.stringify(body) : null;
            const sentAt = Date.now();
            const req = http.request({
                hostname: base.hostname, port: base.port || 80, path: p, method,
                headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
                timeout: REQ_TIMEOUT,
            }, (res) => {
                let s = '';
                res.setEncoding('utf8');
                res.on('data', (c) => { s += c; });
                res.on('end', () => {
                    let j = null; try { j = JSON.parse(s); } catch (e) {}
                    if (j) syncClock(j.serverNow, sentAt);
                    resolve({ status: res.statusCode, body: j });
                });
            });
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.on('error', (e) => resolve({ status: 0, error: e.message }));
            if (data) req.write(data);
            req.end();
        });
    }

    function lose(reason) {
        if (!me) return;
        log('廣場連線結束：' + reason);
        cleanup();
        onLost(reason);
    }
    function cleanup() {
        gen++;
        me = null; members = new Map(); chat = []; lostSince = null; incoming = null; outgoing = null;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        if (streamReq) { try { streamReq.destroy(); } catch (e) {} }
        stream = null; streamReq = null;
    }

    function handle(event, d) {
        if (d && typeof d.serverNow === 'number') syncClock(d.serverNow);
        if (event === 'hello' && Array.isArray(d.roster)) {
            members = new Map(d.roster.map(m => [m.id, m]));
            if (Array.isArray(d.chat)) chat = d.chat.slice(-CHAT_KEEP);
            // 自己不在名單裡 = 伺服器已經把我清掉了（例如它重開過）
            if (!members.has(me.id)) lose('已被移出廣場');
        } else if (event === 'enter' && d.id) {
            members.set(d.id, d);
        } else if (event === 'chat' && d.seq) {
            // seq 去重：重連時 hello 已經帶了整份，之後若又收到同一則不要重複
            if (!chat.length || d.seq > chat[chat.length - 1].seq) {
                chat.push(d);
                if (chat.length > CHAT_KEEP) chat.splice(0, chat.length - CHAT_KEEP);
            }
        } else if (event === 'leave' && d.id) {
            members.delete(d.id);
        } else if (event === 'profile' && d.id) {
            if (members.has(d.id)) Object.assign(members.get(d.id), { name: d.name, color: d.color });
            if (d.id === me.id) Object.assign(me, { name: d.name, color: d.color });
        } else if (event === 'member' && d.id) {
            // 成員狀態整份換掉（走法、自動／手動、是否對戰中）
            const { serverNow, ...m } = d; void serverNow;
            members.set(d.id, m);
        } else if (event === 'invite' && d.inviteId) {
            incoming = { inviteId: d.inviteId, from: d.from, fromName: d.fromName, expiresAt: d.expiresAt };
        } else if (event === 'invite-closed' && d.inviteId) {
            const mine = outgoing && outgoing.inviteId === d.inviteId;
            if (incoming && incoming.inviteId === d.inviteId) incoming = null;
            if (mine) outgoing = null;
            onInviteClose({ inviteId: d.inviteId, reason: d.reason, mine });
        } else if (event === 'battle' && d.battleId) {
            if (d.a && d.b && (d.a.id === me.id || d.b.id === me.id)) {
                const opp = d.a.id === me.id ? d.b : d.a;
                outgoing = null; incoming = null;
                onBattle({ battleId: d.battleId, opp, win: d.winner === me.id, at: d.at });
            }
        } else if (event === 'walk' && d.id && members.has(d.id)) {
            members.get(d.id).walk = d.walk;
        } else if (event === 'kicked') {
            lose(d.reason === 'replaced' ? '你在別處進入了廣場' : '被移出廣場');
        }
    }

    function openStream() {
        const myGen = gen;
        const req = http.get({ hostname: base.hostname, port: base.port || 80,
                               path: '/events?id=' + encodeURIComponent(me.id) }, (res) => {
            if (myGen !== gen) { res.destroy(); return; }
            if (res.statusCode === 404) { res.resume(); lose('已被移出廣場'); return; }
            if (res.statusCode !== 200) { res.resume(); dropped(myGen); return; }
            stream = res; lostSince = null;
            res.setEncoding('utf8');
            let buf = '';
            res.on('data', (c) => {
                buf += c;
                let i;
                while ((i = buf.indexOf('\n\n')) >= 0) {
                    const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
                    let ev = 'message', data = '';
                    for (const line of chunk.split('\n')) {
                        if (line.startsWith('event: ')) ev = line.slice(7);
                        else if (line.startsWith('data: ')) data += line.slice(6);
                    }
                    let d = {}; try { d = JSON.parse(data || '{}'); } catch (e) {}
                    if (myGen === gen) handle(ev, d);
                }
            });
            res.on('end', () => dropped(myGen));
            res.on('error', () => dropped(myGen));
        });
        req.on('error', () => dropped(myGen));
        streamReq = req;
    }

    // 串流斷了：在 retryMs 內每秒重連一次，超過就放棄（回前線）。
    function dropped(myGen) {
        if (myGen !== gen || !me) return;
        stream = null;
        if (lostSince == null) lostSince = Date.now();
        if (Date.now() - lostSince > retryMs) { lose('與廣場的連線中斷'); return; }
        if (retryTimer) return;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            if (myGen === gen && me) openStream();
        }, Math.min(1000, retryMs / 4));
    }

    async function join(profile) {
        if (me) return { ok: true, already: true };
        const r = await request('POST', '/join', profile);
        if (r.status === 0) return { ok: false, error: UNREACHABLE };
        if (!r.body || !r.body.ok) return { ok: false, error: (r.body && r.body.error) || ('廣場回應異常（' + r.status + '）') };
        cleanup();
        me = { ...r.body.me };
        members = new Map((r.body.roster || []).map(m => [m.id, m]));
        chat = (r.body.chat || []).slice(-CHAT_KEEP);
        openStream();
        return { ok: true };
    }

    // 在場上改名牌／名牌顏色（patch 只放要改的欄位）。成功就先改自己這份
    // （推播的 profile 稍後也會到，結果相同）。
    async function update(patch) {
        if (!me) return { ok: false, error: '不在廣場' };
        const r = await request('POST', '/update', { id: me.id, ...patch });
        if (r.status === 0) return { ok: false, error: UNREACHABLE };
        if (!r.body || !r.body.ok) return { ok: false, error: (r.body && r.body.error) || ('廣場回應異常（' + r.status + '）') };
        if (me) {
            Object.assign(me, patch);
            if (members.has(me.id)) Object.assign(members.get(me.id), patch);
        }
        return { ok: true };
    }
    const rename = (name) => update({ name });

    // 自動／手動切換、手動模式的方向（見 plaza-server 的 move）。回來的 walk 先套上，
    // 不等推播 —— 自己按方向鍵要馬上動。
    async function move(patch) {
        if (!me) return { ok: false, error: '不在廣場' };
        const r = await request('POST', '/move', { id: me.id, ...patch });
        if (r.status === 0) return { ok: false, error: UNREACHABLE };
        if (!r.body || !r.body.ok) return { ok: false, error: (r.body && r.body.error) || ('廣場回應異常（' + r.status + '）') };
        if (me && members.has(me.id) && r.body.walk) members.get(me.id).walk = r.body.walk;
        return { ok: true, walk: r.body.walk };
    }

    // 發言。成功不直接塞進 chat —— 等推播回來（自己也收得到），順序才跟別人看到的一樣。
    async function say(text) {
        if (!me) return { ok: false, error: '不在廣場' };
        const r = await request('POST', '/chat', { id: me.id, text });
        if (r.status === 0) return { ok: false, error: UNREACHABLE };
        if (!r.body || !r.body.ok) return { ok: false, error: (r.body && r.body.error) || ('廣場回應異常（' + r.status + '）') };
        return { ok: true, seq: r.body.seq };
    }

    // 邀請對戰／回覆邀請
    async function invite(to) {
        if (!me) return { ok: false, error: '不在廣場' };
        const r = await request('POST', '/invite', { id: me.id, to });
        if (r.status === 0) return { ok: false, error: UNREACHABLE };
        if (!r.body || !r.body.ok) return { ok: false, error: (r.body && r.body.error) || ('廣場回應異常（' + r.status + '）') };
        const t = members.get(to);
        outgoing = { inviteId: r.body.inviteId, to, toName: t ? t.name : '?', expiresAt: r.body.expiresAt };
        return { ok: true, inviteId: r.body.inviteId };
    }
    async function answer(inviteId, accept) {
        if (!me) return { ok: false, error: '不在廣場' };
        const r = await request('POST', '/answer', { id: me.id, inviteId, accept: !!accept });
        if (incoming && incoming.inviteId === inviteId) incoming = null;
        if (r.status === 0) return { ok: false, error: UNREACHABLE };
        if (!r.body || !r.body.ok) return { ok: false, error: (r.body && r.body.error) || ('廣場回應異常（' + r.status + '）') };
        return { ok: true };
    }

    async function leave() {
        if (!me) return { ok: true };
        const id = me.id;
        cleanup();
        await request('POST', '/leave', { id });   // 送不到也沒關係：伺服器 graceMs 後自己清
        return { ok: true };
    }

    return {
        join, leave, rename, update, move, say, invite, answer, active,
        incoming: () => incoming, outgoing: () => outgoing,
        chat: () => chat.slice(),
        me: () => me,
        roster: () => [...members.values()],
        skew: () => skew,
        step: () => W.stepAt(Date.now() + skew),
        url: () => base.origin,
        // 測試用：模擬網路斷掉（不送 leave、直接掐掉串流）
        _dropStream: () => { if (streamReq) streamReq.destroy(); },
    };
}

module.exports = { create, DEFAULT_URL, RETRY_MS, UNREACHABLE };
