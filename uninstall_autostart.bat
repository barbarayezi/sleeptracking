@echo off
REM =============================================
REM Sleep Tracker — 一键停用开机自启（管理员）
REM 双击运行即可：提权 → 删除计划任务 → 停止服务与自启脚本
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
echo  Sleep Tracker 开机自启卸载
echo ========================================
echo.

REM 1) 删除计划任务（停止未来的开机/登录自启）
echo [1/3] 删除计划任务 SleepTrackerServer...
schtasks /delete /tn "SleepTrackerServer" /f 2>nul
if %errorLevel%==0 (echo   已删除) else (echo   任务不存在或已删除)

REM 2) 停止自启脚本进程（否则它的重启循环会再次拉起服务）
echo [2/3] 停止 startup_61023.ps1 自启脚本...
powershell -Command "$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*startup_61023.ps1*' }; foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host ('   已停止 PID ' + $p.ProcessId) } ; if (-not $procs) { Write-Host '   未发现自启脚本进程' }"

REM 3) 停止 61023 端口上的服务进程
echo [3/3] 停止端口 61023 上的服务...
powershell -Command "$conns = Get-NetTCPConnection -LocalPort 61023 -State Listen -ErrorAction SilentlyContinue; foreach ($c in $conns) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue; Write-Host ('   已停止 PID ' + $c.OwningProcess) } ; if (-not $conns) { Write-Host '   端口 61023 无监听进程' }"

timeout /t 2 /nobreak >nul

echo.
echo ========================================
echo  完成！
echo  - 计划任务已删除（不再开机自启）
echo  - 服务进程已停止：http://localhost:61023 暂时不可访问
echo  - 重新启用：双击 install_autostart.bat
echo ========================================
echo.
pause
