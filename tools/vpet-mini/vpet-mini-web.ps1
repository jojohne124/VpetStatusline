# vpet-mini-web.ps1 — 桌寵小視窗（同事做的 v12，2026-10-21 併進 repo，之後由本 repo 維護）
# 用 WebView2 原封不動開 vpet 的 http://localhost:3010。不注入任何樣式、不改 vpet 任何檔案。
# 入口：tools\vpet-tray.ps1（vpet-standalone.vbs 啟動的那個系統匣）選單「開啟 vpet mini 視窗」→ vpet-mini.vbs → 這支。
# 三個視窗：
#   主視窗 = 只有 WebView，形狀（Form.Region）= 頁面回報的實體矩形（面板、按鈕、文字行），其餘是洞（點下去是後面的視窗）
#   小標籤 = 面板右上角上方的小把手（拖曳、右鍵選單、雙擊開完整頁）
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
$script:Cfg = @{ x = 80; y = 80; w = 480; h = 640; zoom = 1.0; topmost = $true; autofit = $true; readZoom = 0 }   # readZoom 0 = 關
if (Test-Path $script:CfgPath) {
    try {
        $j = Get-Content $script:CfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($k in @('x','y','w','h','zoom','topmost','autofit','readZoom')) { if ($null -ne $j.$k) { $script:Cfg[$k] = $j.$k } }
    } catch {}
}
$script:Cfg.autofit = $true   # 固定開：右下角拖曳＝整頁等比例縮放
$script:ZOOM_MIN = 0.4; $script:ZOOM_MAX = 2.0
$script:ContentW = 0; $script:ContentH = 0   # 頁面回報的內容寬高（CSS px，不隨縮放變）
$script:Rects = @()                          # 頁面回報的實體矩形（CSS px）
$script:fitted = $false
function Save-Cfg {
    try { $c = $script:Cfg.Clone(); if ($null -ne $script:baseZoom) { $c.zoom = $script:baseZoom }   # 閱讀縮放暫升中，存的是原本的縮放
          ($c | ConvertTo-Json -Compress) | Set-Content $script:CfgPath -Encoding UTF8 } catch {} }

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
$tag.BackColor = $COL_BAR; $tag.TopMost = [bool]$script:Cfg.topmost
$lbl = New-Object System.Windows.Forms.Label
$lbl.AutoSize = $true; $lbl.ForeColor = $COL_TXT; $lbl.Font = New-Object System.Drawing.Font('Segoe UI', 8)
$lbl.Padding = New-Object System.Windows.Forms.Padding(6, 1, 6, 1); $lbl.Location = New-Object System.Drawing.Point(0, 0)
$lbl.Text = 'vpet'
$tag.Controls.Add($lbl)
function Fit-Tag { $sz = New-Object System.Drawing.Size($lbl.Width, $lbl.Height); $tag.MinimumSize = $sz; $tag.MaximumSize = $sz; $tag.ClientSize = $sz }
function Set-Tag([string]$t, $col) { $lbl.Text = $t; if ($col) { $lbl.ForeColor = $col } else { $lbl.ForeColor = $COL_TXT }; Fit-Tag; Place-Handles }
Fit-Tag

# ── 小方塊（縮放）──
$grip = New-Object System.Windows.Forms.Form
$grip.Text = 'vpet mini grip'; $grip.FormBorderStyle = 'None'; $grip.ShowInTaskbar = $false; $grip.StartPosition = 'Manual'
$grip.BackColor = $COL_LINE; $grip.TopMost = [bool]$script:Cfg.topmost
$grip.MinimumSize = New-Object System.Drawing.Size($GRIP_PX, $GRIP_PX)   # 不設的話 Windows 會套頂層視窗預設最小尺寸（136×39）
$grip.MaximumSize = New-Object System.Drawing.Size($GRIP_PX, $GRIP_PX)
$grip.ClientSize = New-Object System.Drawing.Size($GRIP_PX, $GRIP_PX)
$grip.Cursor = [System.Windows.Forms.Cursors]::SizeNWSE

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
function Place-Handles {
    $p = Get-Panel
    $tx = [Math]::Max(0, $p.x + $p.w - $tag.Width); $ty = $p.y - $tag.Height; if ($ty -lt 0) { $ty = $p.y }
    $tag.Location  = New-Object System.Drawing.Point(($form.Left + $tx), ($form.Top + $ty))
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
    if (-not $script:fitted) { $script:fitted = $true; $form.Opacity = 1; $tag.Show(); $grip.Show(); Place-Handles; $form.Activate() }
}
$form.add_LocationChanged({ Place-Handles })
$form.add_SizeChanged({ Place-Handles })

