param(
    [switch]$KeepStaging,
    [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
$packageDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $packageDir "package-manifest.json"

if (-not [Environment]::Is64BitOperatingSystem) {
    throw "Voicebox CUDA requires 64-bit Windows."
}
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Package manifest is missing: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.platform -ne "windows-x64") {
    throw "Unsupported package platform: $($manifest.platform)"
}

foreach ($file in $manifest.files) {
    $path = Join-Path $packageDir $file.name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Package file is missing: $($file.name)"
    }
    $actualSize = (Get-Item -LiteralPath $path).Length
    if ($actualSize -ne [int64]$file.size) {
        throw "Package file size mismatch: $($file.name)"
    }
    $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $file.sha256.ToLowerInvariant()) {
        throw "Package checksum mismatch: $($file.name)"
    }
}

$msiPath = Join-Path $packageDir $manifest.msi
$coreArchive = Join-Path $packageDir $manifest.cuda_core
$libsArchive = Join-Path $packageDir $manifest.cuda_libraries
$dataDir = Join-Path $env:APPDATA "sh.voicebox.app"
$backendsDir = Join-Path $dataDir "backends"
# Resolve the backend junction itself before creating staging directories.
# Windows tar cannot reliably chdir through nested junctions (the application
# data root and its backends child may both be redirected).
if (Test-Path -LiteralPath $backendsDir) {
    $backendsItem = Get-Item -LiteralPath $backendsDir -Force
    if ($backendsItem.Target) {
        $backendTarget = @($backendsItem.Target)[0]
        if ([System.IO.Path]::IsPathRooted($backendTarget)) { $backendsDir = $backendTarget }
    }
}
$cudaDir = Join-Path $backendsDir "cuda"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$stagingDir = Join-Path $backendsDir (".cuda-install-" + $stamp)
$backupDir = Join-Path $backendsDir ("cuda.backup-" + $stamp)

$requiredBytes = [int64]$manifest.required_free_bytes
$storagePath = $backendsDir
$probe = $dataDir
while (-not (Test-Path -LiteralPath $probe)) {
    $parent = Split-Path -Parent $probe
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $probe) { break }
    $probe = $parent
}
while (Test-Path -LiteralPath $probe) {
    $item = Get-Item -LiteralPath $probe -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $item.Target) {
        $target = @($item.Target)[0]
        if ([System.IO.Path]::IsPathRooted($target)) {
            $relative = $dataDir.Substring($probe.Length).TrimStart('\')
            $storagePath = if ($relative) { Join-Path $target $relative } else { $target }
            break
        }
    }
    $parent = Split-Path -Parent $probe
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $probe) { break }
    $probe = $parent
}
$driveRoot = [System.IO.Path]::GetPathRoot($storagePath)
$drive = New-Object System.IO.DriveInfo($driveRoot)
$availableBytes = [int64]$drive.AvailableFreeSpace
if ($availableBytes -lt $requiredBytes) {
    throw ("Not enough free space on {0}. Required temporarily: {1:N1} GB; available: {2:N1} GB." -f $driveRoot, ($requiredBytes / 1GB), ($availableBytes / 1GB))
}

New-Item -ItemType Directory -Force -Path $backendsDir | Out-Null
New-Item -ItemType Directory -Path $stagingDir | Out-Null
$backendActivated = $false

try {
    & tar.exe -xzf $coreArchive -C $stagingDir
    if ($LASTEXITCODE -ne 0) { throw "Failed to extract the CUDA server archive." }
    & tar.exe -xzf $libsArchive -C $stagingDir
    if ($LASTEXITCODE -ne 0) { throw "Failed to extract the CUDA libraries archive." }
    Copy-Item -LiteralPath (Join-Path $packageDir "cuda-libs.json") -Destination (Join-Path $stagingDir "cuda-libs.json")

    $cudaExe = Join-Path $stagingDir "voicebox-server-cuda.exe"
    $pythonExe = Join-Path $stagingDir "python-backend\runtime\python.exe"
    $launcher = Join-Path $stagingDir "python-backend\launcher.py"
    $torchDir = Join-Path $stagingDir "_internal\torch"
    foreach ($required in @($cudaExe, $pythonExe, $launcher, $torchDir)) {
        if (-not (Test-Path -LiteralPath $required)) {
            throw "Extracted CUDA backend is incomplete: $required"
        }
    }

    $backendVersion = (& $cudaExe --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $backendVersion -notmatch [regex]::Escape($manifest.version)) {
        throw "CUDA backend version does not match package version $($manifest.version): $backendVersion"
    }

    if ($ValidateOnly) {
        Write-Host "Voicebox $($manifest.version) package validation succeeded. No installation changes were made."
        return
    }

    Get-Process -Name "voicebox", "voicebox-server", "voicebox-server-cuda", "python" -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -eq "voicebox" -or ($_.Path -and $_.Path.StartsWith($dataDir, [StringComparison]::OrdinalIgnoreCase)) } |
        Stop-Process -Force

    if (Test-Path -LiteralPath $cudaDir) {
        Move-Item -LiteralPath $cudaDir -Destination $backupDir
    }
    Move-Item -LiteralPath $stagingDir -Destination $cudaDir
    $backendActivated = $true

    $msi = Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", $msiPath, "/passive", "/norestart") -Wait -PassThru
    if ($msi.ExitCode -notin @(0, 3010)) {
        throw "MSI installation failed with exit code $($msi.ExitCode)."
    }

    Write-Host "Voicebox $($manifest.version) with the complete CUDA backend was installed successfully."
    if (Test-Path -LiteralPath $backupDir) {
        Write-Host "Previous CUDA backend backup: $backupDir"
    }
} catch {
    if ($backendActivated -and (Test-Path -LiteralPath $cudaDir -PathType Container)) {
        Remove-Item -LiteralPath $cudaDir -Recurse -Force
    }
    if (Test-Path -LiteralPath $backupDir -PathType Container) {
        Move-Item -LiteralPath $backupDir -Destination $cudaDir
    }
    throw
} finally {
    if (-not $KeepStaging -and (Test-Path -LiteralPath $stagingDir)) {
        Remove-Item -LiteralPath $stagingDir -Recurse -Force
    }
}
