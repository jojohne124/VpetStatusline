@echo off
REM ============================================================
REM  CutIn crop editor
REM  Double-click this file (or run in cmd).
REM  Auto: kill old server on port 3003 -> open browser -> start editor
REM  Stop: press Ctrl+C in this window.
REM  On startup error the window stays open showing the message.
REM ============================================================
setlocal
chcp 65001 >nul

REM cd to this bat's own folder so double-click works from anywhere
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [cutin-editor] node not found. Install Node.js or add it to PATH.
  echo.
  pause
  exit /b 1
)

REM kill old server occupying port 3003
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3003 " ^| findstr LISTENING') do (
  echo [cutin-editor] killing old server PID %%a
  taskkill /F /PID %%a >nul 2>&1
)

REM poll port 3003 in background; open browser once server is up
start "" powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 60;$i++){try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('localhost',3003);$c.Close();Start-Process 'http://localhost:3003';break}catch{Start-Sleep -Milliseconds 250}}"

echo [cutin-editor] starting...
echo [cutin-editor] URL: http://localhost:3003   (Ctrl+C to stop)
echo.

node src/editor/cutin_editor_server.js
set "RC=%errorlevel%"

echo.
echo [cutin-editor] server exited (code %RC%). If unexpected, the reason is above.
echo.
pause
