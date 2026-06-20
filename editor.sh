#!/usr/bin/env bash
# ============================================================
#  sprite editor 啟動器
#  用法：
#    ./editor.sh            啟動 agumon（預設）
#    ./editor.sh renamon    啟動指定角色
#  會自動：關掉占用 3000 port 的舊 server -> 開瀏覽器 -> 啟動 editor
#  結束：按 Ctrl+C
# ============================================================

# 切到本 sh 所在的 repo 目錄
cd "$(dirname "$0")"

# 關掉占用 3000 port 的舊 server
OLD_PID=$(lsof -ti tcp:3000 2>/dev/null)
if [ -n "$OLD_PID" ]; then
  echo "[editor] 關閉舊 server PID $OLD_PID"
  kill -9 $OLD_PID 2>/dev/null
fi

# 角色名稱（預設 agumon）
CHAR="${1:-agumon}"

# 背景輪詢 3000 port，server 真的起來才開瀏覽器
(
  for i in $(seq 1 60); do
    if nc -z localhost 3000 2>/dev/null; then
      open "http://localhost:3000"
      break
    fi
    sleep 0.25
  done
) &

echo "[editor] 啟動中... 角色=$CHAR"
echo "[editor] 網址：http://localhost:3000   結束請按 Ctrl+C"
node src/editor/sprite_editor_server.js "$CHAR"
