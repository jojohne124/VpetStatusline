# 合體進化（Jogress）規格書 — 第一期

> 狀態：**第 1、2 期已實作**（引擎＋CLI＋可達性＋daemon 按鈕；測試在 `scripts/test-jogress.js`、
> `scripts/test-daemon-page.js`）。第 3 期（專屬動畫）未動工。
> 對應討論：2026-09-07；實作時對規格的修正見文末〈實作時的修正〉。
> 關聯：[營地規格書](ranch-spec.md) —— 配對的另一方來自營地，提交也沿用 `applyRanchOp`。
> 命名：識別碼一律 `jogress`（ジョグレス）。顯示文字用「合體進化」。

## 一句話

**前線的 vpet ＋ 營地的特定一隻 → 前線那隻進化成第三隻，營地那隻永久消失。**

第一組：`Angewomon`（前線）＋ `LadyDevimon`（營地）＝ `Mastemon`，兩個方向同結果。

## 決策（2026-09-07 定案）

| # | 項目 | 定案 |
|---|---|---|
| 1 | 門檻 | **只要配對成立**。湊齊兩隻特定 Perfect 本身就是嚴格條件，不再加 cost / 勝率 / 場次 |
| 2 | 進化後數值 | **跟正常進化完全一樣**：`resetStageStats`（訓練值／勝率／心情歸零）、不繼承 power |
| 3 | 二次確認 | daemon 的按鈕要**明講營地那隻會消失**（是哪一隻、救不回來） |
| 4 | 指定對象 | CLI 與按鈕都帶 **ranch id**（營地可能有兩隻同角色，個體不同） |
| 5 | 配對方向 | **有序**：`(前線, 營地) → 目標`。第一組兩個方向同結果，未來會有 `A+B=A1` / `B+A=B1` |
| 6 | 動畫 | 沿用一般進化（本來就是 `dna1/2/3` 三幀 ＋ 光繭破裂，`EVO_LENGTH=12`），專屬版本列階段 3 |

## 資料：`characters/jogress.json`

**不併進 `special-evolutions.json`。** 那份的語意是「**營地裡的那隻**自己變」（大便獸），
jogress 是「**前線**變、營地那隻消失」，方向相反；混在一份裡會讓 `applyRanchAging`
的迴圈同時處理兩種語意，是遲早出事的那種省事。

```json
{
  "pairs": [
    { "pair": ["angewomon", "ladydevimon"], "to": "mastemon" },

    { "front": "a", "camp": "b", "to": "a1" },
    { "front": "b", "camp": "a", "to": "b1" }
  ]
}
```

| 欄位 | 意思 |
|---|---|
| `pair: [x, y]` | **兩個方向同結果**的簡寫，載入時展開成 `(x,y)` 與 `(y,x)` 兩筆 |
| `front` / `camp` | **有序**單筆。用在兩個方向結果不同的組合 |
| `to` | 目標角色 id。不在 roster 就不生效（與 `checkEvolution` 同一條 gate，規則可以先寫著等美術） |
| `note` | 備註，引擎不讀 |

⚠️ **對稱組一定要用 `pair` 簡寫**，不要手寫兩筆。這個 repo 已經因為「同樣的東西存兩份」
漏改過一次（進化 commit 兩份，害相位重對齊漏了一邊）。兩筆並存時總有一天只改一筆。

⚠️ 同一組 `(front, camp)` 只能出現一次。載入時偵測重複、取先出現的那筆 ——
靜靜地用後蓋前會讓「改了沒生效」變成無頭案件。重複清單由載入函式**回傳**，
由 `vpet jogress` 印出來（core 不能印，見〈實作時的修正〉）。

## 引擎（`agumon-core.js`）

### 候選判定要是**一個純函數**

```
jogressCandidates(st, ranch, opts) -> [{ petId, camp: <charId>, to: <charId> }]
```

CLI 要列清單、daemon 要決定按鈕露不露臉、測試要驗邊界 —— 三邊都問這一個函式。
各自寫一份的話，會出現「按鈕亮著但打指令說不成立」這種對不起來的狀況。

gate（與正常進化一致）：

