# ==========================================
# Trae CN 自动签到工具 (多设备伪装版 - 带日志)
# ==========================================

$AUTH_KEY = "iCubeAuthInfo://icube.cloudide"
$API_BASE = "https://api.trae.cn/trae/api/v2/ug/checkin_credits"
$API_ENTITLEMENT = "https://api.trae.cn/trae/api/v2/pay/user_current_entitlement_list"
$REQ_SOURCE = 1

$DATA_FOLDER_NAME = "TraeAccounts"
$LOG_FILE_NAME = "TraeSignCenter.log"

$stats = @{
    TotalAccounts    = 0
    AlreadyChecked   = 0
    NewChecked       = 0
    Failed           = 0
    TotalAmount      = 0.0
    TotalConsumed    = 0.0
    TotalRemain      = 0.0
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$DataDir = Join-Path $ScriptDir $DATA_FOLDER_NAME
$LogFile = Join-Path $ScriptDir $LOG_FILE_NAME

# ---------------- 日志初始化 (防膨胀) ----------------
if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 2097152)) {
    Clear-Content -Path $LogFile
}

# ---------------- 日志记录函数 ----------------
function Write-Log {
    param([string]$msg, [string]$color = "White")
    
    $now = Get-Date
    $timeStr = $now.ToString("HH:mm:ss")
    $fullTimeStr = $now.ToString("yyyy-MM-dd HH:mm:ss")
    
    # 1. 输出到终端 (带颜色)
    Write-Host "[$timeStr] " -ForegroundColor DarkGray -NoNewline
    Write-Host $msg -ForegroundColor $color
    
    # 2. 写入到文件 (PS5.1 限制，直接用 UTF8)
    $logLine = "[$fullTimeStr] $msg"
    Add-Content -Path $LogFile -Value $logLine -Encoding UTF8
}

# 生成 32 位随机字符串 (模拟设备ID)
function Get-RandomHex {
    param([int]$length = 32)
    $chars = "0123456789abcdef"
    $result = ""
    for ($i = 0; $i -lt $length; $i++) {
        $result += $chars[(Get-Random -Maximum $chars.Length)]
    }
    return $result
}

# ---------------- 目录检查 ----------------
if (-not (Test-Path $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir | Out-Null
    Write-Log "未找到账号文件夹，已自动创建: $DataDir" "Yellow"
    if ([Environment]::UserInteractive -and $Host.Name -eq "ConsoleHost") { Write-Host "按回车键退出..." -ForegroundColor DarkGray; $null = Read-Host }
    Exit
}

$accountFiles = Get-ChildItem -Path $DataDir -Filter *.json -File | Where-Object { $_.Name -notlike "*.device.json" }
$stats.TotalAccounts = $accountFiles.Count

if ($stats.TotalAccounts -eq 0) {
    Write-Log "文件夹 [$DataDir] 中没有找到任何 .json 账号文件。" "Yellow"
    if ([Environment]::UserInteractive -and $Host.Name -eq "ConsoleHost") { Write-Host "按回车键退出..." -ForegroundColor DarkGray; $null = Read-Host }
    Exit
}

# ---------------- AES 解密函数 ----------------
function Decrypt-Auth {
    param([string]$b64Text)
    $URE = [byte[]](82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37)
    $DRE = [byte[]](31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125)
    
    try {
        $t = [Convert]::FromBase64String($b64Text)
        $key = $t[6..37]
        $sha = [System.Security.Cryptography.SHA512]::Create()
        $shaHash = $sha.ComputeHash($key)
        $xor = [byte[]]::new(64)
        for ($i = 0; $i -lt 64; $i++) { $xor[$i] = $URE[$i] -bxor $DRE[$i] }
        $combined = [byte[]]::new(128)
        [System.Array]::Copy($shaHash, 0, $combined, 0, 64)
        [System.Array]::Copy($xor, 0, $combined, 64, 64)
        $h = $sha.ComputeHash($combined)
        $aesKey = $h[0..15]
        $iv = $h[16..31]
        $ct = $t[38..($t.Length - 1)]
        $aes = [System.Security.Cryptography.Aes]::Create()
        $aes.Mode = [System.Security.Cryptography.CipherMode]::CBC
        $aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
        $aes.Key = $aesKey
        $aes.IV = $iv
        $decryptor = $aes.CreateDecryptor()
        $plainBytes = $decryptor.TransformFinalBlock($ct, 0, $ct.Length)
        $jsonBytes = $plainBytes[64..($plainBytes.Length - 1)]
        $jsonStr = [System.Text.Encoding]::UTF8.GetString($jsonBytes)
        return $jsonStr | ConvertFrom-Json
    } catch {
        return $null
    }
}

# ---------------- API 请求函数 ----------------
function Invoke-TraeApi {
    param([string]$Url, [string]$Token, [string]$Region, [string]$DeviceId, [string]$MachineId)
    $headers = @{
        "Authorization" = "Cloud-IDE-JWT $Token"
        "x-device-id" = $DeviceId
        "X-Machine-Id" = $MachineId
    }
    if ($Region) { $headers["X-User-Region"] = $Region }
    
    $body = @{ req_source = $REQ_SOURCE } | ConvertTo-Json
    try {
        $response = Invoke-WebRequest -Uri $Url -Method Post -Headers $headers -Body $body -ContentType "application/json" -UseBasicParsing
        $utf8Bytes = [System.Text.Encoding]::GetEncoding("ISO-8859-1").GetBytes($response.Content)
        $jsonStr = [System.Text.Encoding]::UTF8.GetString($utf8Bytes)
        return $jsonStr | ConvertFrom-Json
    } catch {
        if ($_.Exception.Response) {
            try {
                $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream(), [System.Text.Encoding]::UTF8)
                return $reader.ReadToEnd() | ConvertFrom-Json
            } catch {}
        }
        return $null
    }
}

