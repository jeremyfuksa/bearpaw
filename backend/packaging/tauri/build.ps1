# Build Python backend for Tauri sidecar (Windows)
# Run with PowerShell: .\build.ps1

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $ScriptDir))

Write-Host "🔨 Building Scanner Bridge Python backend for Tauri sidecar..." -ForegroundColor Cyan
Write-Host "Project root: $ProjectRoot" -ForegroundColor Cyan

# Platform triple for Windows
$TRIPLE = "x86_64-pc-windows-msvc"
$BIN_NAME = "scanner-bridge-${TRIPLE}.exe"

Write-Host "📋 Building for platform triple: $TRIPLE" -ForegroundColor Cyan
$env:PYINSTALLER_CONFIG_DIR = Join-Path $ProjectRoot "backend\.pyinstaller"
if (-not (Test-Path $env:PYINSTALLER_CONFIG_DIR)) {
    New-Item -ItemType Directory -Force -Path $env:PYINSTALLER_CONFIG_DIR | Out-Null
}

# Activate venv
Write-Host "🐍 Activating virtual environment..." -ForegroundColor Yellow
$VenvPath = Join-Path $ProjectRoot "backend\.venv\Scripts\Activate.ps1"

if (-not (Test-Path $VenvPath)) {
    Write-Host "❌ Virtual environment not found. Creating one..." -ForegroundColor Red
    & python -m venv (Join-Path $ProjectRoot "backend\.venv")
}

& $VenvPath

# Install dependencies
Write-Host "📦 Installing dependencies..." -ForegroundColor Yellow
Set-Location $ProjectRoot
& python -m pip install --upgrade pip
& python -m pip install -r backend\requirements.txt
& python -m pip install pyinstaller

# Build with PyInstaller
Write-Host "🔧 Building with PyInstaller..." -ForegroundColor Yellow
$env:SCANNER_BRIDGE_PROJECT_ROOT = $ProjectRoot
& pyinstaller --clean --noconfirm `
  --distpath "$ProjectRoot\backend\dist" `
  --workpath "$ProjectRoot\backend\build" `
  "$ProjectRoot\backend\packaging\tauri\scanner-bridge-tauri.spec"

# Rename and copy
$DistDir = Join-Path $ProjectRoot "backend\dist"
$OutputFile = Join-Path $DistDir $BIN_NAME
$TargetDir = Join-Path $ProjectRoot "src-tauri\binaries"

Write-Host "📝 Renaming executable to: $BIN_NAME" -ForegroundColor Cyan
if (Test-Path "$DistDir\scanner-bridge.exe") {
    Move-Item -Path "$DistDir\scanner-bridge.exe" -Destination $OutputFile
} else {
    Write-Host "❌ Build failed - scanner-bridge.exe not found" -ForegroundColor Red
    exit 1
}

# Create binaries directory if it doesn't exist
if (-not (Test-Path $TargetDir)) {
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
}

# Copy to Tauri binaries directory
Write-Host "📦 Installing to Tauri binaries..." -ForegroundColor Cyan
Copy-Item -Path $OutputFile -Destination $TargetDir\$BIN_NAME

# Get file size
$FileSize = (Get-Item $TargetDir\$BIN_NAME).Length / 1MB
Write-Host "✅ Build complete!" -ForegroundColor Green
Write-Host "   Binary: $TargetDir\$BIN_NAME" -ForegroundColor Green
Write-Host "   Size: $([math]::Round($FileSize, 2)) MB" -ForegroundColor Green