- `to` 不在 roster → 不是候選
- `st._freezeEvolve` → 空清單（`vpet freeze` 是「凍結進化」，jogress 是進化）
- 那隻正被 daemon 長壓拿在手上（`yardTouch` 的 grab 中）→ 不是候選。
  否則畫面上被抓著的寵物會突然消失，那是 bug 的體感。

### 提交走 `applyRanchOp` 的新 op

```
force.ranchOp = { op: 'jogress', id: <ranchId> }
force.ranchTriggerTs = Date.now()
```

⚠️ **不要另開一條路徑。** `color-state.json` 是單一寫入者制，CLI 只能寫 force，
狀態搬移由「當家」那端下一拍做。沿用 `applyRanchOp` 就免費得到：時戳去重（多視窗
只會做一次）、**表演中回 `retry`**（戰鬥 19 拍的窗口一點都不窄）、過期不補做。
自己開一條等於重走一遍「戰鬥動畫播放中按收進營地 → 現役永久遺失」那個 bug。

成功時的動作順序：

1. 從 `ranch.pets` 移除那一筆 → `saveRanch`
2. 現役走**正常進化**路徑（設與 `force.evolveTarget` 相同的內部旗標）→ 動畫照播
3. `recordAlbumChar(to)`
4. ~~`evoHistory` 接上 `to`~~ → 改成 `updateEvoHistory` 認得合體（見〈實作時的修正〉）
5. 記一筆 `jogressFrom = { front, camp, ranchId, to, at }`。**預設要記**：卡片／右鍵日後能講
   「由 Angewomon ＋ LadyDevimon 而來」，不留的話玩家過幾天只會覺得那隻不見了

失敗回傳（訊息都要能讓人自己修正，不要只說失敗）：

| reason | 情況 |
|---|---|
| `notfound` | id 不在營地（多視窗搶同一隻時的第二個人會走到這裡） |
| `notmatch` | 那隻與現役組不出任何 pair → 訊息要寫出是「現役 X ＋ 營地 Y 沒有這一組」 |
| `frozen` | 進化凍結中 |
| `busy` → `retry` | 戰鬥／進化／空降表演中 |
| `expired` | force 超過 5 分鐘 |

## CLI（`statusline-cheat.js`）

| 指令 | 行為 |
|---|---|
| `vpet jogress` | 列出目前成立的組合（`#id 角色 → 目標`）。沒有就說**缺什麼**（現役是誰、營地有誰） |
| `vpet jogress <ranch-id>` | 印出「會消耗 #id 那一隻，永久」並要求再打一次帶 `yes` |
| `vpet jogress <ranch-id> yes` | 執行（寫 force，下次 refresh 生效） |

⚠️ **release 版要開放** —— 這是玩家功能，不進 `DEV_ONLY`、不進 cheat 的 release gate。
「條件不符」是**狀態 gate**，回「現在不成立」，跟「此版本未提供此指令」不能共用一條路：
兩者混在一起的話，玩家看到的訊息會是錯的。

## daemon UI

- `/state` 增一份 `jogress: { options: [{ id, camp, to }] }`。
  先例是 `ranchInfo{kept,cap}` —— 前線分頁靠它在按下去之前就知道營地滿了。
- `UI_BUTTONS` 目前只有 `dev` / `scope` 兩個維度，要加第三種**條件式**（例如 `when:'jogress'`）：
  `options` 空的時候整顆不露臉。
- 醒目：放按鈕列最前、給 accent 色，文案帶目標角色名。
- `scope: 'both'`。兩邊都相關（對象在營地畫面上看得到），但營地畫面的文案要寫清楚
  影響的是**前線**那一隻。
- 確認文案（決策 3）比照放生的寫法：

  > 合體進化會**永久消耗**營地的 `#2 LadyDevimon`（救不回來），
  > 前線的 `Angewomon` 會變成 `Mastemon`。確定嗎？

- 有多組候選時要能選 —— 一顆鈕配一個下拉（沿用「換出營地」那種 `fields` 形式），
  不要只做「第一組」：營地兩隻 LadyDevimon 的情況下那會變成擲骰子。

## 可達性：圖鑑與路線編輯器

