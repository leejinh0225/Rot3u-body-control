$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$powerShellExe = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$launcher = Join-Path $PSScriptRoot 'launch-robot-arm.ps1'
$icon = Join-Path $PSScriptRoot 'launcher/robot-arm.ico'
foreach ($entry in @(
    @{ Name = '로봇팔 조종'; Action = 'Start'; Description = '로컬 서버를 준비하고 몸동작 조종 화면을 전용 창으로 엽니다.' },
    @{ Name = '로봇팔 서버 종료'; Action = 'Stop'; Description = '실물 조종을 먼저 멈춘 뒤 사용하십시오. 로컬 웹 서버를 종료합니다.' }
)) {
    $linkPath = Join-Path $desktop ($entry.Name + '.lnk')
    $shortcut = $shell.CreateShortcut($linkPath)
    $shortcut.TargetPath = $powerShellExe
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '" -Action ' + $entry.Action
    $shortcut.WorkingDirectory = $PSScriptRoot
    $shortcut.Description = $entry.Description
    $shortcut.IconLocation = $icon + ',0'
    $shortcut.Save()
    Write-Output $linkPath
}
