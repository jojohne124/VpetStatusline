---
name: pvp
description: agumon statusline 幽靈對戰(非同步 ghost battle)架構、ac指令、Cloudflare Worker+KV API
metadata: 
  node_type: memory
  type: project
  originSessionId: d0a17ab2-a64b-40aa-a6ad-075688345472
---

## 狀態（2026-05-29）

原型完成、已 commit+push（commit `cf3ace2`）。worker 已用 `wrangler dev` 本機驗證端到端通過。

### 正式部署進度（host = 使用者本人，2026-05-29）
- ✅ `wrangler login` 完成
- ✅ KV namespace `CARDS` 建立，id `f8876d818945423f801d9cd2509898c8` 已填進 `server/pvp/wrangler.toml`
- ✅ Worker 部署：**https://vpet-pvp.jojohne124.workers.dev**（workers.dev 子網域 = `jojohne124`，帳號層級一次性註冊，走 dashboard onboarding 頁註冊，`wrangler deploy` 的互動 prompt 在此環境會 fallback 成 no）
- ✅ `PVP_KEY` secret 已設（強隨機；**機密，存在 Cloudflare secret + 本機 `state/pvp.json`，未進 repo**；要查就看 pvp.json）
- ✅ 本人 client 已 `--pvp-setup`：friend code `9EENE3`、名稱 `jojohne124`
- ✅ **SSL 憑證已簽發、線上驗證通過（2026-06-01）**：無密鑰→403、帶密鑰→404/200 都正確；`vpet pvp` 已成功 PUT 我的卡到線上（`GET /card/9EENE3` 回 200），隨機回 `no_opponent`（正確，池中只有自己）。**整套 PvP 已正式上線可用。**

### 還沒做（待邀第二人）
1. 邀朋友：給網址 `https://vpet-pvp.jojohne124.workers.dev` + PVP_KEY（在本機 pvp.json），對方跑 `vpet pvp-setup <url> <key> <name>`
2. 兩人都 `vpet pvp` 過一次後，互相 `vpet pvp <對方code>` 實測對戰演出（這才是第一次真人對戰）
3. `wrangler.toml`（含真實 KV id `f8876d818945423f801d9cd2509898c8`，非機密）可隨下次 commit 進 git；PVP_KEY 保持不進 repo

## 操作說明（2026-06-01 上線版）

### 線上環境（已部署）
- **網址**：`https://vpet-pvp.jojohne124.workers.dev`
- **workers.dev 子網域**：`jojohne124`（帳號層級，一次性，走 dashboard onboarding 頁註冊）
- **KV namespace**：`CARDS`，id `f8876d818945423f801d9cd2509898c8`（已在 `server/pvp/wrangler.toml`）
- **PVP_KEY（機密）**：存在 Cloudflare secret + 本機 `~/.claude/agumon-statusline/state/pvp.json` 的 `key`。要查值看 pvp.json，**勿明文寫進 repo / 記憶**。
- host = 使用者本人（friend code `9EENE3`、名稱 `jojohne124`）。

### Host 維運（改 worker 程式碼後重部署）
在 `agumon-cli/server/pvp/`：
```
npx wrangler deploy                 # 重部署 worker.js（非互動，子網域已註冊）
npx wrangler secret put PVP_KEY     # 換密鑰才需要；stdin 餵值：printf '<key>' | npx wrangler secret put PVP_KEY
```
首次部署流程（已完成、備查）：`wrangler login` → `wrangler kv namespace create CARDS`(id 填 toml) → dashboard 註冊子網域 → `secret put PVP_KEY` → `deploy`。
**注意**：`wrangler login` 與「註冊子網域」是互動式，此 CLI 環境的 prompt 會 fallback 成 no → login 用 `! npx wrangler login`、子網域走 dashboard 網頁註冊。

### 邀一個新玩家
給對方：**網址** + **PVP_KEY**（從你的 pvp.json 複製）。對方（已裝 vpet statusline）跑一行：
```
vpet pvp-setup https://vpet-pvp.jojohne124.workers.dev <PVP_KEY> <他的名字>
```

