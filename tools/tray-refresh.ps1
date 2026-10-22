# tray-refresh.ps1 — 熱更後把舊版 tray 換成新版（2026-10-22）
#
# 熱更只重開 daemon 子行程，tray（PowerShell）還在跑舊碼。新版 tray 自己會看檔案換新版（Check-SelfUpdate），
# 但更早的 tray 沒有這能力 —— 由新版 daemon 起來後跑這支替它換：
#   1. 新版 tray 掛著記號 Mutex（Local\vpet-tray-selfupdate）→ 它自己會換，不插手
#   2. 只動「更新外殼（-ShellPid）的父行程、而且命令列是 vpet-tray.ps1」那一個，別的 PowerShell 一律不碰
#   3. 先強制結束舊 tray（不跑它的 finally，所以不會殺 daemon），再起新版 tray 帶 -AdoptPid 接手同一個外殼
#      （舊 tray 的 Mutex 變成被遺棄，新版 tray 會接住）
param([int]$ShellPid = 0)
$ErrorActionPreference = 'Stop'
if (-not $ShellPid) { exit 0 }
$mark = $null
if ([System.Threading.Mutex]::TryOpenExisting('Local\vpet-tray-selfupdate', [ref]$mark)) { $mark.Dispose(); exit 0 }
$trayPs1 = Join-Path $PSScriptRoot 'vpet-tray.ps1'
# 新版 tray 要真的有接手能力，不然殺了舊的也接不上
if (-not (Test-Path $trayPs1) -or -not (Select-String -Path $trayPs1 -Pattern 'vpet-tray-selfupdate' -SimpleMatch -Quiet)) { exit 0 }
$shell = Get-CimInstance Win32_Process -Filter "ProcessId=$ShellPid"
if (-not $shell) { exit 0 }
$tray = Get-CimInstance Win32_Process -Filter "ProcessId=$($shell.ParentProcessId)"
if (-not $tray -or $tray.Name -ne 'powershell.exe' -or $tray.CommandLine -notlike '*vpet-tray.ps1*') { exit 0 }
# 父行程的 PID 可能被重用：舊 tray 一定比外殼早開
if ($tray.CreationDate -gt $shell.CreationDate) { exit 0 }
Stop-Process -Id $tray.ProcessId -Force
Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden',
    '-File', ('"' + $trayPs1 + '"'), '-AdoptPid', [string]$ShellPid)
