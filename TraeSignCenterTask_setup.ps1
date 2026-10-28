# ==========================================
# Trae CN 自动签到 - 计划任务配置工具 (开机触发版)
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
$DefaultDelay = "3" # 默认延迟 3 分钟

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "     Trae CN 自动签到 - 计划任务配置      " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# 检查任务是否已存在
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($ExistingTask) {
    Write-Host "检测到已存在的任务 [$TaskName]" -ForegroundColor Yellow
    Write-Host "  [1] 覆盖更新 (修改延迟时间)"
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
Write-Host "将配置名为 [$TaskName] 的开机自动签到任务。"
Write-Host "每次开机登录后，延迟 $DefaultDelay 分钟在后台静默运行。" -ForegroundColor Gray
Write-Host ""

# 询问是否修改延迟时间
$newDelay = Read-Host "请输入开机后延迟几分钟运行 (直接回车保持默认 $DefaultDelay)"
if (-not [string]::IsNullOrWhiteSpace($newDelay)) {
    if ($newDelay -match '^\d+$') {
        $DefaultDelay = $newDelay
    } else {
        Write-Host " 格式输入有误，将使用默认延迟 $DefaultDelay 分钟" -ForegroundColor Yellow
    }
}

Write-Host "`n正在注册计划任务..." -ForegroundColor Yellow

# 构建操作 (使用 powershell.exe 隐藏窗口运行)
$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$TargetScript`"" -WorkingDirectory $ScriptDir

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
    Write-Host "运行状态: 登录后延迟 $DefaultDelay 分钟，在后台静默运行。"
    Write-Host ""
    Write-Host "你可以在 Windows 开始菜单搜索“任务计划程序”查看和修改它。" -ForegroundColor Gray

} catch {
    Write-Host "`n 任务注册失败: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "请尝试右键以【管理员身份】运行此脚本。" -ForegroundColor Yellow
}

Write-Host ""
Pause