# Agumon CLI — 專案紀錄（交接 / 追蹤文件）

> 用途：紀錄專案當前的完整規格、設計決策、待辦清單。
> 與 `README.md` 的差異：README 是「使用者怎麼用」，本檔是「日後維護者要看什麼」。
>
> 最後更新：2026-05-12（P0 完成 + 方案 A 統一資料夾）

---

## 0. TL;DR

讓「彩色像素動畫角色」出現在 Claude CLI / Cursor CLI 的 statusline 右側。

- **左側**：模型 / 用量 / ctx % / cwd / git branch / cost / rate-limit 進度條
- **右側**：16×16 半角彩色像素角色，會走路、表情、大吼、睡覺、進化
- **動畫驅動**：statusline 一次性執行 → 用 `Date.now()` 算步數 + 狀態檔保存

---

## 1. 目前架構規格

### 1.1 目錄結構（P0 後）

```
agumon-cli/                              ← Git 管理範圍
├── src/
│   ├── runtime/                         ← 由 install.js 部署到 ~/.claude/
│   │   ├── agumon-core.js               ← 核心狀態機（v7 共用）
│   │   ├── statusline-agumon-color.js   ← v7 主入口（彩色 half-block）
│   │   ├── statusline-agumon.js         ← v4 入口（黑白 braille）
│   │   ├── statusline-cheat.js          ← 切角色作弊碼（P1 會擴充）
│   │   └── agumon-hook.js               ← UserPromptSubmit hook
│   ├── tools/
│   │   └── char-cli.js                  ← 統一工具 CLI（prepare/convert/deploy）
│   └── editor/
│       ├── sprite_editor_server.js      ← 像素微調 web server
│       └── sprite_editor.html
├── characters/                          ← 角色資產（含原始素材＋中間產物＋成品）
│   ├── roster.json                      ← source of truth：角色清單 + starters
│   └── <Name>/                          ← PascalCase 資料夾名
│       ├── sprite.png 或 00_xxx.png …   ← 來源圖（strip / grid / individual）
│       ├── pixels.json                  ← 16×16 RGB 中間檔（編輯器存檔）
│       ├── art.json                     ← half-block cell 終端可渲染檔
│       └── config.json                  ← 幀定義 / 進化規則 / layout
├── shared/                              ← P1 預留：跨角色共用點陣
├── legacy/                              ← 歷史檔（不再使用但保留）
│   ├── runtime/                         ← 舊版 statusline 與切換工具
│   │   └── statusline{.js,.ps1,-noborder.js,-compact.js,-oneline.js,-switch.js,-command.sh}
│   └── agumon-source/                   ← 舊單檔工具 + agumon 的原始素材 + 打包檔
│       ├── prepare_frames{,_color}.js
│       ├── convert_to_{braille,color}.js
│       ├── animate_agumon.js
│       ├── agumon_{pixel,art}{,_color}{.png,.json,.bak}
│       └── packaged/  *.rar  *.zip
├── scripts/
│   ├── install.js                       ← 部署 runtime → ~/.claude/
│   └── uninstall.js                     ← 反向操作
├── package.json                         ← npm run install-runtime / uninstall-runtime / char / editor
├── .gitignore
├── README.md                            ← 使用者文件
└── PROJECT.md                           ← 本檔（維護者文件）

~/.claude/                               ← Claude CLI 家目錄（我們只占一個子資料夾）
├── agumon-statusline/                   ← ★ 本專案的東西全部在這
│   ├── agumon-core.js
│   ├── statusline-agumon-color.js
│   ├── statusline-agumon.js
│   ├── statusline-cheat.js
│   ├── agumon-hook.js
│   ├── agumon-art.json                  ← v4 黑白 art
│   ├── assets/
│   │   ├── roster.json
│   │   └── <name>/{art.json, config.json}
│   └── state/                           ← 使用者資料（install 只新建不覆蓋）
│       ├── color-state.json
│       ├── state.json
│       ├── hook.json
│       └── force-char.json
├── settings.json                        ← Claude 自己的設定（install 會更新兩條路徑 + 備份）
└── (其餘 Claude CLI 自己的 sessions/ cache/ skills/ hooks/ …)
```

