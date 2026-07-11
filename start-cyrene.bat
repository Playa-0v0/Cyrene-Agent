@echo off
setlocal
cd /d "%~dp0"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo [Cyrene] Node.js was not found. Install Node.js 24 first.
  goto :failed
)

if not exist "node_modules\electron\package.json" (
  echo [Cyrene] Dependencies are missing. Run: npm install
  goto :failed
)

echo [Cyrene] Building the application...
call npm.cmd run build
if errorlevel 1 goto :failed

echo [Cyrene] Starting...
call npm.cmd start
if errorlevel 1 goto :failed

exit /b 0

:failed
echo.
echo [Cyrene] Startup failed. Review the error above.
pause
exit /b 1
