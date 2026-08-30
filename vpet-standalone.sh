#!/usr/bin/env bash
# ============================================================
#  agumon standalone - one-click launcher (macOS / Linux)
#  Starts the daemon (authoritative) and opens the browser UI.
#  Ctrl+C (or close the terminal) to stop the daemon.
# ============================================================
HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="${AGUMON_DAEMON_PORT:-3010}"

# Non-login shells do not source ~/.bash_profile / ~/.bashrc, so node
# (installed under ~/.local/bin) may be missing from PATH. Match .bashrc.
export PATH="$HOME/.local/bin:$PATH"

command -v node >/dev/null 2>&1 || { echo "[ERROR] Node.js not found. Install Node 18+ from https://nodejs.org/"; exit 1; }

# Warn if the installed statusLine is not yet the daemon-aware (gated) version,
# otherwise the old statusLine and this daemon would both write state (race).
SL="$HOME/.claude/agumon-statusline/statusline-agumon-color.js"
if [ -f "$SL" ] && ! grep -q daemonIsAuthoritative "$SL"; then
  echo "[WARN] Installed statusLine is not the daemon-aware version yet."
  echo "       Until you deploy it, the statusLine may fight the daemon for state."
  echo "       Deploy first with:  vpet install   (or npm run install-runtime in the repo)"
  echo
fi

echo "Starting agumon standalone on http://localhost:$PORT  (Ctrl+C to stop)"
# Open the browser after the server is up (background; macOS 'open', Linux 'xdg-open').
( sleep 2; (open "http://localhost:$PORT" 2>/dev/null || xdg-open "http://localhost:$PORT" 2>/dev/null) ) &
exec node "$HERE/src/daemon/daemon.js" --authoritative
