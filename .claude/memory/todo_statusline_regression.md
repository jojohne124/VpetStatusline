---
name: statusline-bug
description: agumon statusline 偶發 wargreymon → agumon → greymon 倒退；已部署診斷 log 但 root cause 未確認
metadata: 
  node_type: memory
  type: project
  originSessionId: 08ba2a06-1939-4933-ab5a-7410b3702f75
---

## 狀態（2026-06-01 更新）

✅ **已解，可關閉。** corrupt.log 最後一筆停在 2026-05-21T11:29（= 當天修掉 editor `/save` 砍 state 的時間），之後 10+ 天（至 6/01）檔案大小都維持 15465B 沒再增長 → editor /save 不再 unlink state 的修法確認生效，root cause 收斂。下方為原始調查紀錄，保留備查。

---

## 原始狀態（2026-05-20）

⚠ **未解 bug，已部署診斷 log 等待重現**

## 症狀

使用者在 wargreymon 狀態下，statusline 約 0.5 秒內快閃顯示：
1. wargreymon (正常)
2. agumon (默認值)
3. greymon (進化後)

無使用作弊碼，無重啟視窗。發生 ≥ 2 次（同一個 session）。

## 已知 cascade 路徑

`statusline-agumon-color.js` 流程：
1. `loadState` 讀到空/缺 characterId 的 state
2. line ~60 `if (!st.characterId) st.characterId = 'agumon'`
3. `checkEvolution(agumon)` 看 cost (~$363+) >> _evoCostBase(0) + $10 → 進化到 greymon
4. saveState 寫回完整 state（characterId='greymon', _evoCostBase=current cost）

確認 cascade：當前 state `_evoCostBase: 388.44`（current cost）+ characterId='greymon'，跟剛 cascade 完的狀態完全吻合。

## 已嘗試的修法

| 修法 | 位置 | 效果 |
|---|---|---|
| atomicWrite (tmp + rename) | `agumon-core.js` `atomicWrite()` | 修了 partial read 問題，但仍會發生倒退 |
| state 寫入防護 `if (!s.characterId) return` | `saveState` | 不夠 — cascade 最終 save 時 characterId 已是 'greymon'，guard 放行 |
| 0-byte tmp 清理 | 手動 rm state/*.tmp | 一次性 |

## 部署的診斷 log（2026-05-20）

`statusline-agumon-color.js` line 60 附近，每次 `!st.characterId` 觸發時 append 一行到：

```
C:/Users/kaihsiangchang/.claude/agumon-statusline/state/color-state.json.corrupt.log
```

紀錄欄位：timestamp, pid, st keys, disk state 真實 size, raw 前 200 字, force-char.json 存在與否。

## 下次發生時的查證 SOP

1. 立刻 `cat state/color-state.json.corrupt.log`
2. 看 raw_size：是 0 / `{}` (2) / 部分內容
3. 看 st_keys：是 `(none)` 還是有其他 keys 但缺 characterId
4. 看時間點是否與多視窗同時 refresh 重疊
5. 看 pid 是否同時多個（多 instance race）

## 假設

1. **多視窗 load-modify-save race**：兩個 instance 都 loadState v0，A 寫 v1，B 寫 v2 蓋掉 — 但 B 寫的應該是完整 state，理論上不會缺 characterId
2. **某個 process 的 state 物件被異常修改**：例如 try/catch 吃掉中間錯誤，state 物件只有部分 key 就 saveState
3. **atomicWrite race 寫到空檔**：理論上不該，但 0-byte tmp 殘骸是某種異常證據

## 2026-05-21 補充：editor /save 砍 state 是真實 root cause 之一

sprite editor 的 `/save` 端點原本會 `fs.unlinkSync(stateFile)`，造成下次 refresh：
1. `loadState` 拿到空物件
2. `!st.characterId` → fallback 到 `'agumon'`
3. corrupt.log 寫入一行

這完美解釋為什麼會看到「角色倒退 → 默認 agumon → 進化到 greymon」。今日已修：`/save` 不再砍 state。若 corrupt.log 自此不再增長，本 todo 可關閉。

**Why:** 對使用者影響不大（cheat 還原即可），但根本問題不查清楚會持續發生；診斷 log 是最低成本的偵錯方式
**How to apply:** 下次出事先看 corrupt.log，再決定治本方案（CAS / file lock / 不要 default 到 agumon 等）

## 相關修正紀錄（同 session）

- 進化鏈修復：`greymon.evolvesTo = [{metalgreymon, cost_threshold $10}]`（agumon-cli + agumon-statusline 兩邊都改）
- 確認鏈：agumon→greymon→metalgreymon→wargreymon（終點）/ gabumon→garurumon→weregarurumon→metalgarurumon（終點）
- g-wargreymon / godzilla_1999 / soulseer_mizutsune / majaja：獨立角色不在鏈上，只能 cheat
