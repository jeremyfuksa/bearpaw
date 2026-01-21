# Tauri Integration Guide

Scanner Bridge is now available as a standalone desktop application using Tauri.

---

## Overview

Scanner Bridge uses Tauri to provide a native desktop application experience:

- **Frontend:** React + TypeScript rendered in WebView
- **Backend:** Python FastAPI running as a sidecar process
- **Communication:** HTTP/WebSocket over localhost
- **Platforms:** macOS (Intel/ARM), Windows, Linux

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Tauri App Shell                     │
│  ┌─────────────────────────────────────────────────┐   │
│  │           React Frontend (WebView)             │   │
│  │  - Modern UI with React 18+                 │   │
│  │  - Real-time updates via WebSocket            │   │
│  │  - HTTP API calls to backend                │   │
│  └─────────────────────────────────────────────────┘   │
│                         │                             │
│                         │ Tauri Shell Plugin           │
│                         │ (spawns sidecar)            │
│                         ▼                             │
│  ┌─────────────────────────────────────────────────┐   │
│  │     Python Backend (Sidecar Process)           │   │
│  │  - scanner-bridge executable (PyInstaller)      │   │
│  │  - HTTP server on localhost:8000             │   │
│  │  - WebSocket server for real-time updates       │   │
│  │  - USB serial communication with scanner       │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Benefits of Tauri + Sidecar

- **Familiar Development:** Use existing React + Python codebase
- **Small Bundle:** ~50MB (vs ~200MB for Electron)
- **Native Performance:** WebView2 on Windows, WebKit on macOS/Linux
- **Auto-Update:** Built-in update mechanism
- **Distribution:** Single installer for each platform

---

## Installation

### Prerequisites

