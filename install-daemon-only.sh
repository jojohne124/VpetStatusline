#!/usr/bin/env bash
# ============================================================
#  vpet installer —— 只裝 daemon（macOS 雙擊版）
#  給「想繼續用自己的 statusline」的人：
#    - 不會動你自己的 statusLine.command
#    - 只有當它指向 agumon-statusline 時才移除（＝你正從狀態列版轉過來）
#    - 仍會裝 UserPromptSubmit hook（必要：訓練值、自動戰鬥、活動時戳靠它）
#  裝完用 vpet-standalone.command 開瀏覽器看桌寵。
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

node "$(dirname "$0")/scripts/install.js" --daemon-only "$@"
RC=$?

echo
echo "[vpet-install] 完成（exit $RC）。statusLine 的處理見上方紀錄。"
echo "執行 vpet-standalone.command 開啟桌寵視窗。"
read -n 1 -s -p "按任意鍵關閉..."
echo
