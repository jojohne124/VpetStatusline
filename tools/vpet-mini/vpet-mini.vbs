' vpet-mini.vbs - start the vpet mini window (web version) with no console.
' Opened from the tray menu of tools\vpet-tray.ps1 (started by vpet-standalone.vbs), which runs the daemon.
Option Explicit
Dim shell, fso, here
Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.Run "powershell -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File """ & fso.BuildPath(here, "vpet-mini-web.ps1") & """", 0, False
