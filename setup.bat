@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [Cyrene] 开始初始化...

echo [1/5] 安装依赖...
call npm install
if errorlevel 1 (
    echo [错误] npm install 失败
    pause
    exit /b 1
)

echo [2/5] 原生截图助手（需 Rust，可选）...
where cargo >nul 2>&1
if %errorlevel% equ 0 (
    call npm run build:screenshot-helper
    if errorlevel 1 (
        echo [!] 截图助手构建失败，不影响核心功能
    ) else (
        echo [✓] 截图助手就绪
    )
) else (
    echo [!] 未安装 Rust，跳过截图助手（不影响核心功能）
)

echo [3/5] 构建项目...
call npm run build
if errorlevel 1 (
    echo [错误] npm run build 失败
    pause
    exit /b 1
)

echo [4/5] 构建 CLI...
call npm run build:cli
if errorlevel 1 (
    echo [错误] build:cli 失败
    pause
    exit /b 1
)

echo [5/5] 链接 cyrene 命令...
call npm link
if errorlevel 1 (
    echo [错误] npm link 失败
    pause
    exit /b 1
)

echo.
echo [Cyrene] 初始化完成✓  双击 start.bat 启动。
pause
