# PyInstaller spec for Tauri sidecar
# Platform-specific naming required by Tauri externalBin
# Build: backend/packaging/tauri/build.sh (macOS/Linux) or build.ps1 (Windows)

from PyInstaller.utils.hooks import collect_submodules
import sys
import os

PROJECT_ROOT = os.path.abspath(os.environ.get("SCANNER_BRIDGE_PROJECT_ROOT", "."))

# Determine platform triple for Tauri externalBin naming
if sys.platform == "darwin":
    # macOS
    import platform
    arch = platform.machine()
    if arch == "arm64":
        TRIPLE = "aarch64-apple-darwin"
    else:
        TRIPLE = "x86_64-apple-darwin"
elif sys.platform == "win32":
    TRIPLE = "x86_64-pc-windows-msvc"
else:
    TRIPLE = "x86_64-unknown-linux-gnu"

EXE_NAME = f"scanner-bridge-{TRIPLE}"
if sys.platform == "win32":
    EXE_NAME = EXE_NAME + ".exe"

print(f"Building for Tauri externalBin: {EXE_NAME}")

hiddenimports = collect_submodules("scanner_bridge")

a = Analysis(
    [os.path.join(PROJECT_ROOT, "backend", "src", "scanner_bridge", "main.py")],
    pathex=[os.path.join(PROJECT_ROOT, "backend", "src")],
    binaries=[],
    datas=[
        # Include default config
        (os.path.join(PROJECT_ROOT, "backend", "config.example.yaml"), "."),
    ],
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        # Exclude unnecessary large dependencies
        "tkinter",
        "matplotlib",
        "PyQt5",
        "PySide2",
        "PySide6",
        "PyQt6",
        "notebook",
        "IPython",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=None,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=None)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="scanner-bridge",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,  # Hide console in release (change to True for debugging)
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)

# Note: The build script will rename the executable to EXE_NAME
# This is done after PyInstaller completes
