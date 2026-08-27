---
name: StatusLine 設定踩雷
description: Windows 上 statusline.ps1 看不到的根本原因與修正方式（三個坑）
type: feedback
---

statusline 看不到時，依序檢查以下三個常見原因：

## 1. settings.json 路徑加了單引號

**Why:** bash 在 Windows 上傳遞 `-File 'path'` 給 PowerShell 時，單引號導致 `-File` 收到帶引號的路徑，PowerShell 靜默失敗、無輸出。

**How to apply:** `settings.json` 的 command 應為：
```json
"command": "powershell.exe -NoProfile -NonInteractive -File C:/Users/kaihsiangchang/.claude/statusline.ps1"
```
路徑**不加引號**。

## 2. PowerShell 執行政策封鎖 .ps1

**Why:** Windows 預設禁止執行 .ps1 腳本。

**How to apply:** 執行一次：
```
powershell.exe -Command "Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser"
```

## 3. 檔案有 Zone.Identifier（網路下載標記）

**Why:** 從網路下載的檔案會被標記，即使 ExecutionPolicy 設為 RemoteSigned 也無法執行未簽名的腳本。

**How to apply:** 先確認：`Get-Item 'statusline.ps1' -Stream Zone.Identifier`，若存在則：
```
powershell.exe -Command "Unblock-File 'C:/Users/kaihsiangchang/.claude/statusline.ps1'"
```

## 5. PowerShell 5.x 不支援 `` `e `` ESC 語法

**Why:** `` `e `` 是 PowerShell 6+ 才引入的 ESC 字元語法。使用者環境是 PS 5.1，會輸出字面的 `e` 導致整行 ANSI escape 序列全部亂碼。

**How to apply:** statusline.ps1 中改用 `$esc = [char]27`，所有顏色變數改為 `"${esc}[..."` 形式。

## 4. 檔案 encoding 問題（Unicode 字元亂碼）

**Why:** PowerShell 5.x 預設不是 UTF-8，若檔案存為 UTF-8 without BOM，`●` `○` 等字元會解析失敗，腳本報 ParserError。

**How to apply:** 重存為 UTF-8 with BOM：
```powershell
[System.IO.File]::WriteAllText('path/statusline.ps1',
  [System.IO.File]::ReadAllText('path/statusline.ps1', [System.Text.Encoding]::UTF8),
  (New-Object System.Text.UTF8Encoding $true))
```
