---
name: statusline-release
description: 為一般使用者(非開發者)建 release 分支，盡量輕量，移除作弊碼/原圖/editor 等開發用資產
metadata: 
  node_type: memory
  type: project
  originSessionId: d0a17ab2-a64b-40aa-a6ad-075688345472
---

## 狀態（2026-07-13 開工，決策定案 + 打包腳本完成，尚未發布 release 分支）

✅ 決策定案：
- **產出方式＝打包腳本從 main 產**（非手動維護兩份）。
- **PvP server 排除**。
- **作弊碼**：release 用「部署目錄放 `RELEASE` 標記檔 + statusline-cheat.js gate」方式停用（單一原始碼、不手術切塊）。
  - 保留：`help/card/pvp/pvp-setup/code/sleep/wake/tree/reset/freeze/unfreeze` + `battle on/off`（自動戰鬥開關）。
  - 移除(gate 擋)：直接切換任意角色、`evolve <角色>`、`battle <敵人>/win/lose`、`pvp-server`、`pin/unpin`。

✅ 已實作（未 commit，全驗證過）：
- `scripts/build-release.js`：產到 `dist/release`（127 角色、520 檔、略過 1592 張原圖省 ~2.6MB）。移除 src/editor(含進化路線編輯器)/src/tools/legacy/server/docs/dev scripts/PNG/pixels.json/bullet.json/.bak/evo-layout/shared sprites.json；保留 runtime js + 每角色 art/config/bullet-art/cutin-art + roster + shared manifest/art + install/uninstall + bin + package.json + RELEASE 標記 + README。shell 薄殼強制 LF。
- `statusline-cheat.js`：新增 `vpet help`（也吃 --help/-h，exit 0；無參數維持 exit 1）；新增 RELEASE gate（`fs.existsSync(INSTALL_ROOT/RELEASE)` 時擋開發指令）。已驗 gate 擋/放行正確。
- `install.js`：repo 根有 `RELEASE` 就部署到 `~/.claude/agumon-statusline/RELEASE`（main 無此檔＝no-op、開發指令全開）。
- `.gitignore` 加 `dist/`。
- 全新玩家畫面：無 state → `statusline-agumon-color.js:164` 預設 `characterId='agumon'`（給一隻亞古獸），之後可 `vpet reset` 加權重抽 starter。

✅ 已發布（2026-07-13）：
- main 工具 commit `e323a6b`（help + build-release.js + gate + install marker + .gitignore dist/）。
- **`release` orphan 分支已推遠端**（`538ab81`，522 檔）：用 `git worktree add --orphan -b release` 建、灌 dist/release 內容、commit、`push -u origin release`，再移除 worktree。使用者說「有問題再刪」。
- **一鍵發布 `scripts/publish-release.js`**（2026-07-13，main commit `6dc3209`）：build → worktree 檢出 release → 以 dist 覆蓋 → 有變更才 commit+push origin release → 清 worktree。無實質變更自動跳過（不產生空 commit）；容忍網路/殘留 worktree。npm 捷徑 `npm run publish-release`。以後 main 有更新只要跑這一支。兩條路徑（no-change / change）皆實測過。
- （手動舊法備查：`git worktree add <dir> release` → `git rm -rf .` → 覆蓋 dist → add/commit/push → 移除 worktree；worktree 資料夾偶爾檔案鎖刪不掉，用 PowerShell `Remove-Item -Recurse -Force` 清。）
- **新手指南 `GUIDE.md`**（2026-07-13，main commit `0cce4e5`）：安裝/指令/PvP 設置（繁中）。build-release.js 把它當 **release 的 README.md**（clone release 即見安裝指引）；主 README 頂端加指路。release 分支已更新（`69ff3b2`）。指令表只列 release 保留的（不含被 gate 擋的）。

✅ 冒煙測試通過（2026-07-13，隔離環境）：`git clone -b release` 本地 → 臨時 HOME/USERPROFILE + 隔離 `npm_config_prefix`（不碰使用者真 ~/.claude 與全域 vpet）→ `node scripts/install.js` 8 步全過 → statusline 實際渲染出 agumon（characterId 落地=agumon、左側顯示「vpet (release)」）、`vpet help/card/reset` 放行、`evolve`/直接切角被 gate 擋。使用者真機確認無 RELEASE 標記＝dev 模式不受影響。**可以交付測試者了。**

📌 待辦（非阻塞）：是否 trim package.json 的 devDeps/scripts；未來把「產 dist + 推 release」串成一鍵。

## 舊狀態（2026-05-29）

📋 使用者提出方向，細節待整理。

## 目標

main 之外多一個 `release` 分支，給**一般使用者**（非開發者）用的版本，盡可能輕量。只保留執行 vpet statusline 所需，移除開發用的東西。

## 使用者明確點名要移除

- **不必要的作弊碼**（待整理 — 哪些算「不必要」尚未界定）
- **角色原圖**（source PNG）
- **editor**（sprite editor）
- 其他想到再補

## 初步盤點（待確認，依目前 repo 結構推斷）

### runtime 真正需要（保留）
- `~/.claude/agumon-statusline/` runtime js：`agumon-core.js`、`statusline-agumon-color.js`、`statusline-cheat.js`(=ac)、`agumon-hook.js`
- 部署後的**角色資產 json**：每角色 `art.json` / `config.json` / `bullet-art.json` / `cutin-art.json`、`roster.json`、`shared/`
- `scripts/install.js`、`uninstall.js`（裝/移除 runtime）

