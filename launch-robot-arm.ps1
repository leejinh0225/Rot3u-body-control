param(
    [ValidateSet('Start', 'Stop')][string]$Action = 'Start',
    [ValidateSet('Body', 'Servo')][string]$View = 'Body',
    [ValidateRange(1024, 65535)][int]$Port = 8765,
    [switch]$NoBrowser,
    [switch]$Quiet
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'launcher/common.ps1')

# Coordinate repeated double-clicks and the stop action for this exact folder.
$hash = [System.Security.Cryptography.SHA256]::Create()
try { $key = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($PSScriptRoot.ToLowerInvariant() + ':' + $Port)))).Replace('-', '') } finally { $hash.Dispose() }
$mutex = New-Object System.Threading.Mutex($false, ('Local\RobotArm-' + $key))
$locked = $false
try {
    try { $locked = $mutex.WaitOne(15000) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw '다른 시작 또는 종료 처리가 진행 중입니다. 잠시 후 다시 실행하십시오.' }
    if ($Action -eq 'Stop') {
        $result = Stop-RobotServer $Port
    } else {
        $result = Start-RobotServer $Port
    }
} catch {
    if ($Quiet) { Write-Error $_ -ErrorAction Continue } else { Show-RobotMessage $_.Exception.Message -ErrorMessage }
    exit 1
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}

try {
    if ($Action -eq 'Stop') {
        if (-not $Quiet) { Show-RobotMessage '로컬 서버를 종료했습니다. 조종 창도 닫으십시오. 다시 사용할 때는 바탕화면의 로봇팔 조종 아이콘을 실행합니다.' }
    } elseif (-not $NoBrowser) {
        $page = if ($View -eq 'Servo') { 'viewer' } else { 'body-control' }
        $browser = Get-RobotBrowser
        Start-Process -FilePath $browser -ArgumentList "--app=http://127.0.0.1:$Port/$page/" | Out-Null
    }
    $result
} catch {
    if ($Quiet) { Write-Error $_ -ErrorAction Continue } else { Show-RobotMessage $_.Exception.Message -ErrorMessage }
    exit 1
}
