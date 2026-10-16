# 教學（daemon 專屬）

按「?」→ 點想問的地方 → 其餘壓黑，Terriermon 助手跳出來講解那一塊。

- **只在 daemon 頁面**：statusline 沒有可以點的東西，不做。
- **不主動觸發**：第一次開 daemon 不跑導覽，要的人自己按「?」。

## 一、流程

| 狀態 | `helpMode` | 畫面 | 操作 |
|---|---|---|---|
| 平常 | 0 | — | 按「?」→ 問號模式 |
| 問號模式 | 1 | 滑鼠變問號（`cursor:help`）、頂端提示「點想問的地方」、滑過有說明的地方亮紫色虛線框、「?」鈕亮起 | 點有說明的地方 → 講解；點沒說明的地方 → 什麼都不做（留在問號模式）；再按「?」／Esc／右鍵 → 離開 |
| 講解 | 2 | 其餘壓黑、目標留一個亮框；助手對話框逐字講 | 點一下：還在打字 → 一次顯示完；打完了 → 關閉並**回到平常**；Esc／右鍵 → 回到平常 |

看完一則就回平常，不留在問號模式：問號模式下所有按鈕都失靈，留著的話使用者會以為頁面壞了。

### 點擊一律攔下來

問號模式與講解中，`pointerdown / mousedown / mouseup / click / dblclick / auxclick / contextmenu / touchstart`
都在 **window 的捕獲階段**攔下（`preventDefault` + `stopImmediatePropagation`）：

- 想問「🎲 重抽」是什麼，不能真的重抽下去。
- mousedown 也要攔：長壓拎起、下拉選單、`<details>` 展開都從 mousedown／click 開始。
- 唯一放行：問號模式下按「?」鈕本身（交給它自己的 click，切回平常）。

### 對話框位置

先放進整段文字量好高度再定位，逐字打的時候框不會一直長高、跳位置。
放目標下面 → 放不下就上面 → 都放不下（目標很高，例如舞台）就貼視窗底部。左右夾在視窗內。

## 二、助手

- 素材：`characters/TerriermonAssistant/`（144×240 的標準 3×5 版面，跟 BlitzGreymon 那批同格式，
  見該資料夾的原圖與 `characters/BlitzGreymon/格式說明.png`）。用 `scripts/add-character.js` 轉檔，
  逐點比對 0 點不符。power 30（Child）。
- **沒有實裝**（不在 roster）：玩家不會遇到、不算圖鑑分母。資料夾一樣隨 release 出貨
  （build-release 帶所有有 config.json 的角色資料夾）。
- 表演：`IDLE_1` ↔ `IDLE_2` 每 375ms（半拍）交替。之後要換動作改 `tutorFrames()` 挑的幀就好。
- daemon 啟動時把兩幀轉成 16×16 色碼送進頁面（`TUTOR`），前端畫進 16×16 的小畫布、CSS 放大成 80px。
  不走舞台的 dot 網格。讀不到素材 → `TUTOR = null`，說明照出、只是沒有助手（log 一行）。
- 對話框上方署名「🎓 Terriermon 助手」。

## 三、說明表

**只寫在 `src/daemon/help-tips.js`。** 頁面元素只標代號 `data-help="card"`。

| 欄位 | 意思 |
|---|---|
| `t` | 標題 |
| `d` | 說明本文（助手講的話） |
| `dev` | 開發限定：release 頁面不帶這條（`tipsFor(IS_RELEASE)`） |
| `by` | 依畫面換說明（`home / yard / plaza`），目前只有舞台 |

- 找說明是 `closest('[data-help]')`：點到按鈕裡的字，也算點到那顆按鈕；點到舞台裡的天氣看板，是看板（`hud`）而不是舞台。
- `UI_BUTTONS` 產的按鈕代號 = 指令名（`card`），`UI_FORMS` 的列代號 = `action`，沒有 action 的成對開關取第一顆的指令（`freeze`、`battleOn`）。
- 文字裡不要放反引號和 `${`（會進 daemon 頁面的 template literal）。

### 測試（`scripts/test-daemon-page.js`）

- 頁面上每個代號都有說明；表裡每一條都有元素在用（沒有孤兒）。
- `dev` 標記跟元素一致：元素開頭標籤有 `devonly`，或緊接著就有 `devtag` ⇔ `dev: true`。
- release 的表不帶 dev 條目，頁面帶的是 `tipsFor(IS_RELEASE)`。
- 問號模式攔點擊：平常不攔；問號模式 mousedown／click 都攔；點到沒說明的地方留在問號模式；
  ? 鈕放行；右鍵離開；打字中點一下是顯示完而不是關閉；舞台依畫面換說明；助手兩幀有送到。

## 四、還沒做（之後）

- 導覽（一圈帶完所有區塊）：同一套說明表＋壓黑，依序跳。這次決定不做、也不在第一次開時觸發。
- 畫布內分區：營地裡點某一隻講牠是誰。目前舞台整塊當一區。
- 助手其他動作（講到危險操作用 Angry、講完用 Happy…）。
- 停用（disabled）的按鈕：瀏覽器不會對它發 click，點了沒反應。目前畫面上沒有停用的按鈕。