### 可移除（開發用）
- `characters/*/` 的**原圖**：`sprite.png`、個別幀 PNG（`00_Idle_1.png`…含 `_r`）、`CutIn.png`、`pixels.json` → runtime 只吃 build 出來的 json，install.js 只 copy `art/config/bullet-art/cutin-art`。**但這些 json 要保留**（不然 install 沒東西可裝）。
- `src/editor/`（sprite editor）
- `src/tools/char-cli.js`（build 工具）
- `legacy/`（歷史/ packaged）
- `scripts/` 內開發工具（gen-shared / gen-bullets / battle-preview / cutin-preview 等），但 install/uninstall 要留

### 待確認
- **作弊碼取捨**：`statusline-cheat.js` 內哪些留哪些砍？
  - 偏「使用者功能」可能留：`--card`、`--pvp`/`--pvp-setup`/`--code`、`--sleep`/`--wake`
  - 偏「開發/測試」可能砍：任意 `--evolve <char>`、`--battle --win/--lose`、直接切到任意角色(繞過進化鏈)、`--reset`
  - → 需使用者拍板「不必要」的定義
- **PvP server**（`server/pvp/`）：worker 原始碼只有 host 要 deploy，一般使用者不需要 → release 可不含 server/（client `--pvp` 指令在 statusline-cheat.js 內本來就有）。待確認是否完全排除。
- **分支策略**：release 是 main 的精簡子集 → 用 orphan/獨立分支手動挑檔，還是寫個打包腳本從 main 產生 release？（後者較好維護，避免每次手動同步）

## ⭐ vpet 指令分發（2026-06-01 新增，重要）

**問題**：`vpet`（前身 `ac`）指令是 `~/bin/vpet` + `vpet.bat` 這兩個薄殼（內容 = `node "<deployed>/statusline-cheat.js" "$@"`），但 `~/bin/` 是**使用者個人目錄、不在 repo 內**。所以別人 clone 後沒有 `vpet` 捷徑，只能打完整 `node .../statusline-cheat.js pvp`。且 wrapper 必須指向**部署後**的 `~/.claude/agumon-statusline/`（assets/state 在那），不能指 repo 的 src/runtime。

**✅ 已實作（2026-06-01，方案 A）**：
- repo 加 `bin/vpet`(+`.bat`) 可攜薄殼：`node "$HOME/.claude/agumon-statusline/statusline-cheat.js" "$@"`（`.bat` 用 `%USERPROFILE%` + 正斜線避開反斜線轉義）。指向**部署後**的腳本（因 `__dirname` 找 assets/state）。
- `scripts/install.js` 加步驟 `[8/8]`：把薄殼 copy 到 `~/bin`、`chmod +x` bash 版、偵測 `~/bin` 是否在 PATH，不在就印加入 PATH 指示。
- `.gitattributes`：`bin/vpet text eol=lf`（否則 CRLF 讓 shebang 在 unix 壞掉）。
- commit `29c24b6` + `4f5d5f4`。本機已 install 套用（`~/bin/vpet` 換成可攜版、`vpet` 可用）。
- ~~方案 B（npm global bin）不採用：global bin 會指到 repo 而非 ~/.claude → 壞掉。~~ **此判斷錯誤，2026-06-04 已改用 npm bin（見下）。**

## ✅ vpet 分發改用 npm bin（2026-06-04，commit 97d6bd4，取代上面方案 A）

`~/bin` 在新電腦 PATH 幾乎不存在（尤其 Windows）、install 又只警告不修 → 別人裝完 `vpet` command not found。改用 npm bin 解決：
- 新增 `bin/vpet.js`：跨平台 node 薄殼，**spawn** `node ~/.claude/agumon-statusline/statusline-cheat.js`（必須 spawn 不能 require，這樣 child 的 `__dirname` 才落在部署位置找得到 assets/state——原先「方案 B 會壞」的顧慮其實只要 spawn 就解了）。
- `package.json` 加 `"bin": {"vpet": "bin/vpet.js"}`。
- `install.js [8/8]` 改 `npm link`（npm 把 shim 放進它在 PATH 上的 global bin，Windows 自動產 `vpet.cmd`/`vpet.ps1`，零 PATH 改動），失敗才退回 `~/bin` 複製（`installLauncherFallback`）。
- `uninstall.js` 對稱加 `npm unlink -g agumon-cli` + 清 `~/bin` 殘留。
- 舊 `bin/vpet`(+`.bat`) 保留當 fallback 薄殼。
- 本機已 `npm link` 驗證：`vpet.cmd freeze/unfreeze`、`node bin/vpet.js card` 均正常。

**已完成（2026-06-01）**：作弊碼指令前綴 `ac` → `vpet`，且指令可省略 `--`（`vpet pvp` == `vpet --pvp`，舊寫法仍相容）。實作在 `statusline-cheat.js` 開頭的 SUBCMDS 正規化（裸關鍵字補回 `--`）。`~/bin/ac`/`ac.bat` 已刪、改為 `~/bin/vpet`/`vpet.bat`。**此改動尚未 commit（待使用者指示）。**

## Why

一般使用者不需要開發資產（原圖/editor/build 工具/作弊碼），輕量化降低下載體積與誤用風險。

## How to apply

動工前先請使用者界定「不必要作弊碼」清單與 PvP server 是否納入；分支策略建議走「打包腳本從 main 產 release」而非手動維護兩份。

相關記憶：[[cc-statusline 安裝紀錄]]、[[幽靈對戰 PvP 設計]]、[[MiniGames 資源自包化 SOP]]（self-contained 打包思路可參考）