### 1.2 製作工具鏈（`char-cli.js`）

統一指令：

| 指令 | 功能 | 輸入 | 輸出 |
|------|------|------|------|
| `node char-cli.js prepare <Name>` | 圖 → 像素資料 | `sprite.png` 或 `00_Xxx.png` | `pixels.json` |
| `node char-cli.js convert <Name>` | 像素 → 終端 cells | `pixels.json` | `art.json` |
| `node char-cli.js deploy <Name>` | 部署 | `art.json` + `config.json` | 複製到 `~/.claude/agumon-assets/<name>/` |

支援三種 layout（`config.json` 的 `layout` 欄位）：

- `strip`：所有幀水平排成一條（agumon 舊格式，用粉紅分隔欄自動切幀）
- `grid`：3 × N 格子排列
- `individual`：每幀一個獨立 PNG（命名 `00_Idle_1.png` … `11_Attack.png`），**Majaja 採用此格式**

關鍵 config 欄位：

```jsonc
{
  "name": "agumon",
  "layout": "individual",         // 或 "strip" / "grid"
  "frameCount": 12,
  "targetSize": 16,               // 縮放到 16×16
  "directSample": false,          // true = 不做 palette snap
  "paletteSize": 20,              // palette 量化色數
  "transparentColor": [255,0,255],// 指定透明色（可選）
  "frameNames": ["Idle_1",...,"Attack"],
  "frames": { "IDLE_1": 0, "IDLE_2": 1, ... },
  "sleepFrames": [4, 5],
  "sleepPeriod": 2,
  "roarFrames": [11, 0, 11],
  "tokenResetFrames": [7, 0, 7],
  "exprs": [{"frames":[2]}, {"frames":[8]}],
  "evolvesTo": [
    { "character": "greymon",
      "conditions": [{"type":"cost_threshold","usd":10}],
      "operator": "and" }
  ]
}
```

### 1.3 Runtime 狀態機（`agumon-core.js`）

#### 1.3.1 動畫優先順序（高 → 低）

1. **大吼（ROAR）**：`agumon-hook.json` 時間戳更新時觸發。`roarFrames` 動畫，期間繼續走（不凍結位置）
2. **Token 重置 happy**：偵測到 `rate_limits.five_hour.resets_at` 跨過舊值時觸發。`tokenResetFrames` 動畫
3. **睡覺**：閒置超過 `IDLE_MS`（10 分鐘）後播 `sleepFrames`，位置凍結在最後位置
4. **表情**：每秒 10% 機率觸發 `exprs` 之一（位置在觸發秒凍結，避免滑動）
5. **走路**：三角波，週期 `MAX_POS * 2 = 40`，左右擺盪
6. **進化檢查**：每次 render 結束時跑 `checkEvolution`，達成條件就切換 `characterId`

#### 1.3.2 進化條件類型

| type | 行為 |
|------|------|
| `cost_threshold` | `cost.total_cost_usd` 比 `_evoCostBase` 多了 N 美金後 ready |
| `r5h_peak` | 五小時用量達 threshold（預設 95%）後又跨過 reset 即 ready |

支援多條件 + `operator: "and"`/`"or"`。

#### 1.3.3 狀態檔 `agumon-color-state.json`

```jsonc
{
  "characterId": "majaja",      // 目前角色
  "_evoCostBase": 50.10,         // 進化用 cost 基準
  "lastHookTs": 1778583047701,   // 上次大吼觸發
  "lastActivityAt": 1778583047907,
  "_r5hResetAt": 1778590800,
  "lastStepSeen": 1778583156,
  "lastWalkFrame": 1,
  "lastPos": 6,
  "lastFacing": "left",
  "exprStartStep": -1,
  "exprIdx": 0,
  "roarStartStep": -1,
  "happyStartStep": -1
}
```

