#!/usr/bin/env bash
# ============================================================
#  vpet 解除安裝 —— macOS 雙擊版
#  移除 ~/.claude/agumon-statusline、全域 vpet 指令，並從
#  settings.json 拆掉掛鉤。
#  你自己的 statusline 設定不會被動 —— 只有「路徑指向
#  agumon-statusline」的項目會被移除。
#  桌寵存檔（state/）預設保留：
#    --purge          連存檔一起刪
#    --keep-settings  不要動 settings.json
#  （第一次若被系統擋下，到「系統設定 > 隱私權與安全性」按「仍要打開」）
# ============================================================

# 切到本檔所在資料夾（雙擊時工作目錄不一定正確）
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[vpet-uninstall] 找不到 Node.js，請先到 https://nodejs.org 安裝再執行。"
  echo
  read -n 1 -s -p "按任意鍵關閉..."
  echo
  exit 1
fi

node "$(dirname "$0")/scripts/uninstall.js" "$@"
RC=$?

echo
echo "[vpet-uninstall] 完成（exit $RC）。請重開終端機。"
read -n 1 -s -p "按任意鍵關閉..."
echo
