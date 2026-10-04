$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $projectRoot 'launcher/common.ps1')
$launcher = Join-Path $projectRoot 'launch-robot-arm.ps1'
$powerShellExe = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$fixtureRoot = Join-Path $projectRoot '.qa/launcher-test'
New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
function Assert-Launcher([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Get-TestPort {
    $socket = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $socket.Start()
    $port = $socket.LocalEndpoint.Port
    $socket.Stop()
    return $port
}
$testPort = Get-TestPort
$otherPort = Get-TestPort
$ownedServer = $null
$otherServer = $null
try {
    & $powerShellExe -NoProfile -ExecutionPolicy Bypass -File $launcher -NoBrowser -Quiet -Port $testPort | Out-Null
    Assert-Launcher ($LASTEXITCODE -eq 0) 'Cold start failed'
    Assert-Launcher (Get-RobotServerIdentity $testPort) 'Identity was not served'
    $ownedServer = Get-RobotServerProcess $testPort
    Assert-Launcher ($null -ne $ownedServer) 'Owned listening process could not be verified'
    $firstPid = $ownedServer.ProcessId
    Assert-Launcher ((Get-Process -Id $firstPid).MainWindowHandle -eq [IntPtr]::Zero) 'Server has a visible window'
    $page = Invoke-WebRequest "http://127.0.0.1:$testPort/body-control/" -UseBasicParsing -TimeoutSec 3
    Assert-Launcher ($page.StatusCode -eq 200 -and $page.Content.Contains('id="camera"')) 'Control page did not load'

    & $powerShellExe -NoProfile -ExecutionPolicy Bypass -File $launcher -NoBrowser -Quiet -Port $testPort | Out-Null
    Assert-Launcher ($LASTEXITCODE -eq 0) 'Repeat start failed'
    Assert-Launcher ((Get-RobotServerProcess $testPort).ProcessId -eq $firstPid) 'Repeat start created another server'

    & $powerShellExe -NoProfile -ExecutionPolicy Bypass -File $launcher -Action Stop -Quiet -Port $testPort | Out-Null
    Assert-Launcher ($LASTEXITCODE -eq 0 -and -not (Get-RobotServerIdentity $testPort)) 'Stop failed'
    $ownedServer = $null
    & $powerShellExe -NoProfile -ExecutionPolicy Bypass -File $launcher -Action Stop -Quiet -Port $testPort | Out-Null
    Assert-Launcher ($LASTEXITCODE -eq 0) 'Repeated stop failed'

    # Two simultaneous first launches must still create one server.
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $launcher + '" -NoBrowser -Quiet -Port ' + $testPort
    $a = Start-Process $powerShellExe -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $fixtureRoot 'a.out') -RedirectStandardError (Join-Path $fixtureRoot 'a.err')
    $null = $a.Handle # Cache the handle before exit (Windows PowerShell 5.1).
    $b = Start-Process $powerShellExe -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $fixtureRoot 'b.out') -RedirectStandardError (Join-Path $fixtureRoot 'b.err')
    $null = $b.Handle
    $a.WaitForExit(); $b.WaitForExit()
    $ownedServer = Get-RobotServerProcess $testPort
    Assert-Launcher ($a.ExitCode -eq 0 -and $b.ExitCode -eq 0) 'Concurrent launch failed'
    $rootPattern = [regex]::Escape($projectRoot)
    $processes = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "--port\s+$testPort(?:\s|$)" -and $_.CommandLine -match 'launcher[\\/]server.py' -and $_.CommandLine -match $rootPattern })
    Assert-Launcher ($processes.Count -eq 1) 'Concurrent launch left duplicate processes'

    # Even a server claiming the same identity is rejected if its directory differs.
    $otherRoot = Join-Path $fixtureRoot 'other-root'
    New-Item -ItemType Directory -Path (Join-Path $otherRoot 'launcher') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot 'launcher/identity.json') -Destination (Join-Path $otherRoot 'launcher/identity.json')
    $otherServer = Start-Process (Get-RobotPython) -ArgumentList @('-m','http.server',"$otherPort",'--bind','127.0.0.1','--directory',('"'+$otherRoot+'"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $fixtureRoot 'other.out') -RedirectStandardError (Join-Path $fixtureRoot 'other.err')
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    while (-not (Get-RobotServerIdentity $otherPort) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    Assert-Launcher (Get-RobotServerIdentity $otherPort) 'Foreign server fixture failed'
    foreach ($action in @('Start','Stop')) {
        $rejectionArguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $launcher + '" -Action '+$action+' -NoBrowser -Quiet -Port ' + $otherPort
        $rejected = Start-Process $powerShellExe -ArgumentList $rejectionArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $fixtureRoot "rejected-$action.out") -RedirectStandardError (Join-Path $fixtureRoot "rejected-$action.err")
        $null = $rejected.Handle
        $rejected.WaitForExit()
        Assert-Launcher ($rejected.ExitCode -eq 1) 'Foreign root was adopted or stopped'
    }
    $otherServer.Refresh()
    Assert-Launcher (-not $otherServer.HasExited) 'Foreign server was terminated'
    Write-Output 'LAUNCHER_OK: cold start, reuse, page, hidden window, stop, concurrent launch, foreign server preservation'
} finally {
    if (Get-RobotServerProcess $testPort) { Stop-RobotServer $testPort | Out-Null }
    if ($otherServer) { $otherServer.Refresh(); if (-not $otherServer.HasExited) { $otherServer.Kill() } }
}
