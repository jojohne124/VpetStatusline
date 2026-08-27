---
name: todo_statusline_freeze_investigation
description: statusline 角色卡死/定格大調查：孤兒洩漏已修(commit 1429368)，閒置定格=harness限制；待重開機測試對照
metadata: 
  node_type: memory
  type: project
  originSessionId: 94890215-cc6f-402b-965f-60c507ea1c5d
  modified: 2026-07-31T01:45:16.968Z
---

agumon statusline（VpetStatusline repo, origin=github.com/jojohne124/VpetStatusline）角色「卡死/定格」全案調查，2026-06-29。相關 [[feedback_agumon_authoritative]] [[project_cc_statusline]] [[todo_statusline_regression]]。

## 三層疊加模型（症狀分層，別混為一談）
1. **活動中**（打字送出/跑工具/等子代理）：Claude Code 每秒呼叫 statusline → 角色流暢動。
2. **健康閒置**：refreshInterval 在輸入提示符前是「一陣一陣」觸發，**夾 8~12 秒空檔**（實測 probe：60 秒內 state 有推進但斷續）→ 角色一陣陣動、空檔定格。空檔是 harness 行為，腳本改不動（GitHub #50679 closed as not-planned；refreshInterval 文件宣稱 idle 會刷新但實測在 input-prompt 不穩）。
3. **放整個週末**：孤兒堆爆資源 → 連 spawn 都失敗 → 完全卡死。← **真 bug，已修**。

## 真 bug 根因（使用者最初「沒修好」是對的）
statusline 是「每幀 spawn 一個 node、印完即死」的一次性腳本。watchdog（commit ca13739）在 stdin 'end' 進來時即 clearTimeout 清除，之後 render 卡在**同步 `spawnSync('git')`**；資源吃緊時連子行程都 spawn 不出而永久阻塞，此時 watchdog 已清、event loop 又被同步呼叫卡死 → 沒東西能終結 → 永久孤兒。實測一個週末堆到 **156 個孤兒、最老 63 小時**。

## 修正（commit 1429368，已 push origin/main，repo+安裝版都同步）
- `src/runtime/agumon-core.js`：新增 `gitBranch()` 直接讀 `.git/HEAD`（往上找、支援 worktree 的 .git 檔），取代 `spawnSync('git')`。消除唯一同步卡死點 + 省每幀 git 成本。
- `src/runtime/statusline-agumon-color.js`：watchdog 改 `setTimeout(()=>process.exit(0),8000).unref()` 且不再 clearTimeout。正常退出不延遲、stdin 卡住 8 秒強制自殺。
- 驗證：孤兒情境 9 秒自殺、分支名正常、全程 0 洩漏。

## 重開機測試結論（✅ 已驗證，記憶體壓力是斷續主因）
| 指標 | 重開機前(uptime 7天) | 重開機後 |
|---|---|---|
| 可用記憶體 | 4.11GB/31.46GB(用87%) | 19.88GB(用37%) |
| 裸 node 冷啟動 | 43ms | 40ms（一樣→非變數） |
| 完整 render | 441ms(負載飆3.5s) | **43ms** |
| 動畫 | 斷斷續續 | **十分順暢** |

