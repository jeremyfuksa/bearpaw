# Packaging Artifacts

## PyInstaller

```bash
pyinstaller --clean --noconfirm backend/packaging/bearpaw.spec
```

## systemd

Install `backend/packaging/systemd/bearpaw.service` to `/etc/systemd/system/` and configure `/etc/bearpaw/config.yaml`.

## launchd

Install `backend/packaging/launchd/com.bearpaw.plist` to `~/Library/LaunchAgents/` or `/Library/LaunchDaemons/`.

## Windows

Use the NSSM template in `backend/packaging/windows/bearpaw.nssm.txt`.
