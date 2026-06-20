#!/usr/bin/env bash
# ============================================================
#  sprite editor 啟動器（雙擊版）
#  在 Finder 直接點兩下即可啟動，等同 Windows 的 editor.bat
#  預設啟動 agumon；要換角色可改下方 CHAR 或用 editor.sh 帶參數
#  結束：在跳出的 Terminal 視窗按 Ctrl+C
# ============================================================

# 切到本檔所在的 repo 目錄（雙擊時工作目錄不一定正確）
cd "$(dirname "$0")"

# 關掉占用 3000 port 的舊 server
OLD_PID=$(lsof -ti tcp:3000 2>/dev/null)
if [ -n "$OLD_PID" ]; then
  echo "[editor] 關閉舊 server PID $OLD_PID"
  kill -9 $OLD_PID 2>/dev/null
fi

# 角色名稱（雙擊預設 agumon，可改這裡）
CHAR="agumon"

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
