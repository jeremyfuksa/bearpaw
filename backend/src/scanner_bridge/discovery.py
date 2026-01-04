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
    try:
        ports = serial.tools.list_ports.comports()
    except Exception as exc:  # pragma: no cover - platform-specific
        raise PermissionError(
            "Failed to enumerate serial ports. Check permissions."
        ) from exc

    for port in ports:
        if port.vid is None or port.pid is None:
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
    return devices