### 玩家指令（= `~/.claude/agumon-statusline/statusline-cheat.js`，別名 vpet）
```
vpet pvp            # 隨機同階線上對手
vpet pvp <名牌>     # 指名對手（名牌不分大小寫）
vpet pvp MAJAJA     # 固定練習對手（依階級，純本機免連線）
vpet code           # 查自己的名牌 / server
vpet code <名牌>    # 設定名牌（顯示名＝指名 ID 合一；中文或英數）
```

**2026-06-02 friend code 與顯示名合併為「名牌」**（使用者覺得小遊戲不需分兩個）：單一身分欄位，仍存在 `pvp.json.code`、`name` 廢棄（設定時 `delete p.name`）。`normId()`=trim+toUpperCase（ASCII 不分大小寫、CJK 原樣），`validId()`=`/^[\p{L}\p{N}]{1,16}$/u`（中文或英數、不可空白/符號）。`MAJAJA` 為保留字（撞到內建 bot 指名路徑）。`vpet code id <X>` 舊別名仍相容。指名/`exclude` 一律走正規化後的 code。myCard `name:p.code`、oppLabel=`opp.code`。worker 不受影響（仍拿 code 當 KV key）。撞號邏輯不變＝後上傳蓋前者（單一全域池、key 只是 auth gate）。

**2026-06-02 兩項新功能**：
1. **自訂 friend code**：`vpet code id <NEWCODE>`（驗證 `^[A-Z0-9]{3,12}$`、小寫自動轉大寫）。只改本機 `pvp.json.code`，下次 `vpet pvp` 才把卡上傳到新 ID；舊 ID 卡留 server 到 TTL 過期。⚠ 共用同把 key 時若撞到別人 ID，PUT 會覆蓋對方卡（無法查擁有權，只給警告）。
2. **戰鬥演出顯示對方 ID**：`--pvp` 多寫 `force.pvpOppLabel` → statusline 戰鬥 token 接成 `st._pvpOppLabel` → core `startBattle` 落成 `st.pvpOppLabel`（戰鬥結束兩處 cleanup 清空）→ 傳進 `composeBattleScene(opts.oppLabel)`。手動 `vpet battle` 會 `delete force.pvpOppLabel` 避免沿用上次 PvP 的 label。
   **顯示位置（2026-06-02 調整）**：使用者要求改放「角色腳底下、白字、不寫 vs」，**我方與敵方都顯示**。實作：`composeBattleScene` 在 `renderCells` 後用 `captionRow([{col,label}...])` push 一列，把兩個名牌放到各自欄位——我方 `BATTLE_ME_LEFT_COL(0)`、敵方 `BATTLE_ENEMY_RIGHT_COL(36)`，各以 `footCenter()` 置中於自己的 16-cell 區塊；寬度用新加的 `dispWidth()`（東亞全形算 2 格，`isWideChar` 判 CJK）。`captionRow` 依 col 排序、依顯示寬度推進避免重疊。場景列數 8→9。資料流：`force.pvpOppLabel`+`force.pvpMeLabel`(=me.code) → `st._pvpOppLabel/_pvpMeLabel` → `startBattle` 落成 `st.pvpOppLabel/pvpMeLabel`（結束兩處 cleanup 清空）→ `composeBattleScene(opts.oppLabel/meLabel)`。（舊版左側洋紅 `⚔ vs` 已移除。）

**2026-06-02 固定練習對手（bot）**：避免池中只有自己時配不到、也方便測試。ID 一律 `MAJAJA`，依玩家階級派角色（哥吉拉系，stage/power 天然吻合）：Child→babygodzilla(30) / Adult→biollante(65) / Perfect→kiryu(120) / Ultimate→destoroyah(180)。實作於 `statusline-cheat.js`：`PVP_BOTS` map + `makeBot(stage)`（`opp.stage` 用玩家階級保證同階）。觸發兩路：① `vpet pvp`（隨機）抓不到真人（catch `no_opponent`/`HTTP 404`）→ fallback bot（403 等其他錯誤照常拋出）；② `vpet pvp MAJAJA` 指名 → 純本機、**跳過 server PUT/GET、免連線**，最適合測試。console 標 `（固定練習對手）`。bot 角色都在 roster、過得了 `roster.includes` 檢查。
對戰流程（自動）：上傳我的卡 → 抓對手卡 → 本機戰力加權算勝負 → 寫 force → statusline 演出。

