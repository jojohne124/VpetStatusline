---
name: feedback-char-source-16x16
description: vpet 加角色一律先跑 add-character.js --check，不要自己重寫網格偵測
metadata:
  type: feedback
---

agumon-cli 加新角色時，**先跑 `node scripts/add-character.js <Name> --check`**，
不要臨時寫一段區塊掃描去猜邏輯網格。那段已經固化在腳本裡，而且有測試
（`scripts/test-add-character.js`）。也有 skill：`vpet-add-character`。

核心規則仍然成立：**來源 PNG 的實體尺寸無關，邏輯網格必須 = `targetSize`（16）。**
48×48（一格 3×3）與 256×256（一格 16×16）都合法；網格不對的話中心點取樣會取到
格子邊緣，轉出來跟原圖不一樣而且很難看出原因。腳本轉完會逐點比對，不符必須是 0 點。

**Why:** 這個判斷以前每次加角色都在現場重推，等於每次都有一次寫錯的機會；
而錯的症狀（縮圖看起來差不多但顏色/位置微偏）幾乎看不出來。

**How to apply:** `--check` → 看報告（含重複幀＝那個動作不會動）→ 決定 power／要不要
`--implant` → 正式跑。power、實裝與否、進化鏈接誰**要問使用者**，腳本刻意不猜。
⚠️ 別碰 `scripts/gen-new-char-scaffold.js`（一次性腳本，會洗掉 63 個 config 的 evolvesTo，
已加 `--yes` 防呆）。相關：[[project-vpet-add-character-skill]]