**For Development:**
- Node.js 20+
- Python 3.10+
- Rust toolchain (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
- Tauri CLI (`cargo install tauri-cli` or `npm install -g @tauri-apps/cli`)

**For Building:**
- Platform-specific build tools:
  - **macOS:** Xcode Command Line Tools
  - **Windows:** Visual Studio Build Tools
  - **Linux:** GCC, libwebkit2gtk-4.1-0, libgtk-3-0

### Quick Start

#### Development Mode

```bash
# Clone repository
git clone https://github.com/YOUR_USERNAME/uniden.git
cd uniden

# Start development (auto-launches backend + Tauri)
./scripts/dev.sh        # macOS/Linux
# or
.\scripts\dev.ps1        # Windows
```

This will:
1. Start Python backend on `localhost:8000`
2. Start Vite dev server on `localhost:5173`
3. Launch Tauri window with hot reload

#### Building for Distribution

```bash
# Build for current platform
./scripts/build-all.sh    # macOS/Linux
# or
.\scripts\build-all.ps1    # Windows
```

This will:
1. Build Python backend with PyInstaller
2. Build React frontend with Vite
3. Bundle everything with Tauri
4. Create platform-specific installers:
   - macOS: `.app` and `.dmg`
   - Windows: `.msi`
   - Linux: `.deb` and `.AppImage`

---

## Development Workflow

### Project Structure

```
uniden/
├── backend/              # Python backend (unchanged)
│   ├── src/scanner_bridge/
│   ├── packaging/tauri/  # NEW: PyInstaller scripts
│   │   ├── scanner-bridge-tauri.spec
│   │   ├── build.sh
│   │   └── build.ps1
│   └── config.tauri.yaml # NEW: Default config for Tauri
│
├── frontend/             # React frontend (minimal changes)
│   ├── src/
│   ├── vite.config.ts    # UPDATED: Tauri base path
│   └── package.json
│
├── src-tauri/           # NEW: Tauri Rust backend
│   ├── src/main.rs      # Spawns Python sidecar
│   ├── tauri.conf.json # App configuration
│   ├── Cargo.toml       # Rust dependencies
│   ├── capabilities/     # Permissions
│   ├── binaries/        # Python executables (generated)
│   └── icons/          # App icons
│
├── scripts/             # NEW: Build automation
│   ├── dev.sh
│   ├── dev.ps1
│   ├── build-all.sh
│   └── build-all.ps1
│
└── docs/
    ├── USB_PERMISSIONS_SETUP.md  # NEW: USB setup guide
    └── TAURI_INTEGRATION.md     # This file
```

### Development Workflow

#### 1. Start Backend Separately (Optional)

For faster iteration, you can start the backend manually:

```bash
cd backend
source .venv/bin/activate
python -m scanner_bridge --config config.yaml
```

Then in another terminal:
```bash
cd src-tauri
cargo tauri dev
```

#### 2. Full Stack Development

Use the provided scripts for easier development:

```bash
./scripts/dev.sh    # macOS/Linux
.\scripts\dev.ps1    # Windows
```

This handles:
- Backend startup and detection
- Frontend hot reload
- Tauri window management
- Backend cleanup on exit

#### 3. Frontend Development Only

If you're only working on UI:

```bash
cd frontend
npm run dev
```

Then manually start the backend separately.

#### 4. Backend Development Only

If you're only working on Python:

```bash
cd backend
source .venv/bin/activate
python -m scanner_bridge --config config.yaml
```

Then test with `curl` or Postman at `http://localhost:8000`.

---

## Building for Distribution

### Cross-Platform Builds

To build for all three platforms, run the build script on each platform:

#### macOS

```bash
./scripts/build-all.sh
```

**Output:** `src-tauri/target/release/bundle/macos/`
- `Scanner Bridge.app`
- `Scanner Bridge 1.0.0.dmg`

**Signing:** For distribution, you'll need an Apple Developer certificate. Update `src-tauri/tauri.conf.json`:

```json
{
  "bundle": {
    "macOS": {
      "signingIdentity": "Developer ID Application: Your Name (TEAM_ID)"
    }
  }
}
```

#### Windows

```powershell
.\scripts\build-all.ps1
```

**Output:** `src-tauri\target\release\bundle\msi\`
- `Scanner Bridge_1.0.0_x64_en-US.msi`

**Signing:** Use a code signing certificate. Update `src-tauri/tauri.conf.json`:

```json
{
  "bundle": {
    "windows": {
      "certificateThumbprint": "YOUR_CERTIFICATE_THUMBPRINT",
      "digestAlgorithm": "sha256",
      "timestampUrl": "http://timestamp.digicert.com"
    }
  }
}
```

#### Linux

```bash
./scripts/build-all.sh
```

**Output:** `src-tauri/target/release/bundle/`
- `deb/scanner-bridge_1.0.0_amd64.deb`
- `appimage/scanner-bridge_1.0.0_amd64.AppImage`

**Dependencies:**
- `libwebkit2gtk-4.1-0`
- `libgtk-3-0`
- `libappindicator3-1`

### Reducing Bundle Size

The default Python bundle is ~50MB. To reduce:

1. **Exclude unnecessary Python packages** (already done in PyInstaller spec)
2. **UPX compression** (enabled by default)
3. **Strip symbols** (enabled by default)
4. **Remove unused Rust features** in `Cargo.toml`

---

## Auto-Update Configuration

Scanner Bridge includes built-in auto-update functionality using Tauri's updater plugin.

### Setup

1. **Create Update Server:**
   - Host `latest.json` at `https://your-domain.com/updates/latest.json`
   - See `latest.json.example` in project root

2. **Configure Tauri:**
   Update `src-tauri/tauri.conf.json`:

```json
{
  "bundle": {
    "updater": {
      "active": true,
      "endpoints": [
        "https://your-domain.com/updates/latest.json"
      ],
      "dialog": true,
      "pubkey": "YOUR_PUBLIC_KEY_HERE"
    }
  }
}
```

3. **Generate Public Key:**
   ```bash
   cargo tauri signer generate
   ```

4. **Update Release Flow:**
   - Build new version: `./scripts/build-all.sh`
   - Sign installer (macOS/Windows)
   - Upload installer to GitHub Releases
   - Generate and upload `latest.json`
   - Update version numbers in `package.json` and `src-tauri/tauri.conf.json`

### Latest JSON Format

```json
{
  "version": "1.0.1",
  "notes": "Bug fixes and improvements",
  "pub_date": "2025-01-20T12:00:00Z",
  "platforms": {
    "darwin-x86_64": {
      "signature": "...",
      "url": "https://releases/1.0.1/darwin-x86_64/app.tar.gz"
    },
    "darwin-aarch64": {
      "signature": "...",
      "url": "https://releases/1.0.1/darwin-aarch64/app.tar.gz"
    },
    "windows-x86_64": {
      "signature": "...",
      "url": "https://releases/1.0.1/windows-x86_64/app.msi"
    },
    "linux-x86_64": {
      "signature": "...",
      "url": "https://releases/1.0.1/linux-x86_64/app.deb"
    }
  }
}
```

---

## USB Permissions

See `docs/USB_PERMISSIONS_SETUP.md` for detailed platform-specific USB permission setup.

### Quick Summary

- **macOS:** Grant permission in dialog on first launch (system handles it)
- **Windows:** No special permissions needed (automatic)
- **Linux:** Add udev rule (see USB_PERMISSIONS_SETUP.md)

---

## Configuration

### Backend Config

Scanner Bridge ships with a default configuration in `backend/config.tauri.yaml`:

```yaml
backend:
  host: "127.0.0.1"
  port: 8000

scanner:
  auto_detect: true
  timeout: 10

logging:
  level: "INFO"
  file: "scanner-bridge.log"
```

This config is bundled with the app. Users can override by creating:
- macOS: `~/Library/Application Support/scanner-bridge/config.yaml`
- Windows: `%APPDATA%\scanner-bridge\config.yaml`
- Linux: `~/.config/scanner-bridge/config.yaml`

### Frontend Config

Frontend detects Tauri automatically and uses `localhost:8000` for API/WebSocket connections. No manual configuration needed.

---

## Troubleshooting

### Backend Not Starting

**Symptoms:** App opens but no scanner connection

**Solutions:**
1. Check backend logs (see app Help > Show Logs)
2. Verify Python executable is present in bundle
3. Check for port conflicts (other app on 8000)
4. Verify USB permissions (see USB_PERMISSIONS_SETUP.md)

### Frontend Not Loading

**Symptoms:** Window opens blank or error

**Solutions:**
1. Check console (View > Toggle Developer Tools)
2. Verify backend is running
3. Check API/WebSocket URLs in browser console
4. Try restarting the app

### Build Errors

**Symptoms:** Build script fails

**Solutions:**
1. Ensure all prerequisites are installed
2. Check Python venv is set up
3. Verify Tauri CLI is installed: `cargo tauri --version`
4. Check disk space (>2GB required)
5. Try `cargo clean` and rebuild

### USB Detection Issues

**Symptoms:** "No scanner detected" message

**Solutions:**
1. Verify scanner is plugged in and powered on
2. Try different USB cable or port
3. Check `lsusb` (Linux/macOS) or Device Manager (Windows)
4. Review USB permission setup (see USB_PERMISSIONS_SETUP.md)

---

## Contributing

When contributing to Scanner Bridge:

### Testing Tauri Changes

1. Run `./scripts/dev.sh` to test with full stack
2. Test on all target platforms if possible
3. Verify USB access with real hardware
4. Test auto-update mechanism (can mock with local server)

### Updating Documentation

- Keep `docs/TAURI_INTEGRATION.md` in sync with changes
- Update `docs/USB_PERMISSIONS_SETUP.md` if USB behavior changes
- Update version numbers in all relevant files

### Release Process

1. Update version in:
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`
   - `frontend/package.json`
2. Run `./scripts/build-all.sh` on each platform
3. Test installers on fresh systems
4. Sign and upload to GitHub Releases
5. Generate and upload `latest.json`
6. Tag release in git

---

## Additional Resources

- **Tauri Documentation:** https://v2.tauri.app/
- **Tauri Sidecar Guide:** https://v2.tauri.app/develop/sidecar/
- **Tauri Updater Plugin:** https://v2.tauri.app/plugin/updater/
- **PyInstaller Documentation:** https://pyinstaller.org/
- **Uniden Scanner Protocol:** `docs/SCANNER_PROTOCOL_REFERENCE.md`

---

## Support

For issues specific to Tauri integration:

1. Check this documentation first
2. Review troubleshooting section
3. Check USB permission setup
4. Open issue on GitHub with:
   - Platform and version
   - Scanner model
   - App logs (Help > Show Logs)
   - Steps to reproduce

For issues with scanner communication or protocol:

1. See `docs/BACKEND_SPEC.md`
2. Check `docs/SCANNER_PROTOCOL_REFERENCE.md`
3. Review backend code in `backend/src/scanner_bridge/`
