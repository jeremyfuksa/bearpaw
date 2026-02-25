# USB Permissions for Bearpaw

The Bearpaw backend talks directly to the Uniden hardware over USB. Claiming the USB interface (see `backend/src/bearpaw/transport_usb.py`) requires kernel-level access, which is why the backend fails with `usb.core.USBError: [Errno 13] Access denied`. It has been working without `sudo` in the past because the OS granted permission to the scanner device; the change that started the failure is almost certainly a permissions change on `/dev/bus/usb`.

To keep running as a regular user, add a permanent rule that gives your user or the `plugdev` group permission to touch the vendor/product pair configured in `backend/config.yaml`:

```yaml
device:
  usb_vid: 0x1965
  usb_pid: 0x0017
```

## Linux (udev)

1. Create a file under `/etc/udev/rules.d/99-uniden-scanner.rules` with the contents:

   ```text
   SUBSYSTEM=="usb", ATTR{idVendor}=="1965", ATTR{idProduct}=="0017", MODE="0664", GROUP="plugdev"
   ```

2. Reload the rules with `sudo udevadm control --reload-rules` and `sudo udevadm trigger` (or reboot).
3. Unplug and replug the scanner. The backend should now be able to claim the interface as your non-root user.

If you prefer to target your own user instead of `plugdev`, replace `GROUP="plugdev"` with `OWNER="your-username"`.

## macOS

macOS permissions are managed differently. If you previously ran the backend successfully, the device should still be accessible. If you see the same error, try unplugging/replugging the scanner and restarting the app; macOS may have dropped the authorization. For persistent issues you can re-run the app with `sudo` until we build a Latin-based installer with proper USB entitlements.

## Validation

After adding the rule, run the backend via `backend/.venv/bin/bearpaw --config ./config.yaml` without `sudo`. The `Access denied` error should disappear. Keep this doc handy if the team needs to reprovision their development machines.