### 常見狀況
- `no_opponent`：池中沒有同階的別人。**只有自己時必然**，要等第二人 `vpet pvp` 過一次他的卡才存在。
- `403 unauthorized`：密鑰錯/沒設 → 重跑 `vpet pvp-setup`。
- `not_found`（指名）：對方 code 打錯，或對方還沒 `vpet pvp` 過（卡未上傳）。
- 「對手角色本機沒有資產」：雙方角色陣容不一致；用同一套 `install-runtime` 標準角色即可，客製角色（如 g-metalgreymon）別人沒裝會中這個。
- `ERR_SSL...HANDSHAKE_FAILURE`：只有「全新子網域剛部署」那幾分鐘會出現，等憑證簽發即可（本案已過此階段）。

## 核心設計：零核心改動

關鍵洞察：`vpet battle` 本來就支援「指定敵人 + 指定勝負」（寫 `force-char.json` 的 `forceBattleEnemy` + `forceBattleWin`）。所以：

> 幽靈對戰 = 新指令去遠端抓對手卡 + 本機算勝負 → 寫進**跟 `--battle` 完全一樣的 force 欄位** → statusline 照原流程演出。

**statusline / agumon-core 零改動、無 daemon。** 網路只發生在 `vpet pvp` 那一刻（使用者主動觸發），不在每秒 refresh 的 statusline 裡 → statusline 維持純本機。

`--battle`（本機同階隨機）完全保留不動，幽靈對戰走獨立 `--pvp`。

## Client 指令（`statusline-cheat.js`）

| 指令 | 說明 |
|---|---|
| `vpet pvp-setup <url> <key> [name]` | **首次一鍵**：設 server+密鑰+名稱，自動產 6 碼 friend code 並印出 |
| `vpet pvp` | 隨機同階線上對手 |
| `vpet pvp <名牌>` | 指名對手（名牌不分大小寫；`MAJAJA`→固定練習對手） |
| `vpet code [名牌]` | 查看 / 設定名牌（2026-06-02 後 = 顯示名＋指名 ID 合一） |
| `vpet pvp-server <url> [key]` | 只設後端（進階） |

流程：讀本機 state 組我的卡 → `PUT /card/{我code}`（順手上傳）→ 抓對手卡 → 戰力加權結算 → 寫 force。

**結算**：`winProb = myStr/(myStr+oppStr)`，`Str = min(power+train, getTierCap(stage))`，重用 `agumon-core` 的 `getCharacterPower/getCharacterStage/getTierCap/seedRand01`（保證跟本機演出一致）。seed = `me.code:opp.code:Date.now()` 的 hash。

**指名可跨階 + 跨階不計勝率（2026-06-02）**：`vpet pvp <名牌>` 指名本來就沒 stage 限制（隨機 `/random?stage=` 才限同階），可跨階對戰。但 PvP 結果會計入勝率（見下方踩雷），跨階會被高階刷勝率。解法：cheat 端 `crossStage = opp.stage !== me.stage` → 寫 `force.battleNoCount=true`（手動 `vpet battle` 會 delete 此旗標）→ statusline token 接 `st._battleNoCount` → core `startBattle` 落成 `st.battleNoCount`（戰鬥結束清空）→ 計數 gate 改 `if (!st.battleNoCount && ...)`。**同階（含 MAJAJA bot、隨機、同階指名）照計；跨階指名不計**。log 跨階時標 `（跨階，不計勝率）`。

**PvP 計入勝率（現狀，使用者選擇維持）**：戰鬥正常結束的計數（`battleTotalCount`/`battleWinCount`，在 `decideAgumon` 戰鬥結束 else 分支）不分來源——自動/手動/PvP 都算（除上面跨階例外）。勝率是進化 `win_rate` 條件依據。

> 2026-06-01：角色屬性 `rank` 全面改名為 `stage`（Child/Adult/Perfect/Ultimate）。卡欄位、worker query、`getCharacterRank→getCharacterStage` 都已改；保留 `opp.stage ?? opp.rank` / `config.stage ?? config.rank` 舊資料 fallback。

## 設定檔 / 身分

- `state/pvp.json`：`{ endpoint, key, code }`（2026-06-02 後 `name` 廢棄；code＝名牌）。code 首次跑 `--pvp-setup`/`--code`/`--pvp-server` 時自動產生（6 碼隨機，去掉易混 I/O/0/1），可用 `vpet code <名牌>` 改成中文或英數。

