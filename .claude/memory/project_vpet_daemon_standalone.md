---
name: project-vpet-daemon-standalone
description: vpet 抽離獨立介面 + JSONL token 源 + daemon 獨立時鐘；C 方案(daemon當家/statusLine唯讀fallback)
metadata:
  node_type: memory
  type: project
  originSessionId: 168a7381-6701-4571-8f6c-bd0e1541e329
  modified: 2026-07-28T12:05:02.947Z
---

**目標**：把 vpet 從「只能在 Claude CLI 的 statusLine」抽成獨立介面，並根治多視窗卡死。

**卡死根因**（見 [[todo-statusline-freeze-investigation]] 之外的新結論）：statusLine 指令同時是「時鐘」也是「畫面」，而 Claude Code 決定它何時跳；分頁 idle/背景/多開「+」非 Claude 分頁時就不呼叫指令 → pet 完全停住。**是時鐘問題，不是資料問題。**

**兩個 PoC 已驗證可行（2026-07-28，未 commit，`src/daemon/`）：**
- `token-source.js` — ccusage 法讀 `~/.claude/projects/**/*.jsonl` 自算 token/cost。**關鍵：必須用 `message.id|requestId` 去重**（實測 25k 行→10.6k unique，砍 58%，不去重 token 膨脹 2 倍+）。transcript 無現成 cost → 用 token×各模型單價自算(近似,寫死表)。usage 欄在 assistant 行的 `message.usage`。「活躍 session」用最新 timestamp 推定（daemon 沒有 statusLine 的 per-session 輸入）。純唯讀。
- `daemon.js` — 常駐 1s 自轉時鐘，跑既有 `decideAgumon` 表演管線，吃 token-source，開 localhost:3010 顯示（canvas 解析 ANSI 半格 truecolor）。PoC 用獨立 `daemon-state.json` 隔離，不碰正式 state。實測 tick 自跳、認出本 session cost、渲染正常。

**參考來源**：公司 tokscale-sync（安裝檔在 Downloads，頁面 gopotool.towergame.com:8049/ccusage）本體就是 ccusage。**只借「讀 JSONL」方法，不跑它的每日上傳排程**（會把用量傳公司 server）。

**架構決策 = C 方案（daemon 當家、statusLine 唯讀 fallback）：**
- daemon 活著（寫 heartbeat）→ 它是唯一寫入者(寫真 color-state.json + 讀 force-char 套指令)，statusLine 偵測到 heartbeat 新鮮就退唯讀(只 render 不 save)。
- daemon 沒裝/heartbeat 過期 → statusLine 自動退回現在的自寫模式(等同今天,已驗穩定)。
- A案(daemon強制常駐)缺點=純CLI使用者被迫裝daemon;B案(statusLine維持寫)不解卡死=白做。C把daemon降級成「想解卡死才裝」的加值選項，增量最小(core/表演零改;statusLine開頭加十幾行heartbeat判斷)，最壞退化成今天行為。

**獨立介面 = daemon 的一張臉，不是另做一套引擎。** 分層：daemon(唯一大腦:時鐘+decideAgumon+JSONL+寫state+heartbeat+讀force) ← statusLine/web頁/托盤小窗…都只是看同一份 state 的 viewer，永遠同步。解鎖三事：①背景節流不再是正確性問題(時鐘在daemon,viewer只顯示)→web重新可行；②能互動(點角色→開戰,UI POST daemon 走同一個 force 入口,CLI做不到)；③不用開終端也活(直接讀JSONL)。**顯示層先做 daemon 內建網頁(PoC已有)，托盤/置頂小窗(Tauri/webview)後補,同一頁換殼不改引擎。**

**指令路由要收斂**：現在 `vpet battle/card/reset…` 寫 `force-char.json` 給 statusLine 讀；C 之後改 daemon 讀 force+套用，statusLine 唯讀不處理指令；UI 按鈕也走 force 入口。

**打包決策（2026-07-28）：**
- **daemon 不是另一套要裝的軟體**，共用同一份 core+assets（require 已安裝的 agumon-core、讀同批角色圖）；`vpet install` 只要多複製 daemon.js/token-source.js 進 installed。真正差別=**要常駐**（statusLine 由 Claude Code 幫叫；daemon 得自己啟動+保活:開機自啟/崩潰重啟/托盤）。且 **opt-in**：只有想解卡死的人才跑，純 CLI 使用者不用、行為不變。實作給 `vpet daemon`(start/stop/status) 或雙擊啟動器 + 選配自啟。
- **獨立介面不開新 repo，走 monorepo**（單一真理）：獨立介面只是同一顆 daemon/core 的顯示層，跟 CLI 版共用 core(邏輯)+assets(美術)+state。拆兩 repo = 邏輯/美術兩份真理→分歧地獄(現有 installed↔repo 同步痛 ×2)。「兩版本可選/可並存」靠**架構**達成不是 repo 拆：並存=C方案(daemon當家/statusLine唯讀,同份state同步);可選=安裝時選 CLI/獨立/both。結構 `src/runtime`(CLI前端)/`src/daemon`(引擎)/`src/ui`(獨立顯示)/`characters`(共用)。何時才拆:獨立介面若走 Tauri/Electron 重原生打包→把 core 抽成共用套件給兩邊 import(仍單一真理)，非整包 fork。獨立 app = 同 repo 另一個 build target(像 build-release.js 出 dist)，非新 repo。

