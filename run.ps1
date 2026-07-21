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

# Ensure log directory exists
New-Item -ItemType Directory -Path $LogDir -Force -ErrorAction SilentlyContinue | Out-Null

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Sleep Tracker — Auto-Restart Launcher" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Project : $ProjectRoot"
Write-Host "Logs    : $LogDir"
Write-Host "Port    : auto-assigned (zero-conflict)"
Write-Host "         → run.ps1 will show the live URL after starting"
Write-Host ""

while ($true) {
    $StartTime = Get-Date
    $LogFile = Join-Path $LogDir "app-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

    Write-Host "[$Timestamp] Starting app.py ..." -ForegroundColor Green
    Write-Host "[$Timestamp] Logging to: $LogFile" -ForegroundColor DarkGray

    $process = Start-Process -FilePath "python" -ArgumentList "app.py" -WorkingDirectory $ProjectRoot -NoNewWindow -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError $LogFile

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
