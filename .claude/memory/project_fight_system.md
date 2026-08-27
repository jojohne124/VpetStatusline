---
name: 戰鬥(Fight)表演系統規格
description: agumon statusline 戰鬥分鏡、尺寸常數、子彈軌跡，以及自動觸發 TODO
type: project
originSessionId: 5e78a231-fdcc-4abe-979b-75b24667a180
---
## 狀態（2026-05-20 更新）

- **作弊碼觸發**：✓ `ac --battle [enemy]`，atomicWrite 修過 partial-read race
- **自動觸發**：⚠ 已實作但實測不會觸發（見下方 TODO）

## 分鏡（共 18 step，1 step = 1 秒）

| elapsed | phase | 內容 |
|---|---|---|
| 0-1 | encounter | shared `encounter` sprite 居中 |
| 2,4,5 | approach | ANGRY |
| 3,6 | approach | IDLE_1 ← elapsed 6 是「ANGRY→IDLE_1→ATTACK」過渡幀 |
| 7-10 | attack | ATTACK，子彈 progress 0/0.33/0.66/1 |
| 11 | boom | Boom1 (shared sprite 居中) |
| 12 | boom | Boom2 (新增的「外擴」幀) |
| 13 | boom | Boom1 |
| 14,16 | result | IDLE_1 (面左) at center |
| 15,17 | result | HAPPY/SAD (面左) at center |

戰鬥結束後角色不從原位走，**從 col 16 朝左開始走**（`walkPhaseOffset` 機制接續 RESULT 位置）。

## 場景尺寸（`agumon-core.js`）

| 常數 | 值 | 說明 |
|---|---|---|
| `BATTLE_LENGTH` | 18 | 整段戰鬥 step 數 |
| `BATTLE_SCENE_WIDTH` | 48 | 場景寬度 chars |
| `BATTLE_ME_LEFT_COL` | 0 | 我方位置 |
| `BATTLE_ENEMY_RIGHT_COL` | 32 | 敵方位置 |
| `BATTLE_CENTER_COL` | 16 | 共用 sprite + RESULT 位置 |
| 完整寬度需求 | ~122 chars | status + ANCHOR_GAP(4) + 48 |

## 子彈軌跡（`composeBattleScene` in agumon-core.js）

- 我方子彈 col：`8 → 16`（painted 11-20 → 19-28，從身體中央吐出 → 中央碰撞）
- 敵方子彈 col：`24 → 16`（painted 27-36 → 19-28，對稱）
- 起點完全分離，終點完全重疊；painted bbox 在 16-cell canvas 內 cols 3-12（net 10）
- progress 4 拍：elapsed 7,8,9,10 → progress 0, 0.33, 0.66, 1

## Boom2 製作（暫時版）

- art.json frames[2] 新增 16×16 像素的「外擴 + 中央空 + 角落火花」造型
- 配色同 Boom1：黃 (255,220,80) / 橙 (255,140,40)
- manifest.json: `boom.indices = [1, 2, 1]`，frames=3
- 備份在 `art.json.bak` / `manifest.json.bak`
- 形狀想調直接改腳本裡的 `PIXELS` 字串陣列重跑

## composeBattleScene 改動

`frame.sharedFrameIdx` 透過 `getSharedFrame(shared, name, frameIdx)` 傳遞，不再固定 0。

## TODO：自動觸發條件

`agumon-core.js:206-214` 用 `/thinking/i.test(i.model.param_summary)` 偵測 thinking 模式，但實測 `param_summary` 在普通對話下不含 `thinking`。可能方向：
1. dump `i.model` 看真實 param_summary 內容
2. 改回原規格：Stop hook 比對 UserPromptSubmit 時間差 > 3 秒
3. 放寬條件

**Why:** 規格跨多 session 討論 + 實作後條件還沒驗到位
**How to apply:** 重啟此 TODO 時先 dump param_summary 再決定條件
