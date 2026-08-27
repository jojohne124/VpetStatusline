---
name: cc-statusline 安裝紀錄
description: agumon statusline 完整架構、檔案路徑、進化鏈、角色新增 SOP、作弊碼、已知設定
type: project
originSessionId: 77fedcc1-ecac-4f9f-96ca-e6eafda4883a
---
## 安裝狀態：已完成（2026-04-20）

## 近期更新（2026-06-05）
- **vpet 分發改 npm bin**（commit 97d6bd4）：`bin/vpet.js` 跨平台薄殼 spawn 部署後的 cheat；`install.js [8/8]` 改 `npm link`（npm 自動處理 PATH + Windows .cmd/.ps1），失敗才退 `~/bin`。修正了「別人電腦 ~/bin 不在 PATH → vpet 找不到」。
- **進化新增 `time_of_day` 條件**（583c4f2）：`evalCondition` 加 06:00–18:00 為日、其餘夜（`period:"day"/"night"`，即時 gate、不 latch）。分歧引擎其餘維持「多分支取目標 power 最強者＝勝率獎勵」，priority/weight 經討論不需要（同 power 平手才需 weight，現行設計已用 power 拉開避免）。
- **Shadow 黑影角色**（6105fc0）：對手角色本機沒有時的 fallback（PvP 對到新版/客製角色）。`characters/Shadow/`＝塗黑 agumon（gen-shadow），有 cut-in、`pickBattleVersion` 對缺角色視為有 cut-in→走 v2；不進 roster。PvP guard 放寬（44b365e）：缺圖不再拒打、改黑影演出（勝負用對手卡片 power+train，與本機資產無關）。
- **63 隻新角色原圖轉檔**（facf0e4）：art/cutin/bullet/pixels + config 都生好但**未實裝**（未進 roster、evolvesTo 空）。3 種源圖格式（0.png式 / 00_Idle_1式 / grid sprite / 合併格線含cutin）。BlitzGreymon/CresGarurumon 缺資源、待子彈編完通知才實裝。
- **`vpet tree` 進化歷程展示**（62ec471 起，最終 24eec85）：1×4 橫排，走過階段彩色 Idle_1、未到黑影問號、箭頭+名字。靠 **`evoHistory`**（state 記真實走過的鏈；自然進化 append、reset/cheat 跳轉重設、空則 `buildLineageBackward` 補種）。⚠️**改在 statusline 顯示**（6 秒淡入淡出，`composeTreeScene`），不印到終端——見下方踩雷。新增 `vpet pin/unpin` 除錯指令。
- **agumon 改 individual 原圖**（99b4173）：config 加 `layout:individual`，從 0~11.png 重轉。

## ⚠️ 重要踩雷：終端 raw stdout 會劣化 truecolor（2026-06-05，花很久才查出）
`vpet tree` 一開始印到終端(raw stdout)，agumon 的**深金 `177,132,0`/`183,133,4` 被終端/Claude Code bash 輸出顯示端近似成灰(204,204,204)/深灰**，看起來斑駁失真；但 **renamon 等其他角色沒事**（調色盤沒那個會被劣化的色）。關鍵診斷：**statusline（Claude Code 渲染）truecolor 正確、raw 終端輸出會劣化**——`renderCells` 同一份資料兩邊 byte 相同，差別純在「顯示情境」。**教訓：彩色 sprite/half-block 輸出要走 statusline 顯示（card/battle/tree 那套 trigger→statusline 機制），不要直接 print 到終端。** art 資料本身沒問題（白/灰像素在 editor/statusline 都正確）。

## 核心檔案位置（`~/.claude/`）

