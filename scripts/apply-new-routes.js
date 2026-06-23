#!/usr/bin/env node
/*
 * apply-new-routes.js — 套用「新進化分歧 + 新 starter」路線資料到 source configs。
 *
 * 純資料變更：只改 characters/<Name>/config.json 的 `power` 與 `evolvesTo`，
 * 以及 characters/roster.json 的 roster / starters。不碰 art/bullet/cutin，不部署。
 *
 * 用法：
 *   node scripts/apply-new-routes.js            # dry-run：只印計畫，不寫檔（預設）
 *   node scripts/apply-new-routes.js --write     # 實際寫入 source configs + roster
 *   node scripts/apply-new-routes.js --no-roster # 寫檔但不動 roster.json
 *
 * 設計依據：docs/agent-memory/evo-winrate-default.md（win% 由目標 power 決定）
 *   + 本腳本補的 tie-break：相鄰 power 兄弟分支若打平，保留既有那條、新分支挪 ±5%，
 *     確保 checkEvolution（取目標 power 強者）下每條分支都「可達」（嚴格遞增）。
 */
const fs = require('fs');
const path = require('path');

const CHARS_DIR = path.join(__dirname, '..', 'characters');
const WRITE     = process.argv.includes('--write');
const NO_ROSTER = process.argv.includes('--no-roster');

// ── 分波實裝（--wave）：只接「資產（含真子彈）已完成」這批的鏈，其餘設計保留不接。 ──
// 邊只在「兩端都屬本波」時納入；既有角色當交叉/下位端點時列入 WAVE_BASE。
const WAVE = process.argv.includes('--wave');
const WAVE_NEW = new Set([
  'greymon_2010','metalgreymon_2010','zekegreymon',   // 亞古獸 2010 線
  'leomon','loaderleomon','saberleomon',              // 獅子線（loaderleomon 取代 shishimamon）
  'blitzgreymon','cresgarurumon',                     // Perfect→Ultimate 上位旁支
  'commandramon','hi-commandramon','cargodramon','brigadramon',  // 突擊獸線
  'loogamon','loogarmon','soloogarmon','fenriloogamon',          // 狼獸線
  'kuwagamon','okuwamon','grankuwagamon',             // 甲蟲鍬形蟲線（第二波 2026-06-22）
  'dolphmon','whamon','plesiomon',                    // 海獸海豚線（第二波）
  'xiquemon','crowmon','tengumon',                    // 鳥喜鵲線（第二波）
  'pteromon','galemon','grandgalemon','zephagamon',   // 翼龍線（第二波，pteromon 為新 starter）
  'woodmon','cherrymon','puppetmon',                  // 植物木偶線（第三波 2026-06-23）
  'blossomon','hydramon',                             // togemon 花妖線（第三波）
  'pumpkinmon','noblepumpkinmon',                     // bakemon 南瓜線（第三波）
]);
const WAVE_BASE = new Set(['agumon','gabumon','greymon','garurumon','metalgreymon','weregarurumon',
  'tentomon','kabuterimon','gomamon','ikkakumon','biyomon','birdramon','garudamon',
  'zudomon',  // zudomon→plesiomon（plesiomon 改掛上位旁支，與既有 vikemon 並列）
  'palmon','togemon','bakemon']);  // 第三波交叉/下位端點
const inWave = id => WAVE_NEW.has(id) || WAVE_BASE.has(id);
const WAVE_STARTERS = new Set(['commandramon','loogamon','pteromon']);

