param([switch]$FrontendOnly)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$desktop = 'D:\Program\Voicebox\voicebox.exe'
$portable = Join-Path $env:APPDATA 'sh.voicebox.app\backends\cuda\python-backend'
$payload = Join-Path $workspace 'tauri\src-tauri\target\release\voicebox.exe'
$active = Invoke-RestMethod -TimeoutSec 10 'http://127.0.0.1:17493/tasks/active'
if ($active.generations.Count -gt 0 -or @($active.downloads | Where-Object { $_.status -eq 'downloading' }).Count -gt 0) { throw 'Voicebox has active work; update deferred.' }
foreach ($book in (Invoke-RestMethod -TimeoutSec 10 'http://127.0.0.1:17493/audiobooks')) {
    $plan = Invoke-RestMethod -TimeoutSec 10 ('http://127.0.0.1:17493/audiobooks/' + $book.id + '/generation-plans/active')
    if ($plan -and $plan.status -eq 'running') { throw 'An audiobook batch is active; update deferred.' }
}
$backup = Join-Path $workspace ('release\local-workflow-update-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup | Out-Null
$files = @('backends/__init__.py', 'backends/pytorch_backend.py', 'backends/qwen_voice_design_backend.py', 'models.py', 'routes/generations.py', 'routes/audiobooks.py', 'routes/models.py', 'services/generation.py', 'utils/model_runtime.py', 'utils/chunked_tts.py')
$manifest = @()
foreach ($relative in $files) {
    $source = Join-Path $workspace ('backend/' + $relative)
    $target = Join-Path $portable ('app/backend/' + $relative)
    $saved = Join-Path $backup ('backend/' + $relative)
    New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force | Out-Null
    $existed = Test-Path -LiteralPath $target
    if ($FrontendOnly -and (!$existed -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash)) { throw ('Backend source differs; full update required: ' + $relative) }
    if ($existed) { Copy-Item -LiteralPath $target -Destination $saved }
    $manifest += [ordered]@{ target = $target; backup = $saved; existed = $existed; new_sha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash }
}
Copy-Item -LiteralPath $desktop -Destination (Join-Path $backup 'voicebox.exe')
$manifest += [ordered]@{ target = $desktop; backup = (Join-Path $backup 'voicebox.exe'); existed = $true; new_sha256 = (Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash }
[System.IO.File]::WriteAllText((Join-Path $backup 'manifest.json'), ($manifest | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))
$desktopProcesses = Get-Process voicebox -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $desktop }
foreach ($process in $desktopProcesses) { Stop-Process -Id $process.Id; $null = $process.WaitForExit(5000) }
if (!$FrontendOnly) {
    $portablePython = Join-Path $portable 'runtime\python.exe'
    $oldBackend = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $portablePython -and $_.CommandLine -match 'launcher.py' -and $_.CommandLine -match '--port 17493( |$)' }
    foreach ($process in $oldBackend) { Stop-Process -Id $process.ProcessId }
    $stillRunning = $false
    try { $null = Invoke-RestMethod -TimeoutSec 2 'http://127.0.0.1:17493/health'; $stillRunning = $true } catch { }
    if ($stillRunning) { throw 'A retained backend still owns port 17493; files were not replaced.' }
    foreach ($relative in $files) {
        Copy-Item -LiteralPath (Join-Path $workspace ('backend/' + $relative)) -Destination (Join-Path $portable ('app/backend/' + $relative)) -Force
    }
}
Copy-Item -LiteralPath $payload -Destination $desktop -Force
foreach ($entry in $manifest) {
    if ((Get-FileHash -LiteralPath $entry.target -Algorithm SHA256).Hash -ne $entry.new_sha256) { throw ('Hash mismatch: ' + $entry.target) }
}
Write-Output ('Installed and verified. Backup: ' + $backup)