# ── 拖曳移動（小標籤、墊板那一圈）──
$script:drag = $null
$dragDown = { param($s, $e) if ($e.Button -eq 'Left') { $script:drag = New-Object System.Drawing.Point($e.X, $e.Y) } }
$dragMove = { param($s, $e)
    if ($script:drag -and $e.Button -eq 'Left') {
        $form.Location = New-Object System.Drawing.Point(($form.Left + $e.X - $script:drag.X), ($form.Top + $e.Y - $script:drag.Y))
    } }
$dragUp = { param($s, $e) if ($script:drag) { $script:drag = $null; $script:Cfg.x = $form.Left; $script:Cfg.y = $form.Top; Save-Cfg } }
foreach ($c in @($tag, $lbl)) { $c.add_MouseDown($dragDown); $c.add_MouseMove($dragMove); $c.add_MouseUp($dragUp) }
$dblOpen = { param($s, $e) if ($e.Button -eq 'Left') { Start-Process $script:HomeUrl } }
$tag.add_MouseDoubleClick($dblOpen); $lbl.add_MouseDoubleClick($dblOpen)

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
        Set-Tag ('vpet  {0}%' -f [int](($t.w - 26) / [Math]::Max(1, $script:ContentW) * 100)) $null
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
        Set-Tag ('vpet  {0}%' -f [int]($z * 100)) $null
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
      if(r>0&&btm>0){ window.chrome.webview.postMessage(JSON.stringify({w:W,h:H,vw:vw,rects:solidRects()})); }
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
      // 廣場聊天紀錄：要能反白複製，不拖（2026-10-21 併進 repo 時加）
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

$wv.add_CoreWebView2InitializationCompleted({
    param($s, $e)
    if (-not $e.IsSuccess) { [System.Windows.Forms.MessageBox]::Show("WebView2 啟動失敗：`n$($e.InitializationException.Message)", 'vpet mini') | Out-Null; $form.Close(); return }
    $core = $wv.CoreWebView2
    $core.Settings.AreDefaultContextMenusEnabled = $true
    $core.Settings.IsStatusBarEnabled = $false
    $core.Settings.AreDefaultScriptDialogsEnabled = $false   # 關掉內建對話框，ScriptDialogOpening 才會觸發、交給殼畫
    # 圖鑑／舞台底圖是 window.open 開新分頁 → 交給預設瀏覽器
    # ⚠️ 只放行 http／https：Start-Process 收到 file:／本機路徑會直接執行程式，頁面萬一被塞進惡意內容就是破口（2026-10-21 審查）
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
              $script:ContentW = [int]$m.w; $script:ContentH = [int]$m.h; Apply-Fit $script:ContentW $script:ContentH
              Apply-Region; Place-Handles }
        catch { if ($env:VPET_MINI_DEBUG) { Add-Content (Join-Path $here '_err.log') ("{0:HH:mm:ss.fff} {1}`n{2}" -f (Get-Date), $_.Exception.Message, $_.ScriptStackTrace) } }
    })
    $core.add_NavigationCompleted({ param($s2, $e2)
        if (-not $e2.IsSuccess) { Set-Tag "連不到 daemon（localhost:$($script:Port)）— 先雙擊 vpet-standalone.vbs" ([System.Drawing.Color]::FromArgb(255, 255, 90, 90)) }
        else { Set-Tag ('vpet  {0}%' -f [int]([double]$script:Cfg.zoom * 100)) $null }
    })
    $null = $core.AddScriptToExecuteOnDocumentCreatedAsync($MEASURE)
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
                if ($cmd -match '^width (\d+)$') { $script:rs = @{}; $form.Width = [int]$matches[1]; Grip-Release } }
        })
        $script:dbgTimer.Start()
    }
})

