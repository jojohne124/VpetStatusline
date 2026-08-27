---
name: todo-evo-route-editor
description: agumon statusline 新工具「進化路線/參數編輯器」的規格草案（獨立於點陣編輯器）
metadata: 
  node_type: memory
  type: project
  originSessionId: 168a7381-6701-4571-8f6c-bd0e1541e329
---

## 目標

角色/分歧線變多後管理不易，要做一個**進化路線 / 參數編輯器**，把目前散在 `apply-new-routes.js`（POWER/NEW_EDGES/WAVE 白名單）+ 各 `characters/*/config.json` + `roster.json` 的手動接線工作，改成有 UI 的可視化編輯。

## 使用者規格（2026-07-09 初版，之後會再補）

1. **獨立頁面**：比照現有「點陣編輯器」做一個獨立頁面，但兩者功能不同、要分開（不共用同一頁）。
2. **新增/減少 starter**。
3. **編輯進化鍊**：包含分歧、條件（如 time_of_day 日/夜、win% 門檻、power…）。
4. **可選擇實裝與否**（對應現行 `--wave` 白名單 gate 的概念）。
5. 其餘規格使用者之後想到再補。

## 已盤點的現況（2026-07-09）

- **點陣編輯器架構**：`src/editor/sprite_editor_server.js` 起 Node http server（port 3000），瀏覽器開 `src/editor/sprite_editor.html`；`./editor.sh <角色>`（含 editor.bat/.command）啟動、自動關舊 port、開瀏覽器。server 直接讀寫 `characters/<char>/` 與 install dir（`~/.claude/agumon-statusline/assets`、`state`）。**新工具比照這套：獨立 server + 獨立 html + 獨立啟動腳本**。
- **進化資料模型**：每角色 `characters/<name>/config.json` 有 `evolvesTo: [{ character, conditions: [ {type:'cost_threshold',usd}, {type:'win_rate',pct,minBattles}, … ] }]`。條件是 **typed 陣列**，日夜/其他條件就是新增一種 type（如 `time_of_day`）。power/stage 也在 config。
- **starter 定義**：`characters/roster.json` = `{ roster:[…], starters:[…] }`；reset 從 `starters` 隨機抽（`statusline-cheat.js:426`，`--reset`）。
- **實裝與否現況**：靠 `scripts/apply-new-routes.js` 的 `WAVE_NEW/WAVE_BASE/WAVE_STARTERS` 白名單 gate；`--write` 才寫 source config+roster；死路檢查+power tie-break+win% 公式都在此腳本。
- **reset 登場煙霧現況**：`src/runtime/agumon-core.js:235`「Reset 掉落表演（新 starter 空降，腳下左右噴煙塵）」、600 行觸發；抽中高階 starter 換新煙霧圖就掛這（見 [[todo-new-evo-routes]] reset 新規格）。

## ✅ 已實作（2026-07-09，走 A 案 + roster 當 gate；已通過 round-trip / 死路 / 實裝 / runtime 冒煙驗證）

