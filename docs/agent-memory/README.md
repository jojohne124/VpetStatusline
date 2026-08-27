# Agent Memory — 跨機器共享設定

## 現在的做法（2026-08-27 起）

**活記憶就在這個 repo 裡** —— `.claude/memory/`。不再是手動快照。

家目錄那個 Claude Code 會讀的記憶目錄，做成**目錄連結**指過來：

```
~/.claude/projects/<slug>/memory   ──junction──▶   <repo>/.claude/memory
```

所以 Claude 存新記憶＝直接寫進 repo，`git commit` 就同步了，不會再漂掉。

> 之前是「複製快照到 docs/ 再 commit」，結果只同步了 3 個檔案就沒人記得再跑，
> README 還一直指著上一台機器的使用者名。手動同步撐不住，所以改成連結。

## 換一台機器要做什麼

### 1. clone

```
git clone https://github.com/jojohne124/VpetStatusline.git agumon-cli
```

### 2. 接上記憶（一次就好）

`<slug>` ＝ repo 的絕對路徑，把所有非英數字元換成 `-`。
例如 `C:/Users/王小明/agumon-cli` → `C--Users-王小明-agumon-cli`。

**Windows**（不需要系統管理員權限）：

```
mkdir "%USERPROFILE%\.claude\projects\<slug>"
mklink /J "%USERPROFILE%\.claude\projects\<slug>\memory" "<repo 絕對路徑>\.claude\memory"
```

**mac / Linux**：

```
mkdir -p ~/.claude/projects/<slug>
ln -s <repo 絕對路徑>/.claude/memory ~/.claude/projects/<slug>/memory
```

### 3. 從 repo 目錄啟動 claude

```
cd <repo>
claude
```

**這步不能省。** slug 取自 claude 的**啟動目錄**，不是 cwd —— 從家目錄啟動再 cd 進來，
記憶還是會落在家目錄那個 slug，等於沒接上。

## 什麼放哪裡

| | 位置 | 跟著 git？ |
|---|---|---|
| 本專案記憶 | `.claude/memory/` | ✅ |
| 本專案 skill | `.claude/skills/` | ✅ |
| 本專案指示 | `CLAUDE.md`（repo 根） | ✅ |
| 設計依據文件 | `docs/agent-memory/*.md` | ✅ |
| **通用偏好**（回話精簡、只用 log、commit 規則） | `~/.claude/CLAUDE.md` | ❌ 每台機器各自一份 |

通用偏好刻意不放 repo —— 它們是使用者偏好、跨所有專案，放家目錄才會在工作專案也生效。
新機器要自己補一份。

## 這個資料夾剩下什麼

- `evo-winrate-default.md` — 新角色的**預設進化門檻算法**（win% 由目標 power 決定）。
  這是設計依據，`src/shared/evo-rules.js` 的註解直接引用它，不是記憶。
- `project_vpet_statusline.md` — 2026-05-29 的舊快照，來自上一台機器（`C:\Users\jojoh\`）。
  內容大半已被 `.claude/memory/project_cc_statusline.md` 取代，留著當歷史。**可以刪。**
