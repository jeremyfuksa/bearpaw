#!/bin/bash
# Build Python backend for Tauri sidecar (macOS/Linux)
set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

echo "🔨 Building Scanner Bridge Python backend for Tauri sidecar..."
echo "Project root: $PROJECT_ROOT"

# Determine platform triple
ARCH=$(uname -m)
OS=$(uname -s)

if [[ "$OS" == "Darwin" ]]; then
    if [[ "$ARCH" == "arm64" ]]; then
        TRIPLE="aarch64-apple-darwin"
    else
        TRIPLE="x86_64-apple-darwin"
    fi
elif [[ "$OS" == "Linux" ]]; then
    TRIPLE="x86_64-unknown-linux-gnu"
else
    echo "❌ Unsupported platform: $OS"
    exit 1
fi

echo "📋 Building for platform triple: $TRIPLE"

# Activate venv and install dependencies
cd "$PROJECT_ROOT"
export PYINSTALLER_CONFIG_DIR="$PROJECT_ROOT/backend/.pyinstaller"
mkdir -p "$PYINSTALLER_CONFIG_DIR"
if [ ! -d "backend/.venv" ]; then
    echo "❌ Virtual environment not found. Creating one..."
    cd backend
    python3 -m venv .venv
    cd ..
fi

echo "🐍 Activating virtual environment..."
source backend/.venv/bin/activate

# Install dependencies
echo "📦 Installing dependencies..."
pip install --upgrade pip
pip install -r backend/requirements.txt
pip install pyinstaller

# Build with PyInstaller
echo "🔧 Building with PyInstaller..."
export SCANNER_BRIDGE_PROJECT_ROOT="$PROJECT_ROOT"
pyinstaller --clean --noconfirm \
  --distpath "$PROJECT_ROOT/backend/dist" \
  --workpath "$PROJECT_ROOT/backend/build" \
  "$PROJECT_ROOT/backend/packaging/tauri/scanner-bridge-tauri.spec"

# Rename executable for Tauri externalBin
DIST_DIR="$PROJECT_ROOT/backend/dist"
if [[ "$OS" == "Darwin" ]]; then
    BIN_NAME="scanner-bridge-${TRIPLE}"
else
    BIN_NAME="scanner-bridge-${TRIPLE}"
fi

echo "📝 Renaming executable to: $BIN_NAME"
mv "$DIST_DIR/scanner-bridge" "$DIST_DIR/$BIN_NAME"

# Create binaries directory if it doesn't exist
TARGET_DIR="$PROJECT_ROOT/src-tauri/binaries"
mkdir -p "$TARGET_DIR"

# Copy to Tauri binaries directory
echo "📦 Installing to Tauri binaries..."
cp "$DIST_DIR/$BIN_NAME" "$TARGET_DIR/"

# Make executable
chmod +x "$TARGET_DIR/$BIN_NAME"

echo "✅ Build complete!"
echo "   Binary: $TARGET_DIR/$BIN_NAME"
echo "   Size: $(du -h "$TARGET_DIR/$BIN_NAME" | cut -f1)"
