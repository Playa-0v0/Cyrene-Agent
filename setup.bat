@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [Cyrene] 开始初始化...

echo [1/4] 安装依赖...
call npm install
if errorlevel 1 (
    echo [错误] npm install 失败
    pause
    exit /b 1
)

echo [2/4] 构建原生截图助手...
call npm run build:screenshot-helper
if errorlevel 1 (
    echo [错误] build:screenshot-helper 失败
    pause
    exit /b 1
)

echo [3/4] 构建项目...
call npm run build
if errorlevel 1 (
    echo [错误] npm run build 失败
    pause
    exit /b 1
)

echo [4/4] 链接 cyrene 命令...
call npm link
if errorlevel 1 (
    echo [错误] npm link 失败
    pause
    exit /b 1
)

echo.
echo [Cyrene] 初始化完成，可以双击 start.bat 启动。
pause
