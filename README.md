# agumon-cli

讓「彩色像素動畫角色」（亞古獸、加魯魯獸、哥吉拉、Majaja…）出現在 Claude CLI / Cursor CLI 的 statusline 右側。

- **左側**：模型 / ctx % / cwd / git / cost / rate-limit 進度條
- **右側**：16×16 像素角色，會走路、表情、大吼、睡覺、進化

> 詳細架構、設計決策、TODO 路線圖請見 [PROJECT.md](PROJECT.md)。

---

## 前置需求

- **Node.js 18+**
- **Claude Code** 已安裝（會自動把家目錄建在以下位置）：
  - Windows：`C:\Users\<you>\.claude\`
  - macOS / Linux：`~/.claude/`
- 支援平台：Windows、macOS、Linux（runtime 與 install script 全部用 `os.homedir()` + `__dirname`，自動跨平台）

## 安裝

```bash
git clone <repo-url>
cd agumon-cli
npm install
npm run install-runtime
```

`install-runtime` 會把所有東西部署到 **單一資料夾** `~/.claude/agumon-statusline/`：

```
~/.claude/agumon-statusline/
├── agumon-core.js
├── statusline-agumon-color.js
├── statusline-agumon.js
├── statusline-cheat.js
├── agumon-hook.js
├── agumon-art.json
├── assets/
│   ├── roster.json
│   ├── <name>/{art.json, config.json, bullet-art.json}
│   └── shared/{manifest.json, art.json}   ← 共用 sprite（encounter / boom …）
└── state/   (color-state / state / hook / force-char)
```

此外它會自動：

- 把舊版散落在 `~/.claude/` 的 state 檔遷移到 `agumon-statusline/state/`
- 清除舊版散落在 `~/.claude/` 的 runtime js 與 `agumon-assets/`
- 更新 `~/.claude/settings.json` 的 `statusLine.command` 與 `UserPromptSubmit` hook 路徑（**會備份原檔**到 `settings.json.before-agumon-statusline.bak`）
- 透過 `npm link` 把 `vpet` 指令註冊到全域（npm 自動處理 PATH，並在 Windows 產生 `vpet.cmd` / `vpet.ps1`）→ 重開終端後任何電腦都能直接用 `vpet`（見下方 [`vpet` 指令](#vpet-指令切角色--戰鬥--進化--pvp)）。`npm link` 不可用時自動退回複製薄殼到 `~/bin/`（需自行確保 `~/bin` 在 PATH）

**不會動到**：`state/` 內的任何使用者資料（即使重 install）、`settings.json` 內其他欄位。

之後若改了 `src/runtime/` 或 `characters/`，再跑 `npm run install-runtime` 即可同步。

## 解除安裝

```bash
npm run uninstall-runtime          # 保留 state/
npm run uninstall-runtime:purge    # 連 state 一起砍
```

預設只刪 runtime + assets，保留你的 state；加 `--purge` 連 state 一起清。
`settings.json` 永遠不會被刪，請自行移除 `statusLine.command` 與 `UserPromptSubmit` hook。

---

## 目錄結構

```
agumon-cli/
├── src/
│   ├── runtime/                ← 部署到 ~/.claude/ 的 Node 程式
│   │   ├── agumon-core.js          動畫狀態機 + 進化邏輯
│   │   ├── statusline-agumon-color.js   v7 主入口（彩色）
│   │   ├── statusline-agumon.js         v4 入口（黑白 braille）
│   │   ├── statusline-cheat.js          作弊碼：強制切角色
│   │   └── agumon-hook.js               UserPromptSubmit hook
│   ├── tools/
│   │   └── char-cli.js          製作工具（prepare / convert / deploy）
│   └── editor/
│       ├── sprite_editor_server.js   像素微調網頁（localhost:3000）
│       └── sprite_editor.html
├── characters/                  各角色資產（含原始 PNG + pixels + art + config + 子彈）
│   ├── roster.json
│   ├── Agumon/  Greymon/  ...  Majaja/
│   └── <Name>/{sprite.png 或 00_xxx.png, pixels.json, art.json, config.json, bullet-art.json}
├── shared/                      跨角色共用 sprite（encounter / boom）
│   ├── manifest.json            sprite 命名表
│   ├── sprites.json             pixel data
│   └── art.json                 half-block cell data
├── legacy/                      歷史檔（舊版 statusline、agumon 原始素材）
├── scripts/
│   ├── install.js / uninstall.js
│   ├── gen-shared-placeholders.js    重新產 shared sprite
│   ├── gen-bullet-placeholders.js    重新產所有角色子彈
│   ├── battle-preview.js             終端跑完 13 step 戰鬥分鏡
│   └── battle-stdin-test.js          模擬 Claude payload 跑一次 statusline
└── package.json
```

---

## 新增角色

### 1. 建立資料夾與來源圖

```
characters/<Name>/
├── sprite.png           ← strip / grid layout 用單張
│   或
├── 00_Idle_1.png        ← individual layout 用 12 張
├── 01_Idle_2.png
├── ...
└── 11_Attack.png
```

### 2. 寫 `config.json`

```json
{
  "name": "<name>",
  "layout": "individual",
  "frameCount": 12,
  "targetSize": 16,
  "frameNames": ["Idle_1","Idle_2","Eat_1","Eat_2","Sleep_1","Sleep_2","Refuse","Happy","Angry","Hurt","Sad","Attack"],
  "frames": { "IDLE_1": 0, "IDLE_2": 1, "EAT_1": 2, "EAT_2": 3,
              "SLEEP_1": 4, "SLEEP_2": 5, "REFUSE": 6, "HAPPY": 7,
              "ANGRY": 8, "HURT": 9, "SAD": 10, "ATTACK": 11 },
  "sleepFrames": [4, 5],
  "sleepPeriod": 2,
  "roarFrames": [11, 0, 11],
  "tokenResetFrames": [7, 0, 7],
  "exprs": [ {"frames":[2]}, {"frames":[8]} ],
  "evolvesTo": []
}
```

### 3. 跑製作管線

```bash
npm run char prepare <Name>      # sprite.png / individual PNG → pixels.json
npm run char build   <Name>      # pixels.json → art.json
# 或一次跑完：
npm run char process <Name>
```

### 4. 加入 roster 並部署

把 `<name>` 加進 `characters/roster.json`，再跑：

```bash
npm run install-runtime
```

### 5. 像素微調（可選）

```bash
npm run char edit <Name>
# 或直接
node src/editor/sprite_editor_server.js <Name>
```

打開 `http://localhost:3000`，編輯後存檔會自動：
1. 備份 `pixels.json` → `pixels.json.bak`
2. 重 build `art.json`
3. 部署到 `~/.claude/agumon-statusline/assets/<name>/`
4. 清 `~/.claude/agumon-statusline/state/color-state.json` 讓 statusline 下次 render 立即生效