`Mastemon` **目前沒有任何角色的 `evolvesTo` 指向它**（只當敵人出場），jogress 會是它
唯一的取得途徑。所以這兩處一定要一起改，否則會是相反方向的錯：

- `evo-rules.js` 的 `reachableFrom` 要吃 jogress：`to` 可達 ⇔ **`front` 與 `camp` 都可達**。
  不改的話圖鑑的「純敵人過濾」會把 Mastemon 藏起來 —— 而牠明明是玩家養出來的
  （大便獸踩過同一個坑，那次是靠把 special rule 的 `to` 算進來解的）。
- 路線編輯器**不畫** jogress 的邊（同 special-evolutions 的處理：來源是兩隻，畫上去
  會讓圖變成非樹狀），但**死路／孤點檢查要把 jogress 的 `to` 算成拿得到**，
  否則 Mastemon 會永遠被報成孤點，久了就沒人看那份報告了。

## 邊界（都要有測試）

| 情況 | 行為 |
|---|---|
| 營地有兩隻同角色 | 各自是獨立候選，按 id 選 |
| 前線與營地同角色（A＋A） | 只有表裡真的寫了這組才成立（預設沒有） |
| 目標不在 roster | 不是候選（規則可先寫著等美術） |
| 進化凍結中 | 擋，訊息說明原因 |
| 表演中 | `retry`，動畫播完下一拍做 |
| 多視窗同時按 | 時戳去重只做一次；慢的那個收到 `notfound` |
| 那隻正被拿在手上 | 不是候選 |
| 營地那隻在 jogress 前先被 `swap` 出來 | 候選重算（純函數每次現算，不快取） |

## 測試計畫（`scripts/test-jogress.js`）

1. `pair` 簡寫展開成兩筆；有序 `front`/`camp` 兩個方向不同結果
2. 重複的 `(front, camp)` 有 `log()` 且取先出現的
3. `jogressCandidates` 的每一條 gate（roster / freeze / grab 中）
4. `applyRanchOp('jogress')` 的成功路徑：營地少一隻、現役變 `to`、`evoHistory` 接上、
   圖鑑有記、`jogressFrom` 有寫
5. 五種失敗 reason 各一條
6. 多視窗：同一個時戳套兩次，只生效一次
7. `reachableFrom` 認雙親（只有一方可達時 `to` 不可達）
8. daemon：`/state` 的 `options`、條件式按鈕在空清單時不露臉、release 版仍可用
9. **每條新斷言都要驗「還原修正後會紅」** —— 這個專案抓過 7 條假綠

## 分期

| 階段 | 內容 |
|---|---|
| 1 ✅ | `characters/jogress.json` ＋ 引擎 ＋ CLI ＋ 測試 ＋ 可達性（圖鑑／路線編輯器） |
| 2 ✅ | daemon 醒目按鈕 ＋ 確認文案 ＋ `/state`／`/yard` 的候選 ＋ 多組時的下拉 |
| 3 | 專屬動畫（兩隻同時入鏡 → shared sprite 要加新幀） |

## 部署清單（漏了會**靜靜**失效）

- `scripts/install.js`：把 `characters/jogress.json` 帶到 `assets/`
- `scripts/build-release.js`：加進 characters 資料 json 的清單
- 兩處任一漏掉的症狀都一樣：規則讀不到 → 候選永遠是空的 → **按鈕永遠不出現，零錯誤訊息**。
  `scripts/test-release-build.js` 會從 install.js 反推出貨清單，漏第二處會被抓到；
  漏第一處要靠 `test-doctor.js` 那類接線檢查補一條。

## 實作時的修正（第 1 期）

規格照寫會出錯、實作時改掉的地方。

### 1. 營地那隻刪了、進化卻沒發生（最嚴重）

規格的流程是「刪營地那隻 → 走正常進化路徑」。但正常進化要等動畫播完才 commit，
而動畫有逾時保護：statusline 模式下沒人操作二十幾秒就逾時，`onExpired` 清掉
`evoNextCharId`，進化不會發生。結果是**營地少一隻、前線沒變 —— 一隻寵物憑空消失**。

