#!/usr/bin/env bash
# ============================================================
#  營地走動範圍編輯器 啟動器
#  用法：./zone-editor.sh
#  會自動：關掉占用 3005 port 的舊 server -> 開瀏覽器 -> 啟動 editor
#  結束：按 Ctrl+C
# ============================================================

# 切到本 sh 所在的 repo 目錄
cd "$(dirname "$0")"

# 關掉占用 3005 port 的舊 server
OLD_PID=$(lsof -ti tcp:3005 2>/dev/null)
if [ -n "$OLD_PID" ]; then
  echo "[zone-editor] 關閉舊 server PID $OLD_PID"
  kill -9 $OLD_PID 2>/dev/null
fi

# 背景輪詢 3005 port，server 真的起來才開瀏覽器
(
  for i in $(seq 1 60); do
    if nc -z localhost 3005 2>/dev/null; then
      open "http://localhost:3005" 2>/dev/null || xdg-open "http://localhost:3005" 2>/dev/null
      break
    fi
    sleep 0.25
  done
) &

echo "[zone-editor] 啟動中..."
echo "[zone-editor] 網址：http://localhost:3005   結束請按 Ctrl+C"
node src/editor/zone_editor_server.js
