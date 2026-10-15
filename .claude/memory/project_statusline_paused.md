---
name: project-statusline-paused
description: 2026-10-15 起重心放 daemon 版；statusline 照常、只擋右側 vpet（只擋不刪）；之後找機會移植到 mod
metadata:
  type: project
---

2026-10-15 使用者決定：**未來重心放在 daemon 版（獨立視窗），之後找機會再移植到 mod。** Claude Code 的 statusline **要留著**（狀態文字照常），只把**右側的 vpet 機制**先擋掉，相關程式不刪。

⚠️ 我第一次會錯意，把整個 statusline 版擋掉（install 一律 daemon-only、移除使用者的 statusLine 設定），被糾正後撤回。「擋 statusline 版的 vpet」≠「擋 statusline」。

現行擋法（細節見 repo `CLAUDE.md` 的「狀態列的 vpet 暫停中」）：唯一開關 `agumon-core.js` 的 `STATUSLINE_PET_PAUSED = true` → `statusline-agumon-color.js` 入口只輸出 `buildStatusLines`、不讀不寫桌寵 state；`vpet hide/show` 擋掉；GUIDE 的狀態列附錄用 HTML 註解藏起來。安裝流程不變。`test-release-build` 有對應檢查。

**Why:** 開發資源集中在 daemon；statusline 的時鐘受 Claude Code 控制（見 [[project-vpet-daemon-standalone]]），表現本來就比 daemon 差。桌寵全交給 daemon，兩邊才不會搶推同一份 color-state.json。

**How to apply:** 新功能只做 daemon 那一側，不必再顧狀態列的桌寵畫面；但**不要刪** statusline 的程式，恢復時開關改 false 即可。桌寵狀態要靠當家 daemon 推進（所有啟動器都帶 `--authoritative`）。使用者提到的「mod」意思尚未說明，遇到時再問。
