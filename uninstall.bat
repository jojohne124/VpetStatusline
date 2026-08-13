@echo off
REM ============================================================
REM  vpet uninstaller (Windows double-click version).
REM  Removes ~/.claude/agumon-statusline and the global vpet
REM  command, and unhooks it from settings.json.
REM  Your own statusline setting is NEVER touched - only entries
REM  whose path points at agumon-statusline are removed.
REM  Your pet's save data (state/) is KEPT.
REM    - to wipe the save data too: run with --purge
REM    - to leave settings.json alone: run with --keep-settings
REM  Double-click to run. Requires Node.js.
REM ============================================================
setlocal
chcp 65001 >nul

REM cd to this file's own folder so double-click works from anywhere
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [vpet-uninstall] Node.js not found. Install it from https://nodejs.org or add it to PATH, then retry.
  echo.
  pause
  exit /b 1
)

node "%~dp0scripts\uninstall.js" %*
set "RC=%errorlevel%"

echo.
echo [vpet-uninstall] done ^(exit %RC%^). Reopen your terminal.
echo Press any key to close.
pause >nul
