from __future__ import annotations

from typing import List

import serial.tools.list_ports

from scanner_bridge.models import DeviceDescriptor

UNIDEN_VID = 0x1965
UNIDEN_BC125AT_PID = 0x0017
CP210X_VID = 0x10C4
CP210X_PID = 0xEA60


def discover_devices() -> List[DeviceDescriptor]:
    devices: List[DeviceDescriptor] = []
    serial_fallback_candidates: List[DeviceDescriptor] = []
    try:
        ports = serial.tools.list_ports.comports()
    except Exception as exc:  # pragma: no cover - platform-specific
        raise PermissionError(
            "Failed to enumerate serial ports. Check permissions."
        ) from exc

    for port in ports:
        if port.vid is None or port.pid is None:
            device_name = (port.device or "").lower()
            description = (port.description or "").lower()
            manufacturer = (getattr(port, "manufacturer", None) or "").lower()
            is_usb_tty = "/dev/cu.usb" in device_name or "/dev/tty.usb" in device_name
            looks_like_scanner = "uniden" in description or "uniden" in manufacturer

            # Some macOS serial stacks omit VID/PID for USB CDC devices.
            # Keep plausible USB serial endpoints as fallback candidates.
            if is_usb_tty and (looks_like_scanner or "bluetooth" not in description):
                serial_fallback_candidates.append(
                    DeviceDescriptor(
                        port=port.device,
                        vid=None,
                        pid=None,
                        serial_number=port.serial_number,
                        description=port.description or "USB Serial Device",
                    )
                )
            continue
        if port.vid == UNIDEN_VID and port.pid == UNIDEN_BC125AT_PID:
            devices.append(
                DeviceDescriptor(
                    port=port.device,
                    vid=port.vid,
                    pid=port.pid,
                    serial_number=port.serial_number,
                    description=port.description or "Uniden Scanner",
                )
            )
        if port.vid == CP210X_VID and port.pid == CP210X_PID:
            devices.append(
                DeviceDescriptor(
                    port=port.device,
                    vid=port.vid,
                    pid=port.pid,
                    serial_number=port.serial_number,
                    description=port.description or "CP210x Scanner",
                )
            )
    if devices:
        return devices
    return serial_fallback_candidates
