<#
.SYNOPSIS
    Sleep Tracker — 开机自启启动器（固定端口 61023 + 受管 venv python）。
    设计为以 Windows 计划任务运行，开机/登录后自动拉起服务；
    进程退出后自动重启（带频率限制，防止崩溃循环）。

.DESCRIPTION
    - 启动前先尝试释放 61023 端口（杀掉残留的旧实例），避免端口冲突导致崩溃。
    - 使用受管 venv 的 python（已装 flask / libsql / waitress）。
    - 设置 HEADLESS=1（不自动开浏览器），PORT=61023（固定端口 + waitress）。
#>

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSCommandPath
$LogDir      = Join-Path $ProjectRoot ".logs"
# 端口固定为 5800（文件名里的 61023 是历史遗留）。
# 原因：Whoop 控制台 OAuth 白名单只登记了 http://localhost:5800/api/whoop/callback，
# 服务跑在其他端口会导致授权回调落空、Whoop 静默断连、数据连续多天空缺。
$Port        = 5800
$Python      = "C:/Users/wucai/.workbuddy/binaries/python/envs/default/Scripts/python.exe"

New-Item -ItemType Directory -Path $LogDir -Force -ErrorAction SilentlyContinue | Out-Null

# ── 释放端口：杀掉仍占用 61023 的残留进程 ──
try {
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        try {
            Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Releasing stale process on port $Port (PID $($c.OwningProcess))"
            Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
        } catch {}
    }
    if ($conns) { Start-Sleep -Seconds 2 }
} catch {}

# 让子进程继承这些环境变量
$env:PORT     = "$Port"
$env:HEADLESS = "1"

$RestartCount = 0
while ($true) {
    $LogFile = Join-Path $LogDir "app-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
    # PowerShell 5.1 禁止 stdout / stderr 重定向到同一文件，必须分开
    $ErrFile = Join-Path $LogDir "app-$(Get-Date -Format 'yyyyMMdd-HHmmss').err.log"
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$ts] Starting app.py on port $Port (venv) ..."
    try {
        $p = Start-Process -FilePath $Python `
            -ArgumentList "app.py" `
            -WorkingDirectory $ProjectRoot `
            -NoNewWindow -PassThru `
            -RedirectStandardOutput $LogFile `
            -RedirectStandardError $ErrFile
        $p.WaitForExit()
        $code = $p.ExitCode
    } catch {
        $code = 1
        Write-Host "[$ts] Failed to launch: $_"
    }
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$ts] app.py exited (code $code). Restarting ..."

    # 频率限制：1 分钟内最多重启 6 次，超出则冷却 30s，避免崩溃风暴
    $RestartCount++
    if ($RestartCount -ge 6) {
        Write-Host "[$ts] Too many restarts — cooling down 30s ..."
        Start-Sleep -Seconds 30
        $RestartCount = 0
    } else {
        Start-Sleep -Seconds 3
    }
}
