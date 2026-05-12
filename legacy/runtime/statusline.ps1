$raw = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($raw)) {
    Write-Host "Claude"
    exit 0
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$data = $raw | ConvertFrom-Json

# ── Colors ──────────────────────────────────────────────
$esc = [char]27
$blue = "${esc}[38;2;0;153;255m"
$orange = "${esc}[38;2;255;176;85m"
$green = "${esc}[38;2;0;175;80m"
$cyan = "${esc}[38;2;86;182;194m"
$red = "${esc}[38;2;255;85;85m"
$yellow = "${esc}[38;2;230;200;0m"
$white = "${esc}[38;2;220;220;220m"
$magenta = "${esc}[38;2;180;140;255m"
$dim = "${esc}[2m"
$reset = "${esc}[0m"
$sep = " ${dim}│${reset} "

# ── Helpers ─────────────────────────────────────────────
function Format-Tokens {
    param([int]$num)
    if ($num -ge 1000000) { return "{0:0.0}m" -f ($num / 1000000) }
    elseif ($num -ge 1000) { return "{0:0}k" -f ($num / 1000) }
    else { return "$num" }
}

function Get-ColorForPct {
    param([int]$pct)
    if ($pct -ge 90) { return $red }
    elseif ($pct -ge 70) { return $yellow }
    elseif ($pct -ge 50) { return $orange }
    else { return $green }
}

function Build-Bar {
    param([int]$pct, [int]$width)
    if ($pct -lt 0) { $pct = 0 }
    if ($pct -gt 100) { $pct = 100 }

    $filled = [math]::Floor($pct * $width / 100)
    $empty = $width - $filled
    $barColor = Get-ColorForPct $pct

    $filledStr = "●" * $filled
    $emptyStr = "○" * $empty

    return "${barColor}${filledStr}${dim}${emptyStr}${reset}"
}

function Format-ResetTime {
    param([string]$isoStr, [string]$style)
    if ([string]::IsNullOrEmpty($isoStr) -or $isoStr -eq "null") { return "" }

    try {
        # Use DateTimeOffset to correctly handle UTC timezone (Z suffix)
        $dt = [DateTimeOffset]::Parse($isoStr).LocalDateTime
        switch ($style) {
            "time" { return $dt.ToString("MM/dd HH:mm") }
            "datetime" { return $dt.ToString("MM/dd HH:mm") }
            default { return $dt.ToString("MMM d").ToLower() }
        }
    } catch {
        return ""
    }
}

# ── Extract JSON data ───────────────────────────────────
$modelName = if ($data.model -is [string]) { $data.model }
             elseif ($data.model.display_name) { $data.model.display_name }
             else { "Claude" }

$size = if ($data.contextWindow) { $data.contextWindow }
        elseif ($data.context_window.context_window_size) { $data.context_window.context_window_size }
        else { 200000 }

# Prefer pre-calculated used_percentage; fall back to manual calculation
$pctUsed = 0
if ($null -ne $data.context_window.used_percentage) {
    $pctUsed = [math]::Floor([double]$data.context_window.used_percentage)
} else {
    $inputTokens = if ($data.tokenUsage.input) { $data.tokenUsage.input }
                   elseif ($data.context_window.current_usage.input_tokens) { $data.context_window.current_usage.input_tokens }
                   else { 0 }

    $cacheCreate = if ($data.tokenUsage.cacheCreation) { $data.tokenUsage.cacheCreation }
                   elseif ($data.context_window.current_usage.cache_creation_input_tokens) { $data.context_window.current_usage.cache_creation_input_tokens }
                   else { 0 }

    $cacheRead = if ($data.tokenUsage.cacheRead) { $data.tokenUsage.cacheRead }
                 elseif ($data.context_window.current_usage.cache_read_input_tokens) { $data.context_window.current_usage.cache_read_input_tokens }
                 else { 0 }

    $current = $inputTokens + $cacheCreate + $cacheRead
    if ($size -gt 0) { $pctUsed = [math]::Floor($current * 100 / $size) }
}

# ── LINE 1: Model │ Context % │ Directory (branch) │ Effort ──
$pctColor = Get-ColorForPct $pctUsed
$cwd = if ($data.cwd) { $data.cwd } else { Get-Location }
$dirname = Split-Path -Leaf $cwd

$gitBranch = ""
$gitDirty = ""
if (Test-Path "$cwd\.git") {
    try {
        Push-Location $cwd
        $gitBranch = git symbolic-ref --short HEAD 2>$null
        $status = git status --porcelain 2>$null
        if ($status) { $gitDirty = "*" }
        Pop-Location
    } catch {
        Pop-Location
    }
}

$effort = "default"
$settingsPath = "$env:USERPROFILE\.claude\settings.json"
if (Test-Path $settingsPath) {
    try {
        $settings = Get-Content $settingsPath | ConvertFrom-Json
        if ($settings.effortLevel) { $effort = $settings.effortLevel }
    } catch {}
}

$line1 = "${blue}${modelName}${reset}${sep}ctx ${pctColor}${pctUsed}%${reset}${sep}${cyan}${dirname}${reset}"
if ($gitBranch) {
    $line1 += " ${green}(${gitBranch}${red}${gitDirty}${green})${reset}"
}
$line1 += $sep
switch ($effort) {
    "high"   { $line1 += "${magenta}● ${effort}${reset}" }
    "medium" { $line1 += "${dim}◑ ${effort}${reset}" }
    "low"    { $line1 += "${dim}◔ ${effort}${reset}" }
    default  { $line1 += "${dim}◑ ${effort}${reset}" }
}

# ── OAuth token resolution ──────────────────────────────
function Get-OAuthToken {
    if ($env:CLAUDE_CODE_OAUTH_TOKEN) {
        return $env:CLAUDE_CODE_OAUTH_TOKEN
    }

    $credsFile = "$env:USERPROFILE\.claude\.credentials.json"
    if (Test-Path $credsFile) {
        try {
            $creds = Get-Content $credsFile | ConvertFrom-Json
            if ($creds.claudeAiOauth.accessToken) {
                return $creds.claudeAiOauth.accessToken
            }
        } catch {}
    }

    return $null
}

# ── Fetch usage data (cached) ──────────────────────────
$cacheDir = "$env:TEMP\claude"
$cacheFile = "$cacheDir\statusline-usage-cache.json"
$cacheMaxAge = 120

if (-not (Test-Path $cacheDir)) {
    New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
}

$needsRefresh = $true
$usageData = $null
$isStale = $false

if (Test-Path $cacheFile) {
    $cacheAge = (Get-Date) - (Get-Item $cacheFile).LastWriteTime
    if ($cacheAge.TotalSeconds -lt $cacheMaxAge) {
        try {
            $cachedData = Get-Content $cacheFile | ConvertFrom-Json
            $needsRefresh = $false
            $usageData = $cachedData
        } catch {}
    }
}

if ($needsRefresh) {
    $token = Get-OAuthToken
    $refreshed = $false
    if ($token) {
        try {
            $headers = @{
                "Accept" = "application/json"
                "Content-Type" = "application/json"
                "Authorization" = "Bearer $token"
                "anthropic-beta" = "oauth-2025-04-20"
                "User-Agent" = "claude-code/2.1.34"
            }
            $response = Invoke-RestMethod -Uri "https://api.anthropic.com/api/oauth/usage" `
                -Headers $headers -TimeoutSec 5 -ErrorAction SilentlyContinue

            if ($response.five_hour) {
                $usageData = $response
                $refreshed = $true
                $response | ConvertTo-Json -Depth 10 | Set-Content $cacheFile
            }
        } catch {}
    }

    if (-not $refreshed) {
        $isStale = $true
        if (-not $usageData -and (Test-Path $cacheFile)) {
            try {
                $usageData = Get-Content $cacheFile | ConvertFrom-Json
            } catch {}
        }
    }
}

# ── Rate limit lines ────────────────────────────────────
$rateLine = ""

if ($usageData -and $usageData.five_hour) {
    $barWidth = 10

    $staleSuffix = if ($isStale) { " ${dim}(stale)${reset}" } else { "" }

    # Five hour (current)
    $fiveHourPct = [math]::Floor($usageData.five_hour.utilization)
    $fiveHourReset = Format-ResetTime $usageData.five_hour.resets_at "time"
    $fiveHourBar = Build-Bar $fiveHourPct $barWidth
    $fiveHourPctColor = Get-ColorForPct $fiveHourPct
    $fiveHourPctFmt = "{0,3}" -f $fiveHourPct

    # Seven day (weekly)
    $sevenDayPct = [math]::Floor($usageData.seven_day.utilization)
    $sevenDayReset = Format-ResetTime $usageData.seven_day.resets_at "datetime"
    $sevenDayBar = Build-Bar $sevenDayPct $barWidth
    $sevenDayPctColor = Get-ColorForPct $sevenDayPct
    $sevenDayPctFmt = "{0,3}" -f $sevenDayPct

    $currentLine = "${white}current${reset} ${fiveHourBar} ${fiveHourPctColor}${fiveHourPctFmt}%${reset} ${dim}⟳${reset} ${white}${fiveHourReset}${reset}${staleSuffix}"
    $weeklyLine = "${white}weekly${reset}  ${sevenDayBar} ${sevenDayPctColor}${sevenDayPctFmt}%${reset} ${dim}⟳${reset} ${white}${sevenDayReset}${reset}${staleSuffix}"
}

# ── Output ──────────────────────────────────────────────
Write-Host $line1

if ($todoLine) {
    Write-Host "${dim}todos:${reset} $todoLine"
}

if ($currentLine) {
    Write-Host ""
    Write-Host $currentLine
    Write-Host $weeklyLine
}
