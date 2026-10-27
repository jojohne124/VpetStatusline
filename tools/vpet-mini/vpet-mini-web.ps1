# vpet-mini-web.ps1 — 桌寵小視窗（第十四版，2026-10-22）
# 用 WebView2 開vpet 的 http://localhost:3010。不改vpet任何檔案；頁面只注入一條樣式（$STYLE：標題行上下對稱，讓橫列裡的標題與按鈕同一中線，2026-10-22 作者同意）。
# 三個視窗：
#   主視窗 = 只有 WebView，形狀（Form.Region）= 頁面回報的實體矩形（面板、按鈕、文字行）＋頂端橫列（面板上方標題列那一段補成整條），其餘是洞（點下去是後面的視窗）
#   小標籤 = 頂端橫列右端的「☰ vpet 75%」按鈕（左鍵／右鍵開選單、按住拖曳移動、滑鼠移上去變亮）；左邊再一顆「桌寵」按鈕（點了縮成桌寵，橫列放不下就不顯示）
#   小方塊 = 面板右下角 14×14（拖曳 = 整頁等比例縮放 40%～200%，放開才套用）
#   小標籤／小方塊做成主視窗的 owned window：WebView2 是獨立子視窗會蓋住同區域的控制項，疊在上面只能用另一個視窗。
# 頁面裡唯一塞進去的是一段「量內容」的腳本（只量不改、不綁任何 id）：內容寬高（自動貼合）＋實體矩形（形狀）。
# 設定存同資料夾 mini-web.json；WebView2 資料在 webview-data\；需以 -STA 啟動（vpet-mini.vbs 已帶）。
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Path (Join-Path $here 'lib\Microsoft.Web.WebView2.Core.dll')
Add-Type -Path (Join-Path $here 'lib\Microsoft.Web.WebView2.WinForms.dll')
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class VpetNative {
    [DllImport("user32.dll")] public static extern bool ReleaseCapture();
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@

# 只允許一個小視窗：第二次啟動就把已開的那個叫到前面，然後結束
$script:mutex = New-Object System.Threading.Mutex($false, 'Local\vpet-mini-window')
if (-not $script:mutex.WaitOne(0, $false)) {
    $h = [VpetNative]::FindWindow([NullString]::Value, 'vpet mini')
    if ($h -ne [IntPtr]::Zero) { [void][VpetNative]::SetForegroundWindow($h) }
    exit 0
}

$script:Port = if ($env:AGUMON_DAEMON_PORT) { $env:AGUMON_DAEMON_PORT } else { '3010' }
$script:HomeUrl = "http://localhost:$($script:Port)/"
$script:CfgPath = Join-Path $here 'mini-web.json'
$script:Cfg = @{ x = 80; y = 80; w = 480; h = 640; zoom = 1.0; topmost = $true; autofit = $true; readZoom = 0; petFollow = $false; petScale = 0 }   # readZoom 0 = 關；petFollow 小寵物跟隨滑鼠；petScale 0 = 跟小視窗一樣大、>0 = 滾輪調過的倍數
if (Test-Path $script:CfgPath) {
    try {
        $j = Get-Content $script:CfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($k in @('x','y','w','h','zoom','topmost','autofit','readZoom','petFollow','petScale')) { if ($null -ne $j.$k) { $script:Cfg[$k] = $j.$k } }
        $script:startReq = [string]$j.request   # 系統匣在我們還沒開時就寫了 request（雙擊圖示開「桌寵」）：第一次貼合完就照做
    } catch {}
}
$script:Cfg.autofit = $true   # 固定開：右下角拖曳＝整頁等比例縮放
$script:ZOOM_MIN = 0.4; $script:ZOOM_MAX = 2.0
$script:ContentW = 0; $script:ContentH = 0   # 頁面回報的內容寬高（CSS px，不隨縮放變）
$script:Rects = @()                          # 頁面回報的實體矩形（CSS px）
$script:fitted = $false
function Save-Cfg {
    try { $c = $script:Cfg.Clone(); if ($null -ne $script:baseZoom) { $c.zoom = $script:baseZoom }   # 閱讀縮放暫升中，存的是原本的縮放
          ($c | ConvertTo-Json -Compress) | Set-Content $script:CfgPath -Encoding UTF8
          $script:cfgMtime = (Get-Item $script:CfgPath).LastWriteTimeUtc } catch {} }   # 記下自己寫的時間，監看時才分得出是別人（tray）改的
# ── 跟系統匣共用的設定（v16：兩邊選單做成一樣，各自的項目寫對方的設定檔、對方監看檔案變了就套用）──
# 系統匣的設定檔：跟我們的 tray 放一起時是 $here\tray.json；放在 vpet repo 的 tools\vpet-mini\ 時是 ..\vpet-tray.json（作者的 tray）
$script:TrayPrefPath = if (Test-Path (Join-Path $here 'vpet-mini-tray.ps1')) { Join-Path $here 'tray.json' } else { Join-Path $here '..\vpet-tray.json' }
$script:TRAY_DEFAULTS = @{ notifyEvo = $true; notifyBattle = $true; notifyEvent = $true; sound = $true; autoOpenMini = $true; hintShown = $false; dblClick = 'mini' }
function Get-TrayPref {
    $p = $script:TRAY_DEFAULTS.Clone()
    try { if (Test-Path $script:TrayPrefPath) { $j = Get-Content $script:TrayPrefPath -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($k in 'notifyEvo','notifyBattle','notifyEvent','sound','autoOpenMini','hintShown') { if ($null -ne $j.$k) { $p[$k] = [bool]$j.$k } }
            if ($j.dblClick -eq 'web' -or $j.dblClick -eq 'mini' -or $j.dblClick -eq 'pet') { $p.dblClick = [string]$j.dblClick } } } catch {}
    return $p
}
# 只改這一格：讀原檔的整個物件、改一個欄位再寫回（2026-10-27 併入時改：原本只寫認得的幾個欄位，tray 那邊新加的設定會被洗掉）
function Set-TrayPref([string]$k, $v) {
    try { $j = $null; if (Test-Path $script:TrayPrefPath) { $j = Get-Content $script:TrayPrefPath -Raw -Encoding UTF8 | ConvertFrom-Json }
          if ($null -eq $j) { $j = New-Object PSObject }
          if ($null -eq $j.PSObject.Properties[$k]) { $j | Add-Member -NotePropertyName $k -NotePropertyValue $v } else { $j.$k = $v }
          ($j | ConvertTo-Json -Compress) | Set-Content $script:TrayPrefPath -Encoding UTF8 } catch {}
}
$PIN_HINT = "vpet 圖示在右下角的「^」裡。想讓它一直看得到：點「^」，把 vpet 圖示拖到旁邊那排放開，Windows 會記住。"

$GRIP_PX = 14
$COL_BG   = [System.Drawing.Color]::FromArgb(255, 13, 17, 23)     # 跟頁面 body 同色
$COL_BAR  = [System.Drawing.Color]::FromArgb(255, 22, 27, 34)
$COL_TXT  = [System.Drawing.Color]::FromArgb(255, 139, 148, 158)
$COL_LINE = [System.Drawing.Color]::FromArgb(255, 48, 54, 61)

# ── 主視窗：只有 WebView ──
$form = New-Object System.Windows.Forms.Form
$form.Text = 'vpet mini'
$form.FormBorderStyle = 'None'
$form.ShowInTaskbar = $false      # 入口在系統匣（vpet-tray.ps1），不進工作列
$form.StartPosition = 'Manual'
$form.BackColor = $COL_BG
$form.Location = New-Object System.Drawing.Point([int]$script:Cfg.x, [int]$script:Cfg.y)
# 起始先給大尺寸並隱形：頁面的 max-width:100% 會讓內容量不到比視窗更寬，從小視窗起步會長不回去；第一次貼合完才現身
$form.Size = New-Object System.Drawing.Size(1000, 800)
$form.Opacity = 0
$form.TopMost = [bool]$script:Cfg.topmost
$form.MinimumSize = New-Object System.Drawing.Size(160, 80)

$wv = New-Object Microsoft.Web.WebView2.WinForms.WebView2
$wv.Dock = 'Fill'
$wv.DefaultBackgroundColor = $COL_BG
$form.Controls.Add($wv)

# ── 小標籤（把手）──
$tag = New-Object System.Windows.Forms.Form
$tag.Text = 'vpet mini tag'; $tag.FormBorderStyle = 'None'; $tag.ShowInTaskbar = $false; $tag.StartPosition = 'Manual'
$tag.BackColor = $COL_LINE; $tag.TopMost = [bool]$script:Cfg.topmost   # 外圍 1 px 當按鈕的框線
$COL_HOVER = [System.Drawing.Color]::FromArgb(255, 48, 54, 61)
$COL_TXT_HOVER = [System.Drawing.Color]::FromArgb(255, 230, 237, 243)
$lbl = New-Object System.Windows.Forms.Label
# 高度不讓 Label 自己量（☰ 由後備字型畫、會把行高撐高），由 Update-TagFont 決定（有橫列＝橫列高）；寬度用 TextRenderer 量文字
$lbl.AutoSize = $false; $lbl.TextAlign = 'MiddleLeft'; $lbl.ForeColor = $COL_TXT; $lbl.BackColor = $COL_BAR; $lbl.Font = New-Object System.Drawing.Font('Consolas', 11, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$lbl.Location = New-Object System.Drawing.Point(1, 1); $script:tagH = 19
$lbl.Cursor = [System.Windows.Forms.Cursors]::Hand
function Tag-Text([double]$z) { return ('☰ vpet {0}%' -f [int][Math]::Round($z * 100)) }   # 同仁不知道這裡能按：加 ☰、縮放比例外顯
$lbl.Text = Tag-Text ([double]$script:Cfg.zoom)
$tag.Controls.Add($lbl)
function Fit-Tag {
    $tw = [System.Windows.Forms.TextRenderer]::MeasureText($lbl.Text, $lbl.Font).Width + 12
    $lbl.Size = New-Object System.Drawing.Size($tw, $script:tagH)
    $sz = New-Object System.Drawing.Size(($tw + 2), ($script:tagH + 2)); $tag.MinimumSize = $sz; $tag.MaximumSize = $sz; $tag.ClientSize = $sz }
function Set-Tag([string]$t, $col) { $lbl.Text = $t; if ($col) { $lbl.ForeColor = $col } else { $lbl.ForeColor = $COL_TXT }; Fit-Tag; Place-Handles }
Fit-Tag
# 滑鼠移上去變亮（像個按鈕）
$lbl.add_MouseEnter({ $lbl.BackColor = $COL_HOVER; $lbl.ForeColor = $COL_TXT_HOVER })
$lbl.add_MouseLeave({ $lbl.BackColor = $COL_BAR; $lbl.ForeColor = $COL_TXT })

# ── 「桌寵」按鈕（2026-10-22 玩家要一鍵縮成桌寵）：跟小標籤同款、放在它左邊；點了＝縮成桌寵，按住一樣能拖視窗。橫列放不下（會壓到標題）就不顯示 ──
$btn = New-Object System.Windows.Forms.Form
$btn.Text = 'vpet mini pet-button'; $btn.FormBorderStyle = 'None'; $btn.ShowInTaskbar = $false; $btn.StartPosition = 'Manual'
$btn.BackColor = $COL_LINE; $btn.TopMost = [bool]$script:Cfg.topmost
$blbl = New-Object System.Windows.Forms.Label
$blbl.AutoSize = $false; $blbl.TextAlign = 'MiddleCenter'; $blbl.ForeColor = $COL_TXT; $blbl.BackColor = $COL_BAR; $blbl.Font = $lbl.Font
$blbl.Location = New-Object System.Drawing.Point(1, 1); $blbl.Text = '桌面'; $blbl.Cursor = [System.Windows.Forms.Cursors]::Hand
$btn.Controls.Add($blbl)
function Fit-Btn {
    $tw = [System.Windows.Forms.TextRenderer]::MeasureText($blbl.Text, $blbl.Font).Width + 12
    $blbl.Size = New-Object System.Drawing.Size($tw, $script:tagH)
    $sz = New-Object System.Drawing.Size(($tw + 2), ($script:tagH + 2)); $btn.MinimumSize = $sz; $btn.MaximumSize = $sz; $btn.ClientSize = $sz }
Fit-Btn
$blbl.add_MouseEnter({ $blbl.BackColor = $COL_HOVER; $blbl.ForeColor = $COL_TXT_HOVER })
$blbl.add_MouseLeave({ $blbl.BackColor = $COL_BAR; $blbl.ForeColor = $COL_TXT })
$script:btnFits = $true

# ── 小方塊（縮放）──
$grip = New-Object System.Windows.Forms.Form
$grip.Text = 'vpet mini grip'; $grip.FormBorderStyle = 'None'; $grip.ShowInTaskbar = $false; $grip.StartPosition = 'Manual'
$grip.BackColor = $COL_LINE; $grip.TopMost = [bool]$script:Cfg.topmost
$grip.MinimumSize = New-Object System.Drawing.Size($GRIP_PX, $GRIP_PX)   # 不設的話 Windows 會套頂層視窗預設最小尺寸（136×39）
$grip.MaximumSize = New-Object System.Drawing.Size($GRIP_PX, $GRIP_PX)
$grip.ClientSize = New-Object System.Drawing.Size($GRIP_PX, $GRIP_PX)
$grip.Cursor = [System.Windows.Forms.Cursors]::SizeNWSE

# ── 小寵物（第十五版，10-22 改成「照抄遊戲畫面」）：選單「縮成小寵物」→ 小視窗藏起來（不關，WebView 留著），原位放一隻角色；點牠一下小視窗回來 ──
#    圖從哪來：/state 的 petLines＝遊戲此刻真正畫的那隻（8 列 × 52 格彩色半格字元：▀ 前景＝上半、背景＝下半；▄ 前景＝下半、背景＝上半；點字空白透明）
#    → 解回 52×16 像素、裁掉四周透明、放大 petScale 倍。睡覺的 Z、心情決定的表情、戰鬥整場都是遊戲本人畫的，這裡不模擬任何動作。
#    面向：裁出來的圖跟 characters\<角色>\art.json 的 12 幀比對（原圖面向左；比到左右翻轉版＝面向右），走的方向跟面向不合就整張翻轉；
#    比不到單隻（睡覺有 Z、戰鬥整場、進化）就原地站著不走。尺寸：一格＝8 × 畫面縮放（跟小視窗裡那隻一樣大），戰鬥不另外放大。
#    寵物視窗用色鍵透明（TransparencyKey）：這裡沒有 WebView、純 GDI 畫，點擊判定正常（色鍵只對 WebView2 不行）。色鍵 (255,0,255) 掃過 260 隻角色圖都沒用到。
function Find-VpetRoot {
    $cands = @()
    $cf = Join-Path $here 'vpet-mini.config.json'
    if (Test-Path $cf) { try { $c0 = Get-Content $cf -Raw -Encoding UTF8 | ConvertFrom-Json; if ($c0.vpetRoot) { $cands += [string]$c0.vpetRoot } } catch {} }
    if ($env:VPET_ROOT) { $cands += $env:VPET_ROOT }
    $rp = Join-Path $env:USERPROFILE '.claude\agumon-statusline\REPO_PATH'
    if (Test-Path $rp) { try { $cands += (Get-Content $rp -Raw -Encoding UTF8).Trim() } catch {} }
    $up = Resolve-Path (Join-Path $here '..\..') -ErrorAction SilentlyContinue; if ($up) { $cands += $up.Path }
    $cands += 'D:\Tools\vpet'
    foreach ($c in $cands) { if ($c -and (Test-Path (Join-Path $c 'characters'))) { return $c } }
    return $null
}
$script:VpetRoot = Find-VpetRoot
$script:petArt = @{}              # 角色 id → 已裁邊的幀清單（每幀 int[,] [y,x]＝r<<16|g<<8|b，-1 透明），只拿來比對面向
$script:petMode = $false; $script:petDir = -1; $script:petTick = 0; $script:petRange = @{ l = 0; r = 0; y = 0 }
$script:petSingle = $false; $script:lastChar = ''; $script:petScale = 6
$PET_TICK_MS = 150; $PET_POLL_TICKS = 3         # 每 3 拍（0.45 秒）抄一次 /state（遊戲 0.75 秒一步，抄得比它快就不會漏太多）
# 移動（v16 二修，2026-10-22 原作者＋使用者回饋）：
#   一幀一格：只在「抄到的圖變了」那一拍移動（遊戲 0.75 秒換一幀），兩幀之間完全不動——連續移動會像滑行，原作設計是一幀走一格。
#   一格＝素材一個像素＝petScale 螢幕 px。折返走：一幀 1 格。跟隨：一幀 N 格，N＝距離÷60（1～8），遠就大步、近就一格一格。
#   停距＝身寬×1.5（原 0.75，誤點太多），離開 >150 px 才再追（遲滯）
#   躲：滑鼠主動靠到停距×0.6 以內開始躲，一躲就躲到「兩倍距離」才停（遲滯），一幀 4 格（慢，追得到，點牠仍可行）
#   位置限制是「所有螢幕的聯集」：原本限在滑鼠所在螢幕，跨螢幕時會被拉過去瞬移
$PET_FOLLOW_CELL_DIV = 60.0; $PET_FOLLOW_MAX_CELLS = 8; $PET_FLEE_CELLS = 4; $PET_PATROL_CELLS = 1
$PET_STOP_BODY = 1.5; $PET_FLEE_RATIO = 0.6; $PET_FLEE_ESCAPE = 2.0; $PET_FOLLOW_RESUME = 150
# 補間（使用者回饋：大步跳格不順）：一幀要走 ≥ PET_TWEEN_CELLS 格時，把那段平均分到接下來 PET_TWEEN_TICKS 拍慢慢走，
# 到下一幀剛好走完、終點跟跳格版一樣；小步（近距離、折返）仍一幀一跳。門檻設 99 就是全程跳格
$PET_TWEEN_CELLS = 3; $PET_TWEEN_TICKS = 5
$script:petArrived = $false; $script:petFleeing = $false; $script:petStep = $false; $script:petSig = ''; $script:petTween = $null

function Crop-Px([int[,]]$px) {
    # 裁掉四周透明；全透明回 $null。回 @{ w; h; px }
    $H = $px.GetLength(0); $W = $px.GetLength(1)
    $minX = $W; $maxX = -1; $minY = $H; $maxY = -1
    for ($y = 0; $y -lt $H; $y++) { for ($x = 0; $x -lt $W; $x++) { if ($px[$y, $x] -ge 0) { if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }; if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y } } } }
    if ($maxX -lt 0) { return $null }
    $cw = $maxX - $minX + 1; $chh = $maxY - $minY + 1
    $cp = New-Object 'int[,]' $chh, $cw
    for ($y = 0; $y -lt $chh; $y++) { for ($x = 0; $x -lt $cw; $x++) { $cp[$y, $x] = $px[($minY + $y), ($minX + $x)] } }
    return @{ w = $cw; h = $chh; px = $cp; ox = $minX; oy = $minY }   # ox／oy＝裁掉的左／上格數（對位要知道角色在整張畫面裡的位置）
}
function Load-PetArt([string]$charId) {
    # id 來自 /state、直接拼進路徑：只收資料夾名會有的字（不讓 ..\ 之類跑出 characters\，併入時加的）
    if (-not $charId -or $charId -notmatch '^[A-Za-z0-9_-]+$') { return @() }
    if ($script:petArt.ContainsKey($charId)) { return $script:petArt[$charId] }
    $out = @()
    try {
        $p = Join-Path $script:VpetRoot ("characters\" + $charId + "\art.json")
        if ($script:VpetRoot -and (Test-Path $p)) {
            $d = Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json; $W = [int]$d.width; $H = [int]$d.height
            foreach ($fr in $d.frames) {
                $px = New-Object 'int[,]' ($H * 2), $W
                for ($y = 0; $y -lt $H * 2; $y++) { for ($x = 0; $x -lt $W; $x++) { $px[$y, $x] = -1 } }
                for ($y = 0; $y -lt $H; $y++) { $row = $fr[$y]; if ($null -eq $row) { continue }
                    for ($x = 0; $x -lt $W; $x++) { $c = if ($x -lt $row.Count) { $row[$x] } else { $null }; if ($null -eq $c) { continue }
                        foreach ($half in 0, 1) { $r = [int]$c[$half * 3]; if ($r -ge 0) { $px[($y * 2 + $half), $x] = ($r -shl 16) -bor ([int]$c[$half * 3 + 1] -shl 8) -bor [int]$c[$half * 3 + 2] } } } }
                $cr = Crop-Px $px; if ($cr) { $out += ,$cr }
            }
        }
    } catch { if ($env:VPET_MINI_DEBUG) { Add-Content (Join-Path $here '_err.log') ("{0:HH:mm:ss.fff} pet art: {1}" -f (Get-Date), $_.Exception.Message) } }
    $script:petArt[$charId] = $out
    if ($env:VPET_MINI_DEBUG) { Add-Content (Join-Path $here '_fit.log') ("{0:HH:mm:ss.fff} pet art loaded: {1} frames={2}" -f (Get-Date), $charId, $out.Count) }
    return $out
}
function Parse-PetLines($lines) {
    # petLines（ANSI 24-bit 色碼＋半格字元）→ 裁邊後的 @{ w; h; px }；空的回 $null
    $rows = @($lines); if ($rows.Count -eq 0) { return $null }
    $cells = @(); $W = 0
    foreach ($ln in $rows) {
        $fg = -1; $bg = -1; $cl = New-Object System.Collections.ArrayList; $s = [string]$ln; $i = 0; $n = $s.Length
        while ($i -lt $n) {
            $ch = $s[$i]
            if ($ch -eq [char]27 -and ($i + 1) -lt $n -and $s[$i + 1] -eq '[') {
                $j = $s.IndexOf('m', $i); if ($j -lt 0) { break }
                $code = $s.Substring($i + 2, $j - $i - 2); $i = $j + 1
                if ($code -eq '0' -or $code -eq '') { $fg = -1; $bg = -1 }
                elseif ($code.StartsWith('38;2;')) { $q = $code.Split(';'); $fg = ([int]$q[2] -shl 16) -bor ([int]$q[3] -shl 8) -bor [int]$q[4] }
                elseif ($code.StartsWith('48;2;')) { $q = $code.Split(';'); $bg = ([int]$q[2] -shl 16) -bor ([int]$q[3] -shl 8) -bor [int]$q[4] }
                continue
            }
            $top = -1; $bot = -1
            if ($ch -eq [char]0x2580) { $top = $fg; $bot = $bg }
            elseif ($ch -eq [char]0x2584) { $bot = $fg; $top = $bg }
            elseif ($ch -eq [char]0x2588) { $top = $fg; $bot = $fg }
            [void]$cl.Add(@($top, $bot)); $i++
        }
        if ($cl.Count -gt $W) { $W = $cl.Count }
        $cells += ,$cl
    }
    if ($W -eq 0) { return $null }
    $H = $rows.Count * 2
    $px = New-Object 'int[,]' $H, $W
    for ($y = 0; $y -lt $H; $y++) { for ($x = 0; $x -lt $W; $x++) { $px[$y, $x] = -1 } }
    for ($r = 0; $r -lt $rows.Count; $r++) { $cl = $cells[$r]; for ($x = 0; $x -lt $cl.Count; $x++) { $px[($r * 2), $x] = $cl[$x][0]; $px[($r * 2 + 1), $x] = $cl[$x][1] } }
    $res = Crop-Px $px
    if ($res) { $res.fw = $W; $res.fh = $H }   # 裁邊前整張畫面的格數（寬 52、高 16）：對位時拿畫布框寬高÷它＝每格幾 CSS px
    return $res
}
function Match-Facing($img) {
    # 跟角色原圖比：回 -1（原圖方向＝面向左）、1（翻轉版＝面向右）、0（比不到：睡覺有 Z、戰鬥、進化…）
    $frames = Load-PetArt $script:lastChar
    foreach ($fr in $frames) {
        if ($fr.w -ne $img.w -or $fr.h -ne $img.h) { continue }
        $same = 0; $flip = 0; $tot = $fr.w * $fr.h
        for ($y = 0; $y -lt $fr.h; $y++) { for ($x = 0; $x -lt $fr.w; $x++) { $v = $fr.px[$y, $x]; if ($v -eq $img.px[$y, $x]) { $same++ }; if ($v -eq $img.px[$y, ($fr.w - 1 - $x)]) { $flip++ } } }
        if ($same -ge $tot * 0.9) { return -1 }
        if ($flip -ge $tot * 0.9) { return 1 }
    }
    return 0
}
function Build-PetBitmap($img, [int]$k, [bool]$flipX) {
    $bmp = New-Object System.Drawing.Bitmap(($img.w * $k), ($img.h * $k), [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.Clear([System.Drawing.Color]::Transparent)
    $br = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)
    for ($y = 0; $y -lt $img.h; $y++) { for ($x = 0; $x -lt $img.w; $x++) { $v = $img.px[$y, $x]; if ($v -lt 0) { continue }
        $br.Color = [System.Drawing.Color]::FromArgb(255, (($v -shr 16) -band 255), (($v -shr 8) -band 255), ($v -band 255))
        $dx = if ($flipX) { $img.w - 1 - $x } else { $x }
        $g.FillRectangle($br, ($dx * $k), ($y * $k), $k, $k) } }
    $g.Dispose(); $br.Dispose(); return $bmp
}
# 事件的「❗」（跟隨滑鼠時不直接彈回小視窗，改成頭上冒這個、停下來等點）：在寵物圖上面多一條，畫黑底紅驚嘆號。
# 寵物視窗是色鍵透明（每個點只能全透明或不透明），做不出真的半透明 → 黑底用棋盤格（黑點、透明點交錯），
# 遠看就是半透明的暗底，背後透得過來（2026-10-22 使用者選的：半透明黑底＋紅色驚嘆號）。不反鋸齒（半透明的邊會變粉紅）
function Add-PetAlert($bmp, [int]$k) {
    $ah = [Math]::Max(20, $k * 6); $bw = [Math]::Max(14, $k * 4)
    $out = New-Object System.Drawing.Bitmap($bmp.Width, ($bmp.Height + $ah), [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bx = [int](($bmp.Width - $bw) / 2); $bh = $ah - 2
    for ($y = 0; $y -lt $bh; $y++) { for ($x = 0; $x -lt $bw; $x++) {
        if ($x -eq 0 -or $y -eq 0 -or $x -eq $bw - 1 -or $y -eq $bh - 1 -or (($x + $y) % 2) -eq 0) { $out.SetPixel(($bx + $x), $y, [System.Drawing.Color]::Black) } } }
    $g = [System.Drawing.Graphics]::FromImage($out)
    $g.SmoothingMode = 'None'
    $g.DrawImage($bmp, 0, $ah, $bmp.Width, $bmp.Height)
    $sw = [Math]::Max(2, [int]($bw / 4)); $sx = $bx + [int](($bw - $sw) / 2)
    $red = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 77, 79))
    $g.FillRectangle($red, $sx, 3, $sw, [Math]::Max(2, $bh - 6 - $sw - 2))
    $g.FillRectangle($red, $sx, ($bh - 3 - $sw), $sw, $sw)
    $g.Dispose(); $red.Dispose(); $bmp.Dispose(); return $out
}
$script:petAlert = $false; $script:lastEventId = $null; $script:eventPulled = $false
$PET_KEY = [System.Drawing.Color]::FromArgb(255, 255, 0, 255)
$pet = New-Object System.Windows.Forms.Form
$pet.Text = 'vpet mini pet'; $pet.FormBorderStyle = 'None'; $pet.ShowInTaskbar = $false; $pet.StartPosition = 'Manual'
$pet.BackColor = $PET_KEY; $pet.TransparencyKey = $PET_KEY; $pet.TopMost = [bool]$script:Cfg.topmost
$pet.MinimumSize = New-Object System.Drawing.Size(16, 16)
$pbox = New-Object System.Windows.Forms.PictureBox
$pbox.BackColor = $PET_KEY; $pbox.SizeMode = 'AutoSize'; $pbox.Location = New-Object System.Drawing.Point(0, 0)
$pbox.Cursor = [System.Windows.Forms.Cursors]::Hand
$pet.Controls.Add($pbox)
function Get-State {
    try { $req = [System.Net.HttpWebRequest]::Create("http://localhost:$($script:Port)/state"); $req.Timeout = 500; $req.ReadWriteTimeout = 500
          $res = $req.GetResponse(); $sr = New-Object System.IO.StreamReader($res.GetResponseStream()); $txt = $sr.ReadToEnd(); $sr.Close(); $res.Close()
          return ($txt | ConvertFrom-Json) } catch { return $null }
}
function Move-PetBy([double]$ddx, [double]$ddy) {
    # 位置限制是所有螢幕的聯集：跨螢幕就是走過去，不會瞬移。小數累積在 petFx／petFy，不然每拍四捨五入會慢慢吃掉位移
    $script:petFx += $ddx; $script:petFy += $ddy
    $ix = [int][Math]::Round($script:petFx); $iy = [int][Math]::Round($script:petFy); if ($ix -eq 0 -and $iy -eq 0) { return }
    $script:petFx -= $ix; $script:petFy -= $iy
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $nx = [Math]::Max($vs.Left, [Math]::Min($pet.Left + $ix, $vs.Right - $pet.Width)); $ny = [Math]::Max($vs.Top, [Math]::Min($pet.Top + $iy, $vs.Bottom - $pet.Height))
    $pet.Location = New-Object System.Drawing.Point($nx, $ny)
}
$script:petFx = 0.0; $script:petFy = 0.0
function Set-PetDir([int]$d) {
    # 走的方向變了：圖立刻翻，不等下一次抄（抄回來時會按面向重算，結果一致）
    if ($d -eq $script:petDir) { return }
    $script:petDir = $d
    if ($script:petSingle -and $pbox.Image) { $pbox.Image.RotateFlip([System.Drawing.RotateFlipType]::RotateNoneFlipX); $pbox.Invalidate() }
}
function Refresh-Pet($st) {
    # 抄一次遊戲畫面到寵物視窗；$st 給了就用、沒給就讀 /state
    if ($null -eq $st) { $st = Get-State }; if ($null -eq $st) { return }
    if ($st.character) { $script:lastChar = [string]$st.character }
    # 圖變了＝遊戲換了一幀 → 下一拍准許移動一步（一幀一格）
    $sig = [string]::Join('|', @($st.petLines)); if ($sig -ne $script:petSig) { $script:petSig = $sig; $script:petStep = $true }
    $img = Parse-PetLines $st.petLines; if ($null -eq $img) { return }
    $facing = Match-Facing $img
    $script:petSingle = ($facing -ne 0)
    $flip = $(if ($script:petSingle) { $facing -ne $script:petDir } else { $false })
    $old = $pbox.Image
    $pbox.Image = Build-PetBitmap $img $script:petScale $flip
    if ($script:petAlert) { $pbox.Image = Add-PetAlert $pbox.Image $script:petScale }
    # 尺寸變了（例如戰鬥變寬、睡覺多了 Z）：底邊不動往上長、水平置中不動
    $newW = $pbox.Image.Width; $newH = $pbox.Image.Height
    $ddx = [int](($pet.Width - $newW) / 2); $ddy = $pet.Height - $newH
    $pet.ClientSize = New-Object System.Drawing.Size($newW, $newH)
    if ($ddx -ne 0 -or $ddy -ne 0) { $pet.Location = New-Object System.Drawing.Point(($pet.Left + $ddx), ($pet.Top + $ddy)) }
    if ($old) { $old.Dispose() }
    if ($env:VPET_MINI_DEBUG) { Add-Content (Join-Path $here '_fit.log') ("{0:HH:mm:ss.fff} pet refresh: kind={1} img={2}x{3} facing={4} single={5} flip={6} scale={7}" -f (Get-Date), $st.kind, $img.w, $img.h, $facing, $script:petSingle, $flip, $script:petScale) }
}
function Enter-Pet {
    if ($script:petMode) { return }
    $script:eventPulled = $false
    # 大小：滾輪調過就用調過的（petScale），沒有就跟小視窗裡那隻一樣大（100% 時一格 8 px）
    $script:petScale = if ([int]$script:Cfg.petScale -gt 0) { [int]$script:Cfg.petScale } else { [Math]::Max(2, [int][Math]::Round(8 * [double]$script:Cfg.zoom)) }
    $st = Get-State
    if ($null -eq $st -or -not $st.petLines) {
        [void][System.Windows.Forms.MessageBox]::Show("讀不到 daemon 的 /state（petLines）。daemon 沒在跑？", 'vpet mini'); return }
    $p = Get-Panel
    # 折返走的範圍＝小視窗面板的寬
    $script:petRange = @{ l = $form.Left + $p.x; r = $form.Left + $p.x + $p.w; y = $form.Top + $p.y + $p.h }
    # 站的位置＝小視窗裡那隻此刻畫在螢幕上的位置（2026-10-22 玩家回報「縮下去會往下掉」：v15 是站在面板下緣）：
    #   頁面把整張畫面（52×16 格）畫在 #pet 畫布上，畫布框（CSS px）÷格數＝每格幾 CSS px（預期 8），角色左上＝框左上＋裁掉的格數×每格，再×畫面縮放＝螢幕 px。
    #   以「腳底中心」對位：預設倍率下跟視窗裡那隻一樣大 → 疊在原地；滾輪改過倍率就腳站同一點、身體按倍率長
    $img0 = Parse-PetLines $st.petLines; $z = [double]$script:Cfg.zoom; $how = 'panel-bottom'
    $bx = [double]($script:petRange.l + $p.w / 2.0); $by = [double]$script:petRange.y
    if ($script:PetCv -and $img0 -and $img0.fw -gt 0 -and $img0.fh -gt 0 -and [Math]::Abs([double]$script:PetCv[2] / $img0.fw - [double]$script:PetCv[3] / $img0.fh) -lt 0.2) {   # 格子要方正，不方正＝畫布還沒照這張畫面畫
        $sx = [double]$script:PetCv[2] / $img0.fw; $sy = [double]$script:PetCv[3] / $img0.fh
        $bx = $form.Left + ([double]$script:PetCv[0] + ($img0.ox + $img0.w / 2.0) * $sx) * $z
        $by = $form.Top + ([double]$script:PetCv[1] + ($img0.oy + $img0.h) * $sy) * $z
        $script:petRange.y = [int][Math]::Round($by); $how = ('canvas cv={0},{1} {2}x{3} cell={4:0.##}x{5:0.##} crop={6},{7}' -f $script:PetCv[0], $script:PetCv[1], $script:PetCv[2], $script:PetCv[3], $sx, $sy, $img0.ox, $img0.oy)
    }
    $script:petMode = $true; $script:petTick = 0; $script:petDir = -1; $script:petArrived = $false; $script:petFleeing = $false; $script:petTween = $null; $script:petFx = 0.0; $script:petFy = 0.0
    $pet.ClientSize = New-Object System.Drawing.Size(16, 16)
    $pet.Location = New-Object System.Drawing.Point(([int][Math]::Round($bx) - 8), ([int][Math]::Round($by) - 16))   # Refresh-Pet 會以底邊、水平中心不動長成實際大小
    Refresh-Pet $st
    $tag.Hide(); $btn.Hide(); $grip.Hide(); $form.Hide(); $pet.Show(); $script:petTimer.Start()
    if ($env:VPET_MINI_DEBUG -and $pbox.Image) { try { $pbox.Image.Save((Join-Path $here '_pet_enter.png')) } catch {} }   # 進入那一刻的圖（對位測試拿它跟進入前的截圖比）
    if ($env:VPET_MINI_DEBUG) { Add-Content (Join-Path $here '_fit.log') ("{0:HH:mm:ss.fff} pet enter: char={1} range={2}..{3} y={4} at {5},{6} {7}x{8} scale={9} z={10} form={11},{12} how={13}" -f (Get-Date), $script:lastChar, $script:petRange.l, $script:petRange.r, $script:petRange.y, $pet.Left, $pet.Top, $pet.Width, $pet.Height, $script:petScale, $z, $form.Left, $form.Top, $how) }
}
function Leave-Pet {
    if (-not $script:petMode) { return }
    if ($script:petAlert) { $script:eventPulled = $true }   # 點了頭上冒「❗」的牠 = 被事件叫回來的
    $script:petAlert = $false
    $script:petTimer.Stop(); $script:petMode = $false; $pet.Hide()
    $form.Show(); $tag.Show(); $grip.Show(); Place-Handles; $form.Activate()
    if ($env:VPET_MINI_DEBUG) { Add-Content (Join-Path $here '_fit.log') ("{0:HH:mm:ss.fff} pet leave" -f (Get-Date)) }
}
$script:petTimer = New-Object System.Windows.Forms.Timer; $script:petTimer.Interval = $PET_TICK_MS
$script:petTimer.add_Tick({
    if (-not $script:petMode) { return }
    try { Pet-Tick } catch { if ($env:VPET_MINI_DEBUG) { Add-Content (Join-Path $here '_err.log') ("{0:HH:mm:ss.fff} pet tick: {1}`n{2}" -f (Get-Date), $_.Exception.Message, $_.ScriptStackTrace) } }
})
function Pet-Tick {
    $script:petTick++
    if (($script:petTick % $PET_POLL_TICKS) -eq 0) { Refresh-Pet $null }
    if (-not $script:petSingle) { return }   # 睡覺／戰鬥／進化：原地不動，看遊戲演
    if ($script:petAlert) { return }         # 頭上冒「❗」：停下來等點（不追滑鼠）
    if ($script:Cfg.petFollow) {
        $cp = [System.Windows.Forms.Cursor]::Position
        $cx = $pet.Left + $pet.Width / 2.0; $cy = $pet.Top + $pet.Height / 2.0
        $dx = $cp.X - $cx; $dy = $cp.Y - $cy; $dist = [Math]::Sqrt($dx * $dx + $dy * $dy)
        if ([Math]::Abs($dx) -gt 2) { Set-PetDir $(if ($dx -gt 0) { 1 } else { -1 }) }   # 面朝滑鼠（翻圖不算移動，每拍都可以）
    }
    if (-not $script:petStep) {
        if ($script:petTween) { Move-PetBy $script:petTween.vx $script:petTween.vy; $script:petTween.n--; if ($script:petTween.n -le 0) { $script:petTween = $null } }   # 補間中：每拍走一小段
        return
    }
    $script:petStep = $false
    if ($script:petTween) { Move-PetBy ($script:petTween.vx * $script:petTween.n) ($script:petTween.vy * $script:petTween.n); $script:petTween = $null }   # 新的一幀來了還沒走完：補完
    $cell = [Math]::Max(1, [int]$script:petScale)
    if ($script:Cfg.petFollow) {
        $stopAt = [Math]::Max(40, $pet.Width * $PET_STOP_BODY); $fleeAt = $stopAt * $PET_FLEE_RATIO
        # 躲（有遲滯）：進 fleeAt 開始躲，躲到 fleeAt×2 才停；躲完當作「已到達」，滑鼠離開 RESUME 再追
        if ($script:petFleeing) { if ($dist -ge $fleeAt * $PET_FLEE_ESCAPE) { $script:petFleeing = $false; $script:petArrived = $true } }
        elseif ($dist -gt 0 -and $dist -lt $fleeAt) { $script:petFleeing = $true }
        if (-not $script:petFleeing) {
            if ($script:petArrived) { if ($dist -gt $PET_FOLLOW_RESUME) { $script:petArrived = $false } }
            elseif ($dist -le $stopAt) { $script:petArrived = $true }
        }
        $mv = 0.0
        if ($script:petFleeing) { $mv = -1.0 * $PET_FLEE_CELLS * $cell }                                                     # 反方向
        elseif (-not $script:petArrived -and $dist -gt 0) { $n = [Math]::Max(1, [Math]::Min($PET_FOLLOW_MAX_CELLS, [int][Math]::Round($dist / $PET_FOLLOW_CELL_DIV))); $mv = [Math]::Min([double]($n * $cell), $dist - $stopAt + 1) }
        if ($mv -ne 0 -and $dist -gt 0) {
            $tx = $dx / $dist * $mv; $ty = $dy / $dist * $mv
            if ([Math]::Abs($mv) -ge ($PET_TWEEN_CELLS * $cell)) {   # 大步：分拍走（補間）
                $script:petTween = @{ vx = $tx / $PET_TWEEN_TICKS; vy = $ty / $PET_TWEEN_TICKS; n = $PET_TWEEN_TICKS }
                Move-PetBy $script:petTween.vx $script:petTween.vy; $script:petTween.n--
            } else { Move-PetBy $tx $ty }                                # 小步：一幀一跳
        }
        return
    }
    # 沒跟隨滑鼠就在面板寬度內折返走，一幀一格（「原地不動」開關 2026-10-22 使用者決定拿掉）
    $nx = $pet.Left + $script:petDir * $PET_PATROL_CELLS * $cell
    if ($nx -lt $script:petRange.l) { $nx = $script:petRange.l; Set-PetDir 1 }
    if (($nx + $pet.Width) -gt $script:petRange.r) { $nx = $script:petRange.r - $pet.Width; Set-PetDir -1 }
    $pet.Left = $nx
}
# 點牠一下 → 小視窗回來；按住拖 → 搬牠（折返範圍跟著移）
$script:petDrag = $null; $script:petMoved = $false
$petDown = { param($s, $e) if ($e.Button -eq 'Left') { $script:petDrag = [System.Windows.Forms.Cursor]::Position; $script:petMoved = $false; $script:petOrig = $pet.Location } }
$petMove = { param($s, $e) if ($script:petDrag -and $e.Button -eq 'Left') { $cp = [System.Windows.Forms.Cursor]::Position
        if ([Math]::Abs($cp.X - $script:petDrag.X) -gt 3 -or [Math]::Abs($cp.Y - $script:petDrag.Y) -gt 3) { $script:petMoved = $true }
        if ($script:petMoved) { $pet.Location = New-Object System.Drawing.Point(($script:petOrig.X + $cp.X - $script:petDrag.X), ($script:petOrig.Y + $cp.Y - $script:petDrag.Y)) } } }
$petUp = { param($s, $e) if ($script:petDrag) { $script:petDrag = $null
        if ($script:petMoved) {   # 搬完：折返範圍平移到新位置、小視窗回來時也開在對應位置
            $dx = $pet.Left - $script:petOrig.X; $dy = $pet.Top - $script:petOrig.Y
            $script:petRange.l += $dx; $script:petRange.r += $dx; $script:petRange.y += $dy
            $form.Location = New-Object System.Drawing.Point(($form.Left + $dx), ($form.Top + $dy)); $script:Cfg.x = $form.Left; $script:Cfg.y = $form.Top; Save-Cfg }
        elseif ($e.Button -eq 'Left') { Leave-Pet } } }
$pbox.add_MouseDown($petDown); $pbox.add_MouseMove($petMove); $pbox.add_MouseUp($petUp)
# 滾輪改桌面小寵物大小（一格一級、2～16 倍），存 petScale；回小視窗的縮放不受影響（v16，使用者要的）
function Set-PetScale([int]$k) {
    $k = [Math]::Max(2, [Math]::Min(16, $k)); if ($k -eq $script:petScale) { return }
    $script:petScale = $k; $script:Cfg.petScale = $k; Save-Cfg
    if ($script:petMode) { Refresh-Pet $null }
    if ($env:VPET_MINI_DEBUG) { Add-Content (Join-Path $here '_fit.log') ("{0:HH:mm:ss.fff} pet scale -> {1}" -f (Get-Date), $k) }
}
$petWheel = { param($s, $e) if ($e.Delta -gt 0) { Set-PetScale ($script:petScale + 1) } elseif ($e.Delta -lt 0) { Set-PetScale ($script:petScale - 1) } }
$pbox.add_MouseWheel($petWheel); $pet.add_MouseWheel($petWheel)
$petMenu = New-Object System.Windows.Forms.ContextMenuStrip
$pm1 = $petMenu.Items.Add('打開小視窗'); $pm1.add_Click({ Leave-Pet })
$script:pmFollow = $petMenu.Items.Add('跟隨滑鼠'); $script:pmFollow.Checked = [bool]$script:Cfg.petFollow
$script:pmFollow.add_Click({ Apply-Follow (-not $script:Cfg.petFollow); Save-Cfg })
[void]$petMenu.Items.Add('-')
$pm3 = $petMenu.Items.Add('結束 vpet mini'); $pm3.add_Click({ $form.Close() })
$pbox.ContextMenuStrip = $petMenu

# ── 形狀與位置 ──
function Get-Panel {
    # 「面板」= 面積達最大者一半以上的實體矩形裡最左邊那個（右欄整塊顯示時面積可能比左面板大，把手不該跳過去）；沒資料就用整個視窗
    $best = $null; $ba = 0
    foreach ($q in $script:Rects) { $a = [double]$q[2] * [double]$q[3]; if ($a -gt $ba) { $ba = $a } }
    foreach ($q in $script:Rects) { $a = [double]$q[2] * [double]$q[3]; if ($a -ge $ba * 0.5 -and ($null -eq $best -or [double]$q[0] -lt [double]$best[0])) { $best = $q } }
    $z = [double]$script:Cfg.zoom
    if ($best) { return @{ x = [int]([double]$best[0] * $z); y = [int]([double]$best[1] * $z); w = [int]([double]$best[2] * $z); h = [int]([double]$best[3] * $z) } }
    return @{ x = 0; y = 0; w = $form.Width; h = $form.Height }
}
function Get-Bar {
    # 頂端橫列：面板上方、x 範圍跟面板重疊的實體矩形（頁面的「Vpet daemon」標題列）→ 從面板左緣到右緣、頂到那些矩形的最高點，
    # 補成一整條（露出的是頁面 body 的深色底，不注入）。找不到標題列（高度不在 8～80 px）就沒有橫列，小標籤照舊貼面板上方
    if (-not $script:Rects -or $script:Rects.Count -eq 0) { return $null }
    $p = Get-Panel; $z = [double]$script:Cfg.zoom; $top = -1.0
    # 優先用頁面回報的標題盒子（h1 含內距）：實體矩形只量到文字那一行，會少掉上方內距、橫列就不對稱
    if ($script:TitleBox) { $q = $script:TitleBox; $qx = [double]$q[0] * $z; $qy = [double]$q[1] * $z; $qw = [double]$q[2] * $z; $qh = [double]$q[3] * $z
        if (($qy + $qh) -le ($p.y + 1) -and $qx -lt ($p.x + $p.w) -and ($qx + $qw) -gt $p.x) { $top = $qy } }
    if ($top -lt 0) { foreach ($q in $script:Rects) {
        $qx = [double]$q[0] * $z; $qy = [double]$q[1] * $z; $qw = [double]$q[2] * $z; $qh = [double]$q[3] * $z
        if (($qy + $qh) -le ($p.y + 1) -and $qx -lt ($p.x + $p.w) -and ($qx + $qw) -gt $p.x) { if ($top -lt 0 -or $qy -lt $top) { $top = $qy } }
    } }
    if ($top -lt 0) { return $null }
    $h = $p.y - [int][Math]::Floor($top)
    if ($h -lt 8 -or $h -gt 80) { return $null }
    return @{ x = $p.x; y = ($p.y - $h); w = $p.w; h = $h }
}
# 標籤字級跟頁面標題一致：標題字級（CSS px，頁面回報）× 畫面縮放 = 螢幕 px；有橫列時按鈕高＝橫列高−2、對橫列置中
# （標題行由 $STYLE 改成上下對稱，所以也在橫列正中間 → 兩段字同一條中線）
$script:TitleFs = 0; $script:tagPx = 0; $script:tagBarH = -1
function Update-TagFont([int]$barH) {
    $px = if ($script:TitleFs -gt 0) { [int][Math]::Round($script:TitleFs * [double]$script:Cfg.zoom) } else { 11 }
    $px = [Math]::Max(9, [Math]::Min(24, $px))
    if ($px -eq $script:tagPx -and $barH -eq $script:tagBarH) { return }
    $script:tagPx = $px; $script:tagBarH = $barH
    # 字型跟頁面標題同家族（body 是 ui-monospace,Consolas,monospace；h1 粗體）：同字級下 Segoe UI 的字形比等寬字大一圈，光對字級看起來還是不一樣大
    $fam = 'Consolas'; try { $null = New-Object System.Drawing.FontFamily($fam) } catch { $fam = 'Segoe UI' }
    $font = New-Object System.Drawing.Font($fam, [single]$px, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $th = [System.Windows.Forms.TextRenderer]::MeasureText('☰ vpet 100%', $font).Height
    # 按鈕不能比橫列高：裝不下就逐 px 縮字
    while ($barH -gt 0 -and ($th + 4) -gt $barH -and $px -gt 9) { $px--; $font = New-Object System.Drawing.Font($fam, [single]$px, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel); $th = [System.Windows.Forms.TextRenderer]::MeasureText('☰ vpet 100%', $font).Height }
    $script:tagH = if ($barH -gt 0) { $barH - 2 } else { $th + 4 }
    if ($env:VPET_MINI_DEBUG) { Add-Content (Join-Path $here '_fit.log') ("{0:HH:mm:ss.fff} tagfont fam={1} tfs={2} z={3} px={4} th={5} tagH={6} barH={7}" -f (Get-Date), $fam, $script:TitleFs, $script:Cfg.zoom, $px, $th, $script:tagH, $barH) }
    $lbl.Font = $font; Fit-Tag
    $blbl.Font = $font; Fit-Btn
}
function Place-Handles {
    $p = Get-Panel; $bar = Get-Bar
    Update-TagFont $(if ($bar) { [int]$bar.h } else { 0 })
    if ($bar) { $tx = [Math]::Max(0, $bar.x + $bar.w - $tag.Width - 2); $ty = $bar.y + [int](($bar.h - $tag.Height) / 2) }
    else      { $tx = [Math]::Max(0, $p.x + $p.w - $tag.Width); $ty = $p.y - $tag.Height; if ($ty -lt 0) { $ty = $p.y } }
    $tag.Location  = New-Object System.Drawing.Point(($form.Left + $tx), ($form.Top + $ty))
    # 「桌寵」按鈕貼在小標籤左邊 4 px；左緣壓到頁面標題（h1 盒子右緣）或面板左緣就不顯示（50% 時會擠）
    $bx0 = $tx - $btn.Width - 4; $limit = $p.x + 4
    if ($script:TitleText -and $bar) { $limit = [Math]::Max($limit, [int](([double]$script:TitleText[0] + [double]$script:TitleText[1]) * [double]$script:Cfg.zoom) + 4) }   # 標題「文字」的右緣（h1 盒子是整列寬，不能拿它比）
    $script:btnFits = ($bx0 -ge $limit)
    $btn.Location = New-Object System.Drawing.Point(($form.Left + $bx0), ($form.Top + $ty))
    if ($script:btnFits) { if ($tag.Visible -and -not $btn.Visible) { $btn.Show() } } elseif ($btn.Visible) { $btn.Hide() }
    $grip.Location = New-Object System.Drawing.Point(($form.Left + [Math]::Max(0, $p.x + $p.w - $GRIP_PX)), ($form.Top + [Math]::Max(0, $p.y + $p.h - $GRIP_PX)))
}
function Apply-Region {
    if (-not $script:Rects -or $script:Rects.Count -eq 0) { $form.Region = $null; return }
    $z = [double]$script:Cfg.zoom
    $reg = $null
    foreach ($q in $script:Rects) {
        $x = [int][Math]::Floor([double]$q[0] * $z); $y = [int][Math]::Floor([double]$q[1] * $z)
        $w = [int][Math]::Ceiling([double]$q[2] * $z) + 1; $h = [int][Math]::Ceiling([double]$q[3] * $z) + 1
        $r1 = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
        if ($null -eq $reg) { $reg = New-Object System.Drawing.Region($r1) } else { $reg.Union($r1) }
    }
    $bar = Get-Bar
    if ($bar) { $reg.Union((New-Object System.Drawing.Rectangle($bar.x, $bar.y, ($bar.w + 1), ($bar.h + 1)))) }
    if ($env:VPET_MINI_DEBUG) { Add-Content (Join-Path $here '_fit.log') ("{0:HH:mm:ss.fff} bar={1}" -f (Get-Date), $(if ($bar) { "$($bar.x),$($bar.y) $($bar.w)x$($bar.h)" } else { 'none' })) }
    $old = $form.Region; $form.Region = $reg; if ($old) { $old.Dispose() }
    if ($env:VPET_MINI_DEBUG) { $gfx = $form.CreateGraphics(); $bb = $reg.GetBounds($gfx); $gfx.Dispose(); Add-Content (Join-Path $here '_fit.log') ("{0:HH:mm:ss.fff} region rects={1} bounds={2},{3} {4}x{5} form={6}x{7} wv={8}x{9}" -f (Get-Date), $script:Rects.Count, [int]$bb.X, [int]$bb.Y, [int]$bb.Width, [int]$bb.Height, $form.Width, $form.Height, $wv.Width, $wv.Height) }
}
$script:lastFit = ''
function Apply-Fit([int]$cw, [int]$ch) {
    $z = [double]$script:Cfg.zoom
    # 寬度多留 24 px（垂直捲軸 17＋餘裕 7）：右欄顯示時若視窗剛好等寬，右欄先被擠到下面 → 內容變高 → 冒捲軸吃掉 17 px → 右欄永遠排不到旁邊（自我鎖死）。
    # 高度多留 4 px。面板外是洞，多留的看不見。
    $w = [int][Math]::Ceiling($cw * $z) + 2 + 24
    $h = [int][Math]::Ceiling($ch * $z) + 2 + 4
    $wa = [System.Windows.Forms.Screen]::FromControl($form).WorkingArea
    $w = [Math]::Min($w, $wa.Width); $h = [Math]::Min($h, $wa.Height)
    if ($script:rs) { return }            # 拖曳縮放中：先別跟使用者的手搶視窗尺寸
    $key = "$w x $h"
    if ($key -eq $script:lastFit) { return }
    $script:lastFit = $key
    if ($env:VPET_MINI_DEBUG) { Add-Content (Join-Path $here '_fit.log') ("{0:HH:mm:ss.fff} fit {1}x{2} -> {3}x{4}  content {5}x{6} z={7}" -f (Get-Date), $form.Width, $form.Height, $w, $h, $cw, $ch, $z) }
    $form.Size = New-Object System.Drawing.Size([Math]::Max(160, $w), [Math]::Max(80, $h))
    $script:Cfg.w = $form.Width; $script:Cfg.h = $form.Height
    # 變大後超出螢幕就往內推（閱讀縮放、進化樹這類場景會撐大）
    $nx = [Math]::Max($wa.Left, [Math]::Min($form.Left, $wa.Right - $form.Width)); $ny = [Math]::Max($wa.Top, [Math]::Min($form.Top, $wa.Bottom - $form.Height))
    if ($nx -ne $form.Left -or $ny -ne $form.Top) { $form.Location = New-Object System.Drawing.Point($nx, $ny) }
    Apply-Region; Place-Handles
    if (-not $script:fitted) { $script:fitted = $true; $form.Opacity = 1; $tag.Show(); $grip.Show(); Place-Handles; $form.Activate() }   # 啟動前被叫縮成桌寵的，在量測訊息那邊等畫布畫過再縮
}
$form.add_LocationChanged({ Place-Handles })
$form.add_SizeChanged({ Place-Handles })

# ── 拖曳移動（小標籤、墊板那一圈）──
$script:drag = $null; $script:dragFrom = $null; $script:dragMoved = $false
$dragDown = { param($s, $e) if ($e.Button -eq 'Left') { $script:drag = New-Object System.Drawing.Point($e.X, $e.Y); $script:dragFrom = [System.Windows.Forms.Cursor]::Position; $script:dragMoved = $false } }
$dragMove = { param($s, $e)
    if ($script:drag -and $e.Button -eq 'Left') {
        $cp = [System.Windows.Forms.Cursor]::Position
        if ([Math]::Abs($cp.X - $script:dragFrom.X) -gt 3 -or [Math]::Abs($cp.Y - $script:dragFrom.Y) -gt 3) { $script:dragMoved = $true }
        $form.Location = New-Object System.Drawing.Point(($form.Left + $e.X - $script:drag.X), ($form.Top + $e.Y - $script:drag.Y))
    } }
# 放開：有移動 = 拖曳結束（存位置）；沒移動 = 點一下 → 開選單（左鍵也能開，不只右鍵）
$dragUp = { param($s, $e) if ($script:drag) { $script:drag = $null
        if ($script:dragMoved) { $script:Cfg.x = $form.Left; $script:Cfg.y = $form.Top; Save-Cfg }
        elseif ($e.Button -eq 'Left') { $menu.Show($lbl, (New-Object System.Drawing.Point(0, $lbl.Height))) } } }
foreach ($c in @($tag, $lbl)) { $c.add_MouseDown($dragDown); $c.add_MouseMove($dragMove); $c.add_MouseUp($dragUp) }
# 「桌寵」按鈕：按住拖＝搬視窗；沒移動放開＝縮成桌寵
$btnUp = { param($s, $e) if ($script:drag) { $script:drag = $null
        if ($script:dragMoved) { $script:Cfg.x = $form.Left; $script:Cfg.y = $form.Top; Save-Cfg }
        elseif ($e.Button -eq 'Left') { Enter-Pet } } }
foreach ($c in @($btn, $blbl)) { $c.add_MouseDown($dragDown); $c.add_MouseMove($dragMove); $c.add_MouseUp($btnUp) }

# ── 小方塊拖曳 = 整頁等比例縮放 ──
$script:rs = $null; $script:rsTarget = $null
$grip.add_MouseDown({ param($s, $e) if ($e.Button -eq 'Left') {
    $script:rs = @{ x = [System.Windows.Forms.Cursor]::Position.X; y = [System.Windows.Forms.Cursor]::Position.Y; w = $form.Width; h = $form.Height }
    $form.SuspendLayout()   # 拖曳中只改外框、不重排 WebView，放開再一次排好
} })
# 真滑鼠每秒上百個事件，每個都改尺寸會跟不上（事件排隊、放開後還在慢慢跑）→ 只記目標，60 ms 計時器合併套用
$grip.add_MouseMove({ param($s, $e)
    if ($script:rs -and $e.Button -eq 'Left') {
        $p = [System.Windows.Forms.Cursor]::Position
        $script:rsTarget = @{ w = [Math]::Max(160, $script:rs.w + $p.X - $script:rs.x); h = [Math]::Max(80, $script:rs.h + $p.Y - $script:rs.y) }
    } })
$script:rsTimer = New-Object System.Windows.Forms.Timer
$script:rsTimer.Interval = 60
$script:rsTimer.add_Tick({
    if ($script:rs -and $script:rsTarget) {
        $t = $script:rsTarget; $script:rsTarget = $null
        if ($form.Width -ne $t.w -or $form.Height -ne $t.h) { $form.Size = New-Object System.Drawing.Size([int]$t.w, [int]$t.h) }
        Set-Tag (Tag-Text (($t.w - 26) / [Math]::Max(1, $script:ContentW))) $null
    }
})
$script:rsTimer.Start()
# 放開才套用：拖到多寬，整頁縮放比例 = 視窗寬 ÷ 內容寬（CSS px）；高度交給自動貼合
function Grip-Release {
    $script:rs = $null
    try { $form.ResumeLayout($true) } catch {}
    if ($script:ContentW -gt 0) {
        $z = ($form.Width - 26) / [double]$script:ContentW
        $z = [Math]::Round([Math]::Max($script:ZOOM_MIN, [Math]::Min($script:ZOOM_MAX, $z)), 2)
        $script:Cfg.zoom = $z
        if ($wv.CoreWebView2) { $wv.ZoomFactor = $z }
        $script:lastFit = ''
        Apply-Fit $script:ContentW $script:ContentH
        Set-Tag (Tag-Text $z) $null
    }
    Save-Cfg
}
$grip.add_MouseUp({ param($s, $e) if ($script:rs) { Grip-Release } })

# ── 量內容的腳本（只量不改）──
$MEASURE = @'
(function(){
  // 量「內容」的右緣，不是「容器」的：撐滿父層寬度的區塊往下找子元素，沒有子元素就用 Range 量文字本身；
  // flex-wrap 容器若被擠成多列，算它「全排一列」要的寬，右欄顯示時視窗會變寬讓它排在旁邊。不綁任何 id／class。
  function px(v){ return parseFloat(v)||0; }
  function skip(s){ return s.display==='none'||s.visibility==='hidden'||s.position==='fixed'||s.position==='absolute'; }
  // overflow 不是 visible 的元素把子元素裁在框內（戰鬥時畫布原始寬 832，面板 overflow:hidden 裁掉縮放顯示），不能量到框外
  function clipR(s, bb, v){ return (s.overflow!=='visible' || s.overflowX!=='visible') ? Math.min(v, bb.right + window.scrollX) : v; }
  function rightOf(el){
    var s=getComputedStyle(el); if(skip(s)) return 0;
    var bb=el.getBoundingClientRect(); if(bb.width<=0||bb.height<=0) return 0;
    var p=el.parentElement, pr=p?p.getBoundingClientRect():null;
    var stretched = pr && (pr.right - bb.right) <= px(getComputedStyle(p).paddingRight) + 1;
    if(!stretched) return bb.right + window.scrollX;
    var pad = px(s.paddingRight) + px(s.borderRightWidth), r=0, kids=el.children;
    if(s.display.indexOf('flex')>=0 && s.flexWrap==='wrap' && kids.length>1){
      var sum=px(s.paddingLeft)+px(s.borderLeftWidth), gap=px(s.columnGap)||px(s.gap)||0, n=0;
      for(var k=0;k<kids.length;k++){ var ks=getComputedStyle(kids[k]); if(skip(ks)) continue;
        var kb=kids[k].getBoundingClientRect(); if(kb.width<=0) continue;
        sum += kb.width + px(ks.marginLeft) + px(ks.marginRight); n++; }
      if(n>1){ sum += gap*(n-1); return clipR(s, bb, bb.left + window.scrollX + sum + pad); }
    }
    if(kids.length===0){
      var rg=document.createRange(); rg.selectNodeContents(el); var rb=rg.getBoundingClientRect();
      return rb.width>0 ? clipR(s, bb, rb.right + window.scrollX + pad) : 0;
    }
    for(var i=0;i<kids.length;i++) r=Math.max(r, rightOf(kids[i]));
    return r>0 ? clipR(s, bb, r + pad) : 0;
  }
  // 高度：flex-wrap 容器若此刻被擠成多列，用「最高的那個子元素」當它的高，不然會量到上下疊起來的高度
  function bottomOf(el){
    var s=getComputedStyle(el), bb=el.getBoundingClientRect(), kids=el.children;
    if(s.display.indexOf('flex')>=0 && s.flexWrap==='wrap' && kids.length>1){
      var sum=0, maxH=0, n=0, gap=px(s.columnGap)||px(s.gap)||0;
      for(var k=0;k<kids.length;k++){ var ks=getComputedStyle(kids[k]); if(skip(ks)) continue;
        var kb=kids[k].getBoundingClientRect(); if(kb.width<=0) continue;
        sum += kb.width + px(ks.marginLeft) + px(ks.marginRight); maxH=Math.max(maxH, kb.height+px(ks.marginTop)+px(ks.marginBottom)); n++; }
      if(n>1) sum += gap*(n-1);   // 少算 gap 會把「剛好因 gap 而換列」當成沒換列
      if(n>1 && sum > bb.width - px(s.paddingLeft) - px(s.paddingRight) + 1){
        return bb.top + window.scrollY + px(s.paddingTop)+px(s.borderTopWidth) + maxH + px(s.paddingBottom)+px(s.borderBottomWidth);
      }
    }
    return bb.bottom + window.scrollY;
  }
  // 實體區塊：有底色／背景圖／邊框的元素、畫布／圖片／表單控件 → 整塊；其餘往下找，文字節點用每行矩形。
  // 從 body 的子元素開始（body 自己有底色，算進去就沒有洞）。殼拿這些矩形做視窗形狀。
  function solidRects(){
    var out=[], n=0;
    function addR(b){ if(b.width<=0||b.height<=0) return; out.push([Math.floor(b.left+window.scrollX),Math.floor(b.top+window.scrollY),Math.ceil(b.width),Math.ceil(b.height)]); n++; }
    function isSolid(el,s){
      var t=el.tagName; if(t==='CANVAS'||t==='IMG'||t==='SVG'||t==='VIDEO'||t==='INPUT'||t==='BUTTON'||t==='SELECT'||t==='TEXTAREA') return true;
      var bg=s.backgroundColor; if(bg&&bg!=='transparent'&&!/^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)$/.test(bg)) return true;
      if(s.backgroundImage&&s.backgroundImage!=='none') return true;
      if((parseFloat(s.borderTopWidth)||0)>0&&s.borderTopStyle!=='none') return true;
      return false;
    }
    function walk(el){
      if(n>400) return; var s=getComputedStyle(el);
      if(s.display==='none'||s.visibility==='hidden'||parseFloat(s.opacity)===0) return;
      var bb=el.getBoundingClientRect(); if(bb.width<=0||bb.height<=0) return;
      if(isSolid(el,s)){ addR(bb); return; }
      var start=out.length;
      for(var i=0;i<el.childNodes.length;i++){ var c=el.childNodes[i];
        if(c.nodeType===1) walk(c);
        else if(c.nodeType===3&&c.nodeValue.trim()){ var rg=document.createRange(); rg.selectNodeContents(c); var cr=rg.getClientRects(); for(var k=0;k<cr.length;k++) addR(cr[k]); }
      }
      // 沒底色的區塊若底下湊出 6 個以上的小矩形（例如右欄那種整欄文字），改用它整塊的外框，不然一行行文字之間都是洞
      if(out.length-start>=6){ out.length=start; n=start; addR(bb); }
    }
    var b=document.body; if(b){ for(var i=0;i<b.children.length;i++) walk(b.children[i]); }
    return out;
  }
  function m(){
    try{
      var b=document.body; if(!b) return;
      var cs=getComputedStyle(b), pr=px(cs.paddingRight), pb=px(cs.paddingBottom);
      var r=0,btm=0;
      for(var i=0;i<b.children.length;i++){
        var el=b.children[i], s=getComputedStyle(el); if(skip(s)) continue;
        var bb=el.getBoundingClientRect(); if(bb.width<=0||bb.height<=0) continue;
        r=Math.max(r, rightOf(el)); btm=Math.max(btm, bottomOf(el));
      }
      // 浮層（position:fixed／absolute 的彈窗、紀念照卡、對話泡）超出視窗時，視窗要長到放得下它：
      // 看每個可見浮層子樹裡的元素，只有「超出視窗邊緣」的才算（整個在視窗內的不用管，撐滿視窗的遮罩層也不算）→ 需要的寬／高 = 它的寬／高 + 24
      var vw=document.documentElement.clientWidth, vh=document.documentElement.clientHeight, needW=0, needH=0;
      function overlayNeed(el, depth){
        if(depth>6) return; var s=getComputedStyle(el);
        if(s.display==='none'||s.visibility==='hidden'||parseFloat(s.opacity)===0) return;
        var bb=el.getBoundingClientRect();
        if(bb.width>0&&bb.height>0){
          // 不看位置看尺寸：跟視窗剛好等寬／等高的是遮罩層（inset:0），其餘都算需求。看位置會來回跳（長高後就「不超出」、需求歸零又縮回）
          if(Math.abs(bb.width-vw)>2 && bb.width<2000) needW=Math.max(needW, bb.width+24);
          if(Math.abs(bb.height-vh)>2 && bb.height<2000) needH=Math.max(needH, bb.height+24);
        }
        for(var k=0;k<el.children.length;k++) overlayNeed(el.children[k], depth+1);
      }
      for(var j=0;j<b.children.length;j++){ var oe=b.children[j], os=getComputedStyle(oe);
        if((os.position==='fixed'||os.position==='absolute') && os.display!=='none' && os.visibility!=='hidden') overlayNeed(oe, 0); }
      var W=Math.max(Math.ceil(r+pr), Math.ceil(needW)), H=Math.max(Math.ceil(btm+pb), Math.ceil(needH));
      // 頁面標題（h1「Vpet daemon」）的字級（CSS px）：殼的「☰ vpet 75%」按鈕用同字級，看起來同一排。沒有 h1 就 0（殼用預設）
      var h1=document.querySelector('h1'), tfs=h1?(parseFloat(getComputedStyle(h1).fontSize)||0):0, tbox=null;
      if(h1){ var hb=h1.getBoundingClientRect(); if(hb.width>0&&hb.height>0) tbox=[Math.floor(hb.left+window.scrollX),Math.floor(hb.top+window.scrollY),Math.ceil(hb.width),Math.ceil(hb.height)]; }   // 標題整個盒子（含內距），橫列用它的上緣
      // 標題「文字」佔的寬（h1 是整列寬的區塊，盒子右緣不是字的右緣）：殼的「桌寵」按鈕會不會壓到字，看這個
      var ttext=null; if(h1){ try{ var rg=document.createRange(); rg.selectNodeContents(h1); var tr=rg.getBoundingClientRect(); if(tr.width>0) ttext=[tr.left+window.scrollX,tr.width]; }catch(e){} }
      // 前線畫布（最大的那塊）的 CSS 框：進化樹時殼把它鎖回平常的尺寸（object-fit: contain），視窗形狀才不變
      var cvs=document.querySelectorAll('canvas'), scene=null, sa=0;
      for(var ci=0;ci<cvs.length;ci++){ var cst=getComputedStyle(cvs[ci]); if(cst.display==='none'||cst.visibility==='hidden') continue; var cb=cvs[ci].getBoundingClientRect(); if(cb.width<=0||cb.height<=0) continue;
        if(cb.width*cb.height>sa){ sa=cb.width*cb.height; scene=[Math.round(cb.width),Math.round(cb.height)]; } }
      // 前線角色那張畫布（#pet）的 CSS 框：縮成桌寵時角色要疊在它畫的位置上（頁面每格 8 CSS px，殼用框寬÷格數算，不寫死）
      var pc=document.getElementById('pet'), petcv=null;
      if(pc){ var pb=pc.getBoundingClientRect(); if(pb.width>0&&pb.height>0) petcv=[pb.left+window.scrollX,pb.top+window.scrollY,pb.width,pb.height]; }
      if(r>0&&btm>0){ window.chrome.webview.postMessage(JSON.stringify({w:W,h:H,vw:vw,tfs:tfs,tbox:tbox,ttext:ttext,scene:scene,petcv:petcv,rects:solidRects()})); }
    }catch(e){}
  }
  setInterval(m,700); window.addEventListener('load',m);
  // 面板空白處按住 = 拖曳整個視窗：點到的不是互動元件（按鈕、輸入框、連結、畫布、進階指令標題、文字選取）就通知殼，
  // 殼用 ReleaseCapture＋WM_NCLBUTTONDOWN/HTCAPTION 讓 Windows 接手拖曳（無邊框 WebView2 視窗的標準做法）
  function interactive(el){
    for(var e=el; e && e.nodeType===1; e=e.parentElement){
      var t=e.tagName;
      // summary（進階指令那一列）不算互動：按住不動是點（展開／收合），移動超過門檻才是拖曳，兩者由下面的門檻邏輯區分
      if(t==='BUTTON'||t==='A'||t==='INPUT'||t==='SELECT'||t==='TEXTAREA'||t==='CANVAS'||t==='LABEL'||t==='IMG'||t==='VIDEO') return true;
      // data-cmd 只在按鈕類元素上才算互動：vpet把整列 .form 也標了 data-cmd（給列內按鈕讀的），列本身不可點，要能拖
      if(e.getAttribute && (e.getAttribute('onclick')||e.getAttribute('role')==='button'||e.isContentEditable)) return true;
      // 廣場聊天紀錄：要能反白複製，不拖（作者 2026-10-21 併進 repo 時加的，併回）
      if(e.id==='chatlog') return true;
      var cs=getComputedStyle(e); if(cs.cursor==='pointer'||cs.cursor==='grab'||cs.cursor==='move') return true;
    }
    return false;
  }
  // summary（「▸ 進階指令」那一列）整列都是展開／收合的點擊區，但使用者要右邊空白能拖：
  // 量出它文字實際佔到的右緣，按在文字右邊 → 擋掉這次展開／收合、當空白拖；按在文字上 → 照常展開／收合
  function summaryTextRight(sum){ var rg=document.createRange(); rg.selectNodeContents(sum); return rg.getBoundingClientRect().right; }
  function isEmptySpot(target, x){
    var sum = target && target.closest ? target.closest('summary') : null;
    if(sum) return x > summaryTextRight(sum) + 6;
    return !interactive(target);
  }
  window.__vpetIsEmpty = isEmptySpot;   // 測試用（除錯通道可呼叫）
  var suppressClick=false;
  document.addEventListener('mousedown', function(e){
    try{ suppressClick=false; if(e.button!==0 || !isEmptySpot(e.target, e.clientX)) return;
         if(e.target.closest && e.target.closest('summary')) suppressClick=true;   // 萬一 click 還是送到，擋掉展開／收合
         e.preventDefault(); window.chrome.webview.postMessage(JSON.stringify({drag:1})); }catch(x){}
  }, true);
  document.addEventListener('click', function(e){ if(suppressClick){ suppressClick=false; e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  var rt=null; window.addEventListener('resize', function(){ clearTimeout(rt); rt=setTimeout(m,80); });
  var t=null;
  try{ new MutationObserver(function(){ clearTimeout(t); t=setTimeout(m,60); })
         .observe(document.documentElement,{attributes:true,childList:true,subtree:true,attributeFilter:['class','style','open','hidden']}); }catch(e){}
})();
'@

# ── 唯一注入的樣式（2026-10-22，作者同意）：頁面標題 h1 原本「下方 12px 邊距」→ 改成上下各 3px 內距、行高固定，
#    標題行就在橫列正中間，跟右端的 ☰ 按鈕同一條中線；橫列也從 30 CSS px 縮到 24。h1 不在了就沒效果、不會壞。
$STYLE = @'
(function(){
  function add(){
    if(document.getElementById('vpet-mini-style')) return;
    var s=document.createElement('style'); s.id='vpet-mini-style';
    s.textContent='h1{margin:0 !important;padding:3px 0 !important;line-height:1.2 !important}';
    (document.head||document.documentElement).appendChild(s);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',add); else add();
})();
'@

$wv.add_CoreWebView2InitializationCompleted({
    param($s, $e)
    if (-not $e.IsSuccess) { [System.Windows.Forms.MessageBox]::Show("WebView2 啟動失敗：`n$($e.InitializationException.Message)", 'vpet mini') | Out-Null; $form.Close(); return }
    $core = $wv.CoreWebView2
    $core.Settings.AreDefaultContextMenusEnabled = $true
    $core.Settings.IsStatusBarEnabled = $false
    $core.Settings.AreDefaultScriptDialogsEnabled = $false   # 關掉內建對話框，ScriptDialogOpening 才會觸發、交給殼畫
    # 圖鑑／舞台底圖是 window.open 開新分頁 → 交給預設瀏覽器
    # 只放行 http／https：Start-Process 收到 file:／本機路徑會直接執行程式，頁面萬一被塞進惡意內容就是破口（作者 2026-10-21 審查時加的，併回）
    $core.add_NewWindowRequested({ param($s2, $e2) $e2.Handled = $true
        try { $u = [Uri]$e2.Uri; if ($u.Scheme -eq 'http' -or $u.Scheme -eq 'https') { Start-Process $u.AbsoluteUri } } catch {} })
    # 頁面的 confirm／alert／prompt（例如「收進營地」的確認）：WebView2 預設畫在 WebView 裡面，視窗縮小就被切掉；
    # 改由殼接手，用 Windows 自己的對話框顯示（不受縮放與視窗大小影響）
    $core.add_ScriptDialogOpening({ param($s2, $e2)
        try {
            $kind = [string]$e2.Kind
            if ($kind -eq 'Confirm' -or $kind -eq 'Beforeunload') {
                $r = [System.Windows.Forms.MessageBox]::Show($form, $e2.Message, 'vpet', [System.Windows.Forms.MessageBoxButtons]::OKCancel, [System.Windows.Forms.MessageBoxIcon]::Question)
                if ($r -eq [System.Windows.Forms.DialogResult]::OK) { $e2.Accept() }
            } elseif ($kind -eq 'Prompt') {
                Add-Type -AssemblyName Microsoft.VisualBasic
                $txt = [Microsoft.VisualBasic.Interaction]::InputBox($e2.Message, 'vpet', [string]$e2.DefaultText)
                if ($null -ne $txt -and $txt -ne '') { $e2.ResultText = $txt; $e2.Accept() }
            } else {
                [void][System.Windows.Forms.MessageBox]::Show($form, $e2.Message, 'vpet', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
                $e2.Accept()
            }
        } catch { if ($env:VPET_MINI_DEBUG) { Add-Content (Join-Path $here '_err.log') ("{0:HH:mm:ss.fff} dialog: {1}" -f (Get-Date), $_.Exception.Message) } }
    })
    $core.add_WebMessageReceived({ param($s2, $e2)
        try { $m = $e2.WebMessageAsJson | ConvertFrom-Json; $m = $m | ConvertFrom-Json
              if ($m.drag) {   # 面板空白處按住 → 交給 Windows 拖曳整個視窗（會等到放開才回來）
                  if ($env:VPET_MINI_DEBUG) { Add-Content (Join-Path $here '_fit.log') ("{0:HH:mm:ss.fff} drag-start" -f (Get-Date)) }
                  [void][VpetNative]::ReleaseCapture()
                  [void][VpetNative]::SendMessage($form.Handle, 0xA1, [IntPtr]2, [IntPtr]0)
                  $script:Cfg.x = $form.Left; $script:Cfg.y = $form.Top; Save-Cfg
                  return }
              if ($null -ne $m.dbg) { if ($env:VPET_MINI_DEBUG) { Add-Content (Join-Path $here '_fit.log') ("{0:HH:mm:ss.fff} dbg: {1}" -f (Get-Date), $m.dbg) }; return }
              if ($null -eq $m.w) { return }
              if ($env:VPET_MINI_DEBUG) { Add-Content (Join-Path $here '_measure.log') ("{0:HH:mm:ss.fff} w={1} h={2} vw={3} rects={4}" -f (Get-Date), $m.w, $m.h, $m.vw, @($m.rects).Count) }
              if ($m.rects) { $script:Rects = @($m.rects) }
              if ($null -ne $m.tfs -and [double]$m.tfs -gt 0) { $script:TitleFs = [double]$m.tfs }
              $script:TitleBox = if ($m.tbox) { @($m.tbox) } else { $null }
              if ($m.petcv) { $script:PetCv = @($m.petcv) }   # 前線畫布框（CSS px），縮成桌寵時對位用；沒量到就留上一次的
              if ($m.ttext) { $script:TitleText = @($m.ttext) }   # 標題文字的 [left, width]（CSS px）：「桌寵」按鈕放不放得下看它
              # 啟動前就被叫縮成桌寵（系統匣雙擊「桌寵」）：等畫布真的畫過（52×16 格的比例）再縮，不然會對到還沒畫的 480×200 預設框
              if ($script:fitted -and $script:startReq -eq 'pet' -and $script:PetCv -and [double]$script:PetCv[3] -gt 0 -and [Math]::Abs([double]$script:PetCv[2] / [double]$script:PetCv[3] - 3.25) -lt 0.05) { $script:startReq = $null; Save-Cfg; Enter-Pet; return }
              # 進化樹不撐寬（常駐）：內容忽然比平常寬（進化樹 35～92 格 vs 平常 52 格）且場景是 tree → 把前線畫布鎖回平常的框（Set-TreeFit），
              # 這一拍不貼合；下一拍量到的寬高就跟平常一樣，視窗形狀連一拍都不變。樹結束（rzTimer 看到 kind 不是 tree）解鎖。右欄顯示那種變寬不是 tree，不會誤觸。
              $wNew = [int]$m.w
              if (-not $script:treeFit -and $script:homeW -gt 0 -and $wNew -gt ($script:homeW + 8) -and $script:homeScene) {
                  if ($script:lastKind -ne 'tree') { $st0 = Get-State; if ($st0) { $script:lastKind = [string]$st0.kind } }   # 寬度跳了但還沒輪到 1 秒一次的 /state：現在就問
                  if ($script:lastKind -eq 'tree') { Set-TreeFit $true; return }
              }
              if ($script:lastKind -ne 'tree' -and -not $script:treeFit) { $script:homeW = $wNew; if ($m.scene) { $script:homeScene = @($m.scene) } }   # 平常的內容寬與前線畫布框（右欄顯示時會比較寬，那也算平常）
              $script:ContentW = $wNew; $script:ContentH = [int]$m.h; Apply-Fit $script:ContentW $script:ContentH
              Apply-Region; Place-Handles }
        catch { if ($env:VPET_MINI_DEBUG) { Add-Content (Join-Path $here '_err.log') ("{0:HH:mm:ss.fff} {1}`n{2}" -f (Get-Date), $_.Exception.Message, $_.ScriptStackTrace) } }
    })
    $core.add_NavigationCompleted({ param($s2, $e2)
        if (-not $e2.IsSuccess) { Set-Tag "連不到 daemon（localhost:$($script:Port)）— 先雙擊 vpet-standalone.vbs" ([System.Drawing.Color]::FromArgb(255, 255, 90, 90)) }
        else { Set-Tag (Tag-Text ([double]$script:Cfg.zoom)) $null }
    })
    $null = $core.AddScriptToExecuteOnDocumentCreatedAsync($MEASURE)
    $null = $core.AddScriptToExecuteOnDocumentCreatedAsync($STYLE)
    $wv.ZoomFactor = [double]$script:Cfg.zoom
    $core.Navigate($script:HomeUrl)
    # 除錯通道（只在設了 VPET_MINI_DEBUG 時）：_debug_cmd.js 在頁面裡執行；_debug_shell.txt「width N」模擬拖到 N 寬放開。測試不必碰滑鼠
    if ($env:VPET_MINI_DEBUG) {
        $script:dbgTimer = New-Object System.Windows.Forms.Timer; $script:dbgTimer.Interval = 300
        $script:dbgTimer.add_Tick({
            $cf = Join-Path $here '_debug_cmd.js'
            if (Test-Path $cf) { $js = Get-Content $cf -Raw -Encoding UTF8; Remove-Item $cf; try { $null = $wv.CoreWebView2.ExecuteScriptAsync($js) } catch {} }
            $sf = Join-Path $here '_debug_shell.txt'
            if (Test-Path $sf) { $cmd = (Get-Content $sf -Raw -Encoding UTF8).Trim(); Remove-Item $sf
                if ($cmd -match '^width (\d+)$') { $script:rs = @{}; $form.Width = [int]$matches[1]; Grip-Release }
                elseif ($cmd -eq 'follow') { $script:Cfg.petFollow = $true; $script:petArrived = $false; $script:mFollow.Checked = $true; $script:pmFollow.Checked = $true }
                elseif ($cmd -eq 'unfollow') { $script:Cfg.petFollow = $false; $script:mFollow.Checked = $false; $script:pmFollow.Checked = $false }
                elseif ($cmd -match '^petscale ([0-9]+)$') { Set-PetScale ([int]$matches[1]) }
                elseif ($cmd -eq 'pet') { Enter-Pet }
                elseif ($cmd -eq 'unpet') { Leave-Pet }
                elseif ($cmd -eq 'petdump') { if ($pbox.Image) { $pbox.Image.Save((Join-Path $here '_pet_now.png')) } }
                elseif ($cmd -eq 'petpos') { $cp0 = [System.Windows.Forms.Cursor]::Position; Add-Content (Join-Path $here '_fit.log') ("{0:HH:mm:ss.fff} petpos mode={1} at {2},{3} {4}x{5} dir={6} single={7} visible={8} formVisible={9} cursor={10},{11} arrived={12}" -f (Get-Date), $script:petMode, $pet.Left, $pet.Top, $pet.Width, $pet.Height, $script:petDir, $script:petSingle, $pet.Visible, $form.Visible, $cp0.X, $cp0.Y, $script:petArrived) } }
        })
        $script:dbgTimer.Start()
    }
})

# ── 右鍵選單（☰ 按鈕）。結構跟系統匣的一樣（v16，玩家反映兩邊不同很困惑）：
#    開網頁／重新整理 ｜ 小視窗 ▸ ｜ 小寵物 ▸ ｜ 提醒 ▸ ｜ 雙擊圖示開啟 ▸ ｜ 怎麼讓圖示常駐 ｜ 結束
#    「提醒」「雙擊圖示開啟」是系統匣的設定：這裡改了就寫進系統匣的設定檔，系統匣監看檔案變了就套用 ──
function Apply-Zoom([double]$z) {
    $script:Cfg.zoom = $z; if ($wv.CoreWebView2) { $wv.ZoomFactor = $z }; $script:lastFit = ''
    if ($script:ContentW -gt 0) { Apply-Fit $script:ContentW $script:ContentH }
    Set-Tag (Tag-Text $z) $null
}
function Apply-TopMost([bool]$on) { $script:Cfg.topmost = $on; foreach ($f0 in @($form, $tag, $btn, $grip, $pet)) { $f0.TopMost = $on }; if ($script:mTop) { $script:mTop.Checked = $on } }
function Apply-Follow([bool]$on) { $script:Cfg.petFollow = $on; $script:petArrived = $false; if ($script:mFollow) { $script:mFollow.Checked = $on }; if ($script:pmFollow) { $script:pmFollow.Checked = $on } }
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$m1 = $menu.Items.Add('開啟 vpet 網頁視窗'); $m1.add_Click({ Start-Process $script:HomeUrl })   # 名字跟系統匣的同一項一致（2026-10-22 使用者要求）
$m2 = $menu.Items.Add('重新整理'); $m2.add_Click({ if ($wv.CoreWebView2) { $wv.CoreWebView2.Reload() } })
[void]$menu.Items.Add('-')
# 小視窗 ▸
$mWin = New-Object System.Windows.Forms.ToolStripMenuItem('小視窗')
$mZoom = New-Object System.Windows.Forms.ToolStripMenuItem('畫面縮放')   # 原叫「縮放」，同仁看不懂是縮什麼
foreach ($z in 50, 75, 100, 125, 150) {
    $it = $mZoom.DropDownItems.Add("$z%"); $it.Tag = $z
    $it.add_Click({ param($s, $e) Apply-Zoom ([double]$s.Tag / 100.0); Save-Cfg })
}
[void]$mWin.DropDownItems.Add($mZoom)
$mRead = New-Object System.Windows.Forms.ToolStripMenuItem('閱讀縮放（卡片、進化樹暫時放大到）')
foreach ($z in 0, 80, 90, 100, 125) {
    $it = $mRead.DropDownItems.Add($(if ($z -eq 0) { '關' } else { "$z%" })); $it.Tag = $z
    $it.add_Click({ param($s, $e) $script:Cfg.readZoom = [double]$s.Tag / 100.0; Save-Cfg })
}
[void]$mWin.DropDownItems.Add($mRead)
$script:mTop = $mWin.DropDownItems.Add('永遠最上層'); $script:mTop.add_Click({ Apply-TopMost (-not $script:Cfg.topmost); Save-Cfg })
[void]$menu.Items.Add($mWin)
# 小寵物 ▸
$mPetMenu = New-Object System.Windows.Forms.ToolStripMenuItem('小寵物')
$mPet = $mPetMenu.DropDownItems.Add('桌面（點牠就回來）'); $mPet.add_Click({ Enter-Pet })   # 原「縮成小寵物」，2026-10-22 改「桌面」（使用者定的詞；橫列按鈕、系統匣、雙擊選項四處同名）
$script:mFollow = $mPetMenu.DropDownItems.Add('跟隨滑鼠'); $script:mFollow.add_Click({ Apply-Follow (-not $script:Cfg.petFollow); Save-Cfg })
[void]$menu.Items.Add($mPetMenu)
# 提醒 ▸（系統匣的設定）
$mNotify = New-Object System.Windows.Forms.ToolStripMenuItem('提醒')
$script:mNItems = @{}
foreach ($pair in @(@('notifyEvo','進化：跳通知'), @('notifyBattle','戰鬥：跳通知'), @('notifyEvent','事件：跳通知'), @('sound','提示音'), @('autoOpenMini','進化時自動開小視窗'))) {
    $it = $mNotify.DropDownItems.Add($pair[1]); $it.Tag = $pair[0]; $script:mNItems[$pair[0]] = $it
    $it.add_Click({ param($s, $e) $p = Get-TrayPref; Set-TrayPref ([string]$s.Tag) (-not $p[[string]$s.Tag]) })
}
[void]$menu.Items.Add($mNotify)
# 雙擊圖示開啟 ▸（系統匣的設定）
$mDbl = New-Object System.Windows.Forms.ToolStripMenuItem('雙擊圖示開啟')
$script:mDblMini = $mDbl.DropDownItems.Add('小視窗'); $script:mDblMini.add_Click({ Set-TrayPref 'dblClick' 'mini' })
$script:mDblWeb  = $mDbl.DropDownItems.Add('網頁（完整版）'); $script:mDblWeb.add_Click({ Set-TrayPref 'dblClick' 'web' })
$script:mDblPet  = $mDbl.DropDownItems.Add('桌面'); $script:mDblPet.add_Click({ Set-TrayPref 'dblClick' 'pet' })
[void]$menu.Items.Add($mDbl)
$mPin = $menu.Items.Add('怎麼讓圖示常駐顯示？'); $mPin.add_Click({ [void][System.Windows.Forms.MessageBox]::Show($form, $PIN_HINT, '怎麼讓圖示常駐顯示？', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) })
[void]$menu.Items.Add('-')
$mQ = $menu.Items.Add('結束 vpet mini（只關小視窗）'); $mQ.add_Click({ $form.Close() })
# 每次打開選單重讀兩邊的設定，勾勾才是現況（系統匣那邊可能改過）
$menu.add_Opening({
    foreach ($q in $mZoom.DropDownItems) { $q.Checked = ([int]([double]$script:Cfg.zoom * 100) -eq [int]$q.Tag) }
    foreach ($q in $mRead.DropDownItems) { $q.Checked = ([int]([double]$script:Cfg.readZoom * 100) -eq [int]$q.Tag) }
    $script:mTop.Checked = [bool]$script:Cfg.topmost; $script:mFollow.Checked = [bool]$script:Cfg.petFollow
    $p = Get-TrayPref; foreach ($k in $script:mNItems.Keys) { $script:mNItems[$k].Checked = [bool]$p[$k] }
    $script:mDblMini.Checked = ($p.dblClick -ne 'web' -and $p.dblClick -ne 'pet'); $script:mDblWeb.Checked = ($p.dblClick -eq 'web'); $script:mDblPet.Checked = ($p.dblClick -eq 'pet')
})
$tag.ContextMenuStrip = $menu; $lbl.ContextMenuStrip = $menu

$form.add_FormClosed({ $script:Cfg.x = $form.Left; $script:Cfg.y = $form.Top; Save-Cfg; foreach ($f0 in @($tag, $btn, $grip, $pet)) { try { $f0.Close() } catch {} } })

# ── 閱讀縮放：卡片／進化樹這類「有字」的場景，字是vpet畫進 canvas 的點陣，縮小會缺筆畫；
#    每秒看一次 daemon 的 /state（他網頁自己也在用的端點，不綁 id）的 kind，有字場景就暫時升到閱讀縮放，結束回原縮放 ──
$script:TEXT_KINDS = @('card', 'tree')
$script:baseZoom = $null      # 暫時升上去時記住原本的縮放；$null = 沒在暫升
$script:treeFit = $false; $script:homeW = 0; $script:homeScene = $null; $script:lastKind = ''   # 進化樹不撐寬：鎖著沒、平常的內容寬、平常的前線畫布框 [w,h]、最近一次 /state 的 kind
# 進化樹不撐寬（常駐，2026-10-22 使用者要「視窗形狀完全不變」）：樹那張圖 35～92 格比平常 52 格寬，整頁縮放會讓視窗變矮、撐寬會讓視窗變寬，
# 唯一形狀不變的做法是把前線畫布的 CSS 框鎖在平常的寬高、圖用 object-fit: contain 等比縮進去（上下留空）。這是第二條注入的樣式，只在樹期間存在。
# 圖由瀏覽器縮小，比整頁縮放糊一點（image-rendering 改 auto，不然 pixelated 縮小會丟列缺筆畫）。
function Set-TreeFit([bool]$on) {
    if ($on -eq $script:treeFit) { return }
    $script:treeFit = $on
    if (-not $wv.CoreWebView2) { return }
    if ($on) {
        $w0 = [int]$script:homeScene[0]; $h0 = [int]$script:homeScene[1]
        $js = "(function(){var cvs=document.querySelectorAll('canvas'),best=null,ba=0;for(var i=0;i<cvs.length;i++){var b=cvs[i].getBoundingClientRect();if(b.width*b.height>ba){ba=b.width*b.height;best=cvs[i];}}" +
              "if(best)best.setAttribute('data-vpet-mini-fit','1');var s=document.getElementById('vpet-mini-fit');if(!s){s=document.createElement('style');s.id='vpet-mini-fit';(document.head||document.documentElement).appendChild(s);}" +
              "s.textContent='canvas[data-vpet-mini-fit]{width:" + $w0 + "px !important;height:" + $h0 + "px !important;object-fit:contain;image-rendering:auto !important}';})();"
    } else {
        $js = "(function(){var s=document.getElementById('vpet-mini-fit');if(s)s.remove();})();"
    }
    try { $null = $wv.CoreWebView2.ExecuteScriptAsync($js) } catch {}
    if ($env:VPET_MINI_DEBUG) { Add-Content (Join-Path $here '_fit.log') ("{0:HH:mm:ss.fff} treefit {1} (frame {2})" -f (Get-Date), $(if ($on) { 'on' } else { 'off' }), $(if ($script:homeScene) { "$($script:homeScene[0])x$($script:homeScene[1])" } else { '?' })) }
}
function Set-Zoom([double]$z) {
    if ($wv.CoreWebView2) { $wv.ZoomFactor = $z }
    $script:lastFit = ''
    if ($script:ContentW -gt 0) { Apply-Fit $script:ContentW $script:ContentH }
    Set-Tag (Tag-Text $z) $null
}
$script:rzTimer = New-Object System.Windows.Forms.Timer
$script:rzTimer.Interval = 1000
$script:rzTimer.add_Tick({
    if ($script:rs) { return }
    $st = Get-State; if ($null -eq $st) { return }
    $kind = [string]$st.kind
    # 小寵物：角色跟 /state 的 character 走（進化後換圖）；進化開始那一刻小視窗自動回來（跟 tray 的「進化時自動開小視窗」同一個意思）
    $ch = [string]$st.character
    if ($ch) { $script:lastChar = $ch }
    if ($script:petMode -and $kind -eq 'evo') { Leave-Pet }
    $script:lastKind = $kind
    # 事件（/state 的 event，2026-10-22）：新的一個出現那一刻（id 變了）——
    #   小寵物、沒跟隨滑鼠 → 比照進化，直接回小視窗；跟隨滑鼠 → 頭上冒「❗」、停下不追，等點牠才回（不突然擋到游標底下）
    #   一般小視窗：頁面自己會跳對話框，叫到最前面就好。事件被看掉（event 沒了）→ 收掉「❗」
    $evId = ''; try { if ($st.event) { $evId = [string]$st.event.id } } catch {}
    if ($evId -and $null -ne $script:lastEventId -and $evId -ne $script:lastEventId) {
        if ($script:petMode) {
            if ($script:Cfg.petFollow) { $script:petAlert = $true; Refresh-Pet $st } else { Leave-Pet; $script:eventPulled = $true }
        } else { $form.Activate() }
    }
    if (-not $evId -and $script:petAlert) { $script:petAlert = $false; if ($script:petMode) { Refresh-Pet $st } }
    # 事件看完了（event 沒了）、而且這次是從桌面被叫回來的 → 自動縮回桌面；跟隨滑鼠的設定沒動過，縮回去照樣跟（v16 提案，2026-10-27 使用者同意）
    if (-not $evId -and $script:eventPulled -and -not $script:petMode) { $script:eventPulled = $false; Enter-Pet }
    $script:lastEventId = $evId
    # 進化樹不撐寬：樹結束就解鎖畫布（鎖上那一步通常在量測那邊做；這裡補一次以防寬度沒跳）
    if ($kind -ne 'tree' -and $script:treeFit) { Set-TreeFit $false }
    elseif ($kind -eq 'tree' -and -not $script:treeFit -and $script:homeScene) { Set-TreeFit $true }
    $want = $script:TEXT_KINDS -contains $kind
    $rz = [double]$script:Cfg.readZoom
    if ($rz -le 0) { $want = $false }   # 0 = 關（vpet畫布改依解析度放大後通常不需要）
    if ($want -and $null -eq $script:baseZoom -and [double]$script:Cfg.zoom -lt $rz) {
        $script:baseZoom = [double]$script:Cfg.zoom; $script:Cfg.zoom = $rz; Set-Zoom $rz
        if ($env:VPET_MINI_DEBUG) { Add-Content (Join-Path $here '_fit.log') ("{0:HH:mm:ss.fff} readzoom on: kind={1} {2}->{3}" -f (Get-Date), $kind, $script:baseZoom, $rz) }
    } elseif (-not $want -and $null -ne $script:baseZoom) {
        $z = $script:baseZoom; $script:baseZoom = $null; $script:Cfg.zoom = $z; Set-Zoom $z
        if ($env:VPET_MINI_DEBUG) { Add-Content (Join-Path $here '_fit.log') ("{0:HH:mm:ss.fff} readzoom off: kind={1} ->{2}" -f (Get-Date), $kind, $z) }
    }
})
$script:rzTimer.Start()

# ── 監看自己的設定檔（v16）：系統匣的選單改了畫面縮放／閱讀縮放／跟隨滑鼠／最上層，會寫進 mini-web.json；
#    這裡每 2 秒看一次檔案時間，不是自己寫的就重讀套用。系統匣要叫小視窗做事（縮成小寵物）就寫 request 欄位，做完清掉 ──
$script:cfgMtime = $(if (Test-Path $script:CfgPath) { (Get-Item $script:CfgPath).LastWriteTimeUtc } else { [DateTime]::MinValue })
$script:cfgWatch = New-Object System.Windows.Forms.Timer; $script:cfgWatch.Interval = 2000
$script:cfgWatch.add_Tick({
    try {
        if (-not (Test-Path $script:CfgPath)) { return }
        $mt = (Get-Item $script:CfgPath).LastWriteTimeUtc; if ($mt -eq $script:cfgMtime) { return }
        $script:cfgMtime = $mt
        $j = Get-Content $script:CfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -ne $j.zoom -and $null -eq $script:baseZoom -and [Math]::Abs([double]$j.zoom - [double]$script:Cfg.zoom) -gt 0.004) { Apply-Zoom ([double]$j.zoom) }
        if ($null -ne $j.readZoom) { $script:Cfg.readZoom = [double]$j.readZoom }
        if ($null -ne $j.topmost -and [bool]$j.topmost -ne [bool]$script:Cfg.topmost) { Apply-TopMost ([bool]$j.topmost) }
        if ($null -ne $j.petFollow -and [bool]$j.petFollow -ne [bool]$script:Cfg.petFollow) { Apply-Follow ([bool]$j.petFollow) }
        if ($null -ne $j.petScale -and [int]$j.petScale -ne [int]$script:Cfg.petScale) { $script:Cfg.petScale = [int]$j.petScale; if ($script:petMode -and [int]$j.petScale -gt 0) { Set-PetScale ([int]$j.petScale) } }
        if ($j.request -eq 'pet') { Save-Cfg; Enter-Pet }        # 系統匣叫的：縮成小寵物（Save-Cfg 會把 request 寫掉）
        elseif ($j.request -eq 'unpet') { Save-Cfg; Leave-Pet }
        if ($env:VPET_MINI_DEBUG) { Add-Content (Join-Path $here '_fit.log') ("{0:HH:mm:ss.fff} cfg reloaded (zoom={1} readZoom={2} topmost={3} follow={4} request={5})" -f (Get-Date), $j.zoom, $j.readZoom, $j.topmost, $j.petFollow, $j.request) }
    } catch { if ($env:VPET_MINI_DEBUG) { Add-Content (Join-Path $here '_err.log') ("{0:HH:mm:ss.fff} cfg watch: {1}" -f (Get-Date), $_.Exception.Message) } }
})
$script:cfgWatch.Start()

# daemon 消失 → 小視窗自己收掉，不留紅字孤兒。但vpet 的自動更新會讓 3010 空檔十幾秒（換檔、重開子行程），
# 所以：我們的 tray 還在（daemon 父行程活著）就最多等 90 秒；tray 不在了（按了結束或真的掛了）10 秒就關
$script:deadTicks = 0
$script:dmTimer = New-Object System.Windows.Forms.Timer
$script:dmTimer.Interval = 2000
$script:dmTimer.add_Tick({
    $ok = $false
    try { $tc = New-Object System.Net.Sockets.TcpClient; $ar = $tc.BeginConnect('127.0.0.1', [int]$script:Port, $null, $null)
          if ($ar.AsyncWaitHandle.WaitOne(300)) { try { $tc.EndConnect($ar); $ok = $true } catch {} }; $tc.Close() } catch {}
    if ($ok) { $script:deadTicks = 0; return }
    $script:deadTicks++
    $trayAlive = $false
    # 我們的 tray 開 Local\vpet-mini-tray；同仁 repo 的 tools\vpet-tray.ps1 開 Local\vpet-tray（2026-10-22 起小視窗也可能由他的 tray 帶）→ 兩個都認
    foreach ($mn in 'Local\vpet-mini-tray', 'Local\vpet-tray') {
        try { $mx = $null; if ([System.Threading.Mutex]::TryOpenExisting($mn, [ref]$mx)) { $trayAlive = $true }; if ($mx) { $mx.Dispose() } } catch {}
    }
    $limit = if ($trayAlive) { 45 } else { 5 }
    if ($env:VPET_MINI_DEBUG -and $script:deadTicks -eq 1) { Add-Content (Join-Path $here '_fit.log') ("{0:HH:mm:ss.fff} port down, trayAlive={1}, limit={2} ticks" -f (Get-Date), $trayAlive, $limit) }
    if ($script:deadTicks -ge $limit) { $script:dmTimer.Stop(); $form.Close() }
})
$script:dmTimer.Start()

# ── 疊放順序：主視窗 ← 小標籤／小方塊（owned window 永遠在 owner 上面）──
$tag.Owner = $form; $btn.Owner = $form; $grip.Owner = $form

# ── 啟動 WebView2（資料夾放在 vpet-mini 旁，localStorage 記在這裡）──
$envTask = [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::CreateAsync($null, (Join-Path $here 'webview-data'), $null)
if (-not $envTask.Wait(15000) -or $envTask.Status -ne 'RanToCompletion') {
    [System.Windows.Forms.MessageBox]::Show("WebView2 環境建立失敗（Windows 內建的 WebView2 runtime 不在？）", 'vpet mini') | Out-Null; exit 1
}
$null = $wv.EnsureCoreWebView2Async($envTask.Result)
[void][System.Windows.Forms.Application]::Run($form)
