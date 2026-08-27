---
name: agumon-battle-evolution-shared-sprites-editor
description: 進化表演 v1 已上線、battle 動畫升級到 encounter+boom 各 3 幀、sprite editor 加入共用模式與框選拖移
metadata: 
  node_type: memory
  type: project
  originSessionId: f6743aeb-360a-43a6-ad5b-e5e40fddb27c
---

## 狀態（2026-05-21）

agumon statusline 加入「演出表演系統」雛形，含戰鬥（已有 v1）、**進化（今日新加 v1）**、shared sprite assets，以及 sprite editor 強化。

## 進化表演 v1（2026-05-21 完成）

**12 step 分鏡**（1 step = 1 sec）：

| step | 角色 | DNA overlay |
|---|---|---|
| 0 | 舊 IDLE_1 | dna1 |
| 1 | 舊 HAPPY | dna2 |
| 2 | 舊 HAPPY | dna3 |
| 3 | 舊 HAPPY | dna1 |
| 4 | 舊 HAPPY | dna2 |
| 5 | 舊 HAPPY | dna3 |
| 6-7 | 隱形 | dna_end（光繭包覆） |
| 8 | 新 IDLE_1 | — |
| 9 | 新 HAPPY | — |
| 10 | 新 IDLE_1 | — |
| 11 | 新 HAPPY | — |

**觸發路徑：**
- 自然觸發：`checkEvolution` 命中（cost_threshold 等）
- 強制觸發：`node statusline-cheat.js --evolve <next>` 或 alias `ac --evolve <next>`

**核心檔案：**
- `agumon-core.js`：`EVO_LENGTH=12`、`decideEvoFrame()`、`composeEvoScene()`，decideAgumon 內加 evo 最高優先檢查
- `statusline-agumon-color.js`：force.evolveTriggerTs 偵測（5 分鐘 age window）、進化生命週期（commit / cheat-trigger / 自然 trigger 三段）、evo 渲染分支
- `statusline-cheat.js`：`--evolve <next>` 子命令；寫入時清掉 force.character 避免回退
- state 新增鍵：`evoStartStep`、`evoNextCharId`、`lastEvolveTriggerTs`

## 寬度檢查（已接受不觸發）

`statusline-agumon-color.js` 對 battle 有寬度 fallback（`render_width_chars >= maxStatus + ANCHOR_GAP + 52` 才演），但 Claude CLI 子程序拿到的 `render_width_chars` 通常 undefined → `?? 999` → **檢查永遠通過、表演永遠演**。使用者已接受為當前模式（2026-05-22），不需修。終端太窄時會自動換行，畫面有點亂但仍能看出表演。Code 保留為 defensive。Evo 沒做寬度檢查（同樣不演的話也只多一個小角色，沒救援價值）。

## 戰鬥動畫升級（2026-05-21）

- BATTLE_LENGTH 13 → 18 → **19**（encounter 3 拍 + boom 3 拍）
- encounter sprite：1 幀 → **3 幀**（encounter1→encounter2→encounter1）
- boom sprite：1 幀 → **3 幀**（boom1→boom2→boom1）
- 子彈渲染：改為**畫在角色下方**（角色身體遮住子彈左半，像從體內冒出）
- `agumon-core.js` 加 export `BATTLE_LENGTH` + `decideBattleFrame`，`battle-preview.js` 改用 core 邏輯

## Shared sprites 現狀

`shared/manifest.json`：

| sprite | indices | 用途 |
|---|---|---|
| encounter | [0, 1, 0] | 戰鬥開場 |
| boom | [2, 3, 2] | 戰鬥子彈爆炸 |
| dna | [4, 5, 6] | 進化 build-up 循環（dna1→dna2→dna3）|
| dna_end | [7] | 進化峰值光繭 |

art.frames[0..7]：encounter1, encounter2, boom1, boom2, dna1, dna2, dna3, dna_end

**注意：** `gen-shared-placeholders.js` 的 ASCII 模板**已過期**（使用者用 editor 編輯後脫鉤），重跑 gen 會覆蓋編輯內容。

## Sprite editor 強化（2026-05-21）

`sprite_editor.html` + `sprite_editor_server.js`：

- **三模式**：🦖 角色 / 💥 子彈 / **🌐 共用**（新增）
- **框選+拖移工具**（B = 畫筆、V = 選取）：框內拖 = 移動像素，Esc 取消
- **單幀 sprite 命名簡化**：indices 長度 1 → 不加數字後綴（顯示 "dna_end" 而非 "dna_end1"）
- **不再砍 state.json**：之前 /save 砍 state 造成角色倒退 fallback 到 agumon + trigger 重觸發

## 已修 bug（2026-05-21）

| Bug | Root cause | Fix |
|-----|------------|-----|
| 進化 cheat 無效（trigger 被吃掉） | age window 10s 太短，statusline 偶發 idle → 第一次 refresh 已超時 | 拉長到 300s |
| evoStartStep 設了又馬上被清成 -1 | `statusline-color.js` 用 STEP_MS=500，core 用 STEP_MS=1000 → 算出的 step 不一致，core 的「殘留清理」條件誤觸發 | 統一改 1000 |
| 切回 agumon 後無限進化迴圈 | evo commit 後 `force.character` 還在 → 下次 refresh 把角色拉回，cost 又漲 $10 → 再觸發 | commit 時清掉 `force.character` 與 `force.resetCostBase` |
| editor 儲存後 agumon 突然進化 | /save 砍 state → 失去 lastEvolveTriggerTs → 殘留 force.evolveTriggerTs 變新 trigger | /save 不再砍 state |
| editor 共用模式幀名稱錯誤 | /meta 沒接收 mode 參數 | HTML load() 傳 mode 給 /meta |
| Token reset HAPPY 無限重複（每 4 秒一次） | `r5hResetAt !== stored` + `Math.max` 保留舊 stored：input 偶發回傳比 stored 小的值會無限觸發 | 改成 `r5hResetAt > stored`（2026-05-22） |
| 切角色後仍會演進化 | `ac <name>` 切角色沒清 force 內 pending 的 evolveTriggerTs/evolveTarget → 同 refresh 觸發 character 切換 + 殘留 evolve trigger | `ac <name>` cheat 寫入時順手 `delete force.evolveTriggerTs/evolveTarget`（與 `--evolve` 清 force.character 對稱，2026-05-22）|

**Why:** 進化是 P1 重要功能，多視窗 race + 多個 trigger source 設計繁瑣，今日踩了多個邊角 case
**How to apply:** 改 trigger 路徑或新增 force token 時要注意 age window、STEP_MS 一致性、commit 後 force file 清理

## 相關記憶
- [[cc-statusline 安裝紀錄]]：整體架構、安裝 SOP
- [[agumon installed 為權威版本]]：runtime 檔同步流程
- [[statusline 角色倒退未解 bug]]：今日 editor /save 改動可能緩解（待觀察）