// ── 1) power 覆寫（小寫 id → power）。已存在且相同者為 no-op。 ──────────────
const POWER = {
  agumon:20, greymon:70, greymon_2010:65, metalgreymon_2010:115, zekegreymon:170, metalgreymon:120, blitzgreymon:173,
  gabumon:20, leomon:65, loaderleomon:115, saberleomon:165, garurumon:70, weregarurumon:120, cresgarurumon:173,
  tentomon:15, kuwagamon:60, okuwamon:110, grankuwagamon:165,
  gomamon:10, dolphmon:65, whamon:115, leviamon:170, plesiomon:165,
  biyomon:15, xiquemon:70, crowmon:120, tengumon:170,
  palmon:10, woodmon:65, cherrymon:115, puppetmon:165, togemon:60, blossomon:115, hydramon:170,
  patamon:10, turuiemon:60, antylamon:115, dijiangmon:170,
  gatomon:55, ladydevimon:130, lilithmon:175,
  renamon:15, musyamon:60, oboromon:110, zanbamon:160,
  godzillasaurus:80, godzilla_jr:125, godzilla_1994:180,
  bakemon:60, pumpkinmon:120, noblepumpkinmon:175,
  syakomon:15, shellmon:62, marinbullmon:120, ryugumon:170, ariemon:165,
  seadramon:58, megaseadramon:115, metalseadramon:160, shagaramon:165,
  commandramon:25, 'hi-commandramon':75, cargodramon:125, brigadramon:175,
  loogamon:25, loogarmon:75, soloogarmon:125, fenriloogamon:175,
  pteromon:25, galemon:75, grandgalemon:125, zephagamon:175,
  angoramon:25, symbareangoramon:75, lamortmon:125, diarbbitmon:175,
  jellymon:25, teslajellymon:75, thetismon:125, amphimon:175,
};

// ── 2) 新進化邊（from → to，time 為日夜分歧用）──────────────────────────────
const NEW_EDGES = [
  // 亞古獸 2010 線（前期弱、後期持平）+ greymon 交叉
  ['agumon','greymon_2010'], ['greymon_2010','metalgreymon_2010'], ['metalgreymon_2010','zekegreymon'], ['greymon','metalgreymon_2010'],
  // 加布獸獅子線（下位）+ garurumon 交叉（loaderleomon 取代 shishimamon，2026-06-15）
  ['gabumon','leomon'], ['leomon','loaderleomon'], ['loaderleomon','saberleomon'], ['garurumon','loaderleomon'],
  // 甲蟲鍬形蟲線（前期弱、後期持平）+ kabuterimon 交叉
  ['tentomon','kuwagamon'], ['kuwagamon','okuwamon'], ['okuwamon','grankuwagamon'], ['kabuterimon','okuwamon'],
  // 海獸海豚線：終點改 leviamon（待 leviamon 資產完成才接，現由 --wave 自動 gate 住）；plesiomon 改掛 zudomon（見下方 Perfect→Ultimate）
  ['gomamon','dolphmon'], ['dolphmon','whamon'], ['ikkakumon','whamon'], ['whamon','leviamon'],
  // 鳥喜鵲線（上位）+ birdramon 交叉
  ['biyomon','xiquemon'], ['xiquemon','crowmon'], ['crowmon','tengumon'], ['birdramon','crowmon'],
  // 植物木偶線（上位）— 注意：togemon→cherrymon 已依指示刪除
  ['palmon','woodmon'], ['woodmon','cherrymon'], ['cherrymon','puppetmon'],
  // 天使兔線（前弱後強）
  ['patamon','turuiemon'], ['turuiemon','antylamon'], ['antylamon','dijiangmon'],
  // 聖獸日夜分歧（夜→墮天女線）
  ['gatomon','ladydevimon','night'], ['ladydevimon','lilithmon'],
  // 狐武者線（下位）
  ['renamon','musyamon'], ['musyamon','oboromon'], ['oboromon','zanbamon'],
  // 哥吉拉 Jr 線（前期弱、後期持平）
  ['godzillasaurus','godzilla_jr'], ['godzilla_jr','godzilla_1994'],
  // Perfect→Ultimate 上位旁支
  ['metalgreymon','blitzgreymon'], ['weregarurumon','cresgarurumon'], ['zudomon','plesiomon'],
  // togemon 花妖線（上位）
  ['togemon','blossomon'], ['blossomon','hydramon'],
  // bakemon 南瓜線（上位）
  ['bakemon','pumpkinmon'], ['pumpkinmon','noblepumpkinmon'],
  // 新 starter：貝海獸雙線
  ['syakomon','shellmon'], ['shellmon','marinbullmon'], ['marinbullmon','ryugumon'], ['marinbullmon','ariemon'],
  ['syakomon','seadramon'], ['seadramon','megaseadramon'], ['megaseadramon','metalseadramon'], ['megaseadramon','shagaramon'],
  // 高階 starter：上位自家線 + 下位掉入共通線
  ['commandramon','hi-commandramon'], ['commandramon','greymon'], ['hi-commandramon','cargodramon'], ['hi-commandramon','metalgreymon'], ['cargodramon','brigadramon'],
  ['loogamon','loogarmon'], ['loogamon','garurumon'], ['loogarmon','soloogarmon'], ['loogarmon','weregarurumon'], ['soloogarmon','fenriloogamon'],
  ['pteromon','galemon'], ['pteromon','birdramon'], ['galemon','grandgalemon'], ['galemon','garudamon'], ['grandgalemon','zephagamon'],
  ['angoramon','symbareangoramon'], ['angoramon','leomon'], ['symbareangoramon','lamortmon'], ['symbareangoramon','loaderleomon'], ['lamortmon','diarbbitmon'],
  ['jellymon','teslajellymon'], ['jellymon','shellmon'], ['teslajellymon','thetismon'], ['teslajellymon','marinbullmon'], ['thetismon','amphimon'],
];

