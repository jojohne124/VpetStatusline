' plaza-host.vbs - start the vpet plaza server in the system tray, NO console window.
'
' Runs tools\plaza-tray.ps1 hidden; that script starts the plaza server (also
' hidden) and puts an icon in the notification area (bottom-right).
'   Hover the icon ......... how many people are in the plaza
'   Right-click the icon ... roster / stop the plaza
'
' Only the plaza HOST needs this (the machine everyone connects to).

Option Explicit
Dim shell, fso, here, ps1, cmd
Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1  = fso.BuildPath(here, "tools\plaza-tray.ps1")

If Not fso.FileExists(ps1) Then
    MsgBox "Missing: " & ps1, vbCritical, "vpet plaza"
    WScript.Quit 1
End If

cmd = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
shell.Run cmd, 0, False
