# Development workflow: Start backend + Tauri frontend (Windows)
# Run with PowerShell: .\dev.ps1

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

Write-Host "🚀 Starting Scanner Bridge in development mode..." -ForegroundColor Cyan
Write-Host "Project root: $ProjectRoot" -ForegroundColor Cyan
Write-Host ""

# Check if backend is already running
$BackendProcess = Get-Process -Name "python" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*scanner-bridge*" }

if ($BackendProcess) {
    Write-Host "✅ Backend already running (PID: $($BackendProcess.Id))" -ForegroundColor Green
} else {
    # Start Python backend in new window
    Write-Host "🐍 Starting Python backend..." -ForegroundColor Yellow
    $BackendScript = {
        param($ProjectRoot)
        
        Set-Location "$ProjectRoot\backend"
        
        if (-not (Test-Path ".venv")) {
            Write-Host "Creating virtual environment..." -ForegroundColor Cyan
            python -m venv .venv
        }
        
        & .\.venv\Scripts\Activate.ps1
        pip install -q -r requirements.txt
        python -m scanner_bridge --config config.yaml
        
        Read-Host "Press Enter to exit..."
    }
    
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "$BackendScript $ProjectRoot"
    
    Write-Host "   Backend started in new window" -ForegroundColor Green
    Write-Host ""
    
    # Wait a moment for backend to start
    Start-Sleep -Seconds 3
}

# Start Tauri dev
Write-Host "🖥️  Starting Tauri development server..." -ForegroundColor Yellow
Write-Host "   Frontend: http://localhost:5173" -ForegroundColor Cyan
Write-Host "   Backend:  http://localhost:8000" -ForegroundColor Cyan
Write-Host ""
Set-Location "$ProjectRoot

# Check if Tauri CLI is available
$TauriCommand = Get-Command cargo -ErrorAction SilentlyContinue
if ($TauriCommand) {
    cargo tauri dev
} else {
    $NpmTauri = Get-Command npx tauri -ErrorAction SilentlyContinue
    if ($NpmTauri) {
        Write-Host "Using npx tauri..." -ForegroundColor Cyan
        npx tauri dev
    } else {
        Write-Host "❌ Tauri CLI not found" -ForegroundColor Red
        Write-Host "   Install: cargo install tauri-cli" -ForegroundColor Yellow
        Write-Host "   Or:     npm install -g @tauri-apps/cli" -ForegroundColor Yellow
        exit 1
    }
}