## Cloudflare Worker（`agumon-cli/server/pvp/`）

笨儲存，**不做結算**。三支 API：

| Method | Path | 說明 |
|---|---|---|
| PUT | `/card/:code` | upsert 卡，TTL 30 天 |
| GET | `/card/:code` | 指名取卡，無→404 `not_found` |
| DELETE | `/card/:code` | 刪卡（冪等，回 `{ok:true}`）；2026-06-02 加，供改名清舊卡 |
| GET | `/random?stage=&exclude=` | 隨機同階卡，無→404 `no_opponent` |

**改名自動刪舊卡（2026-06-02）**：`vpet code <新名牌>` 在 code 改變且 `p.endpoint` 已設時，async 呼叫 `pvpFetch('DELETE', /card/<舊code>)`（非致命：try/catch、用 `process.exitCode` 避免 Windows fetch socket UV assertion、top-level `return` 不落到切角色邏輯）。舊卡即時清除、不必等 30 天 TTL。worker 已部署 live（Version 3a905637）。卡片上傳時機：只在 `vpet pvp`（隨機/指名真人）那一刻 PUT；`vpet pvp MAJAJA`、`vpet code`、`pvp-setup`、`pvp-server` 都不上傳。

- KV binding = `CARDS`，key 前綴 `c:`。random 用 `list({prefix:'c:'})` + 洗牌 + 取樣最多 20 張找同階。
- 認證：設了 `PVP_KEY` secret 時，請求須帶 `X-Pvp-Key`，否則 403。
- 卡格式：`{ code, name, character, power, train, stage, ts }`。
- 部署：`wrangler login` → `kv namespace create CARDS`（id 貼進 wrangler.toml）→ `secret put PVP_KEY` → `deploy`。

## 踩雷 / 注意

- **Windows `process.exit()` + fetch**：結算後若 `process.exit(0)`，fetch keep-alive socket 還在關閉會觸發 `UV_HANDLE_CLOSING` assertion crash。改用 `process.exitCode = 0` 讓事件迴圈自然排空（undici socket 是 unref 的，會正常退出）。
- **第一個人沒對手**：卡是第一次 `vpet pvp` 才上傳，最早加入者跑隨機會 `no_opponent`；指名也需對方至少 `vpet pvp` 過一次。
- **角色資產要一致**：對手角色本機要有資產才能演出（`roster.includes(opp.character)` 檢查）；客製角色（如 G-Metalgreymon）對方沒裝會「本機沒有資產」。
- **CommonJS top-level `return`**：`--pvp` 用 async IIFE 後 `return` 阻止往下掉到切角色邏輯（Node 模組包在函式內，允許）。
- `.gitignore` 已加 `server/**/.wrangler/` 與 `server/**/.dev.vars`。
- **中文名牌 URL 編碼 bug（2026-06-02 修）**：worker 原本用 `parts[1]`（path segment，未解碼）當 card.code 與 KV key，但 `/random` 的 `exclude` 走 query string 會被 `searchParams` 自動解碼。中文名牌 → PUT 的 path 被 fetch 編碼成 `%E5..`、worker 直接拿來當 key（`c:%E5..`）；exclude 卻是解碼後的 `幹團輸` → 對不上 → **排除不掉自己**（隨機配到自己的鬼影、且顯示成 `%E5..`，不會 fallback 到 MAJAJA）。修法：worker 對 path code 一律 `dec()=decodeURIComponent`（PUT/GET/DELETE 一致），client PUT 路徑與 exclude 都明確 `encodeURIComponent`。修完要**手動刪掉舊的編碼壞卡**（DELETE 時 path 需 double-encode 才能讓新 worker 解一次還原成 `%E5..` 字面）。worker Version 1fe94a3c。

## 未來 v2（先不做）

被指名者也收戰報：加 inbox（`POST /inbox/{targetCode}` 寫含 seed 的戰鬥，對方下次拉下來重演）。需雙方決定性結算（seed 不含時間）。

相關記憶：[[cc-statusline 安裝紀錄]]、[[多視窗 race 與動畫純函數 + per-window cost]]、[[agumon 表演系統 (battle/evo/shared)]]
