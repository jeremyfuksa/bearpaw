# Packaging Artifacts

## PyInstaller

```bash
pyinstaller --clean --noconfirm backend/packaging/scanner-bridge.spec
```

## systemd

Install `backend/packaging/systemd/scanner-bridge.service` to `/etc/systemd/system/` and configure `/etc/scanner-bridge/config.yaml`.

## launchd

Install `backend/packaging/launchd/com.scanner.bridge.plist` to `~/Library/LaunchAgents/` or `/Library/LaunchDaemons/`.

## Windows

Use the NSSM template in `backend/packaging/windows/scanner-bridge.nssm.txt`.
