# ==========================================
# Trae CN 自动签到 - 计划任务配置工具
# ==========================================

# 获取当前脚本所在目录
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$TargetScript = Join-Path $ScriptDir "TraeSignCenter.ps1"

# 检查主脚本是否存在
if (-not (Test-Path $TargetScript)) {
    Write-Host " 错误：未找到 TraeSignCenter.ps1" -ForegroundColor Red
    Write-Host "请确保本脚本与 TraeSignCenter.ps1 放在同一个文件夹下！" -ForegroundColor Yellow
    Pause
    Exit
}

$TaskName = "TraeSignCenterTask"
$DefaultTime = "10:00" # 默认每天早上 10:00 运行

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "     Trae CN 自动签到 - 计划任务配置      " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# 检查任务是否已存在
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($ExistingTask) {
    Write-Host "检测到已存在的任务 [$TaskName]" -ForegroundColor Yellow
    Write-Host "  [1] 覆盖更新 (修改运行时间)"
    Write-Host "  [2] 删除任务 (取消自动签到)"
    Write-Host "  [3] 退出"
    $choice = Read-Host "请选择操作 (1/2/3)"
    
    if ($choice -eq "2") {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "`n 任务已删除，后续将不再自动签到。" -ForegroundColor Green
        Pause
        Exit
    } elseif ($choice -eq "3" -or [string]::IsNullOrWhiteSpace($choice)) {
        Exit
    }
    # 如果选 1，则继续往下走覆盖逻辑
}

Write-Host ""
Write-Host "当前脚本路径: $TargetScript"
Write-Host "将配置名为 [$TaskName] 的每天定时任务。"
Write-Host "默认每天 $DefaultTime 自动在后台运行签到。" -ForegroundColor Gray
Write-Host ""

# 询问是否修改时间
$newTime = Read-Host "请输入每天运行的时间 (格式 小时:分钟，直接回车保持默认 $DefaultTime)"
if (-not [string]::IsNullOrWhiteSpace($newTime)) {
    if ($newTime -match '^\d{1,2}:\d{2}$') {
        $DefaultTime = $newTime
    } else {
        Write-Host " 时间格式输入有误，将使用默认时间 $DefaultTime" -ForegroundColor Yellow
    }
}

# 尝试转换时间字符串
try {
    $RunTime = [datetime]::ParseExact($DefaultTime, "HH:mm", $null)
} catch {
    $RunTime = [datetime]::ParseExact("10:00", "HH:mm", $null)
}

Write-Host "`n正在注册计划任务..." -ForegroundColor Yellow

# 构建操作 (使用 powershell.exe 隐藏窗口运行)
$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$TargetScript`"" -WorkingDirectory $ScriptDir

# 构建触发器 (每天定时)
$Trigger = New-ScheduledTaskTrigger -Daily -At $RunTime

# 构建设置 (允许使用电池时运行，防止错过)
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

try {
    # 如果之前选了覆盖，或者任务不存在，直接注册
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Trae CN 每日自动签到" -RunLevel Highest -Force | Out-Null

    Write-Host "`n 计划任务配置成功！" -ForegroundColor Green
    Write-Host "任务名称: $TaskName"
    Write-Host "运行时间: 每天 $($RunTime.ToString('HH:mm'))"
    Write-Host "运行状态: 会在后台静默运行，不会有黑框弹出。"
    Write-Host ""
    Write-Host "你可以在 Windows 开始菜单搜索“任务计划程序”查看和修改它。" -ForegroundColor Gray

} catch {
    Write-Host "`n 任务注册失败: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "请尝试右键以【管理员身份】运行此脚本。" -ForegroundColor Yellow
}

Write-Host ""
