# vpet — Claude Code 桌寵 新手指南

養一隻像素桌寵：牠會走動、睡覺、隨你使用 Claude Code 而成長、進化，還能跟朋友幽靈對戰。

放在**哪裡**由你決定 —— 可以住在 Claude Code 的狀態列（statusline），也可以只開一個
**獨立視窗**（適合已經在用自己 statusline 的人）。兩種安裝方式見下。

---

## 一、需求

- 已安裝 **Claude Code**，且有 `~/.claude/settings.json`（用過 Claude Code 就會有）。
- **Node.js**（在終端機打 `node -v` 有版本號即可）。

---

## 二、安裝（約 1 分鐘）

```bash
# 1. 取得 release 版
git clone -b release https://github.com/jojohne124/VpetStatusline.git vpet
cd vpet

# 2. 一鍵安裝
node scripts/install.js
```

> **不想開終端機？** 下載後直接雙擊資料夾裡的 **`install.bat`**（Windows）或
> **`install.command`**（macOS）即可安裝，效果與上面的指令相同。（仍需先裝 Node.js）

安裝腳本會自動：
- 把桌寵資產裝到 `~/.claude/agumon-statusline/`
- 幫你的 `~/.claude/settings.json` 掛上 statusline 與 prompt hook（會先備份）
- 註冊全域指令 `vpet`

完成後：
1. **重開終端機**（讓 `vpet` 指令生效）。
2. **重開 Claude Code**（或開新對話）→ 狀態列就會出現一隻 **亞古獸（Agumon）**。

> 若安裝時提示 `vpet` 沒進 PATH，或找不到 `settings.json`，照它印出的指示補一下即可。
> 在 Claude Code 對話框裡，指令前面加 `!` 就能直接執行，例如 `! vpet help`。

### 已經有自己的 statusline？改用「只裝獨立視窗」

如果你已經在用別的 statusline（自己寫的、或別的工具的），不想被接管，改用這個：

```bash
node scripts/install.js --daemon-only
```

> 雙擊版：**`install-daemon-only.bat`**（Windows）／**`install-daemon-only.command`**（macOS）

差別只有一個：**不會碰你 `settings.json` 的 `statusLine` 設定**，桌寵改在瀏覽器的
獨立視窗裡看（見下節）。其餘完全相同 —— `vpet` 指令、進化、戰鬥、圖鑑都照常。

> 為什麼還是會裝 prompt hook？那個 hook 不是 statusline 的一部分，它負責「你送出訊息」
> 這個脈搏 —— 桌寵的**訓練值（戰力成長的唯一來源）**、自動戰鬥、活動時間全靠它。
> 少了它桌寵不會長大，所以兩種安裝都會裝。

反悔了想讓桌寵回到狀態列，重跑一次一般安裝（不加 `--daemon-only`）即可。

---

## 三、獨立視窗（不佔狀態列）

桌寵也可以跑在一個獨立的瀏覽器視窗裡，**不依賴 Claude Code 有沒有在刷新狀態列** ——
它有自己的時鐘，你切到別的分頁牠照樣走動、睡覺、戰鬥。

- 雙擊 **`vpet-standalone.bat`**（Windows）／ **`vpet-standalone.sh`**（macOS / Linux）
- 瀏覽器會自動打開 <http://localhost:3010>
- **不想看到黑色主控台視窗？** 改雙擊 **`vpet-standalone.vbs`** —— 背景執行並在
  右下角工作列放一個圖示。

視窗裡能做的事：

- **點角色**＝摸摸（連戳牠會生氣）
- 快捷鈕：卡片、進化樹、圖鑑
- 「⚙ 進階指令」摺疊區：重抽、進化凍結、自動戰鬥開關、**舞台底圖**、doctor、幽靈對戰、名牌
- 上方面板顯示 token 用量與花費（Claude Code 與 Codex 分開計）

**換自己的照片當背景**：進階區的「🖼 舞台底圖」（或指令 `vpet bg`、雙擊
`bg-editor.bat` / `.sh`）會開一個編輯器，選一張圖、拉框調整縮放位置就好。
處理全在瀏覽器完成，預覽與存檔是同一份像素，不會調好之後走鐘。
底圖只存在你自己電腦上（`~/.claude/agumon-statusline/bg.png`），不會進 repo 也不隨版本散佈。

> 只裝獨立視窗的人（`--daemon-only`）就是用這個視窗玩。
> 兩種都裝的人：獨立視窗一開，狀態列那隻會自動退成唯讀，不會兩邊打架。

`vpet hide` 可以只隱藏狀態列的桌寵（狀態文字保留），`vpet show` 恢復 —— 想專心用
獨立視窗又不想讓狀態列變擠時很好用。

---

## 四、開始玩

- **一開始**：你有一隻亞古獸（Child 階、戰力低）。
- **成長 / 進化**：隨著你正常使用 Claude Code（累積使用量）+ 戰鬥勝率達標，桌寵會
  **自動進化**到下一階。不同條件會走向不同分支，養法不同、結果不同。
- **戰鬥**：送出訊息後有機會自動開打，勝負會影響你的勝率（進而影響進化）。
- **想重來**：`vpet reset` 會重抽一隻起始桌寵（隨機、部分角色機率較高）。

