---
name: install-hook-crossmachine
description: agumon-cli install.js 在新機器若 settings.json 無既有 agumon-hook 條目，updateSettings() 必須能自動「新增」而不只是「更新」
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ce5ae1c3-e9cb-40a3-bddc-2bf5dc704cee
---

agumon-cli `scripts/install.js` 的 `updateSettings()` 寫 settings.json 時，**hook 與 statusLine 行為要對稱**：

- `statusLine.command`：直接覆蓋寫入（不依賴既有條目）→ 新機器 OK
- `hooks.UserPromptSubmit`：必須先檢查是否已有 agumon-hook 條目，「找不到就新增 block」；只做「找到就更新路徑」會在新機器整段被 skip

**Why:** 2026-05-25 在另一台電腦裝這個 repo，發現 statusline 出現但 hook 不作用。根因就是上述 asymmetry——原邏輯 `if (Array.isArray(ups)) { for ... if (regex.test) ... h.command = newHook }` 只能更新既有條目。新機器 `settings.json` 完全沒有 `UserPromptSubmit` → 整段跳過，hook 永遠不會被加進去。修法：在迴圈外用 `agumonHookFound` 旗標，迴圈後若 false 則 `ups.push({ hooks: [{ type: 'command', command: newHook }] })`。Commit `6f48144`。

**How to apply:**
- 改 `install.js` 寫入任何 hook 區塊時，記得「沒有就新增」與「有就更新」兩條路徑都要覆蓋
- 同樣模式適用於未來新增其他 hook event（Stop / PreToolUse 等）
- 驗證 SOP：用 node 模擬四個情境（無 hooks / 共存 / 舊路徑 / 已最新）跑過再 ship

相關記憶：[[cc-statusline 安裝紀錄]]、[[agumon installed 為權威版本]]
