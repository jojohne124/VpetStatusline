agumon 桌寵急救工具包
====================================

裡面有三支工具：
  • agumon-doctor  —— 清掉「卡死的 node 孤兒」行程（溫和、平常保養用）
  • agumon-restart —— statusline 整個卡住/凍結時的「重啟」（比較狠，一鍵救回）
  • agumon-report  —— 卡住時「輸出現況」給開發者診斷（唯讀，不改任何東西）
先試 doctor；還凍住就 restart；若 restart 也救不回，請跑 report 把現況貼回給開發者。


==== agumon doctor（清孤兒）====

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


==== agumon restart（整個卡住時重啟）====

【什麼時候用】
  doctor 清完孤兒後，桌寵「整個畫面還是凍住、完全不動」時用。

【它會做什麼】
  1. 強殺「所有」agumon statusline / hook 行程（不限存活時間，比 doctor 更徹底）。
  2. 清掉背景的 pid 追蹤檔。
  3. 把「會讓畫面凍住的暫時狀態」重置為乾淨的待機（卡住的戰鬥/進化/空降/狀態卡/
     進化樹/睡眠/釘住…都解除）。
  之後回 Claude Code 送一則訊息（或等下次刷新），就會跑出重生的乾淨桌寵。

【會不會弄丟進度】
  不會。角色是誰、進化歷程、勝場數、花費累積、freeze / battle 開關都保留；
  只重置「當下卡住的表演狀態」。（註：若你剛用過強制睡覺，restart 會把牠叫醒。）

【怎麼用】
  Windows：對著 agumon-restart.bat 點兩下
  macOS  ：對著 agumon-restart.command 點兩下
  任何系統：開終端機，在本資料夾執行  node restart.js

【安全性】
  同樣只動 agumon 自己的行程與狀態，不會碰 Cursor / 其他程式。


==== agumon report（輸出現況給開發者診斷）====

【什麼時候用】
  卡住、且 doctor / restart 都救不回時。這支「不修東西」，只把現況拍成一份報告，
  讓開發者判斷是「Claude Code 停止呼叫指令」還是別的原因。

【它會做什麼】
  唯讀蒐集：安裝資訊、最後一次 render / 送訊息的時間差（判斷指令是否還被呼叫）、
  目前 agumon 行程與登記、state 關鍵旗標、settings 的 statusLine 設定、
  執行環境（node / 作業系統 / 記憶體）。
  結果會印在畫面，並存成家目錄的 agumon-report.txt。

【怎麼用】
  Windows：對著 agumon-report.bat 點兩下
  macOS  ：對著 agumon-report.command 點兩下
  任何系統：開終端機，在本資料夾執行  node report.js
  跑完把家目錄的 agumon-report.txt（或印出來的整段文字）貼回給開發者即可。

【安全性】
  純唯讀，不殺行程、不改 state、不動任何檔案（只多產生一份報告 txt）。
