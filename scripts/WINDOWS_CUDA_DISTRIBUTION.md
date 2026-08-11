# Windows CUDA distribution

The complete Windows CUDA package is intended for 64-bit Windows systems with
an NVIDIA GPU and a driver compatible with the bundled CUDA 12.8 runtime. Models
are not bundled and are downloaded separately from the Voicebox model manager.

## Build

Build the desktop MSI and CUDA onedir backend at the same application version,
then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build_windows_cuda_distribution.ps1
```

The builder creates `release\Voicebox-<version>-Windows-x64-CUDA` containing:

- the Voicebox MSI;
- `voicebox-server-cuda.tar.gz` (server core and portable Python backend);
- `cuda-libs-cu128-v1.tar.gz` (NVIDIA runtime libraries);
- `cuda-libs.json` and `package-manifest.json`;
- `SHA256SUMS.txt`;
- `Install-Voicebox-Windows-CUDA.ps1`.

The build fails if the MSI and CUDA server versions do not match. The portable
backend is rebuilt from the current source before the archives are created.

## Install

Keep every package file in the same directory and run PowerShell as the target
Windows user:

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-Voicebox-Windows-CUDA.ps1
```

To verify every checksum, extract both CUDA archives, and validate the backend
version without changing the installed application, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-Voicebox-Windows-CUDA.ps1 -ValidateOnly
```

The installer verifies file sizes and SHA-256 hashes before changing the
installation. It stages the full CUDA backend under Voicebox AppData, validates
the runtime and version, stops managed Voicebox processes, swaps the backend,
and then installs the MSI. If a later step fails, the previous CUDA backend is
restored.

The package is not code-signed by the local build process. Public distributors
should Authenticode-sign the MSI, executables, and installer script before
publishing them.
