@echo off
REM ============================================================
REM  vpet installer - DAEMON ONLY (Windows double-click version).
REM  Installs the pet WITHOUT taking over your statusline:
REM    - does NOT touch settings.json statusLine.command
REM    - still installs the UserPromptSubmit hook (required:
REM      it feeds training points, auto-battle and activity time)
REM  View the pet in the browser via vpet-standalone.bat.
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

node "%~dp0scripts\install.js" --daemon-only %*
set "RC=%errorlevel%"

echo.
echo [vpet-install] done ^(exit %RC%^). Your statusline was left untouched.
echo Run vpet-standalone.bat to open the pet window.
echo Press any key to close.
pause >nul
