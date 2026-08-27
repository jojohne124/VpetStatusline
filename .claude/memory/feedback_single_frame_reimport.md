---
name: single-frame-reimport
description: agumon 角色單幀重匯入工具與方法 — char-cli process 會重轉全部 12 幀(覆蓋手調)，單幀改用 reimport-frame.js
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 83c17d1c-335e-4d03-b251-40bb020e6643
---

要「只重匯入某一幀」(例：Tenkomon 的 08_Angry) 時，**不要跑 `char-cli.js process`** — 它的 prepare 會讀全部 individual PNG 重建整個 pixels.json + art.json，**覆蓋掉你在 sprite editor 手調過的其他幀**。

改用 `agumon-cli/reimport-frame.js`（2026-06-11 建）：
```
node reimport-frame.js <name> <frameIndex>   # 例 node reimport-frame.js tenkomon 8
```
它只重轉指定幀、寫回 pixels.json 的該 index、重建 art.json 的該 halfblock 幀，並回報差異像素數。

**為何單幀可獨立重轉**：individual layout 走 `extractFrameDirect`（char-cli.js:345，中心點直接取樣、保留原色、**不套用全域調色盤**），所以每幀與其他幀完全無關 — 換 strip/grid layout 就不成立（那些會套全域 palette）。來源 PNG 邏輯網格仍須 = targetSize 的整數倍才不失真（見 [[char-cli-png-16-16]]）。

**重轉後必須同步到 runtime 讀取處**：
- runtime 真正讀的是 `ASSETS_DIR = INSTALL_ROOT/assets` = `~/.claude/agumon-statusline/assets/<name>/art.json`（agumon-core.js:8）。
- ⚠️ [[cc-statusline 安裝紀錄]] 舊表寫的 `agumon-assets/<name>/` 路徑已過時、該目錄空的；以 `agumon-statusline/assets/` 為準。
- 只需複製 `art.json`（pixels.json 是中間產物，installed 不放）。

**Why:** 全量 process 會無差別覆蓋所有幀，使用者只想動一幀時會丟失其他手調成果。
**How to apply:** 改完源 PNG → `node reimport-frame.js <name> <idx>` → `cp characters/<name>/art.json ~/.claude/agumon-statusline/assets/<name>/art.json`。相關：[[agumon-installed]]