改法：合體時多記一個持久的 `st.jogressTo`。`settleJogress` 每拍在 `applyForceFlags`
最前面跑：沒有進化在播、也沒有排著要播，角色卻還不是 `jogressTo` → 直接落地
（同正常 commit 的清理）。正常播完的情況只是把記號收掉。

它排在 `applyForceFlags` **最前面**有兩個理由：force 檔不存在時那個函式會提早
return（同營地老化）；同一拍若有 keep/swap，得先讓合體落地，否則收進營地的會是
一隻「欠著一次進化」的快照。

### 2. 提早寫 evoHistory 會被洗掉

規格寫「`evoHistory` 接上 `to`」。但動畫 12 拍才 commit，這段期間現役還是 front，
下一拍 `updateEvoHistory` 看到尾巴（to）≠ 現役（front）就判成斷點、整條重設。
改成讓 `updateEvoHistory` 認得 `isJogressStep(上一隻, 這一隻)`，什麼都不提早寫。

### 3. 「拿在手上」要擋兩次

拿著的狀態只存在 daemon 記憶體（`yard-touch.js` 的 `heldIds()`），由 daemon 經
`applyForceFlags(…, { heldIds })` 傳進 core。列候選時擋一次還不夠：CLI 看不到拿著，
使用者也可能按下合體**之後**才去抓那隻 —— `applyRanchOp` 執行那一刻再擋一次
（`reason: 'held'`）。statusline 當家時沒有「拿著」這回事，這條自然不成立。

### 4. 凍結要看 force，不是 st

`st._freezeEvolve` 在 `applyForceFlags` 裡比 `applyRanchOp` **晚**才從 force 重讀，
這一拍拿到的是上一拍的值。所以 `applyRanchOp` 直接看 `force.freezeEvolve`。

### 5. 營地寫入失敗就不能進化

`saveRanch` 回 false 時回 `reason: 'writefail'`、不排進化。否則營地那隻還在、前線又
變了，等於憑空多出一隻。

### 6. core 不能 `log()`

core 跑在 statusline 裡，stdout 就是狀態列本身，印一行就插進狀態列。組合表的展開
（含重複偵測）放在 `shared/evo-rules.js` 的 `expandJogress`，重複清單用回傳的，
由 CLI 印。圖鑑、路線編輯器也用同一個函式，三邊不會分叉。

### 7. 順手修掉的既有問題：daemon 第一拍一律失敗

daemon 的第一次 `doTick()` 是同步呼叫的，比檔案後段的 `const`（`BASE_COLS` 等）早，
當家模式的第一拍一律撞 TDZ。`doTick` 有 try/catch 所以沒人發現 —— 但失敗點在
`applyForceFlags` 之後、存檔之前：營地寫了、state 沒寫。啟動那一秒若剛好有
**swap** 或合體排著，被換進來／被消耗的那隻就遺失了（swap 是既有的洞，不是合體才有）。
改成 `setImmediate(doTick)`。

### 規格沒寫、實作補上的失敗 reason

| reason | 情況 |
|---|---|
| `held` | 那隻正被 daemon 長壓拿在手上 |
| `writefail` | 營地寫不進去（不進化） |

## 實作時的決定（第 2 期）

- **候選看 `color-state.json`，跟 CLI 同一份。** 隔離模式下 daemon 自己的 `daemon-state.json`
  只是顯示用的分身，拿它算會出現「按鈕亮著，按下去 CLI 說不成立」。
- **按鈕只在前線，不是規格寫的 `scope: 'both'`。** 進化演出在前線，在營地按下去只會看到營地少一隻，
  牠變身的那一刻看不到（使用者定案）。所以 `/yard` 不帶候選，也不需要「送出後切回前線」。
- **沒有候選時整顆不出現，不是灰掉。** 灰掉的鈕會讓人一直想點點看為什麼。
- **測試不送 `/cmd jogress`。** 那會 spawn CLI，而 CLI 的 state／force 路徑寫死在安裝目錄、
  不吃 `AGUMON_STATE_DIR`，會讀寫使用者真正的存檔。候選清單用當家 daemon＋暫存目錄驗，
  執行流程第 1 期的端對端已驗過。