#### 1.3.4 作弊碼

`agumon-force-char.json`：

```json
{ "character": "majaja", "resetCostBase": true }
```

寫入後，statusline 下次 render 會強制切換角色並清相關 state。

### 1.4 渲染管線（`statusline-agumon-color.js`）

```
stdin (Claude payload JSON)
  ↓
loadState → 套用 force-char → loadCharacter(id)
  ↓
decideAgumon() 決定 frameIdx / facing / pos
  ↓
checkEvolution() 看要不要換角色
  ↓
saveState
  ↓
buildStatusLines(i) → 三行狀態列文字
讀 art.json → renderCells(rows) → ANSI 字串
  ↓
composeOutput(status, agumon, aguCol) → 左右拼接 → stdout
```

### 1.5 角色名冊（`roster.json`）

```
starters:  agumon, gabumon
evolution: agumon → greymon → metalgreymon → wargreymon → g-wargreymon
           gabumon → garurumon → weregarurumon → metalgarurumon
standalone: godzilla_1999, soulseer_mizutsune, majaja
```

### 1.6 已知限制

- statusline 是「一次性執行」，不能 `setInterval`，動畫粒度受 `refreshInterval` 限制（目前設 1 秒）
- Claude CLI 子程序拿不到真實 terminal 寬度 → 採「錨定左側資訊右方」策略，不靠右對齊
- v4 (braille 黑白) 與 v5/v7 (彩色 half-block) **共存但路徑分離**，v4 沒接 `agumon-core.js`

---

## 2. TODO 清單

> 狀態：⬜ 未開始　🟡 進行中　✅ 完成
> 優先序：以 P0 / P1 / P2 標示

### P0 — v7 獨立化 + 上 Git ✅（2026-05-12 完成）

- ✅ **將 v7 runtime 獨立到專案內**
  - `~/.claude/agumon-core.js`、`statusline-agumon-color.js`、`statusline-agumon.js`、`statusline-cheat.js`、`agumon-hook.js` 已搬進 `src/runtime/`
  - `~/.claude/agumon-assets/` 改用 `scripts/install.js` 部署機制（copy install 策略）
  - 散落在 `~/.claude/` 的歷史檔（`statusline.js/.ps1`、`-noborder`、`-compact`、`-oneline`、`-switch`、`-command.sh`、`cc-statusline-rows.json`）已搬到 `legacy/runtime/`
- ✅ **目錄結構整理**（見 §1.1）
- ✅ **install / uninstall 指令**
  - `npm run install-runtime` → `scripts/install.js`
  - `npm run uninstall-runtime` → `scripts/uninstall.js`
- ✅ **`.gitignore`** 已建立，含 legacy/ 例外規則
- ✅ **README 與 PROJECT.md 更新**
- ✅ **v4 路徑修正**：`statusline-agumon.js` 改讀 `~/.claude/agumon-art.json`（install 從 legacy 複過去）

### P1 — 新增表演（Performance Animations）

> 統一規格：在 `agumon-core.js` 增加「performance」優先層，介於「大吼」與「token reset happy」之間（或更高，視類型）。
> 每個表演有 `frames`、`hold`（偶數）、觸發條件、是否凍結位置。

- ⬜ **a. 戰鬥（Battle）**
  - 觸發：手動作弊碼 / 工具使用次數累計（待定）
  - 建議幀組合：`ATTACK → IDLE_1 → ATTACK → IDLE_2 → ATTACK`
  - 凍結位置：是
- ⬜ **b. 進化（Evolution）**
  - 觸發：`checkEvolution` 命中後、切換 `characterId` **之前**先播一段表演
  - 建議：白光閃爍 + 縮放 → 切角色 → 落地姿勢
  - 跨角色：表演期間需要同時保留「舊角色幀」與「特效幀」，可考慮 shared art（見 P1 第 3 項）
  - **重要**：state 需新增 `evoStartStep`、`evoNextCharId`、`evoStage`
