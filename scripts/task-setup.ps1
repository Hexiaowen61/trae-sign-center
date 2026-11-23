# ==========================================
# Trae CN 自动签到 - 计划任务配置工具 (开机触发版)
# ==========================================

# 获取当前脚本所在目录（scripts），主脚本在上一级
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectDir = Split-Path -Parent $ScriptDir
$TargetScript = Join-Path $ProjectDir "src\trae.js"

# 检查主脚本是否存在
if (-not (Test-Path $TargetScript)) {
    Write-Host " 错误：未找到 src\trae.js" -ForegroundColor Red
    Write-Host "请确保 scripts 目录与 src 目录保持原有的项目结构！" -ForegroundColor Yellow
    Pause
    Exit
}

$TaskName = "TraeSignCenterTask"
$DefaultDelay = "3" # 默认延迟 3 分钟

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  Trae CN 签到助手 - 配置开机自动签到" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

# 检查任务是否已存在
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

# 沿用现有延迟时间，避免覆盖更新时被重置
if ($ExistingTask -and $ExistingTask.Triggers.Count -gt 0 -and $ExistingTask.Triggers[0].Delay) {
    $delayRaw = [string]$ExistingTask.Triggers[0].Delay
    if ($delayRaw -match 'PT(\d+)M') {
        $DefaultDelay = $Matches[1]
    } elseif ($delayRaw -match '^(\d+):(\d{2})') {
        $DefaultDelay = [string]([int]$Matches[1] * 60 + [int]$Matches[2])
    }
}

Write-Host ""
Write-Host "当前脚本路径: $TargetScript"
Write-Host "将配置名为 [$TaskName] 的开机自动签到任务。"
Write-Host "每次开机登录后，延迟 $DefaultDelay 分钟运行，会显示控制台窗口。" -ForegroundColor Gray
Write-Host ""

# 询问是否修改延迟时间
$newDelay = Read-Host "请输入开机后延迟几分钟运行 (直接回车保持当前 $DefaultDelay 分钟)"
if (-not [string]::IsNullOrWhiteSpace($newDelay)) {
    if ($newDelay -match '^\d+$') {
        $DefaultDelay = $newDelay
    } else {
        Write-Host " 格式输入有误，将使用默认延迟 $DefaultDelay 分钟" -ForegroundColor Yellow
    }
}

Write-Host "`n正在注册计划任务..." -ForegroundColor Yellow

# 构建操作 (登录后以可见的控制台窗口启动 Node)
$Argument = "-NoProfile -ExecutionPolicy Bypass -Command `"& node '$TargetScript' --checkin --pause`""
$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $Argument -WorkingDirectory $ProjectDir

# 构建触发器 (当前用户登录时触发)
$Trigger = New-ScheduledTaskTrigger -AtLogOn
# 【修正点】：将延迟设置加在触发器上
$Trigger.Delay = "PT${DefaultDelay}M"

# 构建设置 (允许使用电池时运行)
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$Settings.ExecutionTimeLimit = "PT0S" # 取消执行时间限制，防止被系统中断

try {
    # 注册任务
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Trae CN 开机延迟自动签到" -Force | Out-Null

    Write-Host "`n 计划任务配置成功！" -ForegroundColor Green
    Write-Host "任务名称: $TaskName"
    Write-Host "触发条件: 每次开机/用户登录时"
    Write-Host "运行状态: 登录后延迟 $DefaultDelay 分钟，运行时显示控制台窗口，结束后按任意键关闭。"
    Write-Host "签到日志: logs\TraeSignCenter.log"
    Write-Host ""
    Write-Host "完成后可关闭本窗口，返回 trae.cmd 菜单继续其他操作。" -ForegroundColor Gray

} catch {
    Write-Host "`n 任务注册失败: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "请返回 trae.cmd 菜单，选择 3 重新操作（会自动请求管理员权限）。" -ForegroundColor Yellow
}

Write-Host ""
Pause