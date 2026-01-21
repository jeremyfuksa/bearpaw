# USB Permission Setup for Scanner Bridge

Scanner Bridge requires USB access to communicate with Uniden scanners. This document provides platform-specific setup instructions.

---

## macOS

### Required for Uniden Scanners

Uniden BC125AT uses USB CDC-ACM (Communications Device Class) with VID:PID `1965:0017`.

### Step-by-Step Setup

#### Option 1: Manual Permission Grant (Easiest)

1. **Plug in your Uniden scanner**
2. **Launch Scanner Bridge**
3. You'll see a prompt: *"Scanner Bridge would like to access a USB device"*
4. Click **"Allow"**
5. Scanner Bridge will now have access to the device

The permission is remembered for this app - you won't need to repeat this.

#### Option 2: System Setup (For Deployment)

If you're deploying to other machines, you can add a USB entitlement to the app:

1. Add to your entitlements file (`src-tauri/entitlements.plist`):
```xml
<key>com.apple.security.device.usb</key>
<array>
  <dict>
    <key>key</key>
    <string>1965:0017</string>
    <key>AllowListing</key>
    <true/>
  </dict>
</array>
```

2. Update `src-tauri/tauri.conf.json`:
```json
{
  "bundle": {
    "macOS": {
      "entitlements": "entitlements.plist"
    }
  }
}
```

### Troubleshooting

**Permission dialog not appearing:**
- Make sure the app is downloaded from a trusted source
- Check System Preferences > Security & Privacy > Privacy > USB
- Look for "Scanner Bridge" and enable it

**Device not detected:**
- Try different USB port
- Check cable is properly connected
- Verify scanner is powered on

---

## Windows

### USB Access

Windows does not require explicit USB permissions - the app can access USB devices automatically.

### Driver Setup

Uniden scanners use USB CDC-ACM, which includes built-in drivers on Windows 10/11:

1. **Plug in scanner** - Windows should automatically install the driver
2. **Verify installation:**
   - Open Device Manager
   - Look under "Ports (COM & LPT)" or "Universal Serial Bus devices"
   - Should see "Uniden USB Device" or similar

3. **COM Port Assignment:**
   - Note the COM port number (e.g., COM3)
   - Scanner Bridge will auto-detect, but you can also specify manually

### Troubleshooting

**Device not appearing:**
- Try different USB port
- Check Device Manager for yellow exclamation mark (driver issue)
- Uninstall driver and re-plug scanner

**COM port changes:**
- Windows may assign different COM port on reconnect
- Scanner Bridge auto-detects, so this usually isn't an issue

---

## Linux

### USB Permissions Required

On Linux, USB devices are owned by `root` by default. Regular users need udev rules to access scanners.

### Step-by-Step Setup

#### 1. Create Udev Rule

Create `/etc/udev/rules.d/99-uniden-scanner.rules`:

```bash
sudo nano /etc/udev/rules.d/99-uniden-scanner.rules
```

Add the following:
```bash
# Uniden BC125AT Scanner (VID:PID 1965:0017)
SUBSYSTEM=="usb", ATTR{idVendor}=="1965", ATTR{idProduct}=="0017", MODE="0666", TAG+="uaccess"

# Also grant access to ttyUSB devices (for serial communication)
SUBSYSTEM=="tty", ATTRS{idVendor}=="1965", ATTRS{idProduct}=="0017", MODE="0666", TAG+="uaccess"
```

#### 2. Reload Udev Rules

```bash
sudo udevadm control --reload-rules
sudo udevadm trigger
```

#### 3. Unplug and Replug Scanner

After reloading udev, unplug your scanner and plug it back in.

#### 4. Verify Permissions

```bash
# Check if device is accessible
ls -l /dev/bus/usb/001/003  # Example path

# Should show crw-rw-rw- (rw for user)
```

### Alternative: Add User to dialout Group

If udev rules don't work, add your user to the `dialout` group:

```bash
sudo usermod -a -G dialout $USER
```

Then log out and log back in.

### Troubleshooting

**Permission denied:**
- Verify udev rule syntax with `udevadm info --attribute-walk`
- Check group membership with `groups`
- Ensure device is unplugged and replugged after rule reload

**Device not found:**
- Check `dmesg` for USB detection messages
- Verify device is detected with `lsusb`
- Look for Uniden VID:PID: `lsusb | grep 1965:0017`

---

## Automated Setup in Scanner Bridge

Scanner Bridge can detect USB permission issues and provide user guidance:

### macOS
- Shows permission dialog if not already granted
- Provides instructions if dialog doesn't appear

### Linux
- Checks for `/dev/bus/usb` access
- Offers to show udev setup instructions
- Can optionally create udev rule file with user assistance

### Windows
- Checks for COM port availability
- Shows device detection status

---

## Security Considerations

**Minimal Permissions:**
- Scanner Bridge only requests access to specific Uniden devices (VID:1965)
- Does not request broad USB access

**Trusted Source:**
- App should be signed (macOS/Windows)
- Download from official repository only

**User Control:**
- User must explicitly grant permission (macOS)
- Udev rules are system-wide but limited to specific devices (Linux)

---

## Testing USB Access

After setup, test USB access:

### Using Scanner Bridge UI
1. Launch Scanner Bridge
2. Check connection status in header
3. Should show "Connected to BC125AT" or similar

### Command Line Testing

```bash
# List USB devices
lsusb | grep 1965

# Check serial ports (Linux/macOS)
ls -l /dev/tty.*

# Check serial ports (Windows)
# Use Device Manager or mode command
```

---

## Developer Notes

### Platform-Specific Code

See `backend/src/scanner_bridge/discovery.py` for device discovery logic.

**macOS:** Uses `pyusb` for USB enumeration
**Linux:** Uses `pyusb` + udev rules
**Windows:** Uses `pyserial` port enumeration

### Testing Without Hardware

For development without real scanner:

```bash
# Use serial replay mode
python -m scanner_bridge --config config.yaml --replay capture.log
```

See `backend/docs/DEVELOPMENT.md` for more details.

---

## Support

If you encounter USB issues not covered here:

1. Check the main documentation: `docs/README.md`
2. Review platform-specific USB debugging tips
3. Open an issue on GitHub with:
   - Operating system and version
   - Scanner model
   - Output of `lsusb` or Device Manager screenshot
   - Scanner Bridge logs (from `~/.local/share/scanner-bridge/scanner-bridge.log`)
