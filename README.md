# vpet — Claude Code 桌寵 新手指南

養一隻像素桌寵：牠會走動、睡覺、隨你使用 Claude Code 而成長、進化，還能帶去廣場跟同事的桌寵碰面。

桌寵住在一個**獨立視窗**裡，有自己的時鐘，永遠在動 —— 不需要 Claude Code 在刷新，
也**完全不碰你的 statusline**。

---

## 一、需求

- 已安裝 **Claude Code**，且有 `~/.claude/settings.json`（用過 Claude Code 就會有）。
- **Node.js**（在終端機打 `node -v` 有版本號即可）。

---

## 二、安裝（三步）

**1. 取得 release 版**

```bash
git clone -b release https://github.com/jojohne124/VpetStatusline.git vpet
cd vpet
```

**2. 安裝**：雙擊資料夾裡的

| Windows | macOS | Linux |
|---|---|---|
| `install.bat` | `install.command` | `./install.sh` |

（或在終端機執行 `node scripts/install.js --daemon-only`，效果一樣。）

**3. 打開桌寵**：雙擊

| Windows | macOS | Linux |
|---|---|---|
| **`vpet-standalone.vbs`**（不開黑色視窗，右下角工作列會有圖示） | **`vpet-standalone.app`**（安裝時產生，不開 Terminal） | `./vpet-standalone.sh` |

瀏覽器會打開 <http://localhost:3010>，你的桌寵就在那裡。

> 想看背景程式的訊息（例如排查問題）：Windows 改用 `vpet-standalone.bat`、macOS 用 `vpet-standalone.command`。

裝完**重開終端機**，`vpet` 指令才會生效。在 Claude Code 對話框裡，指令前加 `!` 就能直接執行，
例如 `! vpet help`。

### 安裝做了什麼

- 把桌寵資產裝到 `~/.claude/agumon-statusline/`
- 在 `~/.claude/settings.json` 掛上 **prompt hook**（會先備份）
- 註冊全域指令 `vpet`
- **不會**動你的 `statusLine` 設定

> **prompt hook 是做什麼的？** 它負責「你送出訊息」這個脈搏 —— 桌寵的**訓練值（戰力成長的
> 唯一來源）**、自動戰鬥、活動時間全靠它。少了它桌寵不會長大。

> 若安裝時提示 `vpet` 沒進 PATH，或找不到 `settings.json`，照它印出的指示補一下即可。

---

## 三、桌寵視窗裡能做的事

- **點角色**＝摸摸（連戳牠會生氣）
- 快捷鈕：卡片、進化樹、圖鑑、營地、**廣場**
- **營地**：把桌寵收進營地、換別隻出來；營地裡的可以摸、可以長按拎起來換位置
- 「⚙ 進階指令」摺疊區：重抽、進化凍結、自動戰鬥開關、**舞台底圖**、doctor、名牌
- 上方面板顯示 token 用量與花費（Claude Code 與 Codex 分開計）

**換自己的照片當背景**：進階區的「🖼 舞台底圖」（或指令 `vpet bg`）會開一個編輯器，
選一張圖、拉框調整縮放位置就好。底圖只存在你自己電腦上
（`~/.claude/agumon-statusline/bg.png`），不會隨版本散佈。

---

## 四、開始玩

- **一開始**：你有一隻起始桌寵（Child 階、戰力低）。
- **成長 / 進化**：隨著你正常使用 Claude Code（累積使用量）+ 戰鬥勝率達標，桌寵會
  **自動進化**到下一階。不同條件會走向不同分支，養法不同、結果不同。
- **戰鬥**：送出訊息後有機會自動開打，勝負會影響你的勝率（進而影響進化）。
- **合體進化**：特定兩隻（一隻在前線、一隻在營地）湊在一起時，視窗會出現合體進化的按鈕。
- **想重來**：`vpet reset` 會重抽一隻起始桌寵。想保留現在這隻，改用「收進營地」。

隨時打 **`vpet help`** 看所有可用指令。

---

## 五、指令一覽

| 指令 | 說明 |
|------|------|
| `vpet help` | 顯示指令說明與目前角色列表 |
| `vpet card` | 秀出狀態卡（角色 / 階級 / 戰力 / 勝率） |
| `vpet tree` | 顯示這隻走過的進化歷程（走過的彩色、還沒到的黑影問號） |
| `vpet album` | 開啟圖鑑（瀏覽器）：養過的角色與進化路線圖 |
| `vpet bg` | 設定舞台底圖（瀏覽器）：換成自己的照片 |
| `vpet camp` | 營地：列出收藏的桌寵 |
| `vpet keep` / `vpet swap <編號>` / `vpet release <編號>` | 收進營地並抽新的 / 換出營地裡的某隻 / 放生 |
| `vpet jogress` | 合體進化：列出目前成立的組合 |
| `vpet reset` | 重抽一隻起始桌寵（轉生） |
| `vpet sleep` / `vpet wake` | 強制睡覺 / 叫醒（睡著時發訊息也不會醒，直到 wake） |
| `vpet freeze` / `vpet unfreeze` | 凍結 / 解除進化（凍結時就算達標也不會自動進化） |
| `vpet battle off` / `vpet battle on` | 關閉 / 恢復「送訊息後自動戰鬥」 |
| `vpet code [名牌]` | 查看 / 設定你的名牌（廣場上顯示的名字） |
| `vpet doctor [--check]` | 桌寵卡住／不動時：清除卡死的背景行程（`--check` 只診斷不清） |