| 檔案 | 說明 |
|------|------|
| `agumon-core.js` | 共用邏輯：狀態機、走路、睡覺、表情、進化檢查、buildStatusLines、loadCharacter |
| `statusline-agumon-color.js` | **v7** 主腳本：單一共用 state，動態載入角色、進化檢查、彩色 cell 渲染 |
| `statusline-agumon.js` | v4 黑白亞古獸（braille） |
| `statusline-cheat.js` | 作弊碼：強制切換角色，寫入 force file |
| `agumon-force-char.json` | 作弊碼 force file（持續存在到進化觸發） |
| `agumon-hook.js` | UserPromptSubmit hook：寫入 `agumon-hook.json`，觸發大吼 |
| `agumon-hook.json` | `{ ts, event }` — 供 statusline 偵測新訊息 |
| `agumon-color-state.json` | **單一共用 state 檔**：characterId、lastHookTs、進化旗標、動畫狀態 |
| `agumon-assets/roster.json` | 角色清單（物件格式）：`{"roster":[...],"starters":[...]}` |
| `agumon-assets/<name>/art.json` | 角色彩色精靈資產 |
| `agumon-assets/<name>/config.json` | 角色行為定義（frames、exprs、evolvesTo、rightOffset 等） |
| `commands/agumon-doctor.md` | `/agumon-doctor` skill：診斷並修復 state 常見問題 |

## State 檔結構（v7 單一共用）

```json
{
  "characterId": "agumon",
  "lastHookTs": 1234567890,
  "_evoCostBase": 0,
  "roarStartStep": -1,
  "exprStartStep": -1,
  "exprIdx": 0,
  "happyStartStep": -1,
  "lastStepSeen": 1234567,
  "lastPos": 10,
  "lastFacing": "left",
  "lastActivityAt": 1234567890,
  "_r5hResetAt": 1234567890
}
```

**重要**：v6 以前的舊 namespace 格式（`_anim_<hash>` 鍵）已廢棄。若 state 檔出現這些鍵，用 `/agumon-doctor` 清理。

## settings.json 現況

```json
{
  "statusLine": {
    "type": "command",
    "command": "node C:/Users/kaihsiangchang/.claude/statusline-agumon-color.js",
    "refreshInterval": 1
  },
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [
      { "type": "command", "command": "node C:/Users/kaihsiangchang/.claude/agumon-hook.js" }
    ]}],
    "Stop": [{ "matcher": "*", "hooks": [
      { "type": "command", "command": "node C:/Users/kaihsiangchang/.claude/hooks/message-tracker.js" }
    ]}]
  }
}
```

## Statusline 版本清單

| # | 腳本 | 說明 |
|---|------|------|
| 1 | `statusline.ps1` | PS1 原版（PowerShell） |
| 2 | `statusline-oneline.js` | 單行 JS |
| 3 | `statusline-compact.js` | 緊湊 2 行 JS |
| 4 | `statusline-agumon.js` | 黑白亞古獸（braille） |
| 5/6 | `statusline-agumon-color.js` v6 | 彩色亞古獸 + 進化鏈（per-window namespace，已廢棄） |
| **7** | `statusline-agumon-color.js` v7 | **現行版**：共用 state，無 namespace，大幅簡化 |

**切換指令：**
```
! node C:/Users/kaihsiangchang/.claude/statusline-switch.js 5
```

## 角色系統

### 現有角色（2026-06-02：共 54 隻）

**權威清單看 `agumon-cli/characters/roster.json`（`roster[]` + `starters[]`），各角色進化鏈看 `characters/<Name>/config.json` 的 `evolvesTo`，不要在此重複列舉、會過時。**

家族概覽：
- **亞古獸系**：agumon→greymon→metalgreymon→wargreymon（終點）；g-metalgreymon→g-wargreymon（旁支，cheat-only）
- **加布獸系**：gabumon→garurumon→weregarurumon→metalgarurumon（終點）
- **Adventure 六條鏈（2026-06-01 pull 進來，commit 23b169f/13826fa，24 角色）**：
  patamon→angemon→magnaangemon→dominimon；salamon→gatomon→angewomon→magnadramon；
  gomamon→ikkakumon→zudomon→vikemon；tentomon→kabuterimon→megakabuterimon→herculeskabuterimon；
  palmon→togemon→lillymon→rosemon；biyomon→birdramon→garudamon→phoenixmon