- ⬜ **c. 誕生（Reset / Birth）**
  - 觸發：偵測到 state file 不存在 / `characterId` 第一次出現（含進化後落地）
  - 建議：蛋 → 裂痕 → 破殼 → 第一個 Idle
  - **依賴**：需要共用的「蛋」「光效」幀（→ 推 P1 第 3 項先做）
- ⬜ **d. 想到隨時補充**
  - 預留：勝利、生病、升等、節日特效…
  - 在 `config.json` 增加 `performances: { battle: {...}, evolution: {...}, birth: {...} }` 區塊
  - 在 `agumon-core.js` 寫一個通用 `decidePerformance(name, st, step)` 函式

### P1 — 共用點陣資源

- ⬜ **新增 `shared/` 目錄存共用 art**
  - 結構：`shared/{art.json, pixels.json, frames/}`
  - 內容（初步）：
    - 蛋（egg）/ 蛋殼破裂幾幀
    - 進化白光 / 閃光圈
    - 戰鬥火花 / 衝擊波
    - 通用睡眠泡泡 Z
    - 通用情緒符號（汗滴、愛心、驚訝符號）
  - `agumon-core.js` 增加 `loadSharedArt()`，角色 frame 不夠時 fallback 到 shared
  - `config.json` 用特殊索引引用，如 `"frames": { "EVO_FLASH": "shared:evo_flash_0" }`

### P1 — 完整作弊碼系統

- ⬜ **擴充 `agumon-force-char.json` schema**
  ```jsonc
  {
    "character": "greymon",     // 已有
    "resetCostBase": true,       // 已有
    "force": {
      "battle": true,            // 強制播戰鬥表演一次
      "evolve": "metalgreymon",  // 強制進化到指定角色（跑進化表演）
      "birth": true,             // 強制播誕生表演
      "expression": "ANGRY"      // 強制特定表情持續到下次清除
    },
    "ttl": 5                     // 自動清除秒數（可選）
  }
  ```
- ⬜ **CLI 子命令**
  - `node char-cli.js cheat battle`
  - `node char-cli.js cheat evolve <next>`
  - `node char-cli.js cheat birth`
  - `node char-cli.js cheat reset`（清 state，回到 starter）
  - `node char-cli.js cheat switch <name>`（=目前 force-char）
- ⬜ **statusline 端處理**
  - 讀完 force 後依類別 dispatch 到對應表演層
  - 一次性表演：播完即刪 force 檔
  - 持續性（如表情）：保留直到 TTL 到期

### P2 — 後續改善（雜項）

- ⬜ 補齊每隻角色的 `config.json`（目前 majaja `evolvesTo: []`，可補相剋 / 平行進化）
- ⬜ 為 `statusline-agumon.js`（v4 黑白版）決定：併入 v7 統一架構 or 廢棄
- ⬜ 加入單元測試（至少 `decideAgumon`、`checkEvolution` 的純函式部分）
- ⬜ `sprite_editor` 支援編輯共用 shared art
- ⬜ 寫 `CHANGELOG.md`，每次發版註記
- ⬜ GitHub Actions：lint + 跑 prepare/convert 驗證所有 character 都能正確產出 art.json

---

## 3. 設計決策備忘（Design Notes）

