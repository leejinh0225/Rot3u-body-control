$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$port = 8765
if (-not (Test-Path -LiteralPath (Join-Path $root 'body-control/vendor/pose_landmarker_lite.task'))) {
    Write-Host 'Preparing local body tracking assets (first run requires internet)...'
    python (Join-Path $root 'body-control/setup-assets.py')
    if ($LASTEXITCODE -ne 0) { Write-Warning 'Body tracking assets could not be prepared. The servo viewer remains available.' }
}
Write-Host 'Robot arm viewer: http://127.0.0.1:8765/viewer/'
Write-Host 'Virtual body control: http://127.0.0.1:8765/body-control/ (no Arduino required)'
Write-Host 'Open this URL in desktop Chrome or Edge. Ctrl+C stops the local server.'
Write-Host 'Keep this terminal open. Upload ArmBench.ino before USB connection.'
python -m http.server $port --bind 127.0.0.1 --directory $root
