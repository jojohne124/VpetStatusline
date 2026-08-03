# vpet-tray.ps1 — 把 daemon 收進工作列右下角的 tray 圖示（無小黑窗）
#
# 為什麼用 PowerShell + .NET NotifyIcon：daemon 部署後身邊沒有 node_modules
# （install 只複製 js，release 也不帶），所以不能用任何 npm 的 tray 套件。
# NotifyIcon 是 Windows 內建的，零相依。
#
# 由 vpet-standalone.vbs 以隱藏視窗啟動；也可自行執行：
#   powershell -ExecutionPolicy Bypass -File tools\vpet-tray.ps1

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent $PSScriptRoot         # repo / 安裝根目錄
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
$proc = [System.Diagnostics.Process]::Start($psi)

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
$menu.Items.Add('-') | Out-Null
$quit = $menu.Items.Add('結束 vpet')
$quit.add_Click({
    try { if (-not $proc.HasExited) { $proc.Kill() } } catch {}
    $ni.Visible = $false
    $ni.Dispose()
    [System.Windows.Forms.Application]::Exit()
})
$ni.ContextMenuStrip = $menu
$ni.add_MouseDoubleClick({ Start-Process $url })   # 雙擊圖示＝開視窗

$ni.ShowBalloonTip(2500, 'vpet 已啟動', "在工作列右下角。雙擊圖示開啟視窗。`n$url", 'Info')

# daemon 自己掛掉時，tray 也跟著收掉，不留孤兒圖示
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
    if ($proc.HasExited) {
        $ni.Visible = $false; $ni.Dispose()
        [System.Windows.Forms.Application]::Exit()
    }
})
$timer.Start()

try {
    [System.Windows.Forms.Application]::Run()
} finally {
    try { if (-not $proc.HasExited) { $proc.Kill() } } catch {}
    try { $ni.Visible = $false; $ni.Dispose() } catch {}
}
