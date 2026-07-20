@echo off
REM =============================================
REM Sleep Tracker — Auto-restart launcher (batch)
REM =============================================
REM Double-click this to start the app.
REM Restarts automatically if it crashes.
REM
REM To install as a startup task (run once from admin cmd):
REM   schtasks /create /tn "SleepTracker" /tr "powershell.exe -File \"%~dp0run.ps1\"" /sc onstart /delay 0000:30 /rl highest
REM =============================================

cd /d "%~dp0"

echo ========================================
echo  Sleep Tracker - Auto-Restart Launcher
echo ========================================
echo.

:restart
echo [%date% %time%] Starting app.py ...
echo [%date% %time%] Starting app.py ... >> ".logs\restarter.log" 2>&1

python app.py >> ".logs\restarter.log" 2>&1

set EXIT_CODE=%errorlevel%
echo [%date% %time%] App exited with code %EXIT_CODE% >> ".logs\restarter.log" 2>&1

if %EXIT_CODE% neq 0 (
    echo [%date% %time%] CRASHED (code %EXIT_CODE%). Restarting in 3s...
    timeout /t 3 /nobreak >nul
) else (
    echo [%date% %time%] Exited normally (code 0). Restarting in 3s...
    timeout /t 3 /nobreak >nul
)

goto restart
