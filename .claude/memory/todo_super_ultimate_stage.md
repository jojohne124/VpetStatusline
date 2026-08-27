---
name: todo-super-ultimate-stage
description: Super-Ultimate 隱藏第5階：敵方+我方均已實裝(含 Kizuna 彩蛋線)，僅剩「encounter 前多2幀/強敵提示」規格歧義未做
metadata:
  node_type: memory
  type: project
  originSessionId: 168a7381-6701-4571-8f6c-bd0e1541e329
  modified: 2026-07-31T09:18:40.734Z
---

# Super-Ultimate 隱藏第 5 階（2026-07-14 收規格；**敵方 + 我方均已實裝並 push**）

Ultimate 之上的隱藏第 5 階，階級字串 = `Super-Ultimate`（含連字號）。`TIER_CAP` 210。

## ✅ 敵方（2026-07-28）
- SU 敵：**BurningGodzilla / Agumon_Kizuna / Gabumon_Kizuna**，`config.power = 200`。
- `chooseBattleEnemy(myId, seed, lastEnemyId, battleStats)` 第 4 參數可選（舊呼叫向後相容→不觸發 SU）。
  gate：我方 Ultimate/SU + `total>=5` + 勝率 `>80%` → `seedRand01(seed+9973)<0.3` 抽 SU 池；我方為 SU 時基礎池退回 Ultimate。
  常數 `SU_STAGE / SU_WIN_RATE_GATE / SU_CHANCE / SU_MIN_BATTLES / SU_SEED_SALT`。
- 驗證：各 gate 正確；擲骰 N=100k 命中 30.12%，與 anti-stick 的 seed+1 統計獨立。
- 效能：`chooseBattleEnemy` 每次呼叫對 roster 每隻做一次 `readFileSync`（~130 次）。每場只呼叫一次故可接受，**不可放進迴圈**。

## ✅ 我方（2026-07-28 正規線 / 2026-07-31 彩蛋線，commit 27850cb）
- **正規線**：Godzilla_1994 → BurningGodzilla（條件 `tag_battles` Destoroyah）。戰力**繼承**（舊角 base+訓練，受舊階 cap 約束）存進 `st.inheritedPower`，`getBasePower()` 在 SU 時優先用它。
- **彩蛋線**：Agumon → Agumon_Kizuna、Gabumon → Gabumon_Kizuna，**Child 直跳 SU**。
  條件＝`power_at_least 50`（本階 cap）+ `win_rate 76% / minBattles 5` + `cost_threshold 0`（後者是 editor 一定會 emit 的 dummy）。
  ⭐ 實務上**必須先 `vpet freeze`** 才養得到 —— 否則一般線的 cost 10 USD 早就達標，會先進化成 greymon/garurumon。這是刻意的隱藏設計。
- card 一律顯示 **Ultimate**（不露出 SU 字樣），power bar 上限用 210。
- tree 格數 = **實際血緣長度**（正規 SU 鏈 5 格、彩蛋線 2 格）；SU 前的箭頭橘紅色 `\x1b[38;2;255;94;43m`，靠「該格是不是 SU」判斷，非寫死索引。

## 兩個關鍵機制（容易忘）
- **`power_at_least`**：判定值 = `min(base + trainingBonus, 本階 cap)`，與狀態卡顯示同一個數字，不 latch。
  `trainingBonus` 本身就被 cap 擋住（`base+train < cap` 才 +1），所以「練滿本階」會**自然停在剛好等於門檻**，不會錯過。
- **`config.evolvePower`**（特規固定戰力）：進化成該角色時 base 直接給定值、**不繼承**。只影響我方，敵方一律讀 `config.power`。
  兩隻 Kizuna = 200（繼承的話只有 50，與 SU 定位不符）。`computeInheritedPower(st, oldId, newId?)` 會先查這個欄位。

## route-editor 支援
- 「戰力 ≥」欄位；死路判定豁免 `powerGate`（比照 tag／日夜，靠別的軸區分不需 win% 遞增）。
- 特規邊（**目標角色有 `evolvePower`** → 自動判定，非寫死名單）：橘紅框 +「特規」徽章，鎖住花費／日夜／tag 三組，只開放 win%／minBattles／戰力 ≥。
- `evolvePower` **刻意不進 `payload()`**：編輯器只讀不寫，不可能被存檔弄丟；要改就手編 config.json。

## ⚠️ 唯一剩下的 TODO
「encounter 前多 2 幀」+「強敵提示」UI —— **規格本身有歧義故未做**：v2 cut-in 本來就已經是「encounter 多 2 拍」（`BATTLE_LENGTH_V2=21` vs v1 `19`），而 SU 敵都有 cut-in → 對上有 cut-in 的我方時已走 v2。所以是要「再 +2（v3=23）」還是「v2 即滿足」需先問。要做 v3 得同步處理 `battleLength()`／`BATTLE_SAFETY`／frame throttle。「強敵提示」UI 形式原規格就標「?」。

相關：[[分歧進化引擎 TODO]]、[[進化路線/參數編輯器 TODO]]、[[新進化路線 TODO]]、[[角色卡 Win Rate 欄位]]
