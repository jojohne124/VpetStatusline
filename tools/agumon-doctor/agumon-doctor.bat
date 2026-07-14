@echo off
REM ============================================================
REM  agumon doctor - clean up stuck statusline node orphans
REM  Double-click to run. Self-contained, no install needed.
REM  It ONLY kills agumon statusline/hook node processes;
REM  it never touches Cursor, editors, or any other program.
REM  On error the window stays open so you can read the message.
REM ============================================================
setlocal
chcp 65001 >nul

REM cd to this file's own folder so double-click works from anywhere
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [agumon-doctor] Node.js not found. Install it from https://nodejs.org or add it to PATH, then retry.
  echo.
  pause
  exit /b 1
)

node "%~dp0doctor.js" %*
set "RC=%errorlevel%"

echo.
echo [agumon-doctor] done ^(exit %RC%^). Press any key to close.
pause >nul
