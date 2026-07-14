#!/usr/bin/env bash
# ============================================================
#  vpet installer —— 部署桌寵到 ~/.claude/agumon-statusline（macOS 雙擊版）
#  在 Finder 對這個檔點兩下即可安裝。需要 Node.js。
#  （第一次若被系統擋下，到「系統設定 > 隱私權與安全性」按「仍要打開」）
# ============================================================

# 切到本檔所在資料夾（雙擊時工作目錄不一定正確）
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[vpet-install] 找不到 Node.js，請先到 https://nodejs.org 安裝再執行。"
  echo
  read -n 1 -s -p "按任意鍵關閉..."
  echo
  exit 1
fi

node "$(dirname "$0")/scripts/install.js" "$@"
RC=$?

echo
echo "[vpet-install] 完成（exit $RC）。請重開終端機讓 vpet 指令生效。"
read -n 1 -s -p "按任意鍵關閉..."
echo
