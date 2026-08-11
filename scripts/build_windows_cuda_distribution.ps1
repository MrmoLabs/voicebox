param(
    [string]$Version = "",
    [string]$MsiPath = "",
    [string]$OutputDirectory = "",
    [string]$PythonRoot = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($Version)) {
    $package = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
    $Version = $package.version
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version must use semantic version format, for example 0.5.1."
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $projectRoot ("release\Voicebox-{0}-Windows-x64-CUDA" -f $Version)
}

$cudaDir = Join-Path $projectRoot "backend\dist\voicebox-server-cuda"
$cudaExe = Join-Path $cudaDir "voicebox-server-cuda.exe"
if (-not (Test-Path -LiteralPath $cudaExe -PathType Leaf)) {
    throw "CUDA onedir backend not found. Build it first: $cudaExe"
}

& (Join-Path $PSScriptRoot "build_portable_cuda_backend.ps1") -PythonRoot $PythonRoot
if ($LASTEXITCODE -ne 0) { throw "Portable CUDA backend build failed." }

$backendVersion = (& $cudaExe --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $backendVersion -notmatch [regex]::Escape($Version)) {
    throw "CUDA backend version does not match $Version. Rebuild the CUDA onedir backend after bumping the release version. Found: $backendVersion"
}

if ([string]::IsNullOrWhiteSpace($MsiPath)) {
    $msiCandidates = @(Get-ChildItem -Path (Join-Path $projectRoot "tauri\src-tauri\target\release\bundle\msi") -Filter "*.msi" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending)
    if ($msiCandidates.Count -eq 0) { throw "No MSI was found. Build the Tauri MSI first." }
    $MsiPath = $msiCandidates[0].FullName
}
$MsiPath = [System.IO.Path]::GetFullPath($MsiPath)
if (-not (Test-Path -LiteralPath $MsiPath -PathType Leaf)) { throw "MSI not found: $MsiPath" }
if ((Split-Path -Leaf $MsiPath) -notmatch [regex]::Escape($Version)) {
    throw "MSI filename does not match release version ${Version}: $MsiPath"
}

$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "release"))
if (-not $output.StartsWith($releaseRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Output directory must be under the repository release directory."
}
if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Recurse -Force }
New-Item -ItemType Directory -Path $output | Out-Null

& python (Join-Path $projectRoot "scripts\package_cuda.py") $cudaDir --output $output --cuda-libs-version "cu128-v1" --torch-compat ">=2.7.0,<2.11.0"
if ($LASTEXITCODE -ne 0) { throw "CUDA archive packaging failed." }

$msiName = Split-Path -Leaf $MsiPath
Copy-Item -LiteralPath $MsiPath -Destination (Join-Path $output $msiName)
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "Install-Voicebox-Windows-CUDA.ps1") -Destination (Join-Path $output "Install-Voicebox-Windows-CUDA.ps1")

$coreName = "voicebox-server-cuda.tar.gz"
$libsName = "cuda-libs-cu128-v1.tar.gz"
$payloadNames = @($msiName, $coreName, $libsName, "cuda-libs.json")
$files = foreach ($name in $payloadNames) {
    $path = Join-Path $output $name
    [ordered]@{
        name = $name
        size = (Get-Item -LiteralPath $path).Length
        sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
$manifest = [ordered]@{
    schema = 1
    product = "Voicebox"
    version = $Version
    platform = "windows-x64"
    backend = "cuda-cu128"
    msi = $msiName
    cuda_core = $coreName
    cuda_libraries = $libsName
    required_free_bytes = [int64](($files | Measure-Object -Property size -Sum).Sum + (Get-ChildItem -LiteralPath $cudaDir -Recurse -File | Measure-Object Length -Sum).Sum + 2GB)
    files = @($files)
}
$json = $manifest | ConvertTo-Json -Depth 5
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $output "package-manifest.json"), $json + [Environment]::NewLine, $utf8NoBom)

$checksumLines = @(Get-ChildItem -LiteralPath $output -File | ForEach-Object {
    "{0}  {1}" -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.Name
})
[System.IO.File]::WriteAllLines((Join-Path $output "SHA256SUMS.txt"), $checksumLines, $utf8NoBom)

Write-Host "Complete Windows CUDA distribution created: $output"
