$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$packaged = Split-Path -Parent $root

$claudeDir = Join-Path $env:USERPROFILE ".claude"
$assetsDir = Join-Path $claudeDir "agumon-assets"

Write-Host "Claude dir: $claudeDir"
New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null
New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null

# 1) 安裝腳本
Copy-Item (Join-Path $root "agumon-core.js")             (Join-Path $claudeDir "agumon-core.js")             -Force
Copy-Item (Join-Path $root "statusline-agumon-bw.js")    (Join-Path $claudeDir "statusline-agumon-bw.js")    -Force
Copy-Item (Join-Path $root "statusline-agumon-color.js") (Join-Path $claudeDir "statusline-agumon-color.js") -Force
Copy-Item (Join-Path $root "agumon-hook.js")             (Join-Path $claudeDir "agumon-hook.js")             -Force

# 2) 安裝資產
Copy-Item (Join-Path $packaged "assets\agumon_art.json")       (Join-Path $assetsDir "agumon_art.json")       -Force
Copy-Item (Join-Path $packaged "assets\agumon_art_color.json") (Join-Path $assetsDir "agumon_art_color.json") -Force

# 3) 更新 settings.json（合併 hooks 與 statusLine）
$settingsPath = Join-Path $claudeDir "settings.json"
if (Test-Path $settingsPath) {
  $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
} else {
  $settings = [pscustomobject]@{}
}

if (-not $settings.statusLine) { $settings | Add-Member -NotePropertyName statusLine -NotePropertyValue ([pscustomobject]@{}) }
$settings.statusLine.type = "command"
$settings.statusLine.command = "node C:/Users/$env:USERNAME/.claude/statusline-agumon-color.js"
if (-not $settings.statusLine.refreshInterval) { $settings.statusLine | Add-Member -NotePropertyName refreshInterval -NotePropertyValue 1 }

if (-not $settings.hooks) { $settings | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{}) }
if (-not $settings.hooks.UserPromptSubmit) { $settings.hooks | Add-Member -NotePropertyName UserPromptSubmit -NotePropertyValue @() }

# 確保 UserPromptSubmit 裡有 agumon-hook.js
$hookCmd = "node C:/Users/$env:USERNAME/.claude/agumon-hook.js"
$found = $false
foreach ($entry in $settings.hooks.UserPromptSubmit) {
  if ($null -ne $entry.hooks) {
    foreach ($h in $entry.hooks) { if ($h.command -eq $hookCmd) { $found = $true } }
  }
}
if (-not $found) {
  $settings.hooks.UserPromptSubmit += [pscustomobject]@{
    hooks = @([pscustomobject]@{ type="command"; command=$hookCmd })
  }
}

$settings | ConvertTo-Json -Depth 50 | Set-Content -Path $settingsPath -Encoding UTF8

Write-Host "✓ Installed Agumon statusline (BW + Color) + assets + hook"
Write-Host "  - Default enabled: color"
Write-Host "  - Assets dir: $assetsDir"

