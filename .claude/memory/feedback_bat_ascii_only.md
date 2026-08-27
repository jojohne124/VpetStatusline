---
name: feedback-bat-ascii-only
description: Windows .bat/.cmd 檔要 ASCII-only，中文會被 cmd 依 OEM codepage(Big5) 誤解析導致雙擊閃退
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 168a7381-6701-4571-8f6c-bd0e1541e329
---

Windows `.bat` / `.cmd` 檔內**不要放中文（或任何非 ASCII）**，包含 REM 註解與 echo 訊息都要用英文。

**Why:** Write 工具存檔是 UTF-8，但 `cmd.exe` 讀 .bat 是用系統 OEM codepage（這台 zh-TW 機器是 Big5/950）。UTF-8 的中文位元組被誤解碼後會**打亂 cmd 的逐行解析**，連 `node ...` 那行都被切碎當成無效命令 → 雙擊「一閃而過」、`node` 根本沒被正確執行。症狀：錯誤訊息像 `'ditor_server.js' 不是內部或外部命令`、`'Node.js' 不是...`（一堆亂碼被當指令）。

**How to apply:**
- 寫 .bat 一律 ASCII；提示訊息用英文（或最多在檔頭 `chcp 65001 >nul` 但仍別依賴中文能正確解析）。
- .sh（git-bash 讀，UTF-8）不受此限，可放中文。
- 診斷閃退：`.bat` 結尾加 `pause`，或用 `Start-Process cmd '/c' '"完整路徑.bat"' -RedirectStandardError err.txt` 抓 stderr。
- ⚠️ 既有 `agumon-cli/editor.bat`（點陣編輯器啟動器）也是 UTF-8 含中文，有同樣潛在問題；使用者可能都走 `editor.sh`。route-editor.bat 已改 ASCII-only（2026-07-09）。

相關：[[todo-evo-route-editor]]、[[StatusLine 設定踩雷]]
