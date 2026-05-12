## Agumon CLI Statusline Pack（可分享版）

此資料夾是「**可打包分享給別人**」的整理版本，**不會動到你原本專案根目錄的任何檔案**。

你會得到兩個 part：

- **`tooling/`**：產圖工具 + 像素編輯器（用來生成/微調資產）
- **`product/`**：成品（Claude CLI statusline：黑白 / 彩色）+ 一鍵安裝腳本

> 成品只保留 **黑白（v4）**與**彩色（v5）**兩版，不再提供 v1~v3 切換。

---

## 1) Product（成品）— 安裝給使用者

### 1.1 先決條件

- 安裝 Node.js（建議 18+）
- Claude CLI 已可使用（並可讀取 `~/.claude/settings.json`）

### 1.2 一鍵安裝（Windows）

在 PowerShell 進入本資料夾後執行：

```powershell
cd C:\path\to\agumon-cli\packaged\product
.\install.ps1
```

安裝後會放到：

- `C:\Users\<你>\.claude\agumon-core.js`
- `C:\Users\<你>\.claude\statusline-agumon-bw.js`
- `C:\Users\<你>\.claude\statusline-agumon-color.js`
- `C:\Users\<你>\.claude\agumon-hook.js`
- `C:\Users\<你>\.claude\agumon-assets\agumon_art.json`
- `C:\Users\<你>\.claude\agumon-assets\agumon_art_color.json`

並自動更新 `C:\Users\<你>\.claude\settings.json`：

- `statusLine.command` 指向彩色版（預設）
- `statusLine.refreshInterval` 設為 1（若已存在則保留）
- 註冊 `hooks.UserPromptSubmit` → `agumon-hook.js`（若已有 hooks，會合併）

### 1.3 切換黑白/彩色

安裝後你只要改 `settings.json` 的 `statusLine.command`：

- 黑白：
  - `node C:/Users/<你>/.claude/statusline-agumon-bw.js`
- 彩色：
  - `node C:/Users/<你>/.claude/statusline-agumon-color.js`

---

## 2) Tooling（製作工具）— 產生/微調資產

### 2.1 安裝依賴

```bash
cd packaged/tooling
npm install
```

### 2.2 放入原圖

把原圖放到 `packaged/tooling/input/`：

- 黑白：`agumon_pixel.png`
- 彩色：`agumon_pixel_color.png`

### 2.3 生成資產（輸出到 `packaged/assets/`）

```bash
# 黑白資產（輸出 agumon_art.json）
node bw_prepare_frames.js
node bw_convert_to_braille.js

# 彩色資產（輸出 agumon_art_color.json）
node color_prepare_frames.js
node color_convert_to_cells.js
```

### 2.4 啟動像素編輯器（微調彩色）

```bash
node sprite_editor_server.js
```

打開瀏覽器 `http://localhost:3000`，儲存後會自動重新產生 `packaged/assets/agumon_art_color.json`。

> 編輯器只改 `packaged/assets/agumon_pixels_color.json`（並自動轉成 `agumon_art_color.json`），**不會改到你原本專案根目錄的 JSON**。

---

## 3) 目錄結構

```
packaged/
  README.md
  assets/
    agumon_art.json
    agumon_art_color.json
    agumon_pixels.json
    agumon_pixels_color.json
  tooling/
    package.json
    input/
      (放原圖 png)
    bw_prepare_frames.js
    bw_convert_to_braille.js
    color_prepare_frames.js
    color_convert_to_cells.js
    sprite_editor_server.js
    sprite_editor.html
  product/
    install.ps1
    agumon-core.js
    statusline-agumon-bw.js
    statusline-agumon-color.js
    agumon-hook.js
```

