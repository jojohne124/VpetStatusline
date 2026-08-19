#!/usr/bin/env node
'use strict';
/**
 * plaza-preview-web.js — 廣場的瀏覽器預覽（768×768，實際尺寸）
 *
 * 這是**預覽用的鷹架，不是最終架構**。規格書 §七 已經決定廣場要做成 daemon 的一個
 * 模式而不是獨立頁面（理由是「在外面」是寫進 color-state.json 的持久狀態，另開一個
 * process 去寫同一份 state 會把單一寫入者原則破壞掉）。但那個理由只適用於「會寫
 * state」的正式版 —— 這支**完全不寫任何 state**，只是把合成器的輸出畫出來看，
 * 所以獨立頁面反而是最安全的做法：不可能弄壞你正在養的那隻。
 *
 * 用途是驗第一期真正不確定的兩件事（規格書 §一）：
 *   1. 多人走動同步起來看起來對不對
 *   2. y 排序（誰擋誰）的畫面好不好看
 * 這兩件事跟後端、跟「不在家」狀態完全無關，所以先用假名單看，比整套接完再看便宜。
 *
 * 用法：
 *   node scripts/plaza-preview-web.js            # 8 個假人
 *   node scripts/plaza-preview-web.js 20         # 20 人（規格上限，看看擠不擠）
 *   node scripts/plaza-preview-web.js 8 --mine   # 其中一隻換成你自己現在養的角色
 *
 * 然後開 http://localhost:3011
 */
const os   = require('os');
const path = require('path');
const fs   = require('fs');
const http = require('http');

const INSTALLED = path.join(os.homedir(), '.claude', 'agumon-statusline', 'agumon-core.js');
let core;
try { core = require(INSTALLED); }
catch (e) { core = require('../src/runtime/agumon-core.js'); }

const W = require('../src/shared/plaza-walk.js');
const P = require('../src/daemon/plaza.js');

const argv = process.argv.slice(2);
const num  = Math.max(1, Math.min(20, parseInt(argv.find(a => /^\d+$/.test(a)) || '8', 10)));
const PORT = parseInt(process.env.AGUMON_PLAZA_PORT || '3011', 10);
const CW = 8, CH = 16;          // 與 daemon 同一組（1 dot = 8×8 px）

// ── 假名單 ───────────────────────────────────────────────────────────
const NAMES = ['阿張', 'MAJAJA', '小明', 'Kai', '喵喵', 'Riku', '大雄', 'Zed',
               '阿翰', 'Nova', '皮蛋', 'Ash', '小美', 'Lyn', '老王', 'Rex',
               '嘟嘟', 'Sol', '花花', 'Ivy'];

function rosterPool() {
    try {
        const r = JSON.parse(fs.readFileSync(path.join(core.ASSETS_DIR, 'roster.json'), 'utf8'));
        const list = (r.characters || r.roster || (Array.isArray(r) ? r : Object.keys(r)))
            .map(c => (typeof c === 'string' ? c : c.id || c.name)).filter(Boolean);
        if (list.length) return list;
    } catch (e) {}
    return ['agumon'];
}
const pool = rosterPool();

const occupants = Array.from({ length: num }, (_, i) => ({
    code:     NAMES[i % NAMES.length],
    char:     pool[(i * 7 + 3) % pool.length],
    seed:     1000 + i * 7919,     // 質數間隔，避免相鄰 seed 走出相似路徑
    joinStep: 0,
}));

// --mine：把第一隻換成你現在養的角色（唯讀，不寫回）
if (argv.includes('--mine')) {
    try {
        const st = JSON.parse(fs.readFileSync(path.join(core.STATE_DIR, 'color-state.json'), 'utf8'));
        if (st.characterId) { occupants[0].char = st.characterId; occupants[0].code = '（你）'; }
    } catch (e) { console.log('  讀不到 color-state.json，第一隻維持假角色'); }
}

const caches = new Map();
const t0 = Date.now();
const stepNow = () => Math.floor((Date.now() - t0) / 1000);

