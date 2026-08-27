---
name: statusline-pin-option
description: 本機 statusline 沒釘住（隨畫面捲走），終端切換沒解；理想要做成可選 pin/scroll 選項
metadata: 
  node_type: memory
  type: project
  originSessionId: e6ca1247-4dcb-463e-bfc4-e7522f6980f9
---

## 現況（2026-05-26）

本機 Claude Code 的 statusline + 輸入框**都會跟畫面滾動**，agumon 7 行輸出被當成普通對話內容 scroll 掉。另一台機器同樣 agumon 配置在底部釘住正常。

### 已嘗試 / 排除
- `~/.claude/settings.json` 的 `statusLine` 已是正確物件形式（`type:command + command + refreshInterval:1`）
- `~/.claude/agumon-statusline/` 只有一份，無多版本衝突
- 裝了 Windows Terminal，但開 Claude Code 時還是用舊 conhost（`WT_SESSION` 環境變數空，確認非 WT）
- 即使從 Windows Terminal 開新分頁跑 `claude` 也仍不釘（使用者回報；待親自驗證）

### 推測根因
連輸入框都跟著滾 → Claude Code 本身沒進 TUI 全屏模式 → 是 Claude Code 端的渲染決策（TTY 偵測 / version / 啟動方式），不是 agumon 本身的問題

## 使用者期望

把「釘住 / 不釘住」做成**可選選項**，而非強制其一：
- 釘住模式：現行設計（statusLine type=command，Claude Code 渲染層處理）
- 不釘住模式：agumon 作為普通對話內容 scroll 過去也接受，至少要能用

### 可能實作方向（未驗證）
1. **檢測 + degrade**：statusline-agumon-color.js 偵測終端能力（TTY / WT_SESSION / TERM 等），不支援釘住時自動切短輸出（單行）或啟用 fallback
2. **環境變數開關**：`AGUMON_MODE=pin|scroll`，scroll 模式輸出單行純文字
3. **使用者設定檔開關**：在 `agumon-statusline/state/` 加 user-prefs.json，提供 `displayMode`
4. **直接做兩個 statusline 腳本**：`statusline-agumon-color.js`（多行 pin）+ `statusline-agumon-mini.js`（單行 scroll-friendly），用 settings.json command path 切換

## 待做

- [ ] 確認另一台「會釘」機器的：Claude Code 版本、啟動方式、終端程式（缺資料，使用者「不確定」）
- [ ] 親自驗證在 Windows Terminal 內跑 `claude` 後 `WT_SESSION` 有值 + statusline 是否釘住
- [ ] 設計並實作 pin/scroll 兩種模式切換機制
- [ ] 文件補上：哪些終端組合會釘 / 不釘

**Why:** 使用者明確指出兩台環境同設定但表現不同，且偏好給予選擇權而非強制單一行為  
**How to apply:** 開始實作前先驗證另一台環境，再決定走 detection 自動 fallback 還是顯式開關

相關記憶：[[cc-statusline 安裝紀錄]]、[[多視窗 race 與動畫純函數 + per-window cost]]
