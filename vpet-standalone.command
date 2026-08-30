#!/usr/bin/env bash
# ============================================================
#  vpet standalone 啟動器（macOS 雙擊版）
#  在 Finder 直接點兩下即可啟動，等同 Windows 的 vpet-standalone.bat。
#  會啟動當家 daemon（唯一 state 寫入者）並開瀏覽器看桌寵。
#  結束：在跳出的 Terminal 視窗按 Ctrl+C
#  （第一次若被系統擋下，到「系統設定 > 隱私權與安全性」按「仍要打開」）
# ============================================================

# 切到本檔所在的 repo 目錄（雙擊時工作目錄不一定正確）
cd "$(dirname "$0")"

# 雙擊 .command 是非登入 shell，不會載入 ~/.bash_profile / ~/.bashrc，
# node（~/.local/bin）不在 PATH 會直接 command not found → 視窗閃退。
export PATH="$HOME/.local/bin:$PATH"

# 沿用 .sh 版的實作，避免兩份邏輯分歧（單一真理）
exec ./vpet-standalone.sh "$@"
