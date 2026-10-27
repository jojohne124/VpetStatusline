# vpet mini — vpet 的桌面小視窗

把 vpet 的網頁（`http://localhost:3010`）原封不動放進一個**只有面板大小、永遠最上層、可拖、可縮放**的小視窗。
同事做的 v12（2026-10-21），同一天併進 repo，**之後由本 repo 維護**；v13（提醒）、v15（小寵物、頂端橫列、系統匣雙擊）2026-10-22 併入，v16（桌面、選單統一、小寵物移動改版）2026-10-27 併入。只支援 Windows。

- 頁面裡塞一段「量尺寸」的腳本（只量不改），加兩條樣式：常駐的 `h1` 上下對稱內距、進化樹期間鎖畫布大小（見維護須知）。
- 相依：Windows 11 內建的 WebView2 runtime、PowerShell 5.1。`lib\` 內附 WebView2 SDK 三個 dll（Microsoft 簽章，授權見 `lib\LICENSE.txt`），不用另外裝。

## 怎麼開

照常雙擊 repo（或 release）根目錄的 **`vpet-standalone.vbs`** → 右下角 vpet 圖示右鍵 →「**開啟 vpet mini 視窗**」。
沒有另外的啟動器；系統匣是 `tools\vpet-tray.ps1` 那一個（daemon 也是它開的）。「結束 vpet」會連小視窗一起關。

**提醒**（同事 v13 的功能，2026-10-22 併進系統匣；選單「提醒」可逐項開關，存 `tools\vpet-tray.json`）：系統匣每秒看 `/state` 的 `kind`，
- 進化開始（`evo`）：Windows 通知氣泡「Vpet進化中！／咦！？ ○○的樣子……！」（○○＝`/state` 的 `jogress.frontName`）＋提示音＋自動開小視窗（已開就叫到前面）。
- 戰鬥開始（`battle`）：通知氣泡「Vpet開打了！／( ◞•̀д•́)═○💥○═(•̀д•́◟ )」＋提示音。
- 啟動那一拍不提醒；Windows「專注輔助」開著時氣泡會被壓掉，只剩提示音。

- 事件（`/state` 的 `event`，例如營地事件）：通知氣泡「事件發生!!」＋提示音（選單「事件：跳通知」可關）。

**系統匣圖示**（v15）：左鍵單擊或右鍵出選單；雙擊照選單「雙擊圖示開啟」的設定開小視窗（預設）、網頁或桌面（v16）。
第一次啟動跳一次「怎麼讓圖示常駐顯示」的教學（Windows 不讓程式自己決定，只能教玩家把圖示從「^」拖出來），之後從選單再看。

**兩邊選單一樣**（v16）：系統匣跟小視窗 ☰ 的選單結構相同、設定互通——
`開啟 vpet 網頁視窗`／`開啟 vpet mini 視窗`／`小視窗 ▸ 畫面縮放・閱讀縮放・永遠最上層`／`小寵物 ▸ 桌面・跟隨滑鼠`／`提醒 ▸ …`／`雙擊圖示開啟 ▸ 小視窗・網頁・桌面`／`怎麼讓圖示常駐顯示？`。
「小視窗」「小寵物」兩組存小視窗自己的 `tools\vpet-mini\mini-web.json`（系統匣改了，小視窗每 2 秒看檔案時間套用；「桌面」是寫 `request: "pet"`，小視窗沒開就先開）；
「提醒」「雙擊」存 `tools\vpet-tray.json`（`notifyEvo`、`notifyBattle`、`notifyEvent`、`sound`、`autoOpenMini`、`dblClick`、`hintShown`；小視窗改了，系統匣每 2 秒重讀）。
兩邊寫檔都只改那一格、其他欄位原樣保留。

## 小視窗怎麼操作

| 動作 | 效果 |
|---|---|
| 面板空白處按住拖曳（不是按鈕、輸入框、畫布、連結、聊天紀錄） | 移動視窗 |
| 「▸ 進階指令」那一列 | 按在文字上＝展開／收合；按在文字右邊的空白＝拖曳 |
| 頂端橫列右端的「☰ vpet 100%」按鈕 | 點一下（左鍵或右鍵）開選單、按住拖曳移動視窗。數字是目前的畫面縮放，字型字級跟頁面標題一致 |
| ☰ 左邊的「桌面」按鈕（v16） | 一鍵縮成桌面小寵物（橫列放不下就不顯示） |
| 小方塊（面板右下角 14×14）拖曳 | 整頁等比例縮放 40%～200%，拖時只動外框、放開才套用 |
| 選單 | 跟系統匣同結構（見上）；另有重新整理、結束 vpet mini（只關小視窗） |
| 「桌面」（原「縮成小寵物」） | 小視窗藏起來（不關），**就站在小視窗裡那隻此刻的位置**（不會往下掉），**照抄遊戲此刻畫的那隻**（`/state` 的 `petLines`），睡覺、表情、戰鬥都同步。移動一幀一格、跟遊戲 0.75 秒一步同步；沒跟隨時在面板寬度內折返。點牠小視窗回來、按住拖搬家、右鍵有選單、**在牠身上滾滾輪改大小**（2～16 倍，存 `petScale`）；進化開始時小視窗自動回來 |
| 小寵物「跟隨滑鼠」 | 一幀走 N 格（遠大步、近一格，大步分 5 拍走完）；離游標「身寬 × 1.5」內停下，滑鼠主動靠太近牠會往反方向躲，離開 150 px 再追；雙螢幕跨螢幕是走過去不瞬移；睡覺／戰鬥時不追 |
| 事件（`/state` 的 `event`） | 一般小視窗：叫到最前面、頁面跳對話框（對話框放視窗正中間）。桌面：比照進化回小視窗，**看完自動縮回桌面**。桌面＋跟隨滑鼠：頭上冒半透明黑底紅「❗」、停下來等點，點了回小視窗、看完也自動縮回 |
| 進化樹（常駐） | 樹那張圖比平常寬，原本視窗會撐寬；現在樹期間把前線畫布鎖在平常寬高、等比縮進去，視窗形狀不變（圖會糊一點） |
| 頁面內「圖鑑」「舞台底圖」 | 交給預設瀏覽器開新分頁（只放行 http／https） |
| 頁面的 confirm／alert／prompt | 改用 Windows 對話框顯示，不受視窗大小影響 |

- 視窗自動貼合頁面內容：右欄顯示會變寬、進化樹會撐大、浮層比視窗大時暫時長到放得下，關掉就縮回。
- 只會開一個小視窗；再開一次只是叫到前面。3010 連不上時：tray 還在就等最多 90 秒（自動更新的空檔），tray 不在了 10 秒關。
- 閱讀縮放（預設關）：卡片／進化樹場景暫時升到指定縮放。頁面的前線畫布已經照 `devicePixelRatio` 畫（2026-10-21），通常不需要。

`mini-web.json`（位置／縮放／最上層／小寵物設定）、`webview-data\`（WebView2 的瀏覽器資料）是小視窗自己產生的，不進 git、不出貨；自動更新只覆寫出貨的檔案，不會刪它們。刪掉就回預設。

## 壞掉時

- 「WebView2 啟動失敗」：Windows 的 WebView2 runtime 不在（Win11 內建，`C:\Program Files (x86)\Microsoft\EdgeWebView\`）。
- 小標籤紅字「連不到 daemon」：daemon 沒在跑，重開 `vpet-standalone.vbs`。
- 視窗尺寸怪：選單「畫面縮放 100%」，或刪 `mini-web.json`。
- 除錯：設環境變數 `VPET_MINI_DEBUG=1` 再開。寫 `_measure.log`／`_fit.log`／`_err.log`；`_debug_cmd.js` 出現時在頁面執行它、`_debug_shell.txt` 寫 `width N`（模擬拖到 N 寬放開）／`pet`／`unpet`／`follow`／`unfollow`／`petpos`／`petdump`／`petscale N`；進入桌面那一刻的圖存 `_pet_enter.png`。指令檔每 300 ms 讀一次，兩個指令之間要等。不必碰滑鼠就能驗。

---

## 維護須知（改程式前先讀）

每條都是實際踩過的坑（同事的交接，併進來時更新過）。

### 架構
三個 WinForms 視窗：**主視窗**只放 WebView2，形狀（`Form.Region`）＝頁面回報的實體矩形＋頂端橫列（頁面標題那段補成面板寬的一條）；**小標籤**（☰ 按鈕，放橫列右端）、**小方塊**是主視窗的 owned window（WebView2 是獨立子視窗，會蓋住同區域的控制項，把手只能用另外的視窗疊上去）。系統匣與 daemon 歸 `tools\vpet-tray.ps1`。

### 跟頁面（`src/daemon/daemon.js`）的約定 —— 改到這些要一起改小視窗（`test-release-build` 有檢查）
- `/state` 的 `kind`：`card`、`tree` 是「有字的場景」（閱讀縮放用）；系統匣的提醒看 `evo`（進化）、`battle`（戰鬥），名字看 `jogress.frontName`。
- 整列 `.form` 帶 `data-cmd`（給列內按鈕讀的），列本身不可點 → 小視窗只把**按鈕上**的 `data-cmd` 當互動。
- 頁面的 `confirm`／`alert`、圖鑑的 `window.open`。
- 聊天紀錄 `#chatlog`：不拖（要能反白複製）。
- tray 開的 Mutex `Local\vpet-tray`：小視窗靠它判斷 daemon 是不是我們管的（自動更新空檔多等）。
- `/state` 的 `petLines`（小寵物照抄：8 列 × 52 格，`▀` 前景＝上半、背景＝下半，`▄` 反之，`█` 兩半前景，點字空白透明）與 `character`（拿 `characters\<character>\art.json` 的 12 幀逐像素比面向，比不到就原地站；id 只收英數、底線、連字號）。
- 頁面標題 `h1`：☰ 按鈕的字級、頂端橫列的上緣都量它；沒有 `h1` 就退回預設。
- `#pet` 畫布（v16）：縮成桌面時量它的 CSS 框算小寵物要站的位置（框寬 ÷ 52 格＝每格 px）。
- `/state` 的 `event`：`{ id, kind, title, name, active, wantsFront }`（daemon 的 `currentEvent()` 統一出口，新事件只改那裡）。小視窗與系統匣只看 `id` 變了沒。