# ---------------- 账号签到逻辑 ----------------
function Checkin-Account {
    param([string]$FilePath, [string]$FileName)
    
    Write-Log "正在处理账号: $FileName" "Cyan"
    
    try {
        $storage = Get-Content $FilePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $encStr = $storage.$AUTH_KEY
        if (-not $encStr) {
            Write-Log "  -> 跳过：文件内无登录态" "Red"
            $stats.Failed++
            return
        }
        
        $auth = Decrypt-Auth -b64Text $encStr
        if (-not $auth -or -not $auth.token) {
            Write-Log "  -> 失败：解密失败或 Token 为空" "Red"
            $stats.Failed++
            return
        }
        
        $token = $auth.token
        $region = $auth.userRegion.region
        
        # ============ 虚拟设备信息读取/生成 ============
        $deviceFile = Join-Path $DataDir ($FileName -replace '\.json$', '.device.json')
        $deviceId = ""
        $machineId = ""
        
        if (Test-Path $deviceFile) {
            $deviceData = Get-Content $deviceFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $deviceId = $deviceData.device_id
            $machineId = $deviceData.machine_id
        } else {
            $deviceId = (Get-Random -Minimum 100000000 -Maximum 999999999).ToString()
            $machineId = Get-RandomHex -length 32
            $newDeviceData = @{
                device_id  = $deviceId
                machine_id = $machineId
            } | ConvertTo-Json
            $newDeviceData | Out-File -FilePath $deviceFile -Encoding UTF8 -Force
            Write-Log "  -> [新建] 已生成独立设备标识: $FileName" "DarkYellow"
        }
        # ====================================================
        
        $status = Invoke-TraeApi -Url "$API_BASE/status" -Token $token -Region $region -DeviceId $deviceId -MachineId $machineId
        if (-not $status) {
            Write-Log "  -> 失败：获取状态失败" "Red"
            $stats.Failed++
            return
        }
        
        $ent = Invoke-TraeApi -Url $API_ENTITLEMENT -Token $token -Region $region -DeviceId $deviceId -MachineId $machineId
        $totalAmt = 0; $remainAmt = 0
        if ($ent -and $ent.usage_summary) {
            $totalAmt = [double]$ent.usage_summary.total_amount
            $consumedAmt = [double]$ent.usage_summary.consumed_amount
            $remainAmt = $totalAmt - $consumedAmt
            $stats.TotalAmount += $totalAmt
            $stats.TotalConsumed += $consumedAmt
            $stats.TotalRemain += $remainAmt
        }
        $usageStr = "剩余 {0:N2} / 总 {1:N0}" -f $remainAmt, $totalAmt
        
        if ($status.checked_in) {
            Write-Log "  -> 今日已签到，$usageStr" "DarkGray"
            $stats.AlreadyChecked++
            return
        }
        
        if (-not $status.enable) {
            Write-Log "  -> 签到不可用: $($status.message)" "Red"
            $stats.Failed++
            return
        }
        
        $claim = Invoke-TraeApi -Url "$API_BASE/claim" -Token $token -Region $region -DeviceId $deviceId -MachineId $machineId
        if ($claim -and $claim.code -eq 0) {
            $entAfter = Invoke-TraeApi -Url $API_ENTITLEMENT -Token $token -Region $region -DeviceId $deviceId -MachineId $machineId
            if ($entAfter -and $entAfter.usage_summary) {
                $newTotal = [double]$entAfter.usage_summary.total_amount
                $newConsumed = [double]$entAfter.usage_summary.consumed_amount
                $newRemain = $newTotal - $newConsumed
                $stats.TotalAmount += ($newTotal - $totalAmt)
                $stats.TotalConsumed += ($newConsumed - $consumedAmt)
                $stats.TotalRemain += ($newRemain - $remainAmt)
                $usageStrAfter = "剩余 {0:N2} / 总 {1:N0}" -f $newRemain, $newTotal
            } else {
                $usageStrAfter = $usageStr
            }
            Write-Log "  -> 签到成功，本次 $($status.credits) 积分。$usageStrAfter" "Green"
            $stats.NewChecked++
        } else {
            $msg = if ($claim -and $claim.message) { $claim.message } else { "未知错误" }
            Write-Log "  -> 签到失败: $msg" "Red"
            if ($msg -match "9074|too many|参与用户太多|今日已签到") {
                Write-Log "  -> 提示: 服务端限制或风控。" "DarkYellow"
            }
            $stats.Failed++
        }
    } catch {
        Write-Log "  -> 异常: $($_.Exception.Message)" "Red"
        $stats.Failed++
    }
}

