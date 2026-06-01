# 幽靈對戰 PvP server（Cloudflare Worker + KV）

純笨儲存：只存/取「戰鬥卡」，勝負由 client 端決定性計算。`--battle`（本機同階隨機）不受影響，幽靈對戰走獨立的 `--pvp` 指令。

對戰流程：上傳我的卡 → 抓對手卡（隨機同階 / 指名 friend code）→ 本機戰力加權算勝負 → 寫進跟 `--battle` 一樣的 force 欄位 → statusline 照原本流程演出。**核心 / statusline 零改動、無 daemon。**

---

## 上手流程

分兩種角色。整個朋友圈只要**一個人當 host** 架一次 server；其他人都是 player。

### 角色 A — Host（整圈一人做一次）

部署 worker，拿到網址 + 密鑰，分享給朋友。在 `server/pvp/` 目錄下（互動式步驟請用 `! npx ...` 在終端自己跑）：

```bash
npx wrangler login                       # 開瀏覽器登入
npx wrangler kv namespace create CARDS   # 把回傳的 id 貼進 wrangler.toml 的 id =
npx wrangler secret put PVP_KEY          # 設一串夠長的共用密鑰（入場券）
npx wrangler deploy                      # 得到 https://vpet-pvp.<account>.workers.dev
```

把 **網址** 和 **PVP_KEY** 私下給朋友——這兩個就是入場券。

### 角色 B — Player（每個第一次要 PvP 的人）

**前提**：已裝好 vpet statusline（`ac` 指令可用）。沒裝先 `npm run install-runtime`。

一鍵設定（一次性）：

```bash
ac --pvp-setup <host給的網址> <host給的PVP_KEY> [你的名字]
#   會設好 server + 密鑰，自動產生 6 碼 friend code，並印出來
```

開打：

```bash
ac --pvp           # 隨機同階對手
ac --pvp <code>    # 指名朋友（用對方的 friend code）
ac --code          # 查看自己的 friend code / 名稱 / server
ac --code <name>   # 改顯示名稱
```

---

## 注意事項

- **friend code**：跑 `--pvp-setup`（或 `--code`）時自動產生，存在本機 `state/pvp.json`。用 `ac --code` 查、貼給朋友讓他指名你。
- **第一個人沒對手**：你的卡是在**第一次 `ac --pvp` 才上傳**到 server。最早加入的人跑隨機會拿到 `no_opponent`，要等有第二個人註冊過才配得到；指名也一樣，對方至少 `ac --pvp` 過一次他的卡才存在。
- **角色資產要一致**：對手用的角色你本機也要有資產才能演出。大家用同一套 `install-runtime` 的標準角色就沒事；客製角色（別人沒裝）對到會出現「本機沒有資產」。
- **密鑰必須帶**：worker 設了 PVP_KEY 時，沒帶密鑰的請求會被擋 403，所以網址 + 密鑰要一起給。

---

## 進階 / 本機測試

只設後端（不走一鍵）：

```bash
ac --pvp-server <url> [key]
```

部署前本機驗證真 worker：

```bash
npx wrangler dev --local --port 8787      # 本機 KV，未設 PVP_KEY 時略過認證
ac --pvp-server http://127.0.0.1:8787
ac --pvp
```

---

## API

| Method | Path | 說明 |
|---|---|---|
| PUT | `/card/:code` | 上傳/更新我的卡（body = card JSON），TTL 30 天 |
| GET | `/card/:code` | 指名取卡，找不到回 404 `not_found` |
| GET | `/random?stage=&exclude=` | 隨機取一張同階卡（排除自己），無對手回 404 `no_opponent` |

所有請求需帶 `X-Pvp-Key`（若 server 有設 PVP_KEY）。

卡片格式：`{ code, name, character, power, train, stage, ts }`
