#!/usr/bin/env bash
# ============================================================
#  agumon doctor —— 桌寵卡死急救（macOS 雙擊版）
#  在 Finder 對這個檔點兩下即可執行。
#  只會清掉 agumon 自己的卡死行程，不會動到 Cursor、編輯器或其他程式。
# ============================================================

# 切到本檔所在資料夾（雙擊時工作目錄不一定正確）
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[agumon-doctor] 找不到 Node.js，請先到 https://nodejs.org 安裝再執行。"
  echo
  read -n 1 -s -p "按任意鍵關閉..."
  echo
  exit 1
fi

node "$(dirname "$0")/doctor.js" "$@"
RC=$?

echo
read -n 1 -s -p "完成（exit $RC），按任意鍵關閉..."
echo
