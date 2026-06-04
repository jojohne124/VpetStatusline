# 進化鏈 Power × 進化勝率 表（設計新分歧參考）

> 依各角色 `characters/<Name>/config.json` 的 `stage` / `power` / `evolvesTo` 整理。
> 資料快照：2026-06-04（共 54 隻）。`win%` 為**設計公式算出的值**（見下方規則）；改 config 後可重新產生（見文末腳本）。

## 進化鏈 × power × 進化勝率

每格 `角色 power`，箭頭間 `win%` = 從左階進化到右階所需的勝率門檻。

| # | 鏈（家族） | Child | →win% | Adult | →win% | Perfect | →win% | Ultimate |
|---|---|---|---|---|---|---|---|---|
| 1 | 亞古獸 | agumon **20** | **50%** | greymon **70** | **60%** | metalgreymon **120** | **65%** | wargreymon **170** |
| 2 | 加布獸 | gabumon **20** | **50%** | garurumon **70** | **60%** | weregarurumon **120** | **65%** | metalgarurumon **170** |
| 3 | 哥吉拉 | babygodzilla **30** | **55%** | godzillasaurus **80** | **60%** | godzilla_1954 **130** | **70%** | godzilla_1999 **180** |
| 4 | 惡魔（主線） | demidevimon **20** | **50%** | devimon **70** | **60%** | myotismon **120** | **65%** | venommyotismon **170** |
| 5 | 惡魔（鬼族分歧） | demidevimon **20** | **45%** | bakemon **60** | **55%** | phantomon **110** | **70%** | creepymon **175** |
| 6 | 狐（renamon） | renamon **15** | **50%** | tenkomon **65** | **55%** | sekkamon **115** | **65%** | yukinamon **170** |
| 7 | 天使（patamon） | patamon **10** | **55%** | angemon **80** | **60%** | magnaangemon **130** | **65%** | dominimon **175** |
| 8 | 聖獸（salamon） | salamon **10** | **45%** | gatomon **55** | **65%** | angewomon **130** | **65%** | magnadramon **175** |
| 9 | 海獸（gomamon） | gomamon **10** | **50%** | ikkakumon **60** | **55%** | zudomon **110** | **60%** | vikemon **160** |
| 10 | 昆蟲（tentomon） | tentomon **15** | **50%** | kabuterimon **65** | **55%** | megakabuterimon **115** | **65%** | herculeskabuterimon **165** |
| 11 | 植物（palmon） | palmon **10** | **50%** | togemon **60** | **55%** | lillymon **110** | **60%** | rosemon **160** |
| 12 | 鳥（biyomon） | biyomon **15** | **50%** | birdramon **65** | **55%** | garudamon **115** | **65%** | phoenixmon **165** |

> `demidevimon` 是分歧範例：#4 主線（gain 50→win 50%）與 #5 鬼族（gain 40→win **45%**，較弱目標較鬆）共用 Child；鬼族 Ultimate 終點 creepymon(175) 的大跳級（gain 65）→ win **70%**，比主線 venommyotismon(gain 50→65%) 嚴。

## 旁支 / 獨立角色（非 starter 鏈）

| 角色 | 階 | power | →win% | 備註 |
|---|---|---|---|---|
| g-metalgreymon → g-wargreymon | Perfect→Ultimate | 130 → **190** | **75%** | 旁支（cheat-only），gain 60 |
| biollante | Adult | 65 | — | 哥吉拉系反派，終點 |
| kiryu | Perfect | 120 | — | 哥吉拉系反派，終點 |
| destoroyah | Ultimate | 180 | — | 哥吉拉系反派，終點 |
| majaja / soulseer_mizutsune | 無階(?) | 200 | — | Boss 級，無進化鏈 |

## 各階 power 區間（設計依據）

| 階段 | 數量 | power 區間 | 平均 | TIER_CAP（戰力上限） |
|---|---|---|---|---|
| **Child** | 11 | 10–30 | 16 | 50 |
| **Adult** | 13 | 55–80 | 66 | 100 |
| **Perfect** | 14 | 110–130 | 119 | 150 |
| **Ultimate** | 14 | 160–190 | 171 | 200 |
| Boss(?) | 2 | 200 | 200 | ∞ |