# ---------------- 主流程启动 ----------------
Write-Host "`n==========================================" -ForegroundColor DarkCyan
Write-Host "  Trae CN 自动签到工具 (多设备伪装版 - 带日志)     " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor DarkCyan
Write-Log "扫描到 $($stats.TotalAccounts) 个账号文件，准备开始签到..." "Yellow"
Write-Host ""

foreach ($file in $accountFiles) {
    Checkin-Account -FilePath $file.FullName -FileName $file.Name
    Write-Host ""
    Start-Sleep -Milliseconds 800 # 稍微拉长点间隔，降低风控概率
}

$checkinTotal = $stats.AlreadyChecked + $stats.NewChecked

# 构建报表内容并输出到终端与文件
$reportStr = @"

==========================================
                今日签到报表               
==========================================
  总账号数  : $($stats.TotalAccounts)
  签到成功  : $checkinTotal (本次新签 $($stats.NewChecked))
  今日已签  : $($stats.AlreadyChecked)
  失败/异常 : $($stats.Failed)
------------------------------------------
  总积分池  : $('{0:N0}' -f $stats.TotalAmount)
  总计消耗  : $('{0:N2}' -f $stats.TotalConsumed)
  总剩余额  : $('{0:N2}' -f $stats.TotalRemain)
==========================================
"@

Write-Host $reportStr -ForegroundColor Cyan

# 将报表也写进日志文件
Add-Content -Path $LogFile -Value $reportStr -Encoding UTF8
Add-Content -Path $LogFile -Value "`r`n" -Encoding UTF8 # 加个空行分隔

# 如果是在命令行窗口手动双击运行的，停留一下。如果是计划任务后台运行的，直接退出。
if ([Environment]::UserInteractive -and $Host.Name -eq "ConsoleHost") {
    Write-Host "按回车键退出..." -ForegroundColor DarkGray
    $null = Read-Host
}