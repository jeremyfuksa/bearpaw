# Scanner Bridge Tauri Integration

Cross-platform Uniden scanner control with native desktop application experience.

## Quick Start

### Development

```bash
# Clone and start development (auto-launches backend + Tauri)
git clone https://github.com/YOUR_USERNAME/uniden.git
cd uniden
npm run dev        # macOS/Linux
# or
npm run dev:win    # Windows
```

### Building

```bash
# Build for current platform
npm run build        # macOS/Linux
# or
npm run build:win    # Windows
```

## Architecture

- **Frontend:** React + TypeScript in WebView (Vite)
- **Backend:** Python FastAPI as Tauri sidecar process
- **Communication:** HTTP/WebSocket over localhost:8000
- **Platforms:** macOS (Intel/ARM), Windows, Linux

## Documentation

- [Tauri Integration Guide](docs/TAURI_INTEGRATION.md) - Complete setup and usage documentation
- [USB Permissions Setup](docs/USB_PERMISSIONS_SETUP.md) - Platform-specific USB access instructions
- [Main Documentation](docs/README.md) - Full project documentation

## Features

- ✅ Native desktop app experience
- ✅ Auto-update mechanism
- ✅ Cross-platform installers
- ✅ USB permission handling
- ✅ Real-time WebSocket updates
- ✅ Hot reload in development

## Platform Support

| Platform | Status | Installer |
|----------|--------|-----------|
| macOS Intel | ✅ | .app, .dmg |
| macOS ARM | ✅ | .app, .dmg |
| Windows x64 | ✅ | .msi |
| Linux x64 | ✅ | .deb, .AppImage |

## License

MIT
