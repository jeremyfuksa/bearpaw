# Build Scanner Bridge for all platforms (Windows)
# Run with PowerShell: .\build-all.ps1

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

Write-Host "🔨 Building Scanner Bridge for all platforms..." -ForegroundColor Cyan
Write-Host "Project root: $ProjectRoot" -ForegroundColor Cyan

# 1. Build Python backend
Write-Host ""
Write-Host "📦 Building Python backend..." -ForegroundColor Yellow
Set-Location "$ProjectRoot\backend\packaging\tauri"
.\build.ps1

# 2. Build frontend
Write-Host ""
Write-Host "🎨 Building frontend..." -ForegroundColor Yellow
Set-Location "$ProjectRoot\frontend"
npm install
npm run build

# 3. Check if Tauri CLI is installed
Write-Host ""
Write-Host "🚀 Building Tauri app..." -ForegroundColor Yellow
Set-Location "$ProjectRoot"
$TauriBundles = if ($env:TAURI_BUNDLES) { $env:TAURI_BUNDLES } else { "app" }

$TauriCommand = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $TauriCommand) {
    $NpmTauri = Get-Command npx tauri -ErrorAction SilentlyContinue
    if ($NpmTauri) {
        Write-Host "Using npx tauri..." -ForegroundColor Cyan
        npx tauri build --bundles $TauriBundles
    } else {
        Write-Host "❌ Tauri CLI not found. Installing..." -ForegroundColor Red
        Write-Host "   Run: cargo install tauri-cli" -ForegroundColor Yellow
        Write-Host "   Or:   npm install -g @tauri-apps/cli" -ForegroundColor Yellow
        exit 1
    }
} else {
    cargo tauri build --bundles $TauriBundles
}

Write-Host ""
Write-Host "✅ Build complete!" -ForegroundColor Green
Write-Host ""
Write-Host "📁 Artifacts:" -ForegroundColor Cyan
Write-Host "   Windows: src-tauri\target\release\bundle\msi\" -ForegroundColor Green
