@echo off
REM 昔涟 v1.0.0 诊断启动器
cd /d "C:\Users\27765\WorkBuddy\2026-07-20-22-08-37\Cyrene-Agent-v1.0.0"
set ELECTRON_RUN_AS_NODE=
echo [诊断] ELECTRON_RUN_AS_NODE=%ELECTRON_RUN_AS_NODE%
echo [诊断] 工作目录=%CD%
echo [诊断] 正在启动 electron（禁用 GPU）...
echo ============================================
node_modules\electron\dist\electron.exe . --disable-gpu
echo ============================================
echo [诊断] 进程已退出，错误码=%ERRORLEVEL%
pause
