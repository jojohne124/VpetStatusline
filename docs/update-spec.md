# release 自動更新 規格

> 2026-10-08 定案。程式：`src/daemon/supervisor.js`（外殼）、`src/daemon/updater.js`（檢查＋安裝）、
> `src/shared/update-bundle.js`（打包／簽章）、`src/shared/update-key.js`（公鑰）、
> `src/daemon/plaza-server.js`（`/update/*` 發包）、`scripts/publish-release.js`（產包）、
> `scripts/gen-release-key.js`（產金鑰）。測試：`scripts/test-update.js`、`test-release-build`。

## 一、流程

```
發版機器（plaza-host 那台）            同事的電腦
npm run publish-release
  ├─ build → push GitHub release
  └─ 打包 + 簽章 → dist/update/
        manifest.json / bundle.bin
plaza-host ── GET /update/manifest ──→ daemon 啟動時（supervisor → updater）
           ── GET /update/bundle   ──→   版本不同 → 下載 → 驗章 → 寫檔 → install → 起新 daemon
```

- **不用 git**：同事的 release 資料夾被直接覆寫，GitHub release 分支只當備份／初次安裝。
- **觸發時機**：每次啟動 daemon（tray／.bat／開機），以及頁面上的「🆕 有新版本」鈕（= 重開 daemon）。
  daemon 啟動 5 秒後、之後每 30 分鐘問一次有沒有新版，有才亮鈕。
- **版本**：release 樹根目錄的 `VERSION`（publish 時寫 main 的 short hash）。跟伺服器的不同就更新
  （不比大小：伺服器說了算，要退版就發舊的）。

## 二、外殼（supervisor）

- release 樹（根目錄有 `RELEASE`）的 `daemon.js` 一開頭就交給 supervisor；開發樹照舊直接跑。
- supervisor：同步跑 updater → 起子行程（`VPET_CHILD=1`）跑真正的 daemon → 子行程結束碼 75 ＝要重開，
  回到第一步；其他結束碼 → 跟著結束。
- 為什麼要外殼：tray 盯的是啟動時那個 PID，換 PID 會以為 daemon 掛了把圖示收掉。外殼 PID 不變。
- 子行程每 2 秒確認外殼還在，外殼被砍就自己結束（Windows 上系統也會連帶結束；mac／Linux 只能靠這個）。

## 三、安全

- Ed25519 簽章。私鑰只在發版機器 `~/.vpet/release-key.pem`（不進 repo、不出貨；`test-release-build` 會擋 `.pem`）。
  公鑰 `src/shared/update-key.js` 跟著 release 出貨。
- daemon 驗：大小、sha256、簽章；包裡的版本要跟 manifest 一致；路徑不能是絕對路徑或含 `..`。
  任何一項不對 → 一個檔都不寫。
- 伺服器本身不用被信任（只負責原樣送檔）：區網裡有人冒充廣場伺服器，也簽不出合法的包。
- **私鑰弄丟／外流**：重跑 `gen-release-key.js --force` 換一組，所有人要手動更新一次（舊版只認舊公鑰）。

## 四、失敗處理

| 狀況 | 結果 |
|---|---|
| plaza-host 沒開／連不上（3 秒逾時） | 跳過，舊版照常啟動，不提示 |
| 下載失敗、驗章不對、install 失敗 | 舊版照常啟動；頁面提示「自動更新失敗：原因（目前仍是舊版）」 |
| 開發樹（沒有 `RELEASE`） | 永遠不自動更新 |
| 沒有外殼的 daemon（舊啟動器、開發版）按更新 | 回「請手動重啟」 |

- 結果記在 `state/update.json`；10 分鐘內的結果頁面顯示一次（同一筆不重複跳）。
- install 用原本的裝法（`~/.claude/agumon-statusline/DAEMON_ONLY` 在 → `--daemon-only`）。
- 新版刪掉的檔案不會從同事的資料夾刪掉（只覆寫、新增）。

## 五、發版步驟

1. 第一次：`node scripts/gen-release-key.js`（已做，2026-10-08），**備份私鑰**。
2. 每次：`npm run publish-release` → 推 GitHub＋產 `dist/update/`。
3. plaza-host 要開著（`plaza-host.bat`）。`/update/*` 是這版才有的路由，plaza-host 要換新版重開一次。
4. 同事手上沒有自動更新的舊版，要先手動更新一次（git pull＋install 或重新下載），之後就自動了。
