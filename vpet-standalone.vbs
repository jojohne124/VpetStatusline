' vpet-standalone.vbs - launch vpet in the system tray, with NO console window.
'
' Double-click this instead of the .bat when you don't want the black box.
' It starts tools\vpet-tray.ps1 hidden; that script runs the daemon (also hidden)
' and puts an icon in the notification area (bottom-right).
'   Double-click the tray icon .... open the vpet window
'   Right-click the tray icon ..... open / quit
'
' The .bat is still there if you prefer a console (useful for reading errors).

Option Explicit
Dim shell, fso, here, ps1, cmd
Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1  = fso.BuildPath(here, "tools\vpet-tray.ps1")

If Not fso.FileExists(ps1) Then
    MsgBox "Missing: " & ps1, vbCritical, "vpet"
    WScript.Quit 1
End If

cmd = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
' 0 = hidden window, False = don't wait
shell.Run cmd, 0, False
