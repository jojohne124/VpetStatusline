---
name: project-vpet-statusline
description: Vpet (digimon) statusline source repo at C:\Users\jojoh\VpetStatusline — power/rank/training/PvP system, battle win/lose effects, status card, sprite editor CutIn mode (uncommitted 2026-05-30), 51 chars (六條 Adventure 進化鏈 2026-05-31 加入)
metadata: 
  node_type: memory
  type: project
  originSessionId: 9cc0c3c0-284d-4c5f-a4ec-7a885bcbd393
---

# VpetStatusline 進度（截至 2026-05-29）

## 待討論 / 未做

- **進化 cut-in（user 已表態想做，未實作）**：在 evo 第 8 拍前後插 1-2 拍新形態 cut-in 特寫，做「新角色 reveal」儀式感
  - **技術前提**：現在 evo 鎖在 `st.lastPos`，cut-in 不能跟著飄。要先設計「evo 開始前角色滑到中央」過渡，或讓 cut-in 那拍切到固定 canvas（類似 battle 場景的固定位置）
  - **fallback**：新形態若沒 `cutin-art.json` → 跳過 cut-in 拍，evo 維持原 12 step

## Repo / 部署
- **Source**: `C:\Users\jojoh\VpetStatusline\`
- **Deployed to**: `C:\Users\jojoh\.claude\agumon-statusline\`
- **Deploy command**: `node scripts/install.js`（會複製 runtime + 角色 assets + 共用 sprite，並更新 settings.json）
- **戰鬥 preview**: `node scripts/battle-preview.js <me> <enemy> [--win|--lose] [--v1|--v2]`
- **Editor**: `node src/tools/char-cli.js edit <Name>` → port 3000；同時間只能跑一個
- **角色觸發 cheat**：`cheat <name>` / `cheat --battle [enemy]` / `cheat --evolve <next>` / `cheat --reset`（PATH shim 在 `C:\Users\jojoh\AppData\Roaming\npm\cheat.cmd`）

## Cheat 命令總覽

| 命令 | 功能 |
|------|------|
| `ac <index或name>` | 切換角色（1-23 或角色名） |
| `ac --reset` | 隨機切到 starter |
| `ac --battle [敵]` | 立即戰鬥（可加 --win/--lose） |
| `ac --card` | 顯示狀態卡 5 秒（含勝/敗率 tally） |
| `ac --sleep` | 強制睡眠（持續到 --wake） |
| `ac --wake` | 喚醒 |
| `ac --evolve <次>` | 立即進化到目標角色 |
| `ac --pvp [code]` | Ghost-battle PvP（無 code = 隨機對手，有 code = 指定） |
| `ac --pvp-setup <url> <key> [name]` | 設定 PvP server（一次性） |
| `ac --code` | 顯示自己的 PvP card code |
| `ac --pvp-server` | 查當前 PvP server 設定 |

## Power / Rank / Training 系統（2026-05-25~28 新增）

### Rank（階級）
- 每個角色 config.json 有 `rank` 欄位：Child / Adult / Perfect / Ultimate / UnRank
- 階級 power cap：Child:50 / Adult:100 / Perfect:150 / Ultimate:200 / UnRank:無上限
- `chooseBattleEnemy()`：同 rank 隨機抽敵人，排除自己
- `getTierCap(rank)`：查階級上限

### Power（戰力）
- 每角色 config.json 有 `power` 欄位（基礎戰力，最近全部 -10 做平衡調整）
- 實際戰力 = `min(my power + trainingBonus, tierCap)`
- 敵人戰力 = 敵 power（無訓練補正）
- `getCharacterPower(name)`：查基礎 power

### Training（訓練加成）
- 每收到新 UserPromptSubmit hook，`trainingBonus +1`
- 多視窗競態安全：靠 `lastHookTs` 自然 idempotent
- 進化/切角色時 `trainingBonus` 歸零（同 `_evoCostBase` 清理規則）
- 訓練補正空間：最高 +40（相對 base power 有感）

### 勝率（差距制線性，2026-06-01 改版）
```
勝率% = 50 + (我戰力 - 敵戰力) + 體驗補正，clamp [5, 95]
體驗補正 = pvp ? 0 : 5（單機給玩家小優勢；PvP 0 → 零和對稱 A勝率+B勝率=100）
勝負由 seedRand01(seed) 確定性擲骰決定（多視窗同 seed 必同結果）
```
- 每 1 點戰力差 = 1% 勝率（直觀好算），訓練值維持 1:1（trainingBonus 最高 +40 = +40%）
- clamp [5,95] 刻意留 ±5% 爆冷空間
- **單機 + PvP 共用同一條核心** `winProbFromStr(myStr, eStr, expBonus=5)`（agumon-core.js export）
  - `computeWinProb(myId, st, enemyId)`：算我戰力 `min(power+train, tierCap)` 後呼叫上者
  - `statusline-cheat.js` PvP 段呼叫 `core.winProbFromStr(myStr, oppStr, 0)`
- `seedRand01(seed)`：MurmurHash-like 確定性隨機數
- `forceBattleWin`（ac --battle --win/--lose）仍可覆蓋
- **改版前**：單機是 logistic（`1/(1+e^(-(差)/25))+0.05`），PvP 還停在更舊的比例制 `我/(我+敵)`，兩邊不一致 → 此次統一

## 狀態卡片（ac --card，2026-05-28 新增）

- 5 秒卡片（CARD_LENGTH = 5 步）：淡入 → 全亮 → 淡出
- 顯示內容：角色名稱 / power（含訓練補正）/ Rank
- 右上 CutIn 完整顯示，左側 3 行文字
- CARD_SCENE_WIDTH = 52 cells（對齊戰鬥場景寬度）
- 卡片不排隊：被 battle/evo/舊卡片阻擋時立刻丟，不等待
- 蓋住睡眠視覺，但 sleep 狀態不中斷（lastActivityAt/forceSleep 不變）
- 多視窗同步：`cardTriggerTs` token，各視窗 5 秒同步顯示
- `composeStatusCard()`：合成左側文字 + 右側 CutIn
- `dimCellRows()`：RGB 淡化輔助函數

## 戰鬥視覺特效（2026-05-27 新增）

- **勝利**：右上小太陽 ☀️（sun sprite），整個 result 階段顯示
- **失敗**：右上小烏雲 ☁️（cloud sprite），整個 result 階段顯示
- **睡覺**：右方 Z 特效疊加（sleep_1 → Z；sleep_2 → zZ）
  - `composeSleepScene()` buffer 加寬至 24 cells（16 角色 + 8 特效區）
- sprite 由 `scripts/gen-shared-placeholders.js` 產生

## 戰鬥敵人決定性化（2026-05-27）

- 戰鬥敵人由 trigger seed 確定性產生（不再各視窗獨立隨機）
- 修正多視窗 race：各視窗各自 random 導致第一幀閃出別的敵人
- `chooseBattleEnemy(seed)` 接受 seed 參數

## 戰鬥 v2 設計（cut-in 版本）

- **觸發條件**：me 跟 enemy 都有 `cutin-art.json` 才走 v2；任一方沒有 → fallback v1（19 step 不變）
- **v2 拍數**：21 step
  - step 0：cut-in slide-in 半進場（me col -16, enemy col +36），無驚嘆號
  - step 1-3：cut-in 全進場（me col -4, enemy col +24，重疊 4 cells）+ encounter[0/1/2] 驚嘆號
  - step 4：cut-in 對峙、驚嘆號離場（staredown beat）
  - step 5-9：approach（= v1 step 3-7）
  - step 10+：跟 v1 對齊（elapsed-2）
- **CutIn.png 規格**：96×48 RGBA，alpha < 128 透明；3:1 nearest downsample 到 32×16 cells
- **客製右向**：若同目錄有 `CutIn_r.png`，目前只有 G-Wargreymon 有
- **退距常數**：`BATTLE_CUTIN_RETREAT = 4`（agumon-core.js）

## Adventure 六條進化鏈（2026-05-31 一次新增 24 隻）

由 `scripts/bootstrap-new-chains.js` 一次 scaffold：寫 24 個 config.json + 跑 cli process/cutin + 寫 roster。Source PNG 命名為 `0.png`~`11.png`（對應 frameNames Idle_1..Attack）+ `CutIn.png`，全部 `layout: 'individual'`、cost_threshold 10 進化。
六條鏈（Child→Adult→Perfect→Ultimate）：
- Patamon(10) → Angemon(80) → MagnaAngemon(130) → Dominimon(175)
- Salamon(10) → Gatomon(55) → Angewomon(130) → Magnadramon(175)
- Gomamon(10) → Ikkakumon(60) → Zudomon(110) → Vikemon(160)
- Tentomon(15) → Kabuterimon(65) → MegaKabuterimon(115) → HerculesKabuterimon(165)
- Palmon(10) → Togemon(60) → Lillymon(110) → Rosemon(160)
- Biyomon(15) → Birdramon(65) → Garudamon(115) → Phoenixmon(165)

預設 bullet：複製 Agumon 的火球（24 隻全部）。後來 user 改成複製 Angemon 子彈到 Gatomon/MagnaAngemon、Patamon 子彈到 Gomamon — 子彈是 ad-hoc 指定的，看圖補就好。

**2026-06-01 進度（Adventure 鏈子彈 + sprite 細修）**

子彈複製（仍是 ad-hoc 指定）：
- Tentomon → Kabuterimon → MegaKabuterimon → HerculesKabuterimon（蟲族鏈整條複用同一顆）
- Biollante → Rosemon（植物系）
- Garurumon → Birdramon → Garudamon（注意 Garudamon 後來改成 WereGarurumon 的）
- Magnadramon → Phoenixmon（龍/鳳鏈）

另外 editor 直接修了不少 sprite/bullet：Angewomon, Birdramon, Biyomon, Dominimon, Garudamon, HerculesKabuterimon, Kabuterimon, Lillymon, MegaKabuterimon, Palmon, Phoenixmon, Rosemon, Sekkamon, Tenkomon, Tentomon, Togemon, WereGarurumon, Zudomon 的 pixels.json/art.json/bullet。

### char-cli 擴充（同次）
`src/tools/char-cli.js` 的 `individual` layout 多吃一種命名 `<index>.png`（除原本 `00_Idle_1.png` / `Idle_1.png`），對應右向幀也支援 `<index>_r.png`。

### Magnadramon 8/9 swap 事件
User 反映 Magnadramon 的 `08_Angry` 和 `09_Hurt` 弄反。多次 swap 過程中發現 editor save flow 可能蓋掉 disk 上的 pixels.json — editor 在瀏覽器載入後若按 save 會把 canvas（載入時的舊狀態）寫回，導致中間做的 PNG swap+process 被覆寫。最終靠 `swap PNG → process → 不開 editor 直接驗證 runtime` 收尾。

## 完整角色列表（51 隻，截至 2026-05-31）

| 角色 | Rank | Power | 備註 |
|------|------|-------|------|
| Agumon | Child | 20 | starter |
| Gabumon | Child | 25 | starter |
| BabyGodZilla | Child | 15 | starter |
| DemiDevimon | Child | 22 | |
| Greymon | Adult | 70 | |
| Metalgreymon | Adult | 95 | |
| Garurumon | Adult | 75 | |
| MetalGarurumon | Adult | 100 | |
| GodZilla_1954 | Adult | 60 | |
| GodZilla_1999 | Adult | 65 | |
| Renamon | Adult | 80 | |
| Sekkamon | Adult | 85 | |
| Tenkomon | Adult | 90 | |
| Biollante | Adult | - | 2026-05-29 新增 |
| GodZillasaurus | Perfect | 140 | |
| Devimon | Perfect | 130 | |
| Myotismon | Perfect | 135 | |
| Kiryu | Perfect | - | 2026-05-29 新增 |
| G-Metalgreymon | Perfect | 130 | 2026-05-29 新增；雙 CutIn 圖；有 _r frames；進化到 G-Wargreymon |
| Wargreymon | Ultimate | 170 | |
| G-Wargreymon | Ultimate | 190 | 雙 CutIn 圖（power 從 175→185→190） |
| WereGarurumon | Ultimate | 180 | |
| Yukinamon | Ultimate | 160 | |
| Destoroyah | Ultimate | - | 2026-05-29 新增 |
| VenomMyotismon | UnRank | 200 | |
| Majaja | UnRank | 200 | |
| Soulseer_Mizutsune | UnRank | - | |

starters（roster.json）：agumon, gabumon, babygodzilla, g-metalgreymon

## 已完成 cut-in 的角色（所有 27 隻都有 cutin-art.json）
agumon, greymon, metalgreymon, wargreymon, g-wargreymon(雙圖), g-metalgreymon(雙圖), gabumon, garurumon, weregarurumon, metalgarurumon, babygodzilla, godzillasaurus, godzilla_1954, godzilla_1999, biollante, kiryu, destoroyah, devimon, myotismon, demidevimon, renamon, sekkamon, tenkomon, yukinamon, venommyotismon, majaja, soulseer_mizutsune
（查最新清單：`ls characters/*/cutin-art.json`）

## 分歧進化（branch evolution，2026-06-02 新增）

- 一個角色可有多條 `evolvesTo`；**多條路線同時滿足條件時，以「進化目標 power 強者」為優先**（user 拍板的分歧決定規則）。
- 實作：`checkEvolution`（agumon-core.js）改成每 tick 評估**所有**路線（不再第一條達成就 return，讓各路線 latch 狀態 `_ready`/`_peaked` 都保持更新），收集達成者後 `sort` by `getCharacterPower(target)` desc 取最強。單一路線行為不變。
- **首例：DemiDevimon 在 Adult 多開一條鬼族線**
  - 原線：DemiDevimon → Devimon(70)（win_rate 60%）
  - 新線：DemiDevimon → Bakemon(60) → Phantomon(110) → Creepymon(175)（win_rate 50/55/75%，門檻照 [[evo-winrate-default]]）
  - 因 Devimon 門檻 60% > Bakemon 50%：勝率 **50–59% 時只有 Bakemon 達標→走鬼族線**；**≥60% 兩條都達標→比 power 走 Devimon**。即「表現中庸→鬼族，表現強→惡魔」。已用 core 實測驗證。
  - 三隻素材：`0.png`~`11.png`（individual layout `<index>.png`）+ CutIn；bullet 暫複製 DemiDevimon（鬼族預設，日後可換）。Bakemon 原 `Cutin.png`（小寫 i）已正規化成 `CutIn.png`。
  - **⚠ bullet 複製要連 `bullet.json` 一起**：runtime 戰鬥只讀 `bullet-art.json`（編譯產物），但 **editor 的 bullet 模式讀 `bullet.json`（pixel 來源）**，缺它 editor 會「載入失敗」（cutin 能從 art 反解、bullet 不行）。複製子彈時兩個檔都要帶。

## 狀態機優先級（高 → 低）
1. 進化 (evo) - 12 步
2. 戰鬥 (battle) - v1:19 步 / v2:21 步
3. 大吼 (roar) - 3 步
4. 訓練高興 (happy) - TOKEN_RESET_FRAMES 步
5. 狀態卡 (card) - 5 步（蓋睡眠視覺，不阻擋上述動畫）
6. 強制睡眠 (forceSleep)
7. 睡眠 (sleep) - IDLE_MS=600000（10分鐘）無 hook
8. 表情 (expr) - 隨機 10%
9. 走路 (walk) - 常態

## 多視窗安全機制

1. **Atomic Write**：state 用 tmp 寫入後 rename
2. **Token-based Trigger**：`lastHookTs` / `lastBattleTriggerTs` / `lastCardTriggerTs`
3. **Seed 確定性**：同一 seed 多視窗算同一結果（battle enemy、勝負）
4. **Sticky Window**：cheat 後 5 秒內，max(cost) bump base
5. **Race-safe Training**：idempotent（多視窗同讀 disk 淨增 +1）
6. **走路純函數**：`step + offset % 2`，多視窗必同步

## 重要 hooks / settings
- `~/.claude/settings.json` 已掛 `UserPromptSubmit` hook（呼叫 `agumon-hook.js` 寫 `state/hook.json`，statusline 偵測到時間戳變化 → ROAR + trainingBonus+1 + 重置 lastActivityAt 避免進入 sleep）
- `STEP_MS = 1000`（1 秒 = 1 step），`IDLE_MS = 600000`（10 分鐘無 hook 進入 sleep）
- `statusLine.refreshInterval: 1`（每秒 1 次 render，跟 STEP_MS 對齊）

## Frame throttle（戰鬥 / 進化「保證不跳幀」）
- core 的 battle 與 evo 區塊都用 `shownElapsed = min(target, prev + 1)` 限制每 render 最多 +1
- **走路沒做 throttle**：維持 wallclock 驅動（偶爾跳 1 cell 視覺上可忽略）

## Sprite Editor 加 CutIn mode（2026-05-30 新增，未 commit）

- `src/editor/sprite_editor_server.js` + `sprite_editor.html`：新增 `✨ CutIn` 模式
- **CutIn 沒有 pixels.json 中介檔**：`cutin-art.json` 是 single source of truth
  - server `artToPixels()` 把 halfblock cells 反解回 32×16 像素給前端編
  - 存檔時直接 pixels → halfblock 寫回 `cutin-art.json`
- **W/H 改成動態**：HTML 從 `const W=16,H=16` 改成 `let`，從 `data.width/height` 抓
  - `applyDimensions()` 用 `--cell-px` CSS variable 動態調 cell 大小（32-寬時自動縮到 ~18px）
  - grid template / preview / thumb canvas 都按 W:H 比例
- **⚠ editor 編完 cutin 不會回寫 `CutIn.png`**：重跑 `node src/tools/char-cli.js cutin <Name>` 會用 PNG 蓋掉編輯。Save 訊息有提示
- **Backup**：存檔前 `cutin-art.json.bak` 自動產生
- `bullet`/`shared`/`cutin` 三個 mode 共用同一條 pixels→art 編譯路徑

## Ghost-battle PvP（2026-05-29 新增）

- **Server**：Cloudflare Worker + KV（`server/pvp/`），PUT/GET `/card/:code`，GET `/random?rank=&exclude=`，X-Pvp-Key 認證，30 天 TTL
- **Client**：`ac --pvp-setup <url> <key> [name]` 一次性設定；`ac --pvp [code]` 觸發對戰；`ac --code` 查自己代碼
- **結果**：複用 agumon-core 的 power/tier/seed 算勝負，寫相同 force 欄位，statusline 動畫完全不變
- **Core 沒動**：只改 `statusline-cheat.js`，不影響既有 --battle

## sweepStaleTmps（2026-05-29 新增）

- `agumon-core.js` 新增 `sweepStaleTmps()`：自動清理超過 10 秒的 `.tmp` 孤兒檔（spawn/kill race 殘留）

## 狀態卡勝率 tally（2026-05-29 新增）

- 狀態卡（`ac --card`）現在顯示累積勝/敗場數
- 切換角色或進化時 statusline 重置勝率計數器

## Anti-stick enemy（2026-05-29 新增）

- `chooseBattleEnemy(seed, lastEnemyId)`：避免連續抽到同一敵人，seed+1 re-roll；多視窗仍一致
- 戰鬥結束後把 `battleEnemy` 存入 `lastBattleEnemy`

## 備份策略
- 重要里程碑用 `agumon-core.js.v<X.Y>.bak` 命名（**非 git**）
  - `agumon-core.js.v2.1.bak`：cut-in 即時進場版（無 slide-in、退距 12）
  - `agumon-core.js.v2.2.bak`：slide-in + 退距 4
- VpetStatusline 是 git repo（GitHub Desktop 管理）；git binary 不在 PATH，要用 `C:\Users\jojoh\AppData\Local\GitHubDesktop\app-3.5.10\resources\app\git\cmd\git.exe`

## 設計上的取捨記錄
- **STEP_MS 維持 1000（不要改 750）**：750ms 加速整體節奏，但跟 `refreshInterval:1s` 取樣 aliasing 造成走路每 3 拍跳 1 cell。User 寧可動畫慢一點也不要走路抽搐 → 回 1000。要加速請改 `refreshInterval` 過取樣，不要動 STEP_MS
- **退距 4 cells**：user 比較 4/6/8/10 後選的，理由是「想保有一點重疊但不要太擠」
- **卡片不排隊**：立刻丟保證響應感，不讓用戶等
- **Power 平衡**：base power -10，訓練空間擴大，使 trainingBonus 更有感
- **勝率公式選線性差距制（2026-06-01）**：user 提案 `50 + (我-敵) + bonus`，比 logistic 直觀（每點 = 1%），且順手統一 single/pvp。clamp 選 [5,95] 而非 [0,100] 是為了保留爆冷戲劇性（logistic 本來免費給）。訓練值「先維持 1:1」（保留日後可能改 ÷2 讓訓練是加分非保送的空間）
- **進化 win_rate 門檻依「進化目標 power」差異化（2026-06-01）**：原本同 stage 統一（50/60/65%），改成 pct 由**進化後型態** power 決定（越強→門檻越高），取 5 的倍數；`minBattles` 仍同 stage 統一。機制本來就 config-driven（`evalCondition` 的 `win_rate` 讀 `cond.pct`/`cond.minBattles`），純改 config.json。**此規則訂為未來新增角色的預設算法 → 見 [[evo-winrate-default]]**
- **跨家族子彈複用慣例**（user 偏好）：gabumon ← agumon 子彈；garurumon ← greymon 子彈。不是嚴格規則，是 ad-hoc 指定的，未來改編 sprite 時要先確認
- **PowerShell 5.1 + Claude Code `!` 子 shell 是 `-NoProfile`**：cheat 用 `.cmd` shim 而不是 PowerShell function

## 「壞 shared sprite」事件留檔
- 若要重新還原 shared sprite：`git checkout HEAD -- shared/sprites.json shared/art.json` 然後 `node scripts/install.js`