**動工分期（2026-07-28 起）：**
- ✅Phase 1（2026-07-28）：statusLine 加 heartbeat-aware 唯讀 fallback。`daemonIsAuthoritative()` 讀 `daemon-heartbeat.json`,4秒內算活;活→readOnly(全用 `if(!readOnly)` 包住 force/evo-commit/triggers/updateEvoHistory/saveState,只 render 不寫)。三態驗過(無hb=自寫5131字元同今天/新鮮hb=唯讀不寫仍render/過期hb=退回自寫)。**僅改 repo,未 deploy installed**。
- ✅Phase 2a（2026-07-28）：daemon 加 `--authoritative`(寫真 color-state.json + 每拍寫 heartbeat,render成功才寫=failsafe);預設隔離只寫 daemon-state.json 無 heartbeat。scratch dir 驗過兩模式。另加 **`AGUMON_STATE_DIR` env 覆蓋** core STATE_DIR(repo+installed同步,未設=零變化)供隔離/測試。
- ⚠️**上線順序硬性**:先 deploy gated statusLine→installed(`vpet install`)再跑 `daemon --authoritative`;反了舊statusLine不認heartbeat會搶寫。目前刻意都沒做,live 維持原狀。
- ✅Phase 2b（2026-07-28）：force/指令路由**抽進 core 單一真理**——新增 `applyForceFlags`/`applyForceTriggers`/`clearForceCharacter`(core,repo+installed同步匯出)，statusLine 原本 ~70 行 inline force 區塊改成呼叫這三支，daemon renderTick 當家模式(`if(AUTHORITATIVE)`)也呼叫同三支。單元+E2E驗過(statusLine無hb套用角色切換=greymon/daemon --authoritative套用+寫heartbeat/隔離daemon忽略force不寫color-state)。daemon 自然進化補 `!_freezeEvolve` 與 statusLine 對齊。
- ✅Phase 3a（2026-07-28）：UI 互動——daemon 加 `POST /cmd`(body {action})→ `writeForce()` merge 寫 force-char.json(跟 vpet CLI 同一通道,COMMANDS 表:battle/card/tree/drop/sleep/wake/freeze/unfreeze/battleOff/On)；網頁加控制鈕 + 點角色=戰鬥。E2E驗:POST battle→force寫入→daemon讀→battleStartStep set/kind=battle;unknown→400。當家時daemon讀、隔離時statusLine讀→UI=圖形版vpet,兩模式皆用。
- ✅一鍵啟動器（2026-07-28）：`vpet-standalone.bat`(ASCII-only)/`.sh`(LF+755) 在 repo 根；跑 `daemon --authoritative`+開 localhost:3010，會先 warn 若 installed statusLine 還不是 daemon-aware 版(避免 race)。
- ✅`vpet hide`/`show`（2026-07-28）：新非作弊指令(release 也可用)。寫 `force.petHidden`→applyForceFlags 設 `st._petHidden`→statusLine 只輸出 3 行狀態列不畫 pet(狀態照常前進,進化/戰鬥計數不受影響)；daemon/獨立介面**不理**此旗標,pet 照常顯示。給「只用狀態列」或「只在獨立介面看 pet」的人。cheat.js SUBCMDS+help+handler 已加,IS_RELEASE gate 不擋。
- ⏸**daemon 介面還會有一波調整，使用者構思中（2026-07-28）**：先不要自行改版/美化 UI，等他給規格。待併入那波的小事：🪂 空降鈕是否也列入 `DEV_ONLY`（與戰鬥同屬強制播表演，但 CLI 無對應 release 指令）。
- Phase 3b(暫緩,使用者2026-07-28決定先不做)：托盤/置頂原生殼。要做時選框架(建議 Tauri:輕量Rust小binary vs Electron重;或零依賴走釘瀏覽器/PWA)。目前顯示層=daemon內建網頁(localhost),掛瀏覽器即可用。
- ⚠️ 開發期間**不 deploy 到 installed、不跑 authoritative daemon、不寫真 state**，避免干擾使用者 live 環境；使用者要親自 deploy+啟動才生效。

相關：[[feedback-agumon-authoritative]]（installed 為權威,改完反向同步 repo）、[[feedback-multi-window-race]]、[[todo-statusline-freeze-investigation]]、[[feedback-confirm-before-push]]
