#!/usr/bin/env bash
# ============================================================
#  agumon restart —— statusline 整個卡住/凍結時的重啟（macOS 雙擊版）
#  在 Finder 對這個檔點兩下即可執行。
#  強殺所有 agumon statusline/hook 行程 + 清 pids + 重置卡住的
#  動畫/睡眠旗標為乾淨 idle（保留角色身分與進度）。
#  只會動 agumon 自己的行程，不會碰 Cursor 或其他程式。
# ============================================================

# 切到本檔所在資料夾（雙擊時工作目錄不一定正確）
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[agumon-restart] 找不到 Node.js，請先到 https://nodejs.org 安裝再執行。"
  echo
  read -n 1 -s -p "按任意鍵關閉..."
  echo
  exit 1
fi

node "$(dirname "$0")/restart.js" "$@"
RC=$?

echo
echo "[agumon-restart] 完成（exit $RC）。回 Claude Code 送一則訊息就會看到桌寵重生。"
read -n 1 -s -p "按任意鍵關閉..."
echo
