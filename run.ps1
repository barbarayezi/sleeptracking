<#
.SYNOPSIS
    Sleep Tracker — auto-restart launcher for Windows.
    Keeps the Flask app running. Restarts on crash. Logs crashes.

.DESCRIPTION
    Runs app.py in a loop. If the Python process exits unexpectedly
    (crash / port conflict / network dropout), it waits 3 seconds
    and restarts automatically.

    For permanent uptime, add this script as a Windows Scheduled Task
    triggered "At startup" (see run.bat for one-liner setup).
#>

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSCommandPath
$LogDir = Join-Path $ProjectRoot ".logs"
$RestartCount = 0
$MaxRestartsPerMinute = 6  # rate-limit: max 6 restarts in 1 minute (prevents crash-loop frenzy)

# 固定端口 5800 —— 不要改成自动分配！
# Whoop 开发者控制台白名单里登记的回调地址是
#   http://localhost:5800/api/whoop/callback
# 端口一旦随机变化，OAuth 授权后的回调就会打到没有服务的端口，
# 表现为「授权页面点了允许，但应用仍然显示未连接、数据继续断档」。
$Port = 5800
$env:PORT     = "$Port"
$env:HEADLESS = "1"

# Ensure log directory exists
New-Item -ItemType Directory -Path $LogDir -Force -ErrorAction SilentlyContinue | Out-Null

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Sleep Tracker — Auto-Restart Launcher" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Project : $ProjectRoot"
Write-Host "Logs    : $LogDir"
Write-Host "Port    : $Port (fixed — required by Whoop OAuth callback whitelist)"
Write-Host ""

while ($true) {
    $StartTime = Get-Date
    $LogFile = Join-Path $LogDir "app-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
    # PowerShell 5.1 禁止 stdout / stderr 重定向到同一文件，必须分开
    $ErrFile = Join-Path $LogDir "app-$(Get-Date -Format 'yyyyMMdd-HHmmss').err.log"
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

    Write-Host "[$Timestamp] Starting app.py ..." -ForegroundColor Green
    Write-Host "[$Timestamp] Logging to: $LogFile" -ForegroundColor DarkGray

    # PORT/HEADLESS 通过脚本级环境变量继承给子进程（不依赖 PS7 的 -Environment 参数）
    # 优先用受管 venv 的 python（依赖已装齐）；找不到时退回 PATH 里的 python。
    $Python = "C:/Users/wucai/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
    if (-not (Test-Path $Python)) { $Python = "python" }
    $process = Start-Process -FilePath $Python -ArgumentList "app.py" -WorkingDirectory $ProjectRoot -NoNewWindow -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile

    # Wait a moment then show the live port
    Start-Sleep -Seconds 3
    $PortFile = Join-Path $ProjectRoot ".active_port"
    if (Test-Path $PortFile) {
        $LivePort = Get-Content $PortFile -Raw -ErrorAction SilentlyContinue
        if ($LivePort) {
            Write-Host "[$Timestamp] App started → http://localhost:$LivePort" -ForegroundColor Green
        }
    }

    # Wait for the process to exit (blocking wait)
    $process.WaitForExit()

    $ExitCode = $process.ExitCode
    $EndTime = Get-Date
    $Duration = ($EndTime - $StartTime).TotalSeconds
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

    if ($ExitCode -eq 0) {
        Write-Host "[$Timestamp] App exited normally (exit code 0)." -ForegroundColor Yellow
        # If it exited normally (e.g., user Ctrl+C), still restart in case it was accidental
    } else {
        Write-Host "[$Timestamp] App CRASHED with exit code $ExitCode after ${Duration}s." -ForegroundColor Red
        Write-Host "[$Timestamp] Last 20 lines of log:" -ForegroundColor DarkYellow
        Get-Content -Tail 20 $LogFile | ForEach-Object { "  $_" }
    }

    # Rate limiting: count restarts in last 60 seconds
    $RestartCount++
    if ($RestartCount -ge $MaxRestartsPerMinute) {
        Write-Host "[$Timestamp] Too many restarts ($RestartCount in last check)." -ForegroundColor Magenta
        Write-Host "[$Timestamp] Waiting 30 seconds before next attempt..." -ForegroundColor Magenta
        Start-Sleep -Seconds 30
        $RestartCount = 0
        continue
    }

    Write-Host "[$Timestamp] Restarting in 3 seconds..." -ForegroundColor DarkGray
    Start-Sleep -Seconds 3
}