const HTML = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>廣場預覽</title>
<style>
  body{background:#0d1117;color:#c9d1d9;font:13px ui-monospace,Consolas,monospace;
       margin:0;padding:16px;display:flex;flex-direction:column;align-items:center;gap:10px}
  /* 廣場是固定 96×48 cell，尺寸由內容決定 —— 不要 max-width:100%，
     否則縮放瀏覽器時 canvas 會被拉扯，像素就不是整數倍了（家裡舞台踩過這個坑）。*/
  #wrap{width:fit-content;border:1px solid #30363d;border-radius:8px;background:#161b22;padding:8px}
  canvas{display:block;image-rendering:pixelated}
  .bar{display:flex;gap:16px;align-items:center;flex-wrap:wrap;max-width:784px}
  .k{color:#8b949e}
</style></head><body>
<div class="bar">
  <span><span class="k">step</span> <b id="step">0</b></span>
  <span><span class="k">在場</span> <b id="n">0</b></span>
  <span><span class="k">走動中</span> <b id="mv">0</b></span>
  <span class="k">96×96 dot = 768×768 px</span>
</div>
<div id="wrap"><canvas id="pz" width="768" height="768"></canvas></div>
<div class="bar k" id="list"></div>
<script>
const CW=${CW}, CH=${CH};
${/* parseAnsi / draw 與 daemon.js 同一套；預覽鷹架先複製一份，
      正式版併進 daemon 時就直接用它原本那份，不會留下兩份。 */''}
function parseAnsi(line){
  const cells=[]; let fg=null,bg=null,idx=0;
  while(idx<line.length){
    if(line[idx]==='\\x1b'){
      const m=/^\\x1b\\[([0-9;]*)m/.exec(line.slice(idx));
      if(m){
        const parts=m[1].split(';').map(Number);
        if(m[1]===''||parts[0]===0){fg=null;bg=null;}
        else if(parts[0]===38&&parts[1]===2){fg=[parts[2],parts[3],parts[4]];}
        else if(parts[0]===48&&parts[1]===2){bg=[parts[2],parts[3],parts[4]];}
        idx+=m[0].length; continue;
      }
    }
    const ch=line[idx];
    if(ch==='▀'){cells.push({top:fg,bot:bg});}
    else if(ch==='▄'){cells.push({top:null,bot:fg});}
    else if(ch==='⠀'||ch===' '){cells.push(null);}
    else {cells.push({ch:ch,col:fg});}
    idx++;
  }
  return cells;
}
function draw(lines){
  const cv=document.getElementById('pz'),ctx=cv.getContext('2d');
  ctx.clearRect(0,0,cv.width,cv.height);
  const rows=lines.map(parseAnsi);
  ctx.textBaseline='top'; ctx.font='13px ui-monospace, Consolas, monospace';
  for(let r=0;r<rows.length;r++)for(let c=0;c<rows[r].length;c++){
    const cell=rows[r][c]; if(!cell||cell.ch!==undefined)continue;
    const x=c*CW,y=r*CH;
    if(cell.top){ctx.fillStyle='rgb('+cell.top.join(',')+')';ctx.fillRect(x,y,CW,CH/2);}
    if(cell.bot){ctx.fillStyle='rgb('+cell.bot.join(',')+')';ctx.fillRect(x,y+CH/2,CW,CH/2);}
  }
  const colOf=c=>c&&c.col?'rgb('+c.col.join(',')+')':'#c9d1d9';
  for(let r=0;r<rows.length;r++){
    let c=0;
    while(c<rows[r].length){
      const cell=rows[r][c];
      if(!cell||cell.ch===undefined){c++;continue;}
      const start=c, style=colOf(cell); let txt='';
      while(c<rows[r].length){const k=rows[r][c];if(!k||k.ch===undefined||colOf(k)!==style)break;txt+=k.ch;c++;}
      const target=(c-start)*CW, w=ctx.measureText(txt).width;
      ctx.save(); ctx.translate(start*CW,r*CH+1);
      if(w>0)ctx.scale(target/w,1);
      ctx.fillStyle=style;
      ctx.shadowColor='rgba(0,0,0,.95)'; ctx.shadowBlur=4;
      ctx.fillText(txt,0,0); ctx.fillText(txt,0,0);
      ctx.shadowBlur=0; ctx.shadowColor='transparent';
      ctx.fillText(txt,0,0);
      ctx.restore();
    }
  }
}
async function poll(){
  try{
    const s=await (await fetch('/state',{cache:'no-store'})).json();
    document.getElementById('step').textContent=s.step;
    document.getElementById('n').textContent=s.placed.length;
    document.getElementById('mv').textContent=s.placed.filter(p=>p.moving).length;
    document.getElementById('list').textContent=
      s.placed.map(p=>p.code+'('+p.char+') '+p.x+','+p.y).join('   ');
    draw(s.lines);
  }catch(e){}
}
poll(); setInterval(poll,1000);
</script></body></html>`;

http.createServer((req, res) => {
    if (req.url === '/state') {
        const step = stepNow();
        const { lines, placed } = P.composePlaza(core, occupants, step, { caches, me: occupants[0].code });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
            step, lines,
            placed: placed.map(p => ({ code: p.code, char: p.char, x: p.x, y: p.y, moving: p.moving })),
        }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
}).listen(PORT, () => {
    console.log(`🏛  廣場預覽（純畫面，不寫任何 state）`);
    console.log(`   ${num} 人 · ${W.PLAZA_W}×${W.PLAZA_H} dot · 每 ${W.STEP_T} 拍決策一次`);
    console.log(`   開啟：http://localhost:${PORT}`);
});
