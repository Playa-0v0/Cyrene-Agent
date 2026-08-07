@echo off
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
start "" /MIN wscript.exe //Nologo //B "%~dp0start-cyrene-silent.vbs"
exit /b 0
