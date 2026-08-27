@echo off
REM =============================================
REM  Sleep Tracker — 安装开机自启任务
REM =============================================
REM 以管理员身份运行此脚本，配置应用开机自启。
REM 使用 Windows Task Scheduler，用户登录后启动。
REM =============================================

cd /d "%~dp0"

echo ========================================
echo  Sleep Tracker - 开机自启安装
echo ========================================
echo.

REM 检查是否管理员权限
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 请以管理员身份运行此脚本！
    echo        右键单击 setup-startup.bat → 以管理员身份运行
    pause
    exit /b 1
)

REM 创建计划任务（用户登录时启动，每5分钟重启一次以防止内存泄漏）
echo [1/2] 创建计划任务 "SleepTracker" ...
schtasks /create /tn "SleepTracker" /tr "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File \"%~dp0run.ps1\"" /sc onlogon /delay 0000:30 /rl highest /f

if %errorlevel% equ 0 (
    echo [OK] 计划任务创建成功！
) else (
    echo [错误] 计划任务创建失败，请检查权限。
    pause
    exit /b 1
)

echo.
echo [2/2] 测试启动应用（按 Ctrl+C 可停止）...
echo.
echo 任务已安装，下次登录时自动启动。
echo 也可以现在双击 run.bat 立即启动。
echo.

pause
