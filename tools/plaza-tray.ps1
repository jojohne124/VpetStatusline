# plaza-tray.ps1 — 廣場伺服器收進工作列右下角的 tray 圖示（無小黑窗）
#
# 由 plaza-host.bat / plaza-host.vbs 以隱藏視窗啟動。做法照抄 vpet-tray.ps1：
# .NET NotifyIcon 是 Windows 內建的，零相依。
#   滑鼠移到圖示上 ... 顯示目前廣場幾個人
#   右鍵 ............. 在場名單 / 結束廣場
# 結束廣場 = 關掉伺服器，所有人約 10 秒後自動回前線。

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent $PSScriptRoot
$server  = Join-Path $root 'src\daemon\plaza-server.js'
$icoPath = Join-Path $PSScriptRoot 'plaza.ico'   # 跟桌寵的 vpet.ico 分開，工作列上一眼分得出來
$port    = if ($env:VPET_PLAZA_PORT) { $env:VPET_PLAZA_PORT } else { '37373' }
$url     = "http://localhost:$port"

if (-not (Test-Path $server)) {
    [System.Windows.Forms.MessageBox]::Show("找不到廣場伺服器：`n$server", 'vpet 廣場') | Out-Null
    exit 1
}

# 已經開著就不要再開一個（第二個會 port 衝突然後默默死掉，留下一顆沒用的圖示）
try {
    Invoke-RestMethod -Uri "$url/roster" -TimeoutSec 2 | Out-Null
    [System.Windows.Forms.MessageBox]::Show("廣場伺服器已經在執行了（port $port）。", 'vpet 廣場') | Out-Null
    exit 0
} catch {}

# ── 啟動伺服器（隱藏視窗）──
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName         = 'node'
$psi.Arguments        = "`"$server`""
$psi.WorkingDirectory = $root
$psi.UseShellExecute  = $false
$psi.CreateNoWindow   = $true
try { $proc = [System.Diagnostics.Process]::Start($psi) }
catch {
    [System.Windows.Forms.MessageBox]::Show("啟動失敗（找不到 node？）：`n$($_.Exception.Message)", 'vpet 廣場') | Out-Null
    exit 1
}

# ── tray 圖示 ──
$icon = if (Test-Path $icoPath) { New-Object System.Drawing.Icon $icoPath }
        else { [System.Drawing.SystemIcons]::Application }
$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $icon
$ni.Text = "vpet 廣場（port $port）"
$ni.Visible = $true

function Get-Roster {
    try { return @((Invoke-RestMethod -Uri "$url/roster" -TimeoutSec 2).roster) } catch { return $null }
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$who = $menu.Items.Add('在場名單')
$who.add_Click({
    $r = Get-Roster
    $msg = if ($r -eq $null) { '伺服器沒有回應。' }
           elseif ($r.Count -eq 0) { '廣場上目前沒有人。' }
           else { "廣場上 $($r.Count) 人：`n" + (($r | ForEach-Object { $_.name + '（' + $_.char + '）' }) -join "`n") }
    [System.Windows.Forms.MessageBox]::Show($msg, 'vpet 廣場') | Out-Null
})
$menu.Items.Add('-') | Out-Null
$quit = $menu.Items.Add('結束廣場（所有人回前線）')
$quit.add_Click({
    try { if (-not $proc.HasExited) { $proc.Kill() } } catch {}
    $ni.Visible = $false
    $ni.Dispose()
    [System.Windows.Forms.Application]::Exit()
})
$ni.ContextMenuStrip = $menu

$ni.ShowBalloonTip(2500, 'vpet 廣場已開啟', "大家現在可以進廣場了。`n右鍵圖示可看名單或結束。", 'Info')

# 每 5 秒更新提示文字（人數）；伺服器自己掛掉時圖示跟著收掉，不留孤兒
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({
    if ($proc.HasExited) {
        $ni.Visible = $false; $ni.Dispose()
        [System.Windows.Forms.Application]::Exit()
        return
    }
    $r = Get-Roster
    if ($r -ne $null) { $ni.Text = "vpet 廣場：$($r.Count) 人（port $port）" }
})
$timer.Start()

try {
    [System.Windows.Forms.Application]::Run()
} finally {
    try { if (-not $proc.HasExited) { $proc.Kill() } } catch {}
    try { $ni.Visible = $false; $ni.Dispose() } catch {}
}
