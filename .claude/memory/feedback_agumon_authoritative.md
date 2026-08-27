---
name: agumon-installed
description: "agumon statusline 開發中 `.claude/agumon-statusline/` 是權威來源，`agumon-cli/src/runtime/` 與 `agumon-cli/shared/` 是落後的 source"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f6743aeb-360a-43a6-ad5b-e5e40fddb27c
---

agumon statusline 的開發流程是 **「installed 即真理」**：

- 權威版本：`C:/Users/kaihsiangchang/.claude/agumon-statusline/`（每次 refresh 跑的版本）
- 落後 source：`C:/Users/kaihsiangchang/agumon-cli/src/runtime/`、`agumon-cli/shared/`
- `scripts/install.js` 會把 `src/runtime/` → installed，所以 source 不同步時跑 install 會把 installed 蓋舊

**Why:** 使用者偏好直接編輯 installed（改完馬上看到效果），事後才反向同步到 source。若不同步就跑 install 會吃掉所有未 backport 的改動（包含 BATTLE_LENGTH、atomicWrite、walkPhaseOffset、encounter2 等等）。

**How to apply:** 
- 改 agumon 行為時：直接編輯 `.claude/agumon-statusline/` 下的檔案，立刻生效
- 改完要記得反向 sync 到 `agumon-cli/src/runtime/`，避免下次跑 install 蓋掉
- 改 shared sprite（encounter/boom 等）：可以選擇 (A) 直接 patch installed 的 `assets/shared/art.json + manifest.json`，或 (B) 改 `agumon-cli/scripts/gen-shared-placeholders.js` 模板後重跑 gen-shared 並複製到 installed
- 若 source 有 uncommitted 改動但 installed 有更新內容，以 installed 為準直接覆蓋

相關紀錄：[[cc-statusline 安裝紀錄]]、[[statusline 角色倒退未解 bug]]
