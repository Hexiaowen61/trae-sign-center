# ==========================================
# Trae CN 自动签到 - 计划任务卸载工具
# ==========================================

$TaskName = "TraeSignCenterTask"

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  Trae CN 签到助手 - 删除开机自动签到" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "正在检查计划任务 [$TaskName]..." -ForegroundColor Yellow

$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($null -eq $ExistingTask) {
    Write-Host " 系统中不存在该任务，无需删除。" -ForegroundColor Green
} else {
    Write-Host "任务存在，正在从系统中移除..." -ForegroundColor Yellow
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Host " 成功：[$TaskName] 已被彻底删除。" -ForegroundColor Green
        Write-Host "后续将不再自动签到。" -ForegroundColor Gray
    } catch {
        Write-Host " 删除失败：$($_.Exception.Message)" -ForegroundColor Red
        Write-Host " 请返回 trae.cmd 菜单，选择 3 重新操作（会自动请求管理员权限）。" -ForegroundColor Yellow
    }
}

Write-Host "删除后开机不再自动签到，手动签到不受影响。" -ForegroundColor Gray
Write-Host ""
Pause