- **哥吉拉系 / 其他**：babygodzilla→godzillasaurus→…、demidevimon→devimon→myotismon→venommyotismon（主鏈）、demidevimon 鬼族分歧鏈 bakemon→phantomon→creepymon（2026-06-02 補進 roster #21-23）、renamon→tenkomon→…、獨立角色 godzilla_1999 / soulseer_mizutsune / majaja / kiryu / destoroyah / biollante / sekkamon / yukinamon 等
- **starters（2026-06-02 補成全部 11 隻 Child）**：agumon, gabumon, babygodzilla, demidevimon, renamon, patamon, salamon, gomamon, tentomon, palmon, biyomon（reset 從這池抽；新增 Child 要記得補進來）

進化條件多為 cost_threshold（累積花費差值 ≥ 門檻，常見 $10）。

### 作弊碼切換（cheat 腳本：`~/.claude/agumon-statusline/statusline-cheat.js`；指令別名 `vpet`）
**2026-06-01：前綴 `ac` → `vpet`，指令可省略 `--`（`vpet pvp` == 舊 `ac --pvp`，舊寫法仍相容）。** `vpet` wrapper 在 `~/bin/vpet`(+`.bat`)，個人目錄不在 repo（分發問題見 [[statusline release 分支]]）。
```
vpet <name>          # 切角色，例 vpet phoenixmon / vpet g-wargreymon
vpet reset           # 隨機抽一個 starter
vpet battle [enemy]  # 手動觸發戰鬥（可加 win/lose）
vpet battle on/off   # 恢復/停用 prompt 後自動戰鬥
vpet card / sleep / wake / evolve <next>
vpet freeze / unfreeze   # 凍結 / 解除自動進化
vpet pvp / pvp <code> / pvp-setup <url> <key> [name] / code [name]   # 幽靈對戰，見 [[幽靈對戰 PvP 設計]]
```
**注意**：角色名稱全小寫含連字號（`g-wargreymon` 非 `G-wargreymon`）。完整指令清單跑 `vpet` 無參數即列出。

**roster 是作弊碼白名單（2026-06-02 踩雷）**：`statusline-cheat.js` 所有指令（切換 line328 / `evolve` line301 / `battle` line231 / `pvp` 對手 line173）都用 `roster.includes()` 把關。新角色只有資產、沒進 `roster.json` → 自然進化進得去、但**所有作弊碼/PvP 全被擋**（顯示「找不到角色」）。新增進化目標務必同步補進 roster 後重跑 `install-runtime`。

**`vpet freeze`（2026-06-01）**：凍結時即使達進化條件也不自動進化（cost 仍累積，解除後達標即進化）；手動 `vpet evolve` 不受影響。機制：cheat 寫 `force.freezeEvolve`（持久開關，同 sleep/wake 模式）；`statusline-agumon-color.js` 讀成 `st._freezeEvolve`，在「自然觸發 checkEvolution」那段加 `&& !st._freezeEvolve` gate。

### 進化邏輯（agumon-core.js `checkEvolution`）
- `cost_threshold` 條件（**2026-06-03 改累積制**）：`delta = evoSpendTotal(st) >= cond.usd` 時 latch `_ready`。
- **累積花費 `_evoSpendBySession`**：`i.cost.total_cost_usd` 是**本 session** 累計，關視窗→新 session 會歸 0。舊的「`total_cost - _evoCostBase` 差值制」跨 session 會進度歸零、進化過後 delta 變負**永久卡住**。改為 per-session `{s:起算cost, p:高水位cost}`，貢獻=`max(0,p-s)`、全 session 加總；首見該 session 以當前 cost 為 `s`（清空後當前 session 貢獻自然歸 0，不重算已花）。`updateEvoSpend(st,i)` 在 `decideAgumon` 每 tick 跑（凍結/表演中也累積）；進化(`checkEvolution`)/切角色(statusline changed 區塊) 時 `_evoSpendBySession={}`。`p` 用 max 冪等 → 多視窗共用 state 也 race-safe（不會被交替灌爆）。舊 `_evoCostBase`/`_evoCheatSticky*`/`_evoCostBasePending` + sticky/pending 機制已移除（切角色時順手 delete 殘留）。需 `session_id`（statusline 輸入有）。
- `win_rate` 條件（2026-06-01 新增）：**即時累積**勝率 `battleWinCount/battleTotalCount*100 >= pct`，且 `battleTotalCount >= minBattles`；**不 latch**（=狀態卡顯示值，所見即所得）
- 支援 `conditions[]` 陣列 + `operator: "and"|"or"`（預設 and）
- **現行各階進化門檻**（2026-06-01）：Child→Adult `$10 + 勝率50% + 5場`；Adult→Perfect `$15 + 60% + 8場`；Perfect→Ultimate `$20 + 65% + 12場`