// 新 starter（reset 可抽）
const NEW_STARTERS = ['syakomon','commandramon','loogamon','pteromon','angoramon','jellymon'];

// ── 公式（同 evo-winrate-default.md / power-table.md）────────────────────────
const STAGE_COST = { Child:10, Adult:15, Perfect:20 };
const STAGE_MINB = { Child:5,  Adult:8,  Perfect:12 };
const BAND = { Child:[10,30], Adult:[55,80], Perfect:[110,130], Ultimate:[160,190] };
const FC   = { Child:[45,60], Adult:[50,70], Perfect:[55,80] };
const r5  = x => Math.round(x/5)*5;
const pos = (p,s) => { const b=BAND[s]; if(!b) return .5; return Math.max(0,Math.min(1,(p-b[0])/(b[1]-b[0]))); };
const gn  = g => Math.max(0,Math.min(1,(g-40)/30));

// ── 載入 source configs ──────────────────────────────────────────────────────
const dirOf = {};      // 小寫 id → 實際資料夾名
const CFG   = {};      // 小寫 id → config 物件
for (const name of fs.readdirSync(CHARS_DIR)) {
  const p = path.join(CHARS_DIR, name, 'config.json');
  if (!fs.existsSync(p)) continue;
  let c; try { c = JSON.parse(fs.readFileSync(p,'utf8')); } catch(e){ continue; }
  const id = name.toLowerCase();
  dirOf[id] = name; CFG[id] = c;
}
const powOf  = id => POWER[id] != null ? POWER[id] : (CFG[id] ? CFG[id].power : null);
const stageOf= id => CFG[id] ? CFG[id].stage : '?';
const winF   = (src,tgt) => { const s=stageOf(src); const fc=FC[s]||[50,70]; return r5(fc[0]+(fc[1]-fc[0])*(0.7*gn(powOf(tgt)-powOf(src))+0.3*pos(powOf(src),s))); };

