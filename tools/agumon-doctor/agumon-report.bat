@echo off
REM ============================================================
REM  agumon report - dump the current state for diagnosis.
REM  Double-click to run. Read-only: changes nothing.
REM  Writes agumon-report.txt to your home folder and prints it;
REM  send that file (or the printed text) back to the developer.
REM ============================================================
setlocal
chcp 65001 >nul

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [agumon-report] Node.js not found. Install it from https://nodejs.org or add it to PATH, then retry.
  echo.
  pause
  exit /b 1
)

node "%~dp0report.js" %*
set "RC=%errorlevel%"

echo.
echo [agumon-report] done ^(exit %RC%^). Send agumon-report.txt (in your home folder) to the developer.
echo Press any key to close.
pause >nul
