@echo off
REM ============================================================
REM  agumon standalone - one-click launcher (Windows, console mode)
REM  Starts the daemon (authoritative) and opens the browser UI.
REM  Close this window to stop the daemon.
REM
REM  TIP: don't want this black console window?
REM       Double-click vpet-standalone.vbs instead - it runs the
REM       daemon hidden and puts an icon in the tray (bottom-right).
REM       This .bat is still handy for seeing error messages.
REM
REM  ASCII-only on purpose (cmd mis-parses non-ASCII -> crash).
REM ============================================================
setlocal
set "HERE=%~dp0"
set "PORT=3010"
if not "%AGUMON_DAEMON_PORT%"=="" set "PORT=%AGUMON_DAEMON_PORT%"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Install Node 18+ from https://nodejs.org/
  pause
  exit /b 1
)

REM Warn if the installed statusLine is not yet the daemon-aware (gated) version,
REM otherwise the old statusLine and this daemon would both write state (race).
findstr /c:"daemonIsAuthoritative" "%USERPROFILE%\.claude\agumon-statusline\statusline-agumon-color.js" >nul 2>&1
if errorlevel 1 (
  echo [WARN] Installed statusLine is not the daemon-aware version yet.
  echo        Until you deploy it, the statusLine may fight the daemon for state.
  echo        Deploy first with:  vpet install   ^(or npm run install-runtime in the repo^)
  echo.
)

echo Starting agumon standalone on http://localhost:%PORT%
echo Close this window to stop.
REM Open the browser shortly after the server is up (non-blocking).
start "" /b powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:%PORT%'"
node "%HERE%src\daemon\daemon.js" --authoritative