- **為何不用 setInterval？** statusline 是 Claude CLI 一次性 spawn 的子程序，無法常駐 → 改用 `Date.now() / STEP_MS` 算步數 + state file。
- **為何 hold 必須偶數？** 走路幀依 `step % 2` 奇偶切換，動畫結束時若 hold 是奇數會造成幀跳一格。`evenHold()` 自動補。
- **為何不靠右對齊？** Claude CLI 子程序拿到的 `render_width_chars` 不可靠 → 改用「左側狀態列最長行 + ANCHOR_GAP + pos」錨定。
- **為何分 `pixels.json` 與 `art.json`？** pixels 是中間檔（編輯器要存的格式），art 是終端要 render 的格式。分離讓 `sprite_editor` 改 pixels 後自動 regen art。
- **為何用 half-block？** 一個字元高度可塞兩個像素（上/下各一），同時上下色獨立 → 16×16 角色只占 8 行終端高度。

---

## 4. 路徑常數（方案 A 後已實作）

| 用途 | Source（repo） | Runtime（部署後） | install 動作 |
|------|----------------|---------------------|--------------|
| Runtime 程式 | `src/runtime/*.js` | `~/.claude/agumon-statusline/*.js` | copy |
| Character 資產 | `characters/<Name>/{art,config}.json` | `~/.claude/agumon-statusline/assets/<name>/` | copy + 小寫化 |
| Roster | `characters/roster.json` | `~/.claude/agumon-statusline/assets/roster.json` | copy |
| v4 黑白 art | `legacy/agumon-source/agumon_art.json` | `~/.claude/agumon-statusline/agumon-art.json` | copy |
| 共用資產（P1） | `shared/` | `~/.claude/agumon-statusline/shared/`（未定） | （P1 規劃） |
| color-state | — | `~/.claude/agumon-statusline/state/color-state.json` | **不動**（runtime 寫入）；舊版會自動遷移 |
| state（v4） | — | `~/.claude/agumon-statusline/state/state.json` | **不動**；舊版會自動遷移 |
| hook 寫入 | — | `~/.claude/agumon-statusline/state/hook.json` | **不動**；舊版會自動遷移 |
| force 檔（作弊碼） | — | `~/.claude/agumon-statusline/state/force-char.json` | **不動**；舊版會自動遷移 |
| Claude 設定 | — | `~/.claude/settings.json` | **自動更新** `statusLine.command` 與 hook 路徑，備份到 `.before-agumon-statusline.bak` |

### 程式內如何取得路徑

所有 runtime js 都用 `__dirname` 推導：

```js
const INSTALL_ROOT = __dirname;                          // ~/.claude/agumon-statusline/
const STATE_DIR    = path.join(INSTALL_ROOT, 'state');
const ASSETS_DIR   = path.join(INSTALL_ROOT, 'assets');
```

這代表 runtime 是「位置無關」的 — 把整個 `agumon-statusline/` 資料夾搬到任何地方，只要 `settings.json` 對應更新，就能跑。

---

## 5. 變更紀錄

- **2026-05-12**：建立本文件；目前 active 角色 = `majaja`（force 中），整體架構為 v7。
- **2026-05-12（P0 完成）**：
  - v7 runtime 與工具搬入 `src/runtime/`、`src/tools/`、`src/editor/`
  - 舊版檔搬入 `legacy/runtime/`、`legacy/agumon-source/`
  - 新增 `scripts/install.js` / `scripts/uninstall.js`、`npm run install-runtime` / `uninstall-runtime`
  - `characters/roster.json` 成為 source of truth
  - `statusline-agumon.js`（v4）改讀 `~/.claude/agumon-art.json`，不再硬編碼 repo 路徑
  - `.gitignore` 建立、`package.json` 升 `v2.0.0`
- **2026-05-12（方案 A：統一資料夾）**：
  - Runtime + assets + state 全部集中到 `~/.claude/agumon-statusline/`
  - 所有 runtime js 改用 `__dirname` 推導路徑，runtime 位置無關
  - `install.js` 增加：舊版散落檔自動遷移、`settings.json` 自動更新（含備份）、舊 `~/.claude/agumon-*.js` 與 `agumon-assets/` 自動清除
  - `uninstall.js` 重寫，支援 `--purge` 連 state 一起刪
  - `package.json` 加 `uninstall-runtime:purge` script
