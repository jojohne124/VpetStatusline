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
# 只開一個 tray（第二次雙擊 vpet-standalone.vbs 直接結束，不會再起第二個 daemon 搶 3010）。
# tools\vpet-mini 的小視窗也看這個 Mutex：tray 在 = daemon 是我們管的，自動更新的空檔多等一下
$mutex = New-Object System.Threading.Mutex($false, 'Local\vpet-tray')
if (-not $mutex.WaitOne(0, $false)) { exit 0 }
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
}
'@
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