採 A 案：編輯器直接讀寫 `config.json`+`roster.json` 為唯一真相；未動 `apply-new-routes.js`（保留為批次工具，不重構）。產出：
- **`src/shared/evo-rules.js`**：抽出 win% 建議公式(`suggestPct`)、tie-break(`resolvePcts`)、死路檢查(`findDeadPaths`)、stage/cost/minBattles 預設。純函數。（`apply-new-routes.js` 暫未改用它，之後可再收斂。）
- **`src/editor/route_editor_server.js`**：Node http server **port 3001**（與點陣編輯器 3000 分開）。`GET /graph` 從所有 config+roster 建圖；`POST /validate` 回死路+建議 pct；`POST /save` 寫回 source 並部署到 `~/.claude/agumon-statusline/assets`（config→`assets/<lc>/config.json`、roster→`assets/roster.json`），存 `.bak`。
- **`src/editor/route_editor.html`**：圖形化節點連線 UI（SVG）。拖拉排版/pan/zoom、依 stage 分欄自動排版、連線模式加邊、右側面板改 stage/power/starter/實裝+每條邊的 win%/cost/minBattles/日夜、即時死路紅框提示、Ctrl+S 存檔。節點座標存 `characters/evo-layout.json`（僅編輯器用、不部署）。**節點左側顯示該角色 idle_1 像素縮圖**（2026-07-09 優化）：server `/graph` 附 `node.sprite`（讀 art.json 的 IDLE_1 幀，color-halfblock）、client 用 canvas 轉 dataURL 快取後畫成 SVG `<image>`；未實裝節點圖半透明。已用 Playwright(msedge channel) 截圖驗證 127 圖全渲染。
- **starter 鏈篩選**（2026-07-09 優化）：toolbar「🧬 顯示 starter 鏈」下拉，勾選 starter → 用邊正向 BFS 只顯示可達子圖（含跨線交叉），並自動縮放視野到該鏈；空選=顯示全部；與「顯示未實裝」疊加。純前端(`shownStarters`/`refreshReach`/`reachCache`)。截圖驗證勾 Agumon → 只剩 8 節點鏈。
- **starter 權重 + 高階旗標**（2026-07-09）：starter 節點面板多「reset 抽選權重」輸入與「高階(reset 用 dust_hi)」勾選。server `/graph` 附 `weight`(roster.starterWeights[id]??1)/`highTier`(在 highTierStarters)、`/save` 寫 `roster.starterWeights`(非1才存)+`highTierStarters`。搭配 reset 加權抽選與 dust_hi 煙霧（見 [[todo-new-evo-routes]] reset 機制）。runtime 同步 3 檔到 .claude、dust_hi 部署 assets/shared。
- **啟動腳本**：`route-editor.bat`(Windows) / `route-editor.sh`(終端機) / `route-editor.command`(macOS Finder 雙擊)。三者開 3001、自動關舊 port+開瀏覽器。⚠️ .sh/.command 需可執行位元(git 100755)、blob 必須 LF(`.gitattributes` 已加 `*.sh`/`*.command eol=lf`，否則 Mac shebang 變 `...bash\r` 會壞)；.bat 必須 ASCII-only 見 [[.bat 要 ASCII-only]]。(macOS 支援 commit `6f88705`)
- **存檔沿用原檔 EOL**（2026-07-09，commit `cf8dcb7`）：save 原以 LF 寫檔，但 Windows 工作區是 CRLF → 每次存檔 git 把全部 config 標 modified（幻影，`git diff` 內容為空、`git add` 後歸零）。改 `writeText/eolOf` helper 沿用目標檔換行（CRLF 檔寫 CRLF、Mac LF 寫 LF）。驗證：no-op 存檔 characters/ 變動 129→0。**結論：按 save 不會讓全角色產生真實差異，只有真的改過的檔才會 diff。**
- **save 即時實裝、免 install**：`/save` 雙寫 → repo source(`characters/`) + runtime 實讀位置(`~/.claude/agumon-statusline/assets/<id>/config.json`、`assets/roster.json`)。runtime 每次 render 重讀 assets(無跨 render 快取)，故存檔後**下一次 statusline 重繪(送訊息/新 prompt)即生效，不用跑 install.js**。install.js 只在「全新角色第一次部署(建 assets 資料夾+art.json)」或「美術/sprite/子彈變動」時才需要(本編輯器不碰圖)。注意 save 部署 config 到 assets 是「該角色 assets 資料夾存在才寫」，從沒 install 過的全新角色需先 install 建資料夾。
- **「實裝與否」= roster 成員**：編輯器把完整設計(含未實裝邊)都寫進 config.evolvesTo，未實裝=不在 roster。
- **runtime gate**（`agumon-core.js` `checkEvolution` + 新 `getRosterSet()`）：跳過目標不在 roster 的邊，未實裝角色不會被進化進去。**向後相容**（現有資料指向未實裝目標的邊=0，等於 no-op）。已同步到 `.claude/agumon-statusline/agumon-core.js`（見 [[agumon installed 為權威版本]]）。

**驗證過**：127 角色 round-trip 存檔後語意零差異（含 boss Majaja/Soulseer 無 stage、Shadow 顯式 UnStage 都原樣保留）；死路偵測正確；實裝 gryphonmon+加 garudamon→gryphonmon 邊 → roster 112→113、config 正確、assets 同步；checkEvolution 冒煙無例外。

✅ **已 commit+push**（2026-07-09，`ebe0f5c` → jojohne124/VpetStatusline origin/main，6 檔 785+）。排除 bin/vpet.js（CRLF 噪音）。啟動：`./route-editor.sh` 或 `route-editor.bat` → http://localhost:3001。

## 原始建議（2026-07-09，已按此實作）

- ✅ **UI 形式：圖形化節點連線**（graph，拖拉節點、連線代表進化邊）——使用者選定。
- 💡 **架構建議（我提、待使用者最終拍板）——A 案：編輯器直接讀寫 config**：
  1. 編輯器直接讀寫 `characters/*/config.json` + `roster.json`，成為唯一真相（config.evolvesTo+roster 本就是 runtime 來源，避免多一層翻譯/多份真相）。
  2. 把 `apply-new-routes.js` 的**死路檢查 + power tie-break + win% 公式抽成共用模組**（如 `src/shared/evo-rules.js`），編輯器與腳本共用、邏輯不分叉；存檔前即時驗證、相鄰 power 打平的死分支當場提示。
  3. `apply-new-routes.js` 降級為一次性遷移/批次工具保留。
  4. **「實裝與否」改資料驅動**：config 加欄位（如 `"implanted": false`），runtime 只納入 implanted 角色進 roster/battle；取代現行藏在腳本的 `WAVE_*` 硬編碼白名單。
  5. **雙寫**：存檔同時寫 `agumon-cli`(source) 與 `.claude/agumon-statusline`(權威)，或存後呼叫 install（見 [[agumon installed 為權威版本]]）。

## 仍待確認

- A 案是否採用（含 `implanted` 欄位這種資料驅動 gate 的設計）。
- 存檔後要不要自動 install。
- 其餘功能規格使用者之後補。

## 相關

- [[cc-statusline 安裝紀錄]]、[[todo-new-evo-routes]]（要管理的路線資料）、[[todo-evolution-branching]]（weight/priority）、[[agumon 表演系統 (battle/evo/shared)]]（既有 editor 共用模式+框選）、[[agumon installed 為權威版本]]（雙寫）
