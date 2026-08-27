---
name: multi-window-race
description: agumon statusline 多視窗共用 state — 沒 lock，動畫類「per-step toggle」必須用純函數避免跳幀
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ce5ae1c3-e9cb-40a3-bddc-2bf5dc704cee
---

agumon statusline 的 state 檔（`color-state.json`）是**所有視窗共用**，`loadState/saveState` 只有 `atomicWrite`（tmp+rename），**沒有 read-modify-write lock**。多視窗 race 機制：

1. `Math.floor(now / 1000)` → 每視窗算出的 `step` 相同
2. `walkPhaseOffset` 共用一個值 → `computeWalk(step, offset)` 算出的「位置」必相同（沒問題）
3. 但任何「state-based toggle」(`st.lastWalkFrame = (st.lastWalkFrame === IDLE_1) ? IDLE_2 : IDLE_1`) 會被先 refresh 的視窗「吃掉」→ 後 refresh 的視窗在那個 step 沒看到 toggle → 視覺跳幀／卡同幀

**Why:** 2026-05-25 使用者開兩視窗發現走路跳幀。修法是把走路幀從 state-based toggle 改成 `((step + walkPhaseOffset) % 2 === 0) ? IDLE_1 : IDLE_2` 純函數（commit pending）。原本選 state-based 是擔心 `step%2` 在動畫結束後因 hold 奇數翻轉奇偶 → 同幀重複，但 `evenHold()` 已修了這個（2026-05-08）。

**How to apply:**
- 加新動畫幀切換邏輯時，**幀類用純函數**（`step` + offset 算），state 只留「動畫進行中」的標記（`xxxStartStep`）
- 任何 random roll 留在 `if (st.lastStepSeen !== step)` block 裡限制每 step 一次（多視窗第二個 refresh 不會重 roll）
- expr / battle 觸發本身有微小 race（A 視窗 roll 中、B 沒中），但 `startStep` 一寫回後 B 下次 refresh 會接著演，可接受
- 若未來真的需要徹底解 read-modify-write race，再考慮 file lock（windows 上需要套件 / dummy-file pattern，較複雜）

**2026-05-25 補充 — `i.cost.total_cost_usd` 是 per-conversation，多視窗 cost 各自不同：**
這跟 `step`/`evenHold` 的「同 step 視覺一致」race 不同。每個視窗自己一個 Claude conversation，`i.cost.total_cost_usd` 各算各的。若用「視窗本地 cost」寫進共享 state（如 `_evoCostBase = current_cost`），後寫的視窗會用自己較低的 cost 覆蓋前者較高的 → 別的視窗下次 refresh 算 `delta = its_high_cost - shared_low_base` 直接超門檻 → ac 切角色立即誤觸發進化。修法：`ac` 後啟 5 秒 sticky window，期間任何視窗看到 `cost > base` 就 bump base 上去（max），等同期所有視窗報過一輪後再正常 delta tracking。同樣 pattern 也適用其他「shared state 但讀的是 per-window input field」的情境。

相關記憶：[[cc-statusline 安裝紀錄]]、[[agumon installed 為權威版本]]、[[agumon 表演系統 (battle/evo/shared)]]
