@echo off
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
:: Nvidia GPU：AudioContext 可正常输出音频，无需 --disable-gpu
start "" "node_modules\electron\dist\electron.exe" .
if %errorlevel% neq 0 (
    echo [错误] 昔涟启动失败 (exit code: %errorlevel%)
    pause
)
