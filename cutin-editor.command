#!/usr/bin/env bash
# ============================================================
#  進化路線 / 參數編輯器 啟動器（macOS 雙擊版）
#  在 Finder 直接點兩下即可啟動，等同 Windows 的 cutin-editor.bat。
#  結束：在跳出的 Terminal 視窗按 Ctrl+C
# ============================================================

# 切到本檔所在的 repo 目錄（雙擊時工作目錄不一定正確）
cd "$(dirname "$0")"

# 關掉占用 3003 port 的舊 server
OLD_PID=$(lsof -ti tcp:3003 2>/dev/null)
if [ -n "$OLD_PID" ]; then
  echo "[cutin-editor] 關閉舊 server PID $OLD_PID"
  kill -9 $OLD_PID 2>/dev/null
fi

# 背景輪詢 3003 port，server 真的起來才開瀏覽器
(
  for i in $(seq 1 60); do
    if nc -z localhost 3003 2>/dev/null; then
      open "http://localhost:3003"
      break
    fi
    sleep 0.25
  done
) &

echo "[cutin-editor] 啟動中..."
echo "[cutin-editor] 網址：http://localhost:3003   結束請按 Ctrl+C"
node src/editor/cutin_editor_server.js
