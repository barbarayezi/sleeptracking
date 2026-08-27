@echo off
REM =============================================
REM Sleep Tracker — 一键安装开机自启（管理员）
REM 双击运行即可：提权 → 杀旧进程 → 注册计划任务 → 立即启动
REM =============================================

REM ── 自动请求管理员权限 ──
NET SESSION >nul 2>&1
if %errorLevel% neq 0 (
    echo 需要管理员权限，正在请求提权...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"

echo ========================================
echo  Sleep Tracker 开机自启安装
echo ========================================
echo.

REM 1) 杀掉仍占用 61023 的旧进程（清掉旧代码实例）
echo [1/3] 停止旧的服务进程...
taskkill /F /IM python.exe >nul 2>&1
timeout /t 2 /nobreak >nul

REM 2) 注册计划任务（登录时自动启动，崩溃由脚本内循环重启）
echo [2/3] 注册计划任务 SleepTrackerServer...
schtasks /create /tn "SleepTrackerServer" /tr "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%~dp0startup_61023.ps1\"" /sc onlogon /rl highest /f

REM 3) 立即拉起新服务（后台隐藏运行，新去重逻辑生效）
echo [3/3] 立即启动服务（后台运行，端口 61023）...
powershell -Command "Start-Process powershell.exe -ArgumentList '-ExecutionPolicy Bypass -WindowStyle Hidden -File \"%~dp0startup_61023.ps1\"' -WindowStyle Hidden"

echo.
echo ========================================
echo  完成！
echo  - 已注册开机/登录自启任务：SleepTrackerServer
echo  - 服务现已在后台运行：http://localhost:61023
echo  - 停用自启：schtasks /delete /tn "SleepTrackerServer" /f
echo ========================================
echo.
pause
