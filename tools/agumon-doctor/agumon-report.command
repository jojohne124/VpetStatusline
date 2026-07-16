#!/usr/bin/env bash
# ============================================================
#  agumon report —— 輸出目前現況給開發者診斷（macOS 雙擊版）
#  唯讀，不改任何東西。會在家目錄產生 agumon-report.txt 並印出，
#  把那個檔（或印出來的整段文字）貼回給開發者即可。
# ============================================================

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[agumon-report] 找不到 Node.js，請先到 https://nodejs.org 安裝再執行。"
  echo
  read -n 1 -s -p "按任意鍵關閉..."
  echo
  exit 1
fi

node "$(dirname "$0")/report.js" "$@"
RC=$?

echo
echo "[agumon-report] 完成（exit $RC）。請把家目錄的 agumon-report.txt 貼回給開發者。"
read -n 1 -s -p "按任意鍵關閉..."
echo
