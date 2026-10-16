$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$desktop = 'D:\Program\Voicebox\voicebox.exe'
$portable = Join-Path $env:APPDATA 'sh.voicebox.app\backends\cuda\python-backend'
$payload = Join-Path $workspace 'tauri\src-tauri\target\release\voicebox.exe'
if (Get-Process voicebox -ErrorAction SilentlyContinue) { throw 'Close Voicebox before updating.' }
if (!(Test-Path -LiteralPath $desktop) -or !(Test-Path -LiteralPath $payload)) { throw 'Desktop paths missing.' }
$backup = Join-Path $workspace ('release\local-stream-preview-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup | Out-Null
$files = @('backends/pytorch_backend.py', 'models.py', 'routes/generations.py', 'services/generation.py', 'utils/live_audio.py')
$manifest = @()
foreach ($relative in $files) {
    $source = Join-Path $workspace ('backend/' + $relative)
    $target = Join-Path $portable ('app/backend/' + $relative)
    $saved = Join-Path $backup ('backend/' + $relative)
    New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force | Out-Null
    $existed = Test-Path -LiteralPath $target
    if ($existed) { Copy-Item -LiteralPath $target -Destination $saved }
    $manifest += [ordered]@{ target = $target; backup = $saved; existed = $existed; new_sha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash }
}
Copy-Item -LiteralPath $desktop -Destination (Join-Path $backup 'voicebox.exe')
$manifest += [ordered]@{ target = $desktop; backup = (Join-Path $backup 'voicebox.exe'); existed = $true; new_sha256 = (Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash }
$json = $manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path $backup 'manifest.json'), $json, [System.Text.UTF8Encoding]::new($false))
foreach ($relative in $files) {
    Copy-Item -LiteralPath (Join-Path $workspace ('backend/' + $relative)) -Destination (Join-Path $portable ('app/backend/' + $relative)) -Force
}
Copy-Item -LiteralPath $payload -Destination $desktop -Force
foreach ($entry in $manifest) {
    if ((Get-FileHash -LiteralPath $entry.target -Algorithm SHA256).Hash -ne $entry.new_sha256) { throw ('Hash mismatch: ' + $entry.target) }
}
Write-Output ('Installed and verified. Backup: ' + $backup)
