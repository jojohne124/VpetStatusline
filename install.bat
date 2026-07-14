@echo off
REM ============================================================
REM  vpet installer - deploy the desktop pet into
REM  ~/.claude/agumon-statusline (Windows double-click version).
REM  Double-click to run. Requires Node.js.
REM  On error the window stays open so you can read the message.
REM ============================================================
setlocal
chcp 65001 >nul

REM cd to this file's own folder so double-click works from anywhere
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [vpet-install] Node.js not found. Install it from https://nodejs.org or add it to PATH, then retry.
  echo.
  pause
  exit /b 1
)

node "%~dp0scripts\install.js" %*
set "RC=%errorlevel%"

echo.
echo [vpet-install] done ^(exit %RC%^). Reopen your terminal so the "vpet" command works.
echo Press any key to close.
pause >nul
