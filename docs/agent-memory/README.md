# Agent Memory（Claude Code 記憶快照）

這裡是 Claude Code 對本專案累積的設計記憶 / 決策紀錄，**複製進 repo 方便跨電腦開發時參考與版本控管**。

## 來源（single source of truth）

實際的「活記憶」在使用者家目錄、不在本 repo：

```
~/.claude/projects/C--Users-jojoh/memory/
```

Claude 啟動時會自動載入那裡的檔案；本資料夾只是**手動快照備份**，不會自動雙向同步。

## 檔案

- `project_vpet_statusline.md` — 專案總進度 / 系統設計 / cheat 指令 / 多視窗機制 / 設計取捨
- `evo-winrate-default.md` — 新增角色時的**預設進化門檻算法**（win_rate pct 由進化目標 power 決定、minBattles 同 stage 統一）

## 更新方式

memory 內容變動後，重新從上述來源路徑複製過來再 commit 即可。請 Claude「把最新 memory 同步進 docs/agent-memory」也行。

> ⚠ 另一台電腦若要讓這些檔案變回「Claude 自動記憶」，需放到那台對應的 `~/.claude/projects/<key>/memory/`（`<key>` 取決於該機使用者名稱與啟動目錄）。純放在 repo 裡只是文件，不會自動載入成記憶。
