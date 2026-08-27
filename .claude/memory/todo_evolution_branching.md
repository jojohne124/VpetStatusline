---
name: todo
description: agumon statusline 進化分歧路線設計（priority 硬排序 + weight 機率分歧 + 跨視窗種子）
metadata: 
  node_type: memory
  type: project
  originSessionId: d0a17ab2-a64b-40aa-a6ad-075688345472
---

## 狀態（2026-06-01）

📋 **設計已定、待實作。** 等真的要設計分歧角色時連同目標角色一起做。基礎進化（cost + win_rate 條件）已上線（見 [[cc-statusline 安裝紀錄]]）。

## 已定的設計

`evolvesTo` 每個分支加兩個可選欄位：
- `priority`（預設 0，越高越稀有）
- `weight`（預設 1，同 priority 內的機率權重）

**選擇演算法**（取代現在 `checkEvolution` 的「回傳第一個達標」）：
1. 篩出「conditions 全滿足」的分支
2. 取其中**最高 priority 的那層**（稀有壓普通）
3. 該層多條 → 用 `weight` **加權隨機**（例 60/40）

→ 同時支援「稀有壓普通」(priority) 與「純機率分歧」(同 priority + weight)。

## ⚠ 關鍵實作踩雷：機率分歧的種子必須跨視窗一致

statusline 每秒在每個視窗各跑一次，且**各視窗讀到的 cost 可能不同**（見 [[多視窗 race 與動畫純函數 + per-window cost]]）。weight 擲骰若用 `Math.random()` 或 per-window cost 當種子 → 各視窗 roll 出不同分支 → 角色閃爍/不一致。
- **解法**：種子取自**共享、已落地的穩定值**，例如 `hash(_evoCostBase + characterId)`，用 `seedRand01`（跟戰鬥 `chooseBattleEnemy` 同套路）。所有視窗算出同一分支；`evoStartStep` 一設定就鎖住不重判。
- priority 純排序是決定性的，沒這問題；只有 weight 需要種子處理。

## 注意
- 向後相容：單分支角色行為不變。但新語意是「最高 priority + 同層加權隨機」→ 想要固定順序**必須設 priority**，否則同層變隨機。
- weight 機率分歧建議用在**風味分歧（強度相當）**；強弱有別用 priority+條件去賺，手感較好。
- **高勝率稀有分歧的天花板限制**：目前練滿勝率上限 ~80%（WIN_SENSITIVITY=25）。所以 Perfect/Ultimate 想做「比主線(65%)更高勝率」的稀有分歧空間有限（>78% 極硬、>82% 不可能）。稀有分歧建議改用**其他軸**（cost 爆量、`r5h_peak`、特定條件）而非更高勝率；或調降 WIN_SENSITIVITY 拉高天花板。

相關：[[cc-statusline 安裝紀錄]]、[[多視窗 race 與動畫純函數 + per-window cost]]