# Memory Index

> vpet（agumon-cli）專案記憶。實際生效的是家目錄那份 —— 見 `../../docs/agent-memory/README.md`。

- [agumon installed 為權威版本](feedback_agumon_authoritative.md) — `.claude/agumon-statusline/` 為真理；改完要反向同步到 `agumon-cli/src/runtime/` 否則 install 會吃掉
- [.bat 要 ASCII-only](feedback_bat_ascii_only.md) — Windows .bat 放中文會被 cmd 依 Big5 誤解析→雙擊閃退；註解/echo 全用英文(route-editor.bat已修;editor.bat有同潛在問題)
- [左右不對稱配色角色的 _r 幀](feedback_asymmetric_right_frames.md) — 慣例看 G-Greymon；三步：建換色表(bias分類+同色系明暗排序)→鏡射→套表；反向要取該階最大宗色否則冒棕塊
- [加角色一律先跑 add-character.js --check](feedback_char_source_16x16.md) — 別再自己重寫網格偵測；實體尺寸無關，邏輯網格必須=targetSize(16)
- [install.js 跨機 hook 寫入](feedback_install_hook_crossmachine.md) — updateSettings() 對 hook 要「沒有就新增」+「有就更新」雙路徑，否則新機 hook 不作用
- [多視窗 race 與動畫純函數 + per-window cost](feedback_multi_window_race.md) — 共享 state、讀 per-window input 都要小心：幀類 toggle 用純函數；`_evoCostBase` 用 sticky max bump
- [角色單幀重匯入](feedback_single_frame_reimport.md) — 只改一幀用 reimport-frame.js，別跑 char-cli process(會重轉全部覆蓋手調)；runtime 讀 agumon-statusline/assets/
- [StatusLine 設定踩雷](feedback_statusline.md) — Windows 上 statusline 看不到：-File 路徑不可加單引號
- [agumon 表演系統 (battle/evo/shared)](project_agumon_perf_system.md) — 2026-05-21 進化動畫 v1 上線；DNA 3 幀+光繭；encounter/boom 升 3 幀；editor 加共用模式+框選
- [cc-statusline 安裝紀錄](project_cc_statusline.md) — 架構/檔案/SOP/Bug表；角色清單以 roster.json 為權威(2026-06-01 共51隻，含6條Adventure鏈)
- [幽靈對戰 PvP 設計](project_pvp_ghost_battle.md) — 非同步 ghost battle：ac --pvp/--pvp-setup、CF Worker+KV API、零核心改動（沿用 --battle 的 force 欄位）
- [vpet 加角色流程工具化](project_vpet_add_character_skill.md) — add-character.js(偵測/轉檔/逐點比對/部署)+vpet-add-character skill；⚠️gen-new-char-scaffold.js 已加 --yes 防呆
- [vpet 抽離獨立介面 + daemon](project_vpet_daemon_standalone.md) — 卡死=時鐘問題非資料;PoC已驗(token-source讀JSONL去重/daemon獨立時鐘);C方案(daemon當家+statusLine唯讀fallback);獨立介面=daemon顯示層;分3期動工,開發期不deploy不寫真state
- [角色卡 Win Rate 欄位](todo_card_winrate.md) — ✅ 已完成(2026-05-29) 卡片第 4 行勝率，installed+source 同步、race-safe 計數
- [進化路線/參數編輯器 TODO](todo_evo_route_editor.md) — 新工具規格草案(2026-07-09)：獨立頁面(比照點陣編輯器Node server:3000+html)、增減starter、編輯進化鍊(分歧/條件)、選實裝與否；已盤點現況(config.json evolvesTo typed conditions/roster.json starters/apply-new-routes WAVE白名單/reset煙霧agumon-core.js:235)；✅已實作(2026-07-09,A案)：src/shared/evo-rules.js(公式/tie-break/死路)+src/editor/route_editor_server.js(port3001)+route_editor.html(SVG圖形UI)+route-editor.bat/sh；實裝=roster成員(runtime checkEvolution加getRosterSet gate跳過非roster目標,向後相容已同步.claude)；127角色round-trip零語意差+死路/實裝/冒煙驗過；save即時實裝雙寫免install(下次render生效)；跨平台bat/sh/command(mac已補);節點顯示idle縮圖+starter鏈篩選；✅commit+push ebe0f5c/6832e64/6f88705(origin/main)
- [分歧進化引擎 TODO](todo_evolution_branching.md) — priority(硬排序)+weight(機率分歧)+跨視窗種子；基礎進化(cost+勝率)已上線，分歧待實作
- [新進化路線 TODO](todo_new_evo_routes.md) — 大量分歧+新starter；✅第一波已實裝+push(2026-06-15：Agumon2010/Leomon(loaderleomon取代shishimamon)/Blitz/Cres/Commandramon/Loogamon 6線，roster54→70,starters→13,死路0；commit d957bd2..0e75874)；分波靠apply-new-routes.js新增的--wave白名單；其餘鏈待後續波(卡子彈/config)；📋2026-06-25收後續波完整規格更新(新分歧/Perfect→Ultimate/新starter Syakomon+Fujamon線/高階Angoramon+Jellymon線；變動已確認:拼字正確=AncientBeatmon/Ofanimon首字大寫(推翻舊ancientbeetmon/ophanimon)、Zudomon>Plesiomon第二波已實裝故未列、新角色清單正確但原圖待補/待轉換)；📋2026-07-09收reset新規格(reset登場煙霧已存在,新增一張新圖專給抽中高階starter用/原圖待補;starter權重公式+設定目前無,要從無到有新建)
- [statusline 角色卡死大調查](todo_statusline_freeze_investigation.md) — ✅孤兒洩漏已修(commit 1429368,git改讀.git/HEAD+watchdog改unref)；三層模型(活動順/閒置斷續/週末孤兒爆死)；重開機驗證:斷續主因=長uptime記憶體壓力(render 441ms→43ms)，週期重開即解，AV例外優先度低
- [statusline 沒釘住 / pin 選項](todo_statusline_pin_option.md) — 本機 statusline 隨畫面捲走，另一台正常；理想做成 pin/scroll 可選
- [statusline 角色倒退 bug](todo_statusline_regression.md) — ✅已解(2026-06-01) editor /save 砍 state 是 root cause，修後 corrupt.log 不再增長
- [statusline release 分支](todo_statusline_release_branch.md) — 為一般使用者建輕量 release；✅2026-07-13開工:打包腳本build-release.js產dist/release(省~2.6MB)、RELEASE標記+cheat gate停用作弊碼(保留help/card/pvp/code/sleep/wake/tree/reset/freeze/unfreeze/battle開關;移除切角/evolve/battle強制/pvp-server/pin)、vpet help指令、全新玩家預設agumon；待辦:推release分支(目前只到dist/)、未commit
- [Super-Ultimate 階段](todo_super_ultimate_stage.md) — ✅敵方+我方均已實裝並push(27850cb)；正規線Godzilla_1994→BurningGodzilla(繼承戰力)、彩蛋線Agumon/Gabumon→Kizuna(Child直跳SU,power_at_least 50+win76%,**必須先freeze**)；config.evolvePower=固定戰力不繼承；tree格數=血緣長度;card一律顯Ultimate；⚠️僅剩「encounter前多2幀/強敵提示」規格有歧義未做
- [戰鬥系統分鏡](project_fight_system.md) — 戰鬥分鏡、尺寸常數、子彈軌跡、自動觸發 TODO（原本沒列進索引）
