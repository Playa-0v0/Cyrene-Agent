' 昔涟 v1.0.0 静默启动
Option Explicit
Dim fso, shell, projectDir, launcherCmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcherCmd = projectDir & "\start.bat"
shell.CurrentDirectory = projectDir
' 清除 ELECTRON_RUN_AS_NODE 避免 Electron 43 启动失败
Call shell.Environment("Process").Remove("ELECTRON_RUN_AS_NODE")
shell.Run """" & launcherCmd & """", 0, False
Set shell = Nothing
Set fso = Nothing
