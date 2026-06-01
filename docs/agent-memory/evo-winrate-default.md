---
name: evo-winrate-default
description: VpetStatusline 預設進化門檻算法 — 新增角色時 win_rate pct 由進化目標 power 決定，minBattles 同 stage 統一
metadata: 
  node_type: memory
  type: project
  originSessionId: d712fea2-64a6-46e2-b97e-674b940bb3e5
---

VpetStatusline 角色 `config.json` 的 `evolvesTo[].conditions[]` 裡 `win_rate` 條件，**未來新增角色一律照此算法設預設值**（user 2026-06-01 拍板）。

**規則**
1. **pct 由「進化目標（evolvesTo 的目標角色）的 power」決定**：目標越強 → 門檻越高。一律取 **5 的倍數**。
2. **minBattles 同 source 角色 stage 統一**：Child=5 / Adult=8 / Perfect=12。
3. **`cost_threshold` 不受此規則影響**（維持各自既有 10/15/20）。
4. 大致關係：同一進化階層內 **每 +5 目標 power ≈ +5% pct**；頂端略壓縮。新角色用其進化目標 power 對照下表內插、取最接近 5 倍數。

**現行對照表（target power → pct）**
- 進化到 **Adult**（source 是 Child，min 5）：55→45, 60→50, 65→55, 70→60, 80→65
- 進化到 **Perfect**（source 是 Adult，min 8）：110→55, 115→60, 120→65, 130→70
- 進化到 **Ultimate**（source 是 Perfect，min 12）：160→60, 165→65, 170→70, 175→75, 180→80, 190→85

**實作備註**
- 純資料變更，無 code 改動；機制在 `agumon-core.js` 的 `evalCondition`（`win_rate` 分支讀 `cond.pct ?? 100` / `cond.minBattles ?? 0`）。
- 改完跑 `node scripts/install.js` 部署。
- 批次套用可仿照當時的外科式替換腳本（只改 win_rate 內 pct/minBattles 兩數字，保持 diff 乾淨）。

**分歧進化**：一個角色多條 `evolvesTo` 同時達標時，以進化目標 power 強者優先（見 [[project-vpet-statusline]] 的「分歧進化」段；首例 DemiDevimon→Bakemon 鬼族線）。

關聯：勝率公式本身見 [[project-vpet-statusline]] 的「勝率（差距制線性）」。