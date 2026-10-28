# ==========================================
# Trae CN 自动签到 - 计划任务卸载工具
# ==========================================

$TaskName = "TraeSignCenterTask"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "     Trae CN 自动签到 - 任务卸载工具      " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "正在检查计划任务 [$TaskName]..." -ForegroundColor Yellow

$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($null -eq $ExistingTask) {
    Write-Host " 系统中不存在该任务，无需删除。" -ForegroundColor Green
} else {
    Write-Host "发现任务，正在从系统中移除..." -ForegroundColor Yellow
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Host " 成功！[$TaskName] 已被彻底删除。" -ForegroundColor Green
        Write-Host "后续将不再自动进行签到。" -ForegroundColor Gray
    } catch {
        Write-Host " 删除失败：$($_.Exception.Message)" -ForegroundColor Red
        Write-Host " 请尝试右键以【管理员身份】运行此脚本。" -ForegroundColor Yellow
    }
}

Write-Host ""
Pause