- 結論：裸 node 啟動恆 ~40ms；真正拖慢的是**完整 render 在記憶體壓力+負載+舊 git 子行程下變重**。重開機釋放記憶體後 render 掉到 43ms≈裸啟動 → 三 session 各每秒刷也跟得上 → 順。
- 斷續主因＝**長 uptime 記憶體壓力/累積負載**（非 AV、非 node spawn 硬天花板）。週期性重開機即解。
- AV(Defender)例外：優先度**確定很低**（清機 render 才 43ms）。要的話仍可請 IT，但非必要。
- 流程：活動中 refreshInterval 每秒刷；健康閒置仍是斷續(~10s空檔，harness #50679)；但機器健康時順暢度足夠。

## 實機驗證（2026-06-30，修正上線約一天後）
- 重開機後 uptime 22.5h，statusline 行程只剩 0~1 個 transient(age 0s)、**0 個累積孤兒** → 修正(commit 1429368)在實機確認穩定，週末死亡螺旋根治。
- git 已 pull 同步到 `9c8750a`(local↔origin/main = 0 0)；該 commit 純角色資料、未動 runtime，修正完好；安裝版↔repo runtime 仍一致。

## ⚠️ 復發+真正根治（2026-07-06）— 先前的 unref 修法本身就是 bug
- **復發**：uptime 166h 後又堆到 **189 個 statusline-agumon-color 孤兒**（全 CPU=0、單執行緒、WS≈0MB → idle 卡在 stdin，非同步 spin），statusline 卡死。commit 1429368 的 watchdog **沒有真正止血**。
- **重現**：用 `child_process.spawn` 照 Claude Code 方式起 statusline，開 stdin 管線但「永不寫入、永不關閉」（洩漏 handle）→ child 12s+ 不死，unref watchdog 不觸發。矩陣測試（timer 2.5s，隔離重跑）：`ref` 版準時 2.9/2.9/3.4s 自殺；`unref` 版飄到 7.0/5.9/3.3s，重負載下等於永不觸發。
- **真因**：`setTimeout(...).unref()`。**unref 計時器不被算進 libuv 的 poll 逾時（uv_backend_timeout）**；當 loop 阻塞在 poll 等那條永不來資料的 stdin 管線（stdin 這個 ref'd handle 撐著行程不退）、又沒有任何 ref'd timer 時，poll 無限期 sleep，unref watchdog 只在 loop 因別的事件偶然醒來才被檢查 → 記憶體壓力下永不醒 → 永久孤兒。**上次「改成 unref」正是把 watchdog 自己廢掉。**
- **修正**：`statusline-agumon-color.js` watchdog 改回 **ref'd**（`const _watchdog = setTimeout(()=>process.exit(0),8000)`，故意不 unref），並在 `stdin.on('end')` 開頭 `clearTimeout(_watchdog)`。正常路徑收到 end 即清除→零延遲自然退出；洩漏路徑無 end→ref'd timer 參與 poll 逾時→8s 準時自殺。實機驗證：正常 1.5s 退、洩漏 9.1s 自殺（原本 12s+ 永不死）。
- 已清掉 183+1 個既有孤兒（node 188→18）；安裝版(權威)+repo `src/runtime/` 都已同步。
- `agumon-hook.js`（原本完全沒 watchdog）也補了同款 ref'd watchdog + clearTimeout（實測洩漏 9.4s 自殺）。
- **已 commit+push**：commit `93c7736`（base 6cfe142）→ origin/main，含 statusline + hook 兩檔。
- **殘留症狀（非 bug）**：孤兒根治後，畫面仍「每 5~15s 才跳一次、空檔定格」= Claude Code 自身刷新節奏（refreshInterval:1 在 input-prompt 不被遵守，GitHub #50679）+ 166h uptime 記憶體壓力讓每次 render 慢到 2~3s。腳本端無解；重啟 session 或重開機才順。

## 🔴 第二次復發 → 真正根治（2026-07-06 同日稍晚）：跨行程收屍
- **ref'd watchdog 仍沒完全擋住**：修正(93c7736)後仍新增 4 個孤兒（啟動時間全在修正 mtime 之後）。特徵：父行程**全部 DEAD**、`ThreadState=5(Wait)`、`Threads=1`、`WorkingSet=0MB`（被換頁凍結）。
- **關鍵發現：任何 in-process 計時器都救不了這類孤兒**。逐一實測：(a) unref timer❌ (b) ref timer❌（idle-Wait 主執行緒下 poll 不醒）(c) **worker 執行緒硬殺也❌**——worker 只在主執行緒 CPU-busy 時能殺，主執行緒 idle 等 stdin（Wait 狀態）時，worker 的 timer 一樣不 fire（實測 unref/非 unref worker 皆撐到 stdin sleep 結束才退）。原因：主執行緒卡在同步 syscall／被記憶體壓力換頁凍結時 event loop 停轉，孤兒**自己救不了自己**。
- **真正解＝跨行程收屍（commit b4ae737）**：每個新啟動的 statusline 在 `reapStale()` 掃 `state/live-pids.json`，把「登記超過 REAP_AGE(20s) 卻還活著」的舊 PID 直接 `process.kill(pid,'SIGKILL')`（健康 render 1~3s 早退出並在 `process.on('exit')` 自我 `deregister()`，故名單裡逾時還活著的必是卡死孤兒）。killer 是剛被排程正常在跑的新行程→不受凍結影響；閒置時 statusline 仍每 5~15s 被叫用→週末也持續收屍。自我除名避免 PID 回收後誤殺。用 `process.kill(pid,0)` 探活。
- 保留 ref'd watchdog 當即時防線（stdin 不 end→8s 自殺，實測 8.4s✓）。
- 驗證：SIGKILL 在 Windows 有效；登記 30s 前的 sleeper 被新 statusline 收屍✓；正常 render 自我除名✓。已 push origin/main（b4ae737，base 891829d 第四波進化）。安裝版(權威)+repo 同步。
- **教訓**：Windows「殺父不連帶殺子」+ 主執行緒可被同步阻塞/換頁凍結 → 靠孤兒自身的任何機制（timer/worker）都不可靠，唯一穩的是「用外部健康行程跨行程收屍」。

## 🔴 第三次復發 → 收屍名單本身有競態（2026-07-13）
- **症狀**：修正(b4ae737)後仍堆出 **9 個孤兒**（最老 26h，皆 WS=0MB 換頁凍結）。關鍵線索：`live-pids.json` 是 `{}`，而 **9 個孤兒 PID 沒有一個在名單裡** → 收屍機制不是沒跑，是「查無此人」。
- **真因＝共享 map 的 read-modify-write 競態**：舊版所有行程都「整份讀 live-pids.json → 改 → 整份寫回」。兩個時間重疊的行程會互相覆蓋：B 讀到（還沒有 A 的）舊快照 → A 寫入 `{A}` → B 把舊快照寫回 → **A 的登記被抹掉** → B 正常退出自我除名 → map 變 `{}` → A 之後凍結成孤兒，收屍名單查不到 → **永遠殺不掉**。窗口只有幾 ms，但 3 sessions × 每 5~15s render，26h 內中 9 次完全合理（且系統壓力大時窗口拉長，正好與凍結同時發生）。
- **第二個洞**：`try{process.kill(pid,0)}catch(e){alive=false}` 把 **EPERM**（行程存在但無權限）也當成死掉 → 把活孤兒誤刪出名單，同方向失效。
- **修正（結構性根治）**：廢除共享 map，改 **一行程一檔** `state/pids/<pid>.pid`（內容＝登記時間戳）。每個行程**只寫／只刪自己那一個檔**，絕不整份讀改寫 → **競態從結構上消失**，目錄列表即名單。`reapStale()` 改為掃目錄；探活改 `catch(e){ alive = (e.code==='EPERM') }`。`agumon-hook.js` 也補上登記/除名（不主動收屍，由 statusline 統一收），使凍結的 hook 孤兒也能被清。舊 `live-pids.json` 已刪除。
- **驗證**：正常 render 1.1s 退出並自我除名✓；偽造「30s 前登記且還活著」的孤兒被新 render SIGKILL✓；**並行 6 個 render 全 exit 0、無誤殺、全數除名**✓；hook 正常✓。既有 9 隻孤兒已清（node 12→4），事後掃描 孤兒=0。
- ⚠️ 測試踩雷：git-bash `$!` 給的是 **MSYS pid 不是 Windows pid**，`process.kill()` 用 Windows pid → 用 bash 起假孤兒會得到假陰性。要用 PowerShell `Start-Process -PassThru` 取 `.Id`。
- 安裝版(權威)+repo `src/runtime/` 已同步；**已 commit+push：`aaf9899`（base 0cce4e5）→ origin/main**。
- **教訓（超越本案）**：多行程共用一份 JSON 當可變狀態時，「整份讀→改→整份寫回」必有覆蓋競態，
  而且**受害者恆是最慢/最卡的那個行程**——正好與你要偵測的病灶重合，於是監控機制對真正的病例系統性失明。
  正解是讓每個行程只擁有自己的檔（目錄列表即名單），而非替共享檔加鎖。

## 🔴 第四次復發 → unlink 時機才是最終真凶（2026-07-14）
- **症狀**：改一行程一檔(aaf9899)後仍冒 3 個孤兒（29688/63216/66812），且**全部在修正 mtime 之後才啟動**（凌晨 3~7 點），故不是「舊碼遺留」。
- **決定性線索**：這 3 隻 `kill(0)` 探得**存活**、`SIGKILL` 也**殺得掉**（手動測 <1s 死），卻活了 1.4~5.3 小時沒被收 → 表示它們的 pid 檔**根本不在 `pids/` 目錄裡**（掃描時 pids/ 只有當下那隻）。登記與收屍邏輯本身都正常（重現實驗證實凍結 child 會建出 pid 檔、殘留檔會被清），問題在「檔案被提早刪掉」。
- **真因**：收屍分支 `try{kill(pid,'SIGKILL')}catch{}` 之後**無條件** `unlink` pid 檔，不確認行程是否真的終結。本機記憶體吃緊時，對已換頁凍結的行程送 TerminateProcess **可能延遲生效／當下沒死**，舊碼卻立刻刪檔 → 行程還活著卻從名單消失 → 之後所有 render 都看不到 → 永久孤兒。手動測因機器已醒、行程可快速換頁回記憶體而瞬殺，**剛好掩蓋此路徑**。第二個洞：探活 catch `alive=(code==='EPERM')`，把 EPERM 以外的暫時性錯誤都當死亡，會誤刪活孤兒追蹤檔。
- **修正（commit `51300aa`，base 9a28938 → origin/main）**：確立單一不變量——**pid 檔只有拿到明確 `ESRCH`（確認死亡）才移除，否則保留交下一個 render 重試**。探活只認 ESRCH 為死、其餘一律當活著；收屍送 SIGKILL 後**回探一次**，唯有確認 ESRCH 才 unlink，否則留檔下輪再殺。收屍因此自我重試、永不失聯，並在行程真死當下自動清檔收斂。
- **驗證**：殺得掉逾時孤兒→殺掉且清檔✓；未逾時健康兄弟→不誤殺且保留✓；已死殘留檔→清掉✓；連跑 3 輪後 pids/ 收斂 0、無死檔殘留、無活著逾時未收✓；hook＋8 路並行 render 皆正常✓。既有 3 隻孤兒已清。安裝版(權威)+repo `src/runtime/` 同步（hook 本次未改）。
- **教訓（累加）**：跨行程收屍的正確不變量是「**先確認死亡、再解除追蹤**」；反過來（先解除、賭它會死）在記憶體壓力/凍結行程下必失聯——而失聯的恰是最該收的那隻。連同前三次：①別用 unref timer 當 watchdog ②別靠孤兒自身任何機制 ③別用共享 map（讀改寫競態）④解除追蹤前先確認死亡。

## 🛠️ doctor 工具（2026-07-14，commit `1f58748` → origin/main）
- 把「掃 node 堆積 + 清孤兒」做成正式工具，不用再手刻 PowerShell。
- **CLI**：`vpet doctor`，接進 statusline-cheat.js（SUBCMDS 加 'doctor'、放 release gate 之前一律可用）；`--check` 只診斷不清。（指令一律 `vpet`，不用舊前綴 ac）
- **獨立包** `tools/agumon-doctor/`：`doctor.js`（零外部依賴、只 node 內建）＋雙擊啟動器（Win `agumon-doctor.bat`／mac `agumon-doctor.command`）＋中文 README。給「桌寵已卡死、連 ac 都不順」的人解壓雙擊自救。發佈產物 `dist/agumon-doctor.zip`（gitignore 不入版控，要發佈時 `Compress-Archive tools/agumon-doctor/* dist/agumon-doctor.zip` 重打）。
- **判定/收屍**：掃 OS 全部 node，只認命令列含 statusline-agumon-color / agumon-hook 且齡>20s 者（健康 render 1~3s 結束）；確認式收屍（SIGKILL 後回探 ESRCH 才算成功）；只碰 agumon、不動 Cursor/其他；誤殺代價僅中止一幀 render。跨平台：Win 走 PowerShell **逐一** per-PID 查 CommandLine（整表查會逾時，教訓），mac/linux 走 `ps -eo pid=,etimes=,args=`。
- ⚠️ `install.js` 的 `RUNTIME_FILES` 已補 `doctor.js`（漏了重裝會使 vpet doctor 失效）。`.bat` 全 ASCII（Big5 踩雷 [[feedback_bat_ascii_only]]）＋ `chcp 65001` 讓子行程中文正常顯示。
- source of truth = 安裝版(權威) `~/.claude/agumon-statusline/doctor.js`，同步至 repo `src/runtime/doctor.js` ＋ bundle `tools/agumon-doctor/doctor.js`（三份同內容）。
- **已發佈 release**：`build-release.js` 自動收 `src/runtime/*.js`(含 doctor.js)＋新增複製 `tools/agumon-doctor/` 自救包；`publish-release.js` 一鍵 build+更新+push origin/release。2026-07-14 已 publish，release 含孤兒修正+doctor+自救包。（2026-07-15 main 已再前進到雙擊安裝啟動器 install.bat/.command，release 隨之同步）
- 死檔(pids/ 過期登記檔)＝設計上必然副產物、非 bug：SIGKILL/當機跑不到 deregister 必留殘檔，但每次 render/doctor 都會探活清除、有上界會自癒、幾十 bytes 無害。真正的鍋是孤兒(已修)。pid 檔只有 render/hook 會建，`vpet doctor` 只讀+刪不建。

## 🔴 doctor 掃描逾時→誤報「0 孤兒」(2026-07-15，commit `a0b5d6c`)
- **現象**：`vpet doctor` 回報「無法掃描、pids/ 追蹤 0 個」＝形同 0 孤兒的假安心；手動 CIM 一查發現 **122 個 node、其中約 116 個凍結 statusline 孤兒(Threads=1)**。全部**未被 pids/ 追蹤**(fallback 顯示 pids/ 0 個)。
- **這 116 是「修正前的舊 backlog」**：齡 3.5~10 天(≈07-05~07-11，早於 per-pid-file 修正 07-13)，是**未追蹤**的凍結孤兒。per-pid-file 自動收屍只收「pids/ 有登記」的(修正後新生的 render 才會登記)→ 舊 backlog 自動收屍看不到，**只有 doctor 的 OS 掃描能清**——但 doctor 掃描剛好壞了 → backlog 一直累積沒人清。
- **doctor 掃描 bug 根因**：scanWin 對每個 node **逐一** per-PID 查 CommandLine，122 次 CIM 查詢超過 25s 逾時 → 掃描回 null → 落到只看 pids/ 的 fallback → 誤報 0。**推翻先前「per-PID 快又穩、整表查逾時」的判斷**：真正逾時的是逐一 per-PID 在行程多時；加 `-Filter "Name='node.exe'"` 的**單次批量**查詢反而快又穩(122 個 node 秒回)。
- **修正**：scanWin 改單次批量 `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` 一次抓 CommandLine+CreationDate+ThreadCount，PS 端分類只回 agumon；齡由 CreationDate 算；逾時放寬 30s。已清 116 隻(node 122→11)；修正後造假孤兒抓→殺→歸零驗過。三份 doctor.js＋zip 同步。
- **重要認知**：①自動收屍只擋「已追蹤」的孤兒；未追蹤的凍結孤兒(舊版遺留/丟追蹤)只能靠 doctor OS 掃描清 → **doctor 必須可靠**(這次才發現它壞了)。②重開機會一次清空所有孤兒(含未追蹤 backlog)，是最徹底的解。③兩次重開機之間，建議**定期跑 `vpet doctor`** 當防線。
- ⏳**未 push**：commit `a0b5d6c` 只在本機 main；repo src/runtime+bundle+安裝版(權威)都已同步；release 尚未 republish。待使用者確認對外動作。

## 待辦/其他
- **8 隻新角色待實裝**：commit 9c8750a 已加進 repo characters/(Coelamon/Fujamon/Gryphonmon/Huankunmon/Jougamon/Peckmon/Sakuyamon/Xiangpengmon + roster + 進化鏈/cutin 微調)，但 runtime 讀 `.claude/agumon-statusline/assets/`，**使用者決定先優化美術、之後再 install 同步資產上線**(現在 statusline 還看不到新角色)。相關 [[todo_new_evo_routes.md]]。
- AV(Defender)例外：使用者非 admin、TamperProtection 開、有 GPO 政策機碼 → 自己加不了，要走 IT。但清機後 node 啟動已快，**優先度降低**。
- 可選：寫 /feedback 回報 refreshInterval 不在 input-prompt 穩定觸發。