> 戰力 = `min(power + trainingBonus, TIER_CAP)`，每則訊息 trainingBonus +1（受 cap 約束）。
> 每階約 +50 級距（如 20→70→120→170），新鏈照此最不突兀。base power 須低於 TIER_CAP，留訓練空間。

## 進化勝率（win_rate）公式 — 考量「收益」與「難度」

`cost_threshold.usd` 與 `minBattles` 各階固定（$10/5 場、$15/8 場、$20/12 場）。
`win_rate.pct` 依下式設計，**收益（gain）為主、難度（source 強度）為輔，夾在各階 [底, 天花板]**：

```
win% = floor + (cap − floor) × (0.7 × gain位階 + 0.3 × source位階)   取 5 的倍數
```

| 進化段 | [floor, cap] | 說明 |
|---|---|---|
| Child→Adult | [45, **60**] | 早期輕鬆 |
| Adult→Perfect | [50, **70**] | 中期 |
| Perfect→Ultimate | [55, **80**] | 後期較嚴 |

- **收益 gain** = `target_power − source_power`，正規化到 `[40,70] → 0~1`（跳級越大越接近天花板）。
- **難度 source位階** = source 在其階級帶 `[min,max]` 的 `0~1`（強者可承受略嚴；權重低）。
- **天花板 60/70/80**：避免 gate 超過訓練滿能達到的勝率而「永遠觸不到」，同時形成「早鬆後嚴」曲線。
- 收益越高越嚴（必然），但有天花板防過苛 → 兼顧體驗。

### 設計新分歧的步驟

1. 依階級帶選 power（Child 10–30 / Adult 55–80 / Perfect 110–130 / Ultimate 160–190），每階約 +50。
2. 算 gain = 目標 − 來源，代入上式得 win%（取 5 倍數、夾天花板）。
3. 分歧之間 power 高低也決定「同 tick 同時達標走哪條」（`checkEvolution` 取進化目標 power 強者）。
4. cost / minBattles 用該階固定值。

## 重新產生本表

config 改動後，於 repo 根目錄跑：

```bash
node -e '
const fs=require("fs"),path=require("path");const dir="characters";const C={};
for(const n of fs.readdirSync(dir)){const p=path.join(dir,n,"config.json");if(!fs.existsSync(p))continue;
let c;try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch{continue}
C[n.toLowerCase()]={id:n.toLowerCase(),stage:c.stage,power:c.power,to:(c.evolvesTo||[]).map(e=>e.character)};}
const band={Child:[10,30],Adult:[55,80],Perfect:[110,130],Ultimate:[160,190]};
const pos=(pw,st)=>{const b=band[st];if(!b)return .5;return Math.max(0,Math.min(1,(pw-b[0])/(b[1]-b[0])));};
const r5=x=>Math.round(x/5)*5;const FC={Child:[45,60],Adult:[50,70],Perfect:[55,80]};
const gn=g=>Math.max(0,Math.min(1,(g-40)/30));
const win=(s,t)=>{const fc=FC[s.stage]||[50,70];return r5(fc[0]+(fc[1]-fc[0])*(0.7*gn(t.power-s.power)+0.3*pos(s.power,s.stage)));};
const starters=require("./characters/roster.json").starters;const paths=[];
function dfs(id,a){const c=C[id];const acc=[...a,id];if(!c||!c.to.length){paths.push(acc);return;}for(const t of c.to)dfs(t,acc);}
for(const s of starters)dfs(s,[]);const seen=new Set();
for(const pth of paths){const k=pth.join(">");if(seen.has(k))continue;seen.add(k);
const out=[];for(let i=0;i<pth.length;i++){const c=C[pth[i]];out.push(c.id+"("+c.power+")");if(i<pth.length-1)out.push(win(c,C[pth[i+1]])+"%");}
console.log(out.join(" → "));}'
```
