# vpet-tray.ps1 — 把 daemon 收進工作列右下角的 tray 圖示（無小黑窗）
#
# 為什麼用 PowerShell + .NET NotifyIcon：daemon 部署後身邊沒有 node_modules
# （install 只複製 js，release 也不帶），所以不能用任何 npm 的 tray 套件。
# NotifyIcon 是 Windows 內建的，零相依。
#
# 由 vpet-standalone.vbs 以隱藏視窗啟動；也可自行執行：
#   powershell -ExecutionPolicy Bypass -File tools\vpet-tray.ps1

# 熱更交棒用：新版 tray 接手舊 tray 開的 daemon（不再開一個）。
# param 一定要是腳本第一句（註解不算）—— 放在 Add-Type 後面會被當成指令、參數整個收不到
param([int]$AdoptPid = 0)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
# 只開一個 tray（第二次雙擊 vpet-standalone.vbs 直接結束，不會再起第二個 daemon 搶 3010）。
# tools\vpet-mini 的小視窗也看這個 Mutex：tray 在 = daemon 是我們管的，自動更新的空檔多等一下
$mutex = New-Object System.Threading.Mutex($false, 'Local\vpet-tray')
# 交棒時舊 tray 還在收尾：多等幾秒讓它放掉 Mutex。
# 舊 tray 被 tools\tray-refresh.ps1 強制結束時 Mutex 會變成「被遺棄」，WaitOne 丟例外但其實已經拿到了
$gotMutex = $false
try { $gotMutex = $mutex.WaitOne($(if ($AdoptPid) { 15000 } else { 0 }), $false) } catch [System.Threading.AbandonedMutexException] { $gotMutex = $true }
if (-not $gotMutex) { exit 0 }
# 記號：這一版 tray 會自己換新版（Check-SelfUpdate）。tray-refresh.ps1 看到它就不插手，只處理沒有這能力的舊 tray
$selfUpdateMark = New-Object System.Threading.Mutex($false, 'Local\vpet-tray-selfupdate')
$root    = Split-Path -Parent $PSScriptRoot         # repo / 安裝根目錄
$miniVbs = Join-Path $PSScriptRoot 'vpet-mini\vpet-mini.vbs'   # 小視窗（同事做的 vpet mini，2026-10-21 併進來）
$daemon  = Join-Path $root 'src\daemon\daemon.js'
$icoPath = Join-Path $PSScriptRoot 'vpet.ico'
$port    = if ($env:AGUMON_DAEMON_PORT) { $env:AGUMON_DAEMON_PORT } else { '3010' }
$url     = "http://localhost:$port"

if (-not (Test-Path $daemon)) {
    [System.Windows.Forms.MessageBox]::Show("找不到 daemon：`n$daemon", 'vpet') | Out-Null
    exit 1
}

# statusLine 若還不是 daemon-aware 版，daemon 當家時會兩邊搶寫 state → 先提醒
$sl = Join-Path $env:USERPROFILE '.claude\agumon-statusline\statusline-agumon-color.js'
if ((Test-Path $sl) -and -not (Select-String -Path $sl -Pattern 'daemonIsAuthoritative' -Quiet)) {
    [System.Windows.Forms.MessageBox]::Show(
        "已安裝的 statusLine 還不是 daemon 版，可能與 daemon 搶寫狀態。`n請先執行 vpet install 再啟動。",
        'vpet', 'OK', 'Warning') | Out-Null
}

