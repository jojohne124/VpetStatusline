@echo off
REM ============================================================
REM  vpet plaza host - double-click to open the plaza server.
REM  The server runs hidden with an icon in the tray (bottom-right):
REM    hover = how many people are in, right-click = roster / stop.
REM  This window closes by itself right away (it only hands off
REM  to plaza-host.vbs, which launches without any console).
REM
REM  Only the plaza HOST needs this. First time only: allow inbound
REM  TCP 37373 in Windows Firewall (see docs/plaza-spec.md).
REM
REM  ASCII-only on purpose (cmd mis-parses non-ASCII -> crash).
REM ============================================================
start "" wscript.exe "%~dp0plaza-host.vbs"
exit /b 0