### 注入的樣式（只有兩條）
- `$STYLE`（常駐）：`h1{margin:0;padding:3px 0;line-height:1.2}`，標題行上下對稱、跟 ☰ 按鈕同一中線；`h1` 不在了就沒效果、不會壞。
- `Set-TreeFit`（只在進化樹期間）：最大那塊畫布加 `data-vpet-mini-fit`，塞 `<style id="vpet-mini-fit">` 把它鎖在平常寬高（`!important`，頁面每幀都會重設 `cv.style.width`）、`object-fit:contain`、`image-rendering:auto`（pixelated 縮小會丟列）；樹結束移除。

### 頁面裡唯一的腳本（`$MEASURE`，`AddScriptToExecuteOnDocumentCreatedAsync`）
每 0.7 秒＋DOM 變動＋resize 時量一次，`postMessage` 給殼：
- `w`／`h`：內容寬高（CSS px）。量「內容」不是「容器」：撐滿父層的區塊往下找子元素、文字用 Range 量；flex-wrap 被擠成多列時算「全排一列」的寬和「最高那個」的高（**要含 gap**）；`overflow` 不是 visible 的元素把子元素裁在框內（戰鬥畫布原始寬 832，不裁會讓視窗一直變寬）。
- `rects`：實體矩形（有底色／背景圖／邊框的元素、畫布／圖片／表單控件整塊；其餘往下找、文字節點每行一塊；沒底色的區塊湊出 ≥6 個小矩形就改用整塊外框，右欄才有底）。從 body 的子元素開始（body 自己有底色，算進去就沒有洞）。
- 浮層需求：fixed／absolute 子樹裡「尺寸跟視窗不相等」的元素，需求＝其寬／高＋24（看尺寸不看位置；看「有沒有超出」會來回跳）。
- `{drag:1}`：空白處 mousedown → 殼 `ReleaseCapture`＋`SendMessage(WM_NCLBUTTONDOWN, HTCAPTION)` 交 Windows 拖曳。互動元件（button/a/input/select/textarea/canvas/label/img/video、onclick、role=button、contentEditable、cursor:pointer、`#chatlog`）不拖；`summary` 依按下位置：文字右緣（Range）之外當空白、並擋掉 click。