### 勝率公式（agumon-core.js `computeWinProb`，2026-06-01 改）
- **差距制 logistic**：`1/(1+e^(-(我戰力-敵戰力)/WIN_SENSITIVITY)) + WIN_EXP_BONUS`，`WIN_SENSITIVITY=25`、`WIN_EXP_BONUS=0.05`
- 取代舊的比值制 `我/(我+敵)`——比值制下高階戰力差被稀釋；差距制讓「固定戰力差→固定勝率擺幅」**每階一致**，練滿各階都 ~80%。
- 我戰力 `min(power+trainingBonus, 階段cap)`、敵戰力=敵基礎 power（無訓練）。
- **PvP 端不用這個**：`statusline-cheat.js` 仍用單純 `我/(我+敵)`（使用者指定，刻意不一致）。

## Reset 空降表演（2026-06-02 新增，commit 90b3d15）
`vpet reset` 不再瞬間切換，改播空降：新 starter 從上緣掉入（超出上緣裁切、**不加高**，clip overflow）→ 落地置中（`BATTLE_CENTER_COL`=18，= 戰鬥 result 高興/難過同一點、同錨點）→ 腳下左右噴煙塵 → `walkPhaseOffset` 相位對齊**從中央接著走**。實作：`agumon-core.js` 加 `composeDropScene`/`paintCellsAt`（含 row offset 裁切）/`trimCells`（裁煙塵 bbox）+ `DROP_FALL/DROP_LAND/DROP_LENGTH` + decideAgumon drop 相位；`cheat` reset 寫 `force.dropTriggerTs` token；statusline 接 `_forceDrop`→`dropStartStep`→`composeDropScene`。煙塵用 shared 新 sprite **`dust`（index 13）**，自動裁 bbox 貼角色輪廓外側（右=原圖、左=`flipRows` 鏡射，畫在 16 格哪都行）。**evo 維持原地變身（使用者指定不置中）**。新增 Child 角色記得：①補進 `starters` ②若要當對手也要在 roster。

## 動畫系統（agumon-core.js）

### 優先順序
1. 大吼（roar）— 最高優先，`agumon-hook.json` 有新 ts 時觸發
2. Token 重置高興（happy）— `_r5hResetAt` 偵測到 5h rate limit window 更新
3. 睡覺（sleep）— 超過 600 秒無活動
4. 表情表演（exprs）— 10% 機率隨機觸發
5. 走路（walk）— 三角波位移，`step % 2` 決定 Idle_1/Idle_2

### 動畫 hold 規則（2026-05-08 修正）
**所有動畫 hold 必須是偶數**，否則結束後 `step % 2` 奇偶翻轉，走路幀會卡 Idle_1→Idle_1。
- 公式：`evenHold(n) = n % 2 === 0 ? n : n + 1`
- 大吼：`evenHold(ROAR_FRAMES.length + 1)`
- Happy：`evenHold(TOKEN_RESET_FRAMES.length)`（舊版直接用 length=3 → ODD BUG，已修）
- Exprs：`evenHold(expr.hold ?? expr.frames.length)`

### Expr 位置凍結（2026-05-08 修正）
表演期間位置凍結在觸發當秒：`computeWalk(st.exprStartStep)` 取位置，避免第二幀滑動。

### 自動戰鬥觸發（2026-06-01 修正）
- **舊版壞掉**：靠 `i.model.param_summary` 含字串 `"thinking"` 判斷 → 該欄實務上不含 → 從未觸發。
- **新版時間制**：prompt（hook）後經過 `BATTLE_DELAY_MS`（agumon-core，預設 5000ms）→ `battlePending=true` 觸發一次（`battleArmHookTs`/`battleFiredHookTs` 以 hook ts 當識別，每 prompt 一次），ROAR 結束後 startBattle。
- **停用**：`vpet battle off` 寫 `force.autoBattleOff` → `st._noAutoBattle` gate 住自動觸發；手動 `vpet battle`（走 `_forceBattle`）不受影響。

