-- ============================================================
--  vpet standalone 啟動器（macOS 免小黑窗版）
--  等同 Windows 的 vpet-standalone.vbs：雙擊完全不開 Terminal 視窗。
--
--  未執行 → 背景啟動當家 daemon（nohup 脫離，關掉任何視窗都不會被殺）後開瀏覽器
--  已執行 → 跳選單「開啟視窗 / 停止 vpet」，對應 Windows 托盤右鍵的 open/quit
--
--  這支只是殼，引擎仍是 src/daemon/daemon.js（單一真理，與 .sh/.bat 同一顆）。
--  日誌：~/Library/Logs/vpet-daemon.log（免視窗＝看不到 stdout，出事看這裡）
--  埠號：預設 3010，可用 AGUMON_DAEMON_PORT 覆蓋（與 .sh 一致）
-- ============================================================

on getPort()
	return do shell script "echo ${AGUMON_DAEMON_PORT:-3010}"
end getPort

on portIsOpen(p)
	try
		do shell script "/usr/bin/nc -z localhost " & p
		return true
	on error
		return false
	end try
end portIsOpen

-- 雙擊的 .app 拿到的是最小 PATH，不會載入 ~/.bashrc，node（~/.local/bin）會找不到。
on shellWithPath(cmd)
	return "export PATH=\"$HOME/.local/bin:$PATH\"; " & cmd
end shellWithPath

on nodeMissing()
	try
		do shell script my shellWithPath("command -v node >/dev/null 2>&1")
		return false
	on error
		return true
	end try
end nodeMissing

-- 安裝版 statusLine 若還不是 daemon-aware 版，兩邊會搶寫 state（race）。
on statusLineNotGated()
	try
		do shell script "SL=\"$HOME/.claude/agumon-statusline/statusline-agumon-color.js\"; [ -f \"$SL\" ] && ! grep -q daemonIsAuthoritative \"$SL\""
		return true
	on error
		return false
	end try
end statusLineNotGated

-- 背景啟動 daemon。
-- ⚠️ 這裡的括號不是裝飾：do shell script 會等到整個行程群組結束，單純
-- 「nohup … &」對 node daemon 無效（實測會一路卡住，.app 雙擊後只會轉圈）。
-- 用子 shell 二次 fork 讓 daemon 脫離群組，do shell script 才會立刻返回。
on startDaemon(repoDir, p)
	do shell script my shellWithPath("mkdir -p \"$HOME/Library/Logs\"; cd " & quoted form of repoDir & " || exit 1; export AGUMON_DAEMON_PORT=" & p & "; ( nohup node src/daemon/daemon.js --authoritative >> \"$HOME/Library/Logs/vpet-daemon.log\" 2>&1 </dev/null & ) & exit 0")
end startDaemon

on waitForPort(p)
	try
		do shell script "for i in $(seq 1 40); do /usr/bin/nc -z localhost " & p & " >/dev/null 2>&1 && exit 0; sleep 0.25; done; exit 1"
		return true
	on error
		return false
	end try
end waitForPort

on stopDaemon(p)
	do shell script "PIDS=$(lsof -ti tcp:" & p & " 2>/dev/null); if [ -n \"$PIDS\" ]; then kill $PIDS 2>/dev/null; fi; exit 0"
end stopDaemon

on openUI(p)
	open location "http://localhost:" & p
end openUI

on run
	set p to my getPort()
	set appPath to POSIX path of (path to me)
	set repoDir to do shell script "dirname " & quoted form of appPath

	-- 已在執行：給 open / quit 兩個選擇（等同托盤右鍵選單）
	if my portIsOpen(p) then
		set act to button returned of (display dialog "vpet 已經在執行中。" buttons {"取消", "停止 vpet", "開啟視窗"} default button "開啟視窗" with title "vpet standalone" with icon note)
		if act is "開啟視窗" then
			my openUI(p)
		else if act is "停止 vpet" then
			my stopDaemon(p)
		end if
		return
	end if

	if my nodeMissing() then
		display alert "找不到 Node.js" message "請先到 https://nodejs.org 安裝 Node 18 以上版本。" as critical
		return
	end if

	if my statusLineNotGated() then
		display alert "statusLine 還不是 daemon-aware 版" message "目前安裝的 statusLine 會和 daemon 搶著寫 state。請先在 repo 執行 npm run install-runtime 再啟動。" as warning
	end if

	my startDaemon(repoDir, p)

	if my waitForPort(p) then
		my openUI(p)
	else
		display alert "vpet 啟動失敗" message "daemon 沒有在 10 秒內就緒。詳細訊息請看 ~/Library/Logs/vpet-daemon.log" as critical
	end if
end run
