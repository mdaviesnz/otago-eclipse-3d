# download_cmsaf.ps1
# Downloads and extracts CM SAF CLARA-A3 (CFC) order archives for Otago

param(
    [string[]]$OrderIds = @("ORD70689", "ORD70690"),
    [string]$OutputDir = "$PSScriptRoot\cache\cmsaf",
    [string]$Username = $env:CMSAF_USER,
    [string]$Password = $env:CMSAF_PASSWORD
)

$ErrorActionPreference = "Stop"

if (-not $Username) {
    $Username = Read-Host "Enter CM SAF username (e.g. routcm)"
}
if (-not $Password) {
    $Password = Read-Host "Enter CM SAF password" -AsSecureString
    $BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password)
    $Password = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
}

# Ensure output directory exists
if (-not (Test-Path -Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

foreach ($orderId in $OrderIds) {
    $url = "https://cmsaf.dwd.de/data/$orderId/$orderId.tar"
    $tarPath = Join-Path -Path $OutputDir -ChildPath "$orderId.tar"

    Write-Host "`nDownloading CM SAF archive ($orderId) to $tarPath..." -ForegroundColor Cyan

    # Use curl.exe with basic auth
    & curl.exe -u "${username}:${password}" --progress-bar -o "$tarPath" "$url"

    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -Path $tarPath)) {
        Write-Error "Failed to download $url"
        continue
    }

    $fileSizeMB = [math]::Round((Get-Item -Path $tarPath).Length / 1MB, 2)
    Write-Host "Downloaded $orderId ($fileSizeMB MB)." -ForegroundColor Green

    Write-Host "Extracting $orderId..." -ForegroundColor Cyan
    & tar.exe -xf "$tarPath" -C "$OutputDir"

    if ($LASTEXITCODE -eq 0) {
        Write-Host "Extraction of $orderId complete!" -ForegroundColor Green
    } else {
        Write-Error "Failed to extract $tarPath"
    }
}

$ncFiles = Get-ChildItem -Path $OutputDir -Filter "*.nc"
$julyFiles = Get-ChildItem -Path $OutputDir -Filter "*0701*.nc"

Write-Host "`n===============================================" -ForegroundColor Yellow
Write-Host "All downloads complete!" -ForegroundColor Green
Write-Host "Total NetCDF files in $OutputDir : $($ncFiles.Count)" -ForegroundColor Yellow
Write-Host "Total July files (1979 - 2026)      : $($julyFiles.Count)" -ForegroundColor Yellow
Write-Host "===============================================" -ForegroundColor Yellow