> 指令的 `--` 可省略（`vpet card` = `vpet --card`）。

---

## 六、廣場

在桌寵視窗的前線按 **🏛 廣場**，前線那隻就會走進一個大家共用的廣場，看得到同事的桌寵在旁邊走動。
**不用任何設定**，在公司內網就連得上。

- 連不上（主機沒開、或你不在公司內網）會留在前線，並告訴你原因。
- 在廣場的期間桌寵不會成長：訓練值、自動戰鬥、進化都先暫停。也不能切到營地、
  不能重抽／收進營地／合體，要先按 **🚪 離開廣場**。
- 關掉桌寵視窗的分頁不算離開，牠會繼續在廣場走；關掉 daemon 或斷線就會回到前線。
- 名牌就是你在廣場上顯示的名字：進階區的「🏷 名牌」或 `vpet code 新名牌`。
  同名的人後進場的會把先進場的擠回前線，別跟同事撞名。

---

## 七、疑難排解

- **雙擊 `vpet-standalone` 沒開出視窗**：先確認安裝成功過；用 `vpet-standalone.bat`
  （Windows）／ `.command`（macOS）開，看黑色視窗裡印了什麼錯誤。
  也可以直接打開 <http://localhost:3010> 看看。
- **打 `vpet` 說找不到指令**：重開終端機；仍不行就照安裝時印的 PATH 指示加一下。
- **忘記 clone 在哪**：`vpet help` 最後會印出這份指引的完整路徑。
  若顯示「找不到當初 clone 的資料夾」，代表那個資料夾被刪或搬走了 —— 重新
  `git clone` 一份再跑安裝即可（存檔在 `~/.claude/agumon-statusline/state/`，不會遺失）。
- **桌寵卡住、互動了也不恢復**：先打 `vpet doctor` 清除卡死的背景行程（只想先看有沒有問題就
  `vpet doctor --check`）。平時系統會自動清，這是手動補刀。
- **doctor 也救不回**：到 `tools/agumon-doctor/` 雙擊 **`agumon-restart.bat`**（Windows）/
  **`agumon-restart.command`**（macOS）強制重啟（會保留你的角色與進度），或執行
  `node tools/agumon-doctor/restart.js`。要回報問題就跑 `agumon-report`（見 `tools/agumon-doctor/`）。
- **更新到新版**：在 clone 的資料夾裡 `git pull`，再雙擊一次 `install`。角色與進度不受影響。
- **想移除**：雙擊 **`uninstall.bat`**（Windows）／ **`uninstall.command`**（macOS）／
  `./uninstall.sh`，或執行 `node scripts/uninstall.js`。你的桌寵存檔預設保留（加 `--purge`
  才一併刪除）。**你自己的 statusline 設定不會被動到。**

---

## 附錄：讓桌寵也住進 Claude Code 狀態列（進階）

預設安裝不碰 statusline。如果你想在 Claude Code 底下的狀態列也看到桌寵：

```bash
node scripts/install.js        # 不加 --daemon-only
```

完成後**重開 Claude Code**，狀態列就會出現桌寵。獨立視窗照樣可以用：視窗一開，
狀態列那隻會自動退成只顯示，兩邊不會打架。

要知道的：

- **會覆蓋你原本的 statusline**。有自己慣用的 statusline 的話，先備份 `settings.json` 裡那條指令。
- **狀態列那隻要等 Claude Code 刷新才會動**（最快一秒一次），所以比獨立視窗頓；
  Claude 分頁閒置或沒 focus 時還會停格 —— 回到 Claude 分頁、送一則訊息就恢復。
- `vpet hide` 只隱藏狀態列的桌寵（狀態文字保留），`vpet show` 恢復。

**改回預設（只用獨立視窗）**：再雙擊一次 `install`（或 `node scripts/install.js --daemon-only`）。
腳本會把狀態列那份拆乾淨，並移除 `settings.json` 裡**指向 `agumon-statusline` 的那條 `statusLine`**
（會先備份），你的狀態列就恢復成 Claude Code 預設。角色與進度不受影響。

> ⚠ 2026-08 之前的舊版 `--daemon-only` **不會**清掉那條 `statusLine`，結果是 Claude Code 每秒
> 去執行一個已被刪掉的檔案、狀態列跳「找不到檔案」。先 `git pull` 再跑；已經踩到的話，手動把
> `~/.claude/settings.json` 裡的 `statusLine` 整段刪掉即可。

祝養寵愉快 🦖
