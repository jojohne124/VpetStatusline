#!/usr/bin/env bash
# ============================================================
#  vpet installer —— 只裝 daemon（macOS 雙擊版）
#  給「想繼續用自己的 statusline」的人：
#    - 不會動你自己的 statusLine.command
#    - 只有當它指向 agumon-statusline 時才移除（＝你正從狀態列版轉過來）
#    - 仍會裝 UserPromptSubmit hook（必要：訓練值、自動戰鬥、活動時戳靠它）
#  裝完雙擊 vpet-standalone.app 看桌寵（免小黑窗）；
#  想看 console 訊息就用 vpet-standalone.command。
#  （第一次若被系統擋下，到「系統設定 > 隱私權與安全性」按「仍要打開」）
# ============================================================

# 切到本檔所在資料夾（雙擊時工作目錄不一定正確）
cd "$(dirname "$0")"

# 雙擊 .command 是非登入 shell，不會載入 ~/.bash_profile / ~/.bashrc，
# node（~/.local/bin）不在 PATH 會直接判定「找不到 Node.js」而中止。
# 補上與 .bashrc 相同的 PATH，確保雙擊也找得到 node。
export PATH="$HOME/.local/bin:$PATH"

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
echo "雙擊 vpet-standalone.app 開啟桌寵（免小黑窗）；要看 console 用 vpet-standalone.command。"
read -n 1 -s -p "按任意鍵關閉..."
echo
