---
name: card-winrate
description: 角色狀態卡 Win Rate 欄位 — 已完成（2026-05-29），勝場/總戰鬥場數，multi-window race-safe
metadata: 
  node_type: memory
  type: project
  originSessionId: e6ca1247-4dcb-463e-bfc4-e7522f6980f9
---

## 狀態：已完成（2026-05-29）

狀態卡片第 4 行 `Win Rate: XX%` 已上線。installed + source 兩邊都改完、語法檢查通過。

```
Name: XXX
power: XXX
Rank: XXX
Win Rate: XX%
```

## 實作（已落地）

1. **計數**（`agumon-core.js` decideAgumon 戰鬥「正常結束」block，約 line 458）：
   - `st.battleTotalCount` +1、勝場才 `st.battleWinCount` +1
   - multi-window dedup：`st.lastBattleCountedStartStep !== st.battleStartStep` 才計（以 battleStartStep 當該場唯一 id，同 lastBattleTriggerTs 思路）
   - 殘留清理 block（safety reset）不計，cheat forceBattle 走正常結束會被計入
2. **渲染**（`agumon-core.js` composeStatusCard）：`winRate = total>0 ? round(wins/total*100) : 0`，0 場顯示 `0%`（不 NaN）；textRaw 由 4→5 行，仍在 H=8 內
3. **歸零**（`statusline-agumon-color.js`）：切角色（line ~55）與進化 commit（line ~142）都 `delete battleTotalCount/battleWinCount/lastBattleCountedStartStep`，與 trainingBonus 一致

## 已驗證

- composeStatusCard 單測：3/7 → 43%、0 場 → 0%
- 全 statusline 餵真實 input pipe → exit 0
- source 兩檔 `node --check` 通過

## 殘留 race（可接受）

兩視窗同一秒都讀到 stale `battleStartStep=N` 才會雙計，與系統其他 battle-trigger micro-race 同等級，罕見可接受。若日後想徹底解需 file lock。

相關記憶：[[多視窗 race 與動畫純函數 + per-window cost]]、[[agumon installed 為權威版本]]