### 殼這邊的規則
- 自動貼合：寬＝內容×縮放＋2＋**24**（垂直捲軸 17＋餘裕；剛好等寬時右欄會被捲軸卡在面板下面排不回旁邊）、高＋2＋4。起始先 1000×800 隱形、第一次貼合才現身（頁面 `max-width:100%` 會讓內容量不到比視窗更寬，從小視窗起步長不回去）。變大超出螢幕往內推。
- 縮放：小方塊拖曳時只記目標、60 ms 計時器合併套用，`SuspendLayout` 凍結內部版面，放開才算比例（視窗寬÷內容寬）、`ResumeLayout`、套 `ZoomFactor`。
- **不能用 TransparencyKey 色鍵挖洞**：色鍵視窗的點擊判定看 GDI 畫面，WebView2 用 D3D 合成不在裡面，整塊會被當成洞、按鈕全點穿。用 `Form.Region`。
- **WebView2 的 confirm／alert／prompt 畫在 WebView 裡**，視窗小就被切：`AreDefaultScriptDialogsEnabled=$false` 後接 `ScriptDialogOpening` 用 MessageBox／InputBox 畫。
- **新視窗只放行 http／https**（`NewWindowRequested`）：`Start-Process` 收到本機路徑會直接執行程式。
- release 版 daemon 是更新外殼＋子行程兩層，自動更新只重開子行程、3010 空檔十幾秒：小視窗看門狗「tray 的 Mutex 還在就等 90 秒、不在 10 秒關」。要模擬更新空檔用 `NtSuspendProcess` 暫停子行程（殺子行程會連外殼一起退出）。

### PowerShell 5.1 的坑
- 變數**不分大小寫**：`$grip`（物件）會蓋掉 `$GRIP`（常數）——常數一律加後綴（`$GRIP_PX`）。
- `$script:Home` 撞唯讀的 `$HOME`。
- Win32 字串參數傳 `$null` 會變空字串（`FindWindow($null, …)` 找不到），要傳 `[NullString]::Value`。
- 頂層小視窗要設 `MinimumSize`／`MaximumSize`，否則 Windows 撐成 136×39。
- 事件處理裡的 `try/catch` 至少在除錯模式要落檔（`_err.log`），不然整段靜默失敗。
- 檔案要 **UTF-8 含 BOM**（沒 BOM 中文會被拆壞）；以 `-STA` 啟動（`vpet-mini.vbs` 已帶）。
