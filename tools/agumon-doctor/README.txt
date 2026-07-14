agumon doctor —— 桌寵卡死急救工具
====================================

【這是什麼】
桌寵小恐龍（Claude Code 狀態列的 statusline）如果卡住不動、不再變化，
多半是背景累積了「卡死的 node 孤兒」行程。這個小工具會找出並清掉它們。

【安全性】
只會清掉 agumon 自己的 statusline / hook 行程，
不會動到 Cursor、VS Code、編輯器或其他任何程式，可以安心執行。
（判定條件：命令列含 statusline-agumon-color 或 agumon-hook，且存活超過 20 秒。
  健康的 render 1~3 秒就結束，超過 20 秒＝卡死。）

【怎麼用】
  Windows：對著 agumon-doctor.bat 點兩下
  macOS  ：對著 agumon-doctor.command 點兩下
           （第一次若被系統擋下，到「系統設定 > 隱私權與安全性」按「仍要打開」）
  任何系統：開終端機，在本資料夾執行  node doctor.js

【只想檢查、先不清除】
  加上 --check，例如：  node doctor.js --check
  會列出目前有幾隻孤兒，但不會動手清。

【需要環境】
  電腦要有 Node.js（跟 Claude Code / statusline 同一套執行環境，通常已經有）。
  若沒有，到 https://nodejs.org 安裝 LTS 版即可。

【平常其實會自動清】
  statusline 本身每次刷新都會自動收掉卡死的孤兒；這個工具是「手動補刀 + 診斷」，
  給自動機制萬一沒跟上、或想立刻確認/清乾淨時用。