隨時打 **`vpet help`** 看所有可用指令。

---

## 五、指令一覽

| 指令 | 說明 |
|------|------|
| `vpet help` | 顯示指令說明與目前角色列表 |
| `vpet card` | 在狀態列秀出狀態卡（角色 / 階級 / 戰力 / 勝率，約 5 秒） |
| `vpet tree` | 顯示這隻走過的進化歷程（走過的彩色、還沒到的黑影問號） |
| `vpet album` | 開啟圖鑑（瀏覽器）：養過的角色與進化路線圖 |
| `vpet bg` | 設定獨立視窗的舞台底圖（瀏覽器）：換成自己的照片 |
| `vpet hide` / `vpet show` | 隱藏 / 顯示狀態列的桌寵（狀態文字保留；適合搭配獨立視窗） |
| `vpet reset` | 重抽一隻起始桌寵（轉生） |
| `vpet sleep` / `vpet wake` | 強制睡覺 / 叫醒（睡著時發訊息也不會醒，直到 wake） |
| `vpet freeze` / `vpet unfreeze` | 凍結 / 解除進化（凍結時就算達標也不會自動進化） |
| `vpet battle off` / `vpet battle on` | 關閉 / 恢復「送訊息後自動戰鬥」 |
| `vpet pvp-setup <url> <key> [名牌]` | 首次設定幽靈對戰（見下） |
| `vpet pvp [名牌]` | 幽靈對戰 |
| `vpet code [名牌]` | 查看 / 設定你的名牌 |
| `vpet doctor [--check]` | 桌寵卡住／不動時：清除卡死的背景行程（`--check` 只診斷不清） |

> 指令的 `--` 可省略（`vpet pvp` = `vpet --pvp`）。

---

## 六、幽靈對戰（PvP）設置

幽靈對戰是**非同步**的：你把自己的「戰卡」上傳到一台共用後端，朋友就能挑戰你的
分身（反之亦然），不需要同時上線。

### 1. 首次設定
需要後端網址與金鑰（`url` / `key`，由架設後端的人提供）：

```bash
vpet pvp-setup <url> <key> 你的名牌
```

- **名牌**＝你的顯示名，也是別人指名你對戰用的 ID（中文或英數、1–16 字、不含空白／符號）。
- 例：`vpet pvp-setup https://xxx.workers.dev SECRET123 阿張`

### 2. 開打

```bash
vpet pvp            # 隨機配同階對手（配不到真人 → 自動派固定練習對手）
vpet pvp 阿明        # 指名挑戰名牌為「阿明」的朋友
vpet pvp MAJAJA     # 指名內建練習對手（純本機、免連線，依你的階級出招）
```

對戰結果會在下次狀態列刷新時演出。

### 3. 查看 / 改名牌

```bash
vpet code           # 看目前名牌與後端
vpet code 新名牌     # 改名牌（會同步更新後端上的戰卡）
```

> ⚠ 同一群朋友之間別撞名牌（上傳會覆蓋對方的戰卡）。
> 只想單機玩、不設後端也完全沒問題 —— 桌寵的成長／進化／`vpet pvp MAJAJA` 練習都不需連線。

---

## 七、疑難排解

- **狀態列沒出現桌寵**：確認已重開 Claude Code；檢查 `~/.claude/settings.json` 的
  `statusLine.command` 有指向 `agumon-statusline/statusline-agumon-color.js`。
- **打 `vpet` 說找不到指令**：重開終端機；仍不行就照安裝時印的 PATH 指示加一下。
- **只裝了獨立視窗（`--daemon-only`），狀態列當然不會有桌寵** —— 那是預期行為。
  桌寵在 `vpet-standalone.bat` / `.sh` 開的視窗裡。想改回狀態列就重跑一次一般安裝。
- **桌寵停格不動（最常見，不是故障）**：Claude 分頁**閒置或沒 focus** 時（例如你切到別的分頁工作、或開了非 Claude 的分頁），Claude Code 會暫停 statusline 更新 → 桌寵看起來卡住。**回到 Claude 分頁、送一則訊息，或打 `vpet card`** 就會恢復。經常掛在別的分頁的人尤其容易遇到。
- **桌寵卡住、且上面互動了也不恢復**：先打 `vpet doctor` 清除卡死的背景行程（只想先看有沒有問題就 `vpet doctor --check`）。平時系統會自動清，這是手動補刀。
- **整個 statusline 完全凍住、doctor 也救不回**：到 `tools/agumon-doctor/` 資料夾雙擊 **`agumon-restart.bat`**（Windows）/ **`agumon-restart.command`**（macOS）強制重啟（會保留你的角色與進度），或執行 `node tools/agumon-doctor/restart.js`。仍要診斷就跑 `agumon-report`（見 `tools/agumon-doctor/`）把現況回報給開發者。
- **想移除**：雙擊 **`uninstall.bat`**（Windows）／ **`uninstall.command`**（macOS），
  或執行 `node scripts/uninstall.js`。你的桌寵存檔預設保留（加 `--purge` 才一併刪除）。
  **你自己的 statusline 設定不會被動到** —— 只會移除路徑指向 `agumon-statusline` 的項目。

祝養寵愉快 🦖
