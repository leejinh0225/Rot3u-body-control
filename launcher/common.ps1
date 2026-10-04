$ErrorActionPreference = 'Stop'
$script:RobotRoot = Split-Path -Parent $PSScriptRoot

function Get-RobotServerIdentity([int]$Port) {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/launcher/identity.json" -UseBasicParsing -TimeoutSec 2 -Headers @{ 'Cache-Control' = 'no-cache' }
        $identity = $response.Content | ConvertFrom-Json
        return $identity.application -eq 'rot3u-body-arm-local' -and $identity.schema -eq 1
    } catch { return $false }
}

function Get-RobotListener([int]$Port) {
    return @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Get-RobotServerProcess([int]$Port) {
    # Verify the listening PID, exact server invocation, loopback binding and root.
    # A different service on this port must never be stopped or adopted.
    foreach ($listener in (Get-RobotListener $Port)) {
        $serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
        if (-not $serverProcess) { continue }
        $command = $serverProcess.CommandLine
        $rootPattern = [regex]::Escape($script:RobotRoot.TrimEnd('\'))
        $serverPattern = [regex]::Escape((Join-Path $script:RobotRoot 'launcher/server.py'))
        $legacy = $command -match "(?:^|\s)-m\s+http\.server\s+$Port(?:\s|$)" -and $command -match '(?:^|\s)--bind\s+127\.0\.0\.1(?:\s|$)'
        $managed = $command -match ('(?:^|\s)"' + $serverPattern + '"(?:\s|$)') -and $command -match "(?:^|\s)--port\s+$Port(?:\s|$)"
        if ($listener.LocalAddress -eq '127.0.0.1' -and ($legacy -or $managed) -and
            ([IO.Path]::GetFileName($serverProcess.ExecutablePath) -in @('python.exe', 'pythonw.exe')) -and
            $command -match ('(?:^|\s)--directory\s+"' + $rootPattern + '"(?:\s|$)')) {
            return $serverProcess
        }
    }
    return $null
}

function Get-RobotPython {
    $pythonCommand = Get-Command python.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $pythonCommand) { throw 'Python을 찾지 못했습니다. Python을 설치한 뒤 다시 시작하십시오.' }
    return $pythonCommand.Source
}

function Get-RobotBrowser {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Google/Chrome/Application/chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google/Chrome/Application/chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google/Chrome/Application/chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft/Edge/Application/msedge.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft/Edge/Application/msedge.exe')
    )
    foreach ($candidate in $candidates) { if (Test-Path -LiteralPath $candidate) { return $candidate } }
    throw 'Chrome 또는 Edge를 찾지 못했습니다. 두 브라우저 중 하나를 설치하십시오.'
}

function Initialize-RobotAssets([string]$Python) {
    $assets = @(
        'pose_landmarker_lite.task', 'three/build/three.module.js', 'three/build/three.core.js',
        'mediapipe/vision_bundle.mjs', 'mediapipe/wasm/vision_wasm_internal.js',
        'mediapipe/wasm/vision_wasm_internal.wasm', 'mediapipe/wasm/vision_wasm_nosimd_internal.js',
        'mediapipe/wasm/vision_wasm_nosimd_internal.wasm'
    )
    $missing = @($assets | Where-Object { -not (Test-Path -LiteralPath (Join-Path $script:RobotRoot "body-control/vendor/$_")) })
    if ($missing.Count -eq 0) { return }
    & $Python (Join-Path $script:RobotRoot 'body-control/setup-assets.py')
    if ($LASTEXITCODE -ne 0) { throw '자세 인식 파일을 준비하지 못했습니다. 인터넷 연결을 확인하고 다시 시작하십시오.' }
}

function Start-RobotServer([int]$Port) {
    $python = Get-RobotPython
    Initialize-RobotAssets $python
    if (Get-RobotServerIdentity $Port) {
        $existing = Get-RobotServerProcess $Port
        if (-not $existing) { throw "포트 $Port 서버의 실행 경로를 확인할 수 없습니다. 기존 서버를 닫은 뒤 다시 시작하십시오." }
        return [pscustomobject]@{ Reused = $true; ProcessId = $existing.ProcessId }
    }
    if (@(Get-RobotListener $Port).Count -gt 0) { throw "포트 $Port 을 다른 프로그램이 사용 중입니다. 해당 프로그램을 닫고 다시 시작하십시오." }
    $runtime = Join-Path $script:RobotRoot '.runtime'
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    $pythonWindowless = Join-Path (Split-Path -Parent $python) 'pythonw.exe'
    if (Test-Path -LiteralPath $pythonWindowless) { $python = $pythonWindowless }
    # The server owns its log files; inheriting redirected launcher pipes can
    # keep a calling PowerShell pipeline alive after this launcher has exited.
    $server = Start-Process -FilePath $python -ArgumentList @(('"' + (Join-Path $script:RobotRoot 'launcher/server.py') + '"'), '--port', "$Port", '--directory', ('"' + $script:RobotRoot + '"')) -WorkingDirectory $script:RobotRoot -WindowStyle Hidden -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    do {
        if (Get-RobotServerIdentity $Port) { return [pscustomobject]@{ Reused = $false; ProcessId = $server.Id } }
        $server.Refresh()
        if ($server.HasExited) { throw "로컬 서버를 시작하지 못했습니다. .runtime/server-$Port.stderr.log를 확인하십시오." }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    # Only stop the exact child that this attempt just created.
    $server.Refresh()
    if (-not $server.HasExited) { $server.Kill() }
    throw '로컬 서버 준비 시간이 초과되었습니다. 다시 시작하십시오.'
}

function Stop-RobotServer([int]$Port) {
    if (@(Get-RobotListener $Port).Count -eq 0) { return 'AlreadyStopped' }
    if (-not (Get-RobotServerIdentity $Port)) { throw "포트 $Port 은 다른 프로그램입니다. 종료하지 않았습니다." }
    $server = Get-RobotServerProcess $Port
    if (-not $server) { throw '이 폴더에서 시작한 로봇팔 서버인지 확인할 수 없어 종료하지 않았습니다.' }
    # Recheck process creation time to avoid killing a reused PID.
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($server.ProcessId)" -ErrorAction SilentlyContinue
    if (-not $current -or $current.CreationDate -ne $server.CreationDate) { throw '서버 상태가 바뀌었습니다. 다시 시도하십시오.' }
    $processHandle = Get-Process -Id $server.ProcessId -ErrorAction Stop
    Stop-Process -Id $server.ProcessId -ErrorAction Stop
    if (-not $processHandle.WaitForExit(3000)) { throw '서버 종료를 확인하지 못했습니다. 다시 시도하십시오.' }
    return 'Stopped'
}

function Show-RobotMessage([string]$Text, [switch]$ErrorMessage) {
    Add-Type -AssemblyName System.Windows.Forms
    $icon = if ($ErrorMessage) { [System.Windows.Forms.MessageBoxIcon]::Error } else { [System.Windows.Forms.MessageBoxIcon]::Information }
    [System.Windows.Forms.MessageBox]::Show($Text, '로봇팔 조종', [System.Windows.Forms.MessageBoxButtons]::OK, $icon) | Out-Null
}