# ── 右鍵選單（小標籤、墊板那一圈）──
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$m1 = $menu.Items.Add('在瀏覽器開完整網頁'); $m1.add_Click({ Start-Process $script:HomeUrl })
$m2 = $menu.Items.Add('重新整理'); $m2.add_Click({ if ($wv.CoreWebView2) { $wv.CoreWebView2.Reload() } })
[void]$menu.Items.Add('-')
$mZoom = New-Object System.Windows.Forms.ToolStripMenuItem('縮放')
foreach ($z in 50, 75, 100, 125, 150) {
    $it = $mZoom.DropDownItems.Add("$z%"); $it.Tag = $z
    $it.add_Click({ param($s, $e) $script:Cfg.zoom = [double]$s.Tag / 100.0; $wv.ZoomFactor = $script:Cfg.zoom; $script:lastFit = ''
        if ($script:ContentW -gt 0) { Apply-Fit $script:ContentW $script:ContentH }
        Set-Tag ('vpet  {0}%' -f [int]$s.Tag) $null; Save-Cfg })
}
[void]$menu.Items.Add($mZoom)
$mRead = New-Object System.Windows.Forms.ToolStripMenuItem('閱讀縮放（卡片、進化樹暫時放大到）')
foreach ($z in 0, 80, 90, 100, 125) {
    $it = $mRead.DropDownItems.Add($(if ($z -eq 0) { '關' } else { "$z%" })); $it.Tag = $z; $it.Checked = ([int]([double]$script:Cfg.readZoom * 100) -eq $z)
    $it.add_Click({ param($s, $e) $script:Cfg.readZoom = [double]$s.Tag / 100.0; foreach ($q in $mRead.DropDownItems) { $q.Checked = ($q.Tag -eq $s.Tag) }; Save-Cfg })
}
[void]$menu.Items.Add($mRead)
$script:mTop = $menu.Items.Add('永遠最上層'); $script:mTop.Checked = [bool]$script:Cfg.topmost
$script:mTop.add_Click({ $script:Cfg.topmost = -not $script:Cfg.topmost
    foreach ($f0 in @($form, $tag, $grip)) { $f0.TopMost = $script:Cfg.topmost }
    $script:mTop.Checked = $script:Cfg.topmost; Save-Cfg })
[void]$menu.Items.Add('-')
$mQ = $menu.Items.Add('結束 vpet mini'); $mQ.add_Click({ $form.Close() })
$tag.ContextMenuStrip = $menu; $lbl.ContextMenuStrip = $menu

$form.add_FormClosed({ $script:Cfg.x = $form.Left; $script:Cfg.y = $form.Top; Save-Cfg; foreach ($f0 in @($tag, $grip)) { try { $f0.Close() } catch {} } })

# ── 閱讀縮放：卡片／進化樹這類「有字」的場景，字是vpet畫進 canvas 的點陣，縮小會缺筆畫；
#    每秒看一次 daemon 的 /state（他網頁自己也在用的端點，不綁 id）的 kind，有字場景就暫時升到閱讀縮放，結束回原縮放 ──
$script:TEXT_KINDS = @('card', 'tree')
$script:baseZoom = $null      # 暫時升上去時記住原本的縮放；$null = 沒在暫升
function Set-Zoom([double]$z) {
    if ($wv.CoreWebView2) { $wv.ZoomFactor = $z }
    $script:lastFit = ''
    if ($script:ContentW -gt 0) { Apply-Fit $script:ContentW $script:ContentH }
    Set-Tag ('vpet  {0}%' -f [int]($z * 100)) $null
}
$script:rzTimer = New-Object System.Windows.Forms.Timer
$script:rzTimer.Interval = 1000
$script:rzTimer.add_Tick({
    if ($script:rs) { return }
    $kind = $null
    try { $req = [System.Net.HttpWebRequest]::Create("http://localhost:$($script:Port)/state"); $req.Timeout = 500; $req.ReadWriteTimeout = 500
          $res = $req.GetResponse(); $sr = New-Object System.IO.StreamReader($res.GetResponseStream()); $txt = $sr.ReadToEnd(); $sr.Close(); $res.Close()
          $kind = [string](($txt | ConvertFrom-Json).kind) } catch { return }
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
    try { $mx = $null; $trayAlive = [System.Threading.Mutex]::TryOpenExisting('Local\vpet-tray', [ref]$mx); if ($mx) { $mx.Dispose() } } catch {}   # tools\vpet-tray.ps1 開的
    $limit = if ($trayAlive) { 45 } else { 5 }
    if ($env:VPET_MINI_DEBUG -and $script:deadTicks -eq 1) { Add-Content (Join-Path $here '_fit.log') ("{0:HH:mm:ss.fff} port down, trayAlive={1}, limit={2} ticks" -f (Get-Date), $trayAlive, $limit) }
    if ($script:deadTicks -ge $limit) { $script:dmTimer.Stop(); $form.Close() }
})
$script:dmTimer.Start()

# ── 疊放順序：主視窗 ← 小標籤／小方塊（owned window 永遠在 owner 上面）──
$tag.Owner = $form; $grip.Owner = $form

# ── 啟動 WebView2（資料夾放在 vpet-mini 旁，localStorage 記在這裡）──
$envTask = [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::CreateAsync($null, (Join-Path $here 'webview-data'), $null)
if (-not $envTask.Wait(15000) -or $envTask.Status -ne 'RanToCompletion') {
    [System.Windows.Forms.MessageBox]::Show("WebView2 環境建立失敗（Windows 內建的 WebView2 runtime 不在？）", 'vpet mini') | Out-Null; exit 1
}
$null = $wv.EnsureCoreWebView2Async($envTask.Result)
[void][System.Windows.Forms.Application]::Run($form)
