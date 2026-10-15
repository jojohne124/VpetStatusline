# vpet（agumon-cli）— 專案指示

Claude Code 桌寵：statusline 或獨立視窗裡的 16×16 像素角色，會走動、進化、對戰。
使用者指南 `GUIDE.md`、維護紀錄 `PROJECT.md`、規格 `docs/`。

## 這個 repo 是跨機共享的來源

`.claude/` 底下的東西**跟著 git 走**，不要改到家目錄那份：

| 路徑 | 內容 |
|---|---|
| `.claude/memory/` | 本專案的記憶（家目錄的 memory 是 junction 指到這裡） |
| `.claude/skills/` | 本專案的 skill（`vpet-add-character`） |
| `docs/agent-memory/` | 設計依據文件（不是記憶） |

換機器要做的一次性設定見 `docs/agent-memory/README.md`。
通用偏好（回話精簡、只用 log、commit 規則）在 `~/.claude/CLAUDE.md`，不在這裡。

## 狀態列的 vpet 暫停中（2026-10-15）

重心放在 **daemon 版**（獨立視窗），之後找機會再移植到 mod。**statusline 本身照常**（狀態文字），
只有右側的 vpet **只擋不刪**：

- 開關只有一個：`agumon-core.js` 的 `STATUSLINE_PET_PAUSED = true`。
- `statusline-agumon-color.js` 入口看到它就只輸出狀態文字，不讀不寫桌寵的 state（全交給 daemon）。
- `vpet hide / show` 擋掉、help 不列；GUIDE 的「讓桌寵住進狀態列」附錄用註解藏起來。
- 安裝流程不變（statusline 版的人照樣裝 statusLine、hook）。新功能不必再顧狀態列那一側的畫面。
- 恢復：開關改 false、拿掉 GUIDE 附錄的註解。

## 兩份 code，改了要同步

`~/.claude/agumon-statusline/` 是**實際跑的安裝版，也是權威版本**。
repo 的 `src/runtime/` 是來源，`npm run install-runtime` 會把 repo 蓋過去。

- 直接改安裝版 → 記得反向同步回 `src/runtime/`，否則下次 install 會被吃掉。
- 改了 `src/runtime/agumon-core.js` → **先 `npm run install-runtime` 再跑測試**。
  `test-plaza` / `test-ranch` 載入的是安裝版，不然你測到的是舊程式（踩過）。

## 測試

`npm test` —— 12 支，全綠才算完成。新增修正時一併補測試，並且**驗證它在還原修正後會紅**；
只看它綠沒有意義（這個專案抓過 7 條假綠斷言）。

## 平台

Windows 為主。`.bat` **只能 ASCII** —— 放中文會被 cmd 依 Big5 誤解析，雙擊直接閃退。

## 加角色

跑 `node scripts/add-character.js <資料夾名> --check`，不要自己重寫網格偵測。
完整流程見 skill `vpet-add-character`。
