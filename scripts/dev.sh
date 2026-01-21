#!/bin/bash
# Development workflow: Start backend + Tauri frontend (macOS/Linux)
set -e

PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"

echo "🚀 Starting Scanner Bridge in development mode..."
echo "Project root: $PROJECT_ROOT"
echo ""

# Check if backend is already running
if pgrep -f "scanner-bridge" > /dev/null; then
    echo "✅ Backend already running"
else
    # Start Python backend in background
    echo "🐍 Starting Python backend..."
    cd "$PROJECT_ROOT/backend"
    
    if [ ! -d ".venv" ]; then
        echo "❌ Virtual environment not found. Creating one..."
        python3 -m venv .venv
    fi
    
    source .venv/bin/activate
    pip install -q -r requirements.txt
    scanner-bridge --config config.yaml > /tmp/scanner-bridge.log 2>&1 &
    BACKEND_PID=$!
    
    echo "   Backend started (PID: $BACKEND_PID)"
    echo "   Log: /tmp/scanner-bridge.log"
    
    # Wait a moment for backend to start
    sleep 2
fi

# Start Tauri dev
echo ""
echo "🖥️  Starting Tauri development server..."
echo "   Frontend: http://localhost:5173"
echo "   Backend:  http://localhost:8000"
echo ""
cd "$PROJECT_ROOT"

# Check if Tauri CLI is available
# Source cargo environment if Rust is installed via rustup
if [ -f "$HOME/.cargo/env" ]; then
    source "$HOME/.cargo/env"
fi

if command -v tauri &> /dev/null; then
    tauri dev
elif command -v npx &> /dev/null; then
    npx tauri dev
elif command -v cargo tauri &> /dev/null; then
    cargo tauri dev
else
    echo "❌ Tauri CLI not found"
    echo "   Install: cargo install tauri-cli"
    echo "   Or:     npm install -g @tauri-apps/cli"
    
    # Cleanup backend
    if [ ! -z "$BACKEND_PID" ]; then
        kill $BACKEND_PID 2>/dev/null
    fi
    exit 1
fi

# Cleanup on exit
trap "echo ''; echo '🛑 Shutting down...'; kill $BACKEND_PID 2>/dev/null; exit 0" INT TERM
