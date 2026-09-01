$taskName = "SleepTracker"
$scriptPath = "D:\01_Projects\self_coding\sleep_traking\run.ps1"
$action = "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""

schtasks /create /tn $taskName /tr "$action" /sc onlogon /delay 0000:30 /rl highest /f

if ($LASTEXITCODE -eq 0) {
    Write-Host "========================================" -ForegroundColor Green
    Write-Host " Sleep Tracker 开机自启已安装成功！" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "下次登录时自动启动。"
    Write-Host "也可以立即启动：双击 D:\01_Projects\self_coding\sleep_traking\run.bat"
} else {
    Write-Host "安装失败，请右键以管理员身份运行。" -ForegroundColor Red
    Read-Host "按回车退出"
}

Start-Sleep -Seconds 5
