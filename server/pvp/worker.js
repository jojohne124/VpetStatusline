// VpetStatusline — 幽靈對戰 PvP server (Cloudflare Worker + KV)
//
// 角色定位：純笨儲存。只存/取「戰鬥卡」，不做任何結算（勝負由 client 端決定性計算）。
//
// 路由：
//   PUT  /card/:code                 上傳/更新我的卡（body = card JSON）
//   GET  /card/:code                 指名：取某人的卡
//   GET  /random?stage=&exclude=     隨機：取一張同階卡（排除自己）
//
// 認證：若設了 PVP_KEY secret，所有請求須帶 header  X-Pvp-Key: <key>
// 綁定：KV namespace binding = CARDS
//
// 卡片保存 30 天（TTL），過期自動消失，避免殭屍卡。

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const CARD_TTL = 60 * 60 * 24 * 30; // 30 天
const RANDOM_SCAN = 20;             // 隨機模式最多取樣幾張來找同階

export default {
  async fetch(req, env) {
    // 認證
    if (env.PVP_KEY && req.headers.get('X-Pvp-Key') !== env.PVP_KEY) {
      return json({ error: 'unauthorized' }, 403);
    }

    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean); // ['card','ABC'] / ['random']

    // PUT /card/:code  —— upsert
    if (req.method === 'PUT' && parts[0] === 'card' && parts[1]) {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
      const card = {
        code: parts[1],
        name: String(body.name || parts[1]).slice(0, 24),
        character: String(body.character || ''),
        power: Number(body.power) || 0,
        train: Number(body.train) || 0,
        stage: String(body.stage || ''),
        ts: Date.now(),
      };
      await env.CARDS.put('c:' + parts[1], JSON.stringify(card), { expirationTtl: CARD_TTL });
      return json({ ok: true, card });
    }

    // GET /card/:code  —— 指名
    if (req.method === 'GET' && parts[0] === 'card' && parts[1]) {
      const v = await env.CARDS.get('c:' + parts[1]);
      if (!v) return json({ error: 'not_found' }, 404);
      return json(JSON.parse(v));
    }

    // GET /random?stage=&exclude=  —— 隨機同階
    if (req.method === 'GET' && parts[0] === 'random') {
      const stage = url.searchParams.get('stage');
      const exclude = url.searchParams.get('exclude');
      const list = await env.CARDS.list({ prefix: 'c:' });
      let keys = list.keys
        .map(k => k.name)
        .filter(n => n !== 'c:' + exclude);
      // Fisher–Yates 洗牌，再依序取樣找同階
      for (let i = keys.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [keys[i], keys[j]] = [keys[j], keys[i]];
      }
      for (const k of keys.slice(0, RANDOM_SCAN)) {
        const v = await env.CARDS.get(k);
        if (!v) continue;
        const c = JSON.parse(v);
        if (!stage || c.stage === stage) return json(c);
      }
      return json({ error: 'no_opponent' }, 404);
    }

    return json({ error: 'not_found' }, 404);
  },
};