// 既有邊存的 win% pct（讀 config）
function existingPct(src,tgt){
  const c = CFG[src]; if(!c||!c.evolvesTo) return null;
  const e = c.evolvesTo.find(x=>x.character===tgt); if(!e) return null;
  const conds = e.conditions ?? (e.condition?[e.condition]:[]);
  const w = conds.find(x=>x.type==='win_rate');
  return w ? w.pct : null;
}
const isExisting = (src,tgt) => !!(CFG[src] && CFG[src].evolvesTo && CFG[src].evolvesTo.some(x=>x.character===tgt));

// ── 組合每個 parent 的 children（既有 + 新），算 pct + tie-break ─────────────
const children = {};  // src → [{tgt, isNew, time}]
const waveParents = new Set();   // --wave：本波實際接到新邊的 parent
for (const id in CFG) (CFG[id].evolvesTo||[]).forEach(e => { (children[id]=children[id]||[]).push({tgt:e.character, isNew:false, time:null}); });
for (const [from,to,time] of NEW_EDGES) {
  if (WAVE && !(inWave(from) && inWave(to))) continue;   // 分波：只接兩端都屬本波的邊
  if (WAVE) waveParents.add(from);
  children[from]=children[from]||[];
  if (!children[from].some(k=>k.tgt===to)) children[from].push({tgt:to, isNew:true, time:time||null});
}

const PCT = {};   // "src>tgt" → 最終 pct
for (const src in children) {
  let kids = children[src].map(k => ({
    ...k, p: powOf(k.tgt),
    pct: k.isNew ? winF(src,k.tgt) : existingPct(src,k.tgt),
  })).sort((a,b)=>a.p-b.p);
  const timeGated = kids.some(k=>k.time);
  if (!timeGated) {
    for (let i=1;i<kids.length;i++) {
      if (kids[i].p>kids[i-1].p && kids[i].pct<=kids[i-1].pct) {
        if (kids[i].isNew)        kids[i].pct   = kids[i-1].pct + 5;   // 強分支(新)升
        else if (kids[i-1].isNew) kids[i-1].pct = kids[i].pct   - 5;   // 弱分支(新)降
        else                      kids[i].pct   = kids[i-1].pct + 5;   // 兩既有(理論不會)
      }
    }
  }
  kids.forEach(k => PCT[src+'>'+k.tgt] = k.pct);
}

// ── 驗證：每個分歧點 win% 嚴格遞增（無死路）────────────────────────────────
let dead = 0;
for (const src in children) {
  const kids = children[src]; if (kids.length<2) continue;
  const a = kids.map(k=>({...k,p:powOf(k.tgt),pct:PCT[src+'>'+k.tgt]})).sort((x,y)=>x.p-y.p);
  if (a.some(k=>k.time)) continue;  // time-gated 互斥，不需遞增
  for (let i=1;i<a.length;i++) if (a[i].p>a[i-1].p && a[i].pct<=a[i-1].pct) {
    console.log(`  !! DEAD ${src}: ${a[i-1].tgt}(p${a[i-1].p},w${a[i-1].pct}) >= ${a[i].tgt}(p${a[i].p},w${a[i].pct})`);
    dead++;
  }
}

// ── 產生每個角色的新 config（power + evolvesTo）────────────────────────────
function buildEvolvesTo(src) {
  const kids = children[src]; if (!kids) return undefined;
  const stage = stageOf(src);
  return kids.sort((a,b)=>powOf(a.tgt)-powOf(b.tgt)).map(k => {
    const conds = [
      { type:'cost_threshold', usd: STAGE_COST[stage] ?? 15 },
      { type:'win_rate', pct: PCT[src+'>'+k.tgt], minBattles: STAGE_MINB[stage] ?? 8 },
    ];
    // 既有邊：保留它原本 cost（避免動到既有平衡），只在 gatomon→angewomon 補 day
    if (!k.isNew) {
      const orig = CFG[src].evolvesTo.find(x=>x.character===k.tgt);
      const oc = orig.conditions ?? (orig.condition?[orig.condition]:[]);
      const cost = oc.find(x=>x.type==='cost_threshold');
      const win  = oc.find(x=>x.type==='win_rate');
      if (cost) conds[0] = {...cost};
      if (win)  conds[1] = {...win};
    }
    if (k.time) conds.push({ type:'time_of_day', period:k.time });
    // 聖獸日線：既有 angewomon 補 day gate
    if (src==='gatomon' && k.tgt==='angewomon') conds.push({ type:'time_of_day', period:'day' });
    return { character:k.tgt, conditions:conds };
  });
}

