param(
    [string]$OutputDirectory = "backend\dist\voicebox-server-cuda\python-backend",
    [string]$CudaInternal = "",
    [string]$PythonRoot = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$defaultCudaInternal = Join-Path $projectRoot "backend\dist\voicebox-server-cuda\_internal"
if ([string]::IsNullOrWhiteSpace($CudaInternal)) {
    $CudaInternal = $defaultCudaInternal
}
if ([string]::IsNullOrWhiteSpace($PythonRoot)) {
    $pythonCommand = Get-Command python.exe -ErrorAction Stop
    $PythonRoot = Split-Path -Parent $pythonCommand.Source
}
$output = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDirectory))
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "backend\dist"))
if (-not $output.StartsWith($distRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Output directory must be under backend\dist"
}
if (-not (Test-Path -LiteralPath $CudaInternal -PathType Container)) {
    throw "CUDA internal directory not found: $CudaInternal. Build the CUDA onedir backend first or pass -CudaInternal."
}
if (-not (Test-Path -LiteralPath (Join-Path $PythonRoot "python.exe") -PathType Leaf)) {
    throw "Python 3.12 runtime not found: $PythonRoot"
}

if (Test-Path -LiteralPath $output) {
    Remove-Item -LiteralPath $output -Recurse -Force
}
New-Item -ItemType Directory -Path $output | Out-Null

function Copy-Tree {
    param([string]$Source, [string]$Destination, [string[]]$ExcludeDirectories = @(), [string[]]$ExcludeFiles = @())
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $arguments = @($Source, $Destination, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:2", "/W:1")
    if ($ExcludeDirectories.Count -gt 0) { $arguments += "/XD"; $arguments += $ExcludeDirectories }
    if ($ExcludeFiles.Count -gt 0) { $arguments += "/XF"; $arguments += $ExcludeFiles }
    & robocopy @arguments | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed from $Source to $Destination with code $LASTEXITCODE" }
}

$runtime = Join-Path $output "runtime"
Copy-Tree $PythonRoot $runtime @("Doc", "tcl", "Scripts", "__pycache__", "site-packages") @("*.pyc", "*.pyo")

$backendSite = Join-Path $projectRoot "backend\venv\Lib\site-packages"
$siteOutput = Join-Path $output "site-packages"
$backendExcludes = @(
    "torch", "torchaudio", "torchgen", "functorch", "qwen_tts", "numpy", "numpy.libs", "pip", "__pycache__"
) | ForEach-Object { Join-Path $backendSite $_ }
Copy-Tree $backendSite $siteOutput $backendExcludes @("*.pyc", "*.pyo")

$performanceSite = Join-Path $projectRoot ".venv-perf\Lib\site-packages"
$performanceOutput = Join-Path $output "performance-site-packages"
$performanceExcludes = @(
    "torch", "torchaudio", "torchgen", "functorch", "pip", "__pycache__"
) | ForEach-Object { Join-Path $performanceSite $_ }
Copy-Tree $performanceSite $performanceOutput $performanceExcludes @("*.pyc", "*.pyo", "*.whl")

$sourceOutput = Join-Path $output "app\backend"
Copy-Tree (Join-Path $projectRoot "backend") $sourceOutput @(
    "venv", "dist", "build", "tests", "__pycache__", ".pytest_cache"
) @("*.pyc", "*.pyo")

Copy-Tree (Join-Path $projectRoot "backend\vendor\qwen_tts") (Join-Path $output "qwen-source\qwen_tts") @("__pycache__") @("*.pyc", "*.pyo")
Copy-Item -LiteralPath (Join-Path $projectRoot "backend\portable_cuda_launcher.py") -Destination (Join-Path $output "launcher.py")

$internalLink = Join-Path $output "..\_internal"
if (-not (Test-Path -LiteralPath $internalLink)) {
    throw "The portable backend requires the CUDA _internal directory beside it: $internalLink"
}

$size = (Get-ChildItem $output -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("Portable CUDA backend built: {0:N1} MB at {1}" -f ($size / 1MB), $output)
