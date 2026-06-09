@echo off
REM ============================================================
REM  sprite editor 啟動器
REM  用法：
REM    editor.bat            啟動 agumon（預設）
REM    editor.bat renamon    啟動指定角色
REM  會自動：關掉占用 3000 port 的舊 server -> 開瀏覽器 -> 啟動 editor
REM  結束：在此視窗按 Ctrl+C
REM ============================================================
setlocal

REM 切到本 bat 所在的 repo 目錄，從任何地方執行都正確
cd /d "%~dp0"

REM 關掉占用 3000 port 的舊 server
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 " ^| findstr LISTENING') do (
  echo [editor] 關閉舊 server PID %%a
  taskkill /F /PID %%a >nul 2>&1
)

REM 角色名稱（預設 agumon）
set "CHAR=%~1"

REM 背景輪詢 3000 port，server 真的起來才開瀏覽器（避免開太早顯示空白頁）
start "" powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 60;$i++){try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('localhost',3000);$c.Close();Start-Process 'http://localhost:3000';break}catch{Start-Sleep -Milliseconds 250}}"

echo [editor] 啟動中... 角色=%CHAR% （預設 agumon）
echo [editor] 網址：http://localhost:3000   結束請按 Ctrl+C
node src/editor/sprite_editor_server.js %CHAR%