// ── 輸出計畫 / 寫檔 ─────────────────────────────────────────────────────────
const touched = WAVE
  ? new Set([...waveParents, ...WAVE_NEW])                       // 分波：只動本波 parent + 本波新角色
  : new Set([...Object.keys(POWER), ...Object.keys(children)]);
const plan = [];
for (const id of [...touched].sort()) {
  if (!CFG[id]) { plan.push(`  ! 缺 config: ${id}`); continue; }
  const c = CFG[id];
  const newPow = powOf(id);
  const powChg = c.power !== newPow ? `power ${c.power}→${newPow}` : null;
  const evo = buildEvolvesTo(id);
  const oldEvo = (c.evolvesTo||[]).map(e=>e.character).join(',');
  const newEvo = (evo||[]).map(e=>`${e.character}(${(e.conditions.find(x=>x.type==='win_rate')||{}).pct}%${e.conditions.some(x=>x.type==='time_of_day')?'/'+e.conditions.find(x=>x.type==='time_of_day').period:''})`).join(' , ');
  const evoChg = oldEvo !== (evo||[]).map(e=>e.character).join(',') || JSON.stringify(c.evolvesTo)!==JSON.stringify(evo);
  if (powChg || evoChg) plan.push(`  ${dirOf[id].padEnd(20)} ${stageOf(id).padEnd(8)} ${powChg?('['+powChg+'] '):''}-> ${newEvo}`);
  if (WRITE) {
    c.power = newPow;
    if (evo) c.evolvesTo = evo;
    fs.writeFileSync(path.join(CHARS_DIR, dirOf[id], 'config.json'), JSON.stringify(c,null,2)+'\n');
  }
}

console.log(`\n=== 進化路線套用計畫 (${WRITE?'WRITE':'DRY-RUN'}${WAVE?' / WAVE':''}) — 死路風險: ${dead} ===\n`);
console.log(plan.join('\n'));

// roster
const rosterPath = path.join(CHARS_DIR,'roster.json');
if (fs.existsSync(rosterPath)) {
  const r = JSON.parse(fs.readFileSync(rosterPath,'utf8'));
  const before = { roster:r.roster.length, starters:r.starters.length };
  const wiredIds = new Set();
  for (const src in children) { wiredIds.add(src); children[src].forEach(k=>wiredIds.add(k.tgt)); }
  const addRoster = [...wiredIds].filter(id=>CFG[id] && !r.roster.includes(id)).sort();
  const addStart  = NEW_STARTERS.filter(id=>(!WAVE || WAVE_STARTERS.has(id)) && !r.starters.includes(id));
  console.log(`\n=== roster.json ===`);
  console.log(`  新增 roster (${addRoster.length}): ${addRoster.join(', ')}`);
  console.log(`  新增 starters (${addStart.length}): ${addStart.join(', ')}`);
  if (WRITE && !NO_ROSTER) {
    addRoster.forEach(id=>r.roster.push(id));
    addStart.forEach(id=>r.starters.push(id));
    fs.writeFileSync(rosterPath, JSON.stringify(r,null,2)+'\n');
    console.log(`  -> 已寫入 (roster ${before.roster}→${r.roster.length}, starters ${before.starters}→${r.starters.length})`);
  }
}

console.log(`\n${WRITE?'✅ 已寫入 source configs。部署請另跑 node scripts/install.js':'（dry-run，未寫檔。加 --write 實際套用，仍不部署）'}`);
