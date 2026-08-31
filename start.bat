@echo off
chcp 65001 >nul
cd /d "%~dp0"
cyrene run
if errorlevel 1 (
    echo [错误] cyrene run 退出
    pause
)
