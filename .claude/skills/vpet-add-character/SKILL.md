---
name: vpet-add-character
description: 在 agumon-cli（vpet 桌寵）加一隻新角色 —— 點陣圖轉檔、config、實裝、部署。使用者提供角色 PNG 或說「加一隻新角色 / 轉換點陣 / 這隻圖進去」時使用。
---

# 加一隻 vpet 新角色

## 先跑偵測，不要自己重寫檢查

```bash
node scripts/add-character.js <資料夾名> --check
```

`characters/<Name>/` 底下放好 PNG 就能跑。它會回報版面、一格幾像素、**邏輯網格**、
CutIn 尺寸、重複幀，什麼都不寫。

**不要自己臨時寫區塊掃描去猜網格。** 那段已經在腳本裡，而且有測試
（`scripts/test-add-character.js`）。每次重寫一次就多一次寫錯的機會。

## 正式轉

```bash
node scripts/add-character.js <Name> --power 50                    # 產 config + 轉檔 + 部署
node scripts/add-character.js <Name> --power 50 --bullet Agumon    # 子彈借別人的
node scripts/add-character.js <Name> --power 50 --implant          # 順便實裝
```

轉完會**逐點比對 art.json 與原圖**，不符必須是 0 點。有差就是網格或取樣偏了，
腳本會擋下來不讓部署 —— 那種錯看縮圖幾乎看不出來。

## 要問使用者的，不要自己決定

腳本刻意不猜這些：

- **power**（決定階段、戰力上限、敵人配對）
- **要不要 `--implant`** —— 進 roster 才會被玩家遇到、才會算進圖鑑分母
- **進化鏈** —— 一律留空，之後用進化路線編輯器接
  （`node src/editor/route_editor_server.js`，port 3001）
- 子彈要借誰，還是先用暫代白球

## 這個專案的坑

- **邏輯網格 ≠ 實體尺寸。** PNG 多大都無所謂，格子數必須等於 `targetSize`（16）。
  48×48（一格 3×3）和 256×256（一格 16×16）都是合法的 16×16。
- **`~/.claude/agumon-statusline/` 那份才是 runtime 真理。** repo 改完要同步過去
  （腳本預設會做，`--no-deploy` 可關）。反過來也一樣：只改 installed 會被下次 install 蓋掉。
- **不要把東西加進 `characters/roster.json` 以外的地方當設定。**
  進化路線編輯器存檔時會整份重寫 roster.json，只保留
  `roster` / `starters` / `starterWeights` / `highTierStarters`，其他 key 會被無聲刪掉。
  規則型資料放 `characters/special-evolutions.json`。
- **roster 成員一律要有 `bullet-art.json` + `cutin-art.json`。** 缺 cutin 會退回 v1 戰鬥分鏡。
- **重複幀 = 那個動作不會動。** 腳本會列出來，看到就回報使用者（例如
  「Sleep_1 = Sleep_2 表示睡覺沒有呼吸動畫」），由他決定要不要補圖。
- **`scripts/gen-new-char-scaffold.js` 不要跑。** 那是 2026 年那批 63 隻的一次性腳本，
  會覆寫 63 個 config.json 連同已接好的 evolvesTo。現在要 `--yes` 才會動，但最好別碰。
- 只改**一幀**用 `node reimport-frame.js`（在 repo 根目錄，不在 scripts/），不要跑整包 process（會覆蓋手調過的其他幀）。

## 收尾

```bash
npm test                  # 全套
git status                # 確認只動到預期的檔案
```

commit 等使用者說了才做，訊息用繁體中文。