---

## `vpet` 指令（切角色 / 戰鬥 / 進化 / PvP）

`npm run install-runtime` 會透過 `npm link` 把 `vpet` 註冊到全域（npm 把 shim 放進它在 PATH 上的 global bin，跨平台可攜，不需手動改 PATH）。重開終端後即可直接用 `vpet`，在 Claude Code 內用 `! vpet ...`。**指令可省略 `--`**（`vpet pvp` == `vpet --pvp`，舊寫法仍相容）。

```bash
# 角色
vpet <index|name>        # 切角色，例 vpet phoenixmon / vpet 33
vpet reset               # 隨機抽一個 starter
vpet evolve <next>       # 立即播進化表演
vpet freeze / unfreeze   # 凍結 / 解除自動進化（凍結時達標也不進化；手動 evolve 不受影響）

# 表演
vpet battle [enemy]      # 手動觸發戰鬥（13 秒分鏡，可加 win / lose 強制勝負）
vpet battle on / off     # 恢復 / 停用「prompt 後自動戰鬥」（手動觸發不受影響）
vpet card                # 顯示狀態卡 5 秒
vpet sleep / wake        # 強制睡覺 / 喚醒

# 幽靈對戰 PvP（非同步；需 host 先架 server，見 server/pvp/README.md）
vpet pvp-setup <url> <key> [name]   # 首次一鍵設定（server + 密鑰 + 名稱）
vpet pvp [code]          # 隨機同階對手 / 指名 friend code
vpet code [name]         # 查看 / 設定自己的 friend code 與顯示名稱
```

> `vpet` 只是 `~/.claude/agumon-statusline/statusline-cheat.js` 的薄殼。不想上 PATH 也可直接 `node ~/.claude/agumon-statusline/statusline-cheat.js <args>`。跑 `vpet`（無參數）會列出完整指令與角色清單。
> 完整作弊碼系統（強制進化/誕生）見 [PROJECT.md](PROJECT.md) §2 P1。

---

## 戰鬥表演（P1）

當 Claude 進入 **Thinking mode** 時自動觸發：偵測 `model.param_summary` 含 thinking 後，於下一個大吼結束時啟動 13 秒分鏡（encounter → 對峙 → 攻擊 + 子彈飛行 → 爆炸 → 勝/敗結果）。

- **寬度需求**：`render_width_chars >= status最長行 + 4 + 48`。不夠則跳過戰鬥當作沒事
- **每隻角色一張子彈**：`characters/<Name>/bullet-art.json`（敵方靠 `flipRows` 翻向左）
- **共用 sprite**：`shared/{encounter,boom}` 兩張置中
- **重做暫代圖**：`npm run gen-shared`（紅驚嘆號 + 黃橘星爆）、`npm run gen-bullets`（白球＋拖尾）

詳細時序表與場景座標見 [PROJECT.md §1.7](PROJECT.md)。

```bash
# 在終端直接看戰鬥（不用啟動 Claude）：
node scripts/battle-preview.js agumon godzilla_1999 --win
```

---

## 版本演進

- **v1–v3**：原始 PowerShell statusline（無動畫），保存在 [legacy/runtime/](legacy/runtime/)
- **v4**：黑白 braille 亞古獸（`src/runtime/statusline-agumon.js`）
- **v5**：第一版彩色 half-block
- **v7**：當前版。共用 [src/runtime/agumon-core.js](src/runtime/agumon-core.js) 狀態機，支援多角色、進化、作弊碼

---

## 疑難排解

| 問題 | 解法 |
|------|------|
| 角色沒換 / 改 source 沒生效 | 跑 `npm run install-runtime` 再 refresh 一次 CLI |
| 顏色亂掉 / 沒顏色 | PowerShell 視窗不支援 truecolor，請看 Claude CLI 內顯示 |
| 位置怪 / 飄走 | 看 §1.6「已知限制」於 [PROJECT.md](PROJECT.md) |
| 進化沒觸發 | 查 `~/.claude/agumon-statusline/state/color-state.json` 的 `_evoCostBase` 與目前 cost 差距 |
| 戰鬥沒觸發 | 終端寬度需 ≥ 110 cells；或用 `statusline-cheat.js --battle` 強制觸發測試 |
| 戰鬥卡住沒結束 | 刪掉 state 中的 `battleStartStep` 欄位、或重 install-runtime |
