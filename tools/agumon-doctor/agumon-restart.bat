@echo off
REM ============================================================
REM  agumon restart - recover a stuck / frozen statusline pet.
REM  Double-click to run. Self-contained, no install needed.
REM  Force-kills ALL agumon statusline/hook node processes,
REM  clears pid tracking, and resets stuck animation/sleep flags
REM  to a clean idle (keeps your pet's identity and progress).
REM  It ONLY touches agumon processes; never Cursor or others.
REM  On error the window stays open so you can read the message.
REM ============================================================
setlocal
chcp 65001 >nul

REM cd to this file's own folder so double-click works from anywhere
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [agumon-restart] Node.js not found. Install it from https://nodejs.org or add it to PATH, then retry.
  echo.
  pause
  exit /b 1
)

node "%~dp0restart.js" %*
set "RC=%errorlevel%"

echo.
echo [agumon-restart] done ^(exit %RC%^). Send a message in Claude Code to see the pet respawn.
echo Press any key to close.
pause >nul
