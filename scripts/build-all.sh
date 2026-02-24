#!/bin/bash
# Build Scanner Bridge for all platforms (macOS/Linux)
set -e

PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"

echo "🔨 Building Scanner Bridge for all platforms..."
echo "Project root: $PROJECT_ROOT"

# 1. Build Python backend for current platform
echo ""
echo "📦 Building Python backend..."
cd "$PROJECT_ROOT/backend/packaging/tauri"
./build.sh

# 2. Build frontend
echo ""
echo "🎨 Building frontend..."
cd "$PROJECT_ROOT/frontend"
npm install
npm run build

# 3. Check if Tauri CLI is installed
# Source cargo environment if Rust is installed via rustup
if [ -f "$HOME/.cargo/env" ]; then
    source "$HOME/.cargo/env"
fi

echo ""
echo "🚀 Building Tauri app..."
cd "$PROJECT_ROOT"
TAURI_BUNDLES="${TAURI_BUNDLES:-app}"
if cargo tauri --version &> /dev/null; then
    cargo tauri build --bundles "$TAURI_BUNDLES"
elif npx tauri --version &> /dev/null; then
    echo "Using npx tauri..."
    npx tauri build --bundles "$TAURI_BUNDLES"
else
    echo ""
    echo "❌ Tauri CLI not found. Installing..."
    echo "   Run: cargo install tauri-cli"
    echo "   Or: npm install -g @tauri-apps/cli"
    exit 1
fi

echo ""
echo "✅ Build complete!"
echo ""
echo "📁 Artifacts:"
echo "   macOS: src-tauri/target/release/bundle/macos/"
echo "   Linux: src-tauri/target/release/bundle/deb/"
echo ""
echo "   Note: For cross-platform builds, run this script on each target platform"