### 大吼觸發條件
- `UserPromptSubmit` hook 更新 `agumon-hook.json`
- statusline 偵測到 `hook.ts !== st.lastHookTs`
- `lastHookTs` 為頂層 shared 鍵（所有視窗共用），防止多視窗重複觸發

## 右向幀支援（非對稱角色）

**config.json 加 `rightOffset`**：
```json
{ "rightOffset": 12 }
```
- 無此欄位 → 向右走時翻轉圖片
- 有此欄位 → 向右走時取 `frameIdx + rightOffset`，不翻轉

## 角色新增 SOP（開發目錄：`agumon-cli/`）

1. 放原圖：`characters/<name>/sprite.png`
2. 建 config：`characters/<name>/config.json`
3. 轉換：`node char-cli.js process <name>`
4. 微調：`node sprite_editor_server.js <name>` → `http://localhost:3000`
   - 殺舊 server：`Stop-Process -Id (Get-NetTCPConnection -LocalPort 3000 -State Listen).OwningProcess -Force`
5. 加入 roster：`~/.claude/agumon-assets/roster.json`
6. 更新前一個角色的 `evolvesTo`

## 已知 Bug 與修正紀錄

| bug | 根本原因 | 修正位置 |
|-----|---------|---------|
| 切換角色後自動回到亞古獸 | force file 被第一個 instance 刪除 | force file 不刪，只在進化時刪 |
| 啟動時誤觸大吼 | `lastHookTs` undefined 也比較 | `isFirstLoad = st.lastHookTs === undefined` |
| 高興表演定格/反覆觸發 | 兩視窗 `resets_at` 相差輪流寫入 | `_r5hResetAt = Math.max(...)` |
| exprs 連續觸發 | 表演結束後 `lastStepSeen` 未更新 | expr 結束加 `st.lastStepSeen = step` |
| 走路定格（多視窗） | v6 namespace 方案失敗（ppid 每次都不同） | v7 改回共用 state，`lastHookTs` 置頂層 |
| **無限大吼** | 舊 namespace 裡殘留 `lastHookTs`，`Object.assign` 蓋掉 shared 值 | v7 廢除 namespace；animSt 只 import ANIM_KEYS |
| **state 檔暴增 416KB** | `process.ppid` 每次呼叫不同 → 每秒生新 namespace | v7 廢除 namespace；`/agumon-doctor` 可清理殘留 |
| **走路幀 Idle_1→Idle_1** | `tokenResetFrames` hold=3（奇數）→ step 奇偶翻轉 | `evenHold()` 確保所有動畫 hold 為偶數 |
| **expr 第二幀滑動** | walk pos 繼續前進，表演中角色位置移動 | expr 期間用 `computeWalk(exprStartStep)` 凍結位置 |
| roster.json BOM 錯誤 | PowerShell `-Encoding utf8` 寫入 UTF-8 BOM | 改用 Node.js 寫入 |
| **state/ 堆積孤兒 .tmp** | statusline 每秒 spawn/kill，process 在 atomicWrite 的 write→rename 之間被砍時 catch 來不及 unlink tmp（0-byte=砍在 write 前；有內容=砍在 rename 前） | `agumon-core.js` 加 `sweepStaleTmps()`，atomicWrite 每次寫入前掃同目錄、刪 >30 秒未 rename 的 `<file>.*.tmp`（在途的 <30s 不碰，多視窗安全）；2026-05-29 修，兩邊同步 |

## 注意事項
- Windows 路徑必須用絕對路徑（`C:/Users/...`），不能用 `~/`
- 角色名稱作弊碼全小寫，含連字號（`g-wargreymon`）
- state 檔異常時用 `/agumon-doctor` 診斷

**Why:** 避免重裝時重踩同樣的坑，保留進化鏈設計脈絡
**How to apply:** 新增角色或重裝時按 SOP 操作；遇 bug 先查 Bug 表