# ── 啟動 daemon（隱藏視窗，這就是「不要小黑窗」的關鍵）──
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName        = 'node'
$psi.Arguments       = "`"$daemon`" --authoritative"
$psi.WorkingDirectory = $root
$psi.UseShellExecute = $false
$psi.CreateNoWindow  = $true
# 熱更交棒：接手舊 tray 開的那個 daemon（更新外殼的 PID 從頭到尾不變），不要再開第二個
$proc = $null
if ($AdoptPid) { try { $proc = [System.Diagnostics.Process]::GetProcessById($AdoptPid) } catch { $proc = $null } }
if (-not $proc) { $proc = [System.Diagnostics.Process]::Start($psi) }

# ── tray 圖示 ──
$icon = if (Test-Path $icoPath) { New-Object System.Drawing.Icon $icoPath }
        else { [System.Drawing.SystemIcons]::Application }

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $icon
$ni.Text = "vpet (port $port)"        # 滑鼠移上去的提示
$ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('開啟 vpet 視窗')
$open.add_Click({ Start-Process $url })
# 桌面小視窗：只有面板大小、永遠最上層、可拖、可縮放（tools\vpet-mini，WebView2）
if (Test-Path $miniVbs) {
    $mini = $menu.Items.Add('開啟 vpet mini 視窗')
    $mini.add_Click({ Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $miniVbs + '"') })
}
$menu.Items.Add('-') | Out-Null
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class VpetTrayNative {
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@
# ── 提醒（同事 vpet mini v13 的功能，2026-10-22 併進來）：進化／戰鬥開始時跳 Windows 通知氣泡＋提示音，
#    進化時順便把小視窗叫出來。各項可在選單「提醒」開關，存 tools\vpet-tray.json（自動產生，不進 git）──
$prefPath = Join-Path $PSScriptRoot 'vpet-tray.json'
# dblClick：雙擊圖示開 'mini'（小視窗）或 'web'（網頁）；hintShown：第一次啟動的常駐教學跳過了沒（v15）
$PREF = @{ notifyEvo = $true; notifyBattle = $true; sound = $true; autoOpenMini = $true; hintShown = $false; dblClick = 'mini' }
try { if (Test-Path $prefPath) { $j = Get-Content $prefPath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($k in 'notifyEvo','notifyBattle','sound','autoOpenMini','hintShown') { if ($null -ne $j.$k) { $PREF[$k] = [bool]$j.$k } }
        if ($j.dblClick -eq 'web' -or $j.dblClick -eq 'mini') { $PREF.dblClick = [string]$j.dblClick } } } catch {}
function Save-Pref { try { ($PREF | ConvertTo-Json -Compress) | Set-Content $prefPath -Encoding UTF8 } catch {} }
$mNotify = New-Object System.Windows.Forms.ToolStripMenuItem('提醒')
$mNE = $mNotify.DropDownItems.Add('進化：跳通知'); $mNE.Checked = $PREF.notifyEvo;    $mNE.add_Click({ $PREF.notifyEvo = -not $PREF.notifyEvo; $mNE.Checked = $PREF.notifyEvo; Save-Pref })
$mNB = $mNotify.DropDownItems.Add('戰鬥：跳通知'); $mNB.Checked = $PREF.notifyBattle; $mNB.add_Click({ $PREF.notifyBattle = -not $PREF.notifyBattle; $mNB.Checked = $PREF.notifyBattle; Save-Pref })
$mNS = $mNotify.DropDownItems.Add('提示音');       $mNS.Checked = $PREF.sound;        $mNS.add_Click({ $PREF.sound = -not $PREF.sound; $mNS.Checked = $PREF.sound; Save-Pref })
if (Test-Path $miniVbs) {
    $mNO = $mNotify.DropDownItems.Add('進化時自動開小視窗'); $mNO.Checked = $PREF.autoOpenMini; $mNO.add_Click({ $PREF.autoOpenMini = -not $PREF.autoOpenMini; $mNO.Checked = $PREF.autoOpenMini; Save-Pref })
}
[void]$menu.Items.Add($mNotify)
# ── 雙擊圖示開什麼、圖示常駐教學（同事 vpet mini v15 的功能，2026-10-22 併進來）──
#    雙擊照設定開小視窗或網頁（預設小視窗；小視窗檔不在就退回網頁）
function Open-Default {
    if ($PREF.dblClick -ne 'web' -and (Test-Path $miniVbs)) { Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $miniVbs + '"') } else { Start-Process $url }
}
if (Test-Path $miniVbs) {
    $mDbl = New-Object System.Windows.Forms.ToolStripMenuItem('雙擊圖示開啟')
    $mDblMini = $mDbl.DropDownItems.Add('小視窗'); $mDblWeb = $mDbl.DropDownItems.Add('網頁（完整版）')
    function Sync-Dbl { $mDblMini.Checked = ($PREF.dblClick -ne 'web'); $mDblWeb.Checked = ($PREF.dblClick -eq 'web') }
    $mDblMini.add_Click({ $PREF.dblClick = 'mini'; Sync-Dbl; Save-Pref }); $mDblWeb.add_Click({ $PREF.dblClick = 'web'; Sync-Dbl; Save-Pref }); Sync-Dbl
    [void]$menu.Items.Add($mDbl)
}
#    圖示常駐顯示：Windows 不讓程式自己決定，只能教玩家拖一次（第一次啟動跳一次、選單隨時可再看）
$PIN_HINT = "vpet 圖示在右下角的「^」裡。想讓它一直看得到：點「^」，把 vpet 圖示拖到旁邊那排放開，Windows 會記住。"
function Show-PinHint([string]$title = '怎麼讓圖示常駐顯示？') { $ni.ShowBalloonTip(8000, $title, $PIN_HINT, 'Info') }
$mPin = $menu.Items.Add('怎麼讓圖示常駐顯示？'); $mPin.add_Click({ Show-PinHint })
$menu.Items.Add('-') | Out-Null
# 結束時小視窗一起關（送 WM_CLOSE，讓它自己存位置）
function Close-Mini { try { $h = [VpetTrayNative]::FindWindow([NullString]::Value, 'vpet mini'); if ($h -ne [IntPtr]::Zero) { [void][VpetTrayNative]::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) } } catch {} }
$quit = $menu.Items.Add('結束 vpet')
$quit.add_Click({
    Close-Mini
    try { if (-not $proc.HasExited) { $proc.Kill() } } catch {}
    $ni.Visible = $false
    $ni.Dispose()
    [System.Windows.Forms.Application]::Exit()
})
$ni.ContextMenuStrip = $menu
# 左鍵單擊也出選單（NotifyIcon 只有右鍵會自動出；用內部的 ShowContextMenu 才會出在正確位置、點外面會收），雙擊照設定開。
# 單擊要等一個「雙擊時限」再出選單，不然雙擊的第一下會先把選單叫出來
function Show-TrayMenu { $m = $ni.GetType().GetMethod('ShowContextMenu', [System.Reflection.BindingFlags]'NonPublic,Instance'); if ($m) { $m.Invoke($ni, $null) } else { $menu.Show([System.Windows.Forms.Cursor]::Position) } }
$script:clickTimer = New-Object System.Windows.Forms.Timer; $script:clickTimer.Interval = [Math]::Max(200, [System.Windows.Forms.SystemInformation]::DoubleClickTime)
$script:clickTimer.add_Tick({ $script:clickTimer.Stop(); Show-TrayMenu })
$ni.add_MouseClick({ param($s, $e) if ($e.Button -eq 'Left') { $script:clickTimer.Stop(); $script:clickTimer.Start() } })
$ni.add_MouseDoubleClick({ param($s, $e) if ($e.Button -eq 'Left') { $script:clickTimer.Stop(); Open-Default } })

# 第一次啟動跳一個氣泡：標題「vpet 已啟動」、內容是怎麼常駐顯示（之後不跳，從選單看）。晚 1.5 秒等圖示站穩。
# 原本每次啟動都跳「已啟動」，Windows 一次只顯示一個氣泡會互吞，所以併成這一個。熱更交棒（AdoptPid）不跳
if (-not $AdoptPid -and -not $PREF.hintShown) {
    $script:hintTimer = New-Object System.Windows.Forms.Timer; $script:hintTimer.Interval = 1500
    $script:hintTimer.add_Tick({ $script:hintTimer.Stop(); Show-PinHint 'vpet 已啟動'; $PREF.hintShown = $true; Save-Pref })
    $script:hintTimer.Start()
}

# ── 熱更後換新版 tray（2026-10-22 回報：熱更只重開 daemon，tray 還是舊的，選單要手動重開才會變）──
#    每 30 秒看自己的檔案；被更新換掉了 → 起一個新版 tray（-AdoptPid 接手同一個 daemon），自己安靜退場、不殺 daemon
$selfPath = $PSCommandPath
$selfStamp = (Get-Item $selfPath).LastWriteTimeUtc
$script:handedOff = $false
function Check-SelfUpdate {
    try {
        if ($script:handedOff -or $proc.HasExited) { return }
        if ((Get-Item $selfPath).LastWriteTimeUtc -eq $selfStamp) { return }
        $script:handedOff = $true
        Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden',
            '-File', ('"' + $selfPath + '"'), '-AdoptPid', [string]$proc.Id)
        $ni.Visible = $false; $ni.Dispose()
        try { $mutex.ReleaseMutex() } catch {}
        [System.Windows.Forms.Application]::Exit()
    } catch {}
}
$script:selfTicks = 0

# ── 提醒：每秒讀 /state 的 kind（頁面自己也每秒讀它），從別的場景變成 evo（進化）／battle（戰鬥）那一刻提醒一次 ──
#    啟動那一拍不提醒（不然一開 vpet 剛好在打就跳）。名字用 /state 的 jogress.frontName（顯示名），拿不到退回 character
$script:lastKind = $null; $script:lastName = ''
function Get-VpetState {
    try { $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port/state"); $req.Timeout = 400; $req.ReadWriteTimeout = 400
          $res = $req.GetResponse(); $sr = New-Object System.IO.StreamReader($res.GetResponseStream(), [System.Text.Encoding]::UTF8); $txt = $sr.ReadToEnd(); $sr.Close(); $res.Close()
          $s = $txt | ConvertFrom-Json
          $n = ''; try { $n = [string]$s.jogress.frontName } catch {}; if (-not $n) { $n = [string]$s.character }
          return @{ kind = [string]$s.kind; name = $n } } catch { return $null }
}
function On-Kind([string]$kind, [string]$name) {
    $prev = $script:lastKind; $script:lastKind = $kind
    if ($name) { $script:lastName = $name } else { $name = $script:lastName }
    if ($null -eq $prev -or $prev -eq $kind) { return }
    if ($kind -eq 'evo') {
        $who = if ($name) { $name } else { '牠' }
        if ($PREF.notifyEvo) { $ni.ShowBalloonTip(5000, 'Vpet進化中！', ("咦！？ {0}的樣子……！" -f $who), 'Info') }
        if ($PREF.sound) { [System.Media.SystemSounds]::Exclamation.Play() }
        if ($PREF.autoOpenMini -and (Test-Path $miniVbs)) {   # 小視窗已開就叫到前面，沒開就開
            $h = [VpetTrayNative]::FindWindow([NullString]::Value, 'vpet mini')
            if ($h -ne [IntPtr]::Zero) { [void][VpetTrayNative]::SetForegroundWindow($h) } else { Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $miniVbs + '"') }
        }
    } elseif ($kind -eq 'battle') {
        if ($PREF.notifyBattle) { $ni.ShowBalloonTip(3000, 'Vpet開打了！', '( ◞•̀д•́)═○💥○═(•̀д•́◟ )', 'Info') }
        if ($PREF.sound) { [System.Media.SystemSounds]::Asterisk.Play() }
    }
}

# 每秒一拍：daemon 自己掛掉時，tray 也跟著收掉，不留孤兒圖示；看場景有沒有變成進化／戰鬥
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.add_Tick({
    if ($proc.HasExited) {
        $ni.Visible = $false; $ni.Dispose()
        [System.Windows.Forms.Application]::Exit()
        return
    }
    $st = Get-VpetState; if ($st) { On-Kind $st.kind $st.name }
    $script:selfTicks++; if ($script:selfTicks -ge 30) { $script:selfTicks = 0; Check-SelfUpdate }
})
$timer.Start()

try {
    [System.Windows.Forms.Application]::Run()
} finally {
    # 交棒給新版 tray 時不殺 daemon（新的 tray 接手）
    if (-not $script:handedOff) { try { if (-not $proc.HasExited) { $proc.Kill() } } catch {} }
    try { $ni.Visible = $false; $ni.Dispose() } catch {}
}
