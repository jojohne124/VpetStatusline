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
├── assets/  (roster.json + 各角色 art/config)
└── state/   (color-state / state / hook / force-char)
```

此外它會自動：

- 把舊版散落在 `~/.claude/` 的 state 檔遷移到 `agumon-statusline/state/`
- 清除舊版散落在 `~/.claude/` 的 runtime js 與 `agumon-assets/`
- 更新 `~/.claude/settings.json` 的 `statusLine.command` 與 `UserPromptSubmit` hook 路徑（**會備份原檔**到 `settings.json.before-agumon-statusline.bak`）

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
├── characters/                  各角色資產（含原始 PNG + pixels + art + config）
│   ├── roster.json
│   ├── Agumon/  Greymon/  ...  Majaja/
│   └── <Name>/{sprite.png 或 00_xxx.png, pixels.json, art.json, config.json}
├── shared/                      P1 預留：跨角色共用點陣（蛋、進化光效…）
├── legacy/                      歷史檔（舊版 statusline、agumon 原始素材）
├── scripts/
│   ├── install.js
│   └── uninstall.js
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

## 切換角色（作弊碼）

```bash
node ~/.claude/agumon-statusline/statusline-cheat.js <index>      # 用編號
node ~/.claude/agumon-statusline/statusline-cheat.js <name>       # 用名稱
node ~/.claude/agumon-statusline/statusline-cheat.js --reset      # 隨機抽 starter
```

> 完整作弊碼系統（強制戰鬥/進化/誕生）見 [PROJECT.md](PROJECT.md) §2 P1。

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
| 進化沒觸發 | 查 `~/.claude/agumon-color-state.json` 的 `_evoCostBase` 與目前 cost 差距 |
