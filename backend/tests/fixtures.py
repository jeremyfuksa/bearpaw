from dataclasses import dataclass, field as dataclass_field
from typing import Optional, Dict, List
from scanner_bridge.models import (
    ChannelData,
    LiveState,
    DeviceInfo,
    ShadowState,
)


def create_channel(
    index: int = 1,
    frequency: float = 151.25,
    modulation: str = "FM",
    alpha_tag: str = "Test Channel",
    delay: int = 2,
    lockout: bool = False,
    priority: bool = False,
    tone_squelch: Optional[float] = None,
    bank: int = 1,
) -> ChannelData:
    return ChannelData(
        index=index,
        frequency=frequency,
        modulation=modulation,
        alpha_tag=alpha_tag,
        delay=delay,
        lockout=lockout,
        priority=priority,
        tone_squelch=tone_squelch,
        bank=bank,
    )


def create_live_state(
    timestamp: float = 0.0,
    frequency: float = 151.25,
    modulation: str = "FM",
    squelch_open: bool = False,
    rssi: int = 60,
    mode: str = "SCAN",
    channel: Optional[int] = 1,
    alpha_tag: Optional[str] = "Test Channel",
    volume: int = 10,
    battery: Optional[int] = 85,
    stale: bool = False,
) -> LiveState:
    if timestamp == 0.0:
        import time

        timestamp = time.time()
    return LiveState(
        timestamp=timestamp,
        frequency=frequency,
        modulation=modulation,
        squelch_open=squelch_open,
        rssi=rssi,
        mode=mode,
        channel=channel,
        alpha_tag=alpha_tag,
        volume=volume,
        battery=battery,
        stale=stale,
    )


def create_device_info(
    model: Optional[str] = "BC125AT",
    port: Optional[str] = "/dev/ttyUSB0",
    vid: Optional[int] = 0x0BCD,
    pid: Optional[int] = 0x0001,
    serial_number: Optional[str] = "123456789",
    description: Optional[str] = "BC125AT Scanner",
    firmware: Optional[str] = "1.0.12",
    connection_status: str = "connected",
) -> DeviceInfo:
    return DeviceInfo(
        model=model,
        port=port,
        vid=vid,
        pid=pid,
        serial_number=serial_number,
        description=description,
        firmware=firmware,
        connection_status=connection_status,
    )


def create_shadow_state(
    channels: Optional[Dict[int, ChannelData]] = None,
    last_sync: float = 0.0,
    dirty: bool = True,
) -> ShadowState:
    return ShadowState(
        channels=channels or {},
        last_sync=last_sync,
        dirty=dirty,
    )


def create_analytics_hit(
    timestamp: float = 0.0,
    frequency: float = 151.25,
    channel: Optional[int] = 1,
    alpha_tag: Optional[str] = "Test Channel",
    rssi: int = 60,
    duration: float = 2.5,
) -> dict:
    import time

    if timestamp == 0.0:
        timestamp = time.time()
    return {
        "timestamp": timestamp,
        "frequency": frequency,
        "channel": channel,
        "alpha_tag": alpha_tag,
        "rssi": rssi,
        "duration": duration,
    }


def create_settings() -> dict:
    return {
        "firmware": "1.0.12",
        "squelch": {"level": 5},
        "backlight": {"event": "AO"},
        "battery": {"charge_time": 10},
        "key_beep": {"level": 2, "lock": False},
        "priority": {"mode": 1},
        "search": {"delay": 0, "code_search": False},
        "close_call": {
            "mode": 0,
            "alert_beep": True,
            "alert_light": True,
            "band": [True, True, True, True, True],
            "lockout": True,
        },
        "service_search": {
            "groups": [True, False, True, False, True, False, True, False],
        },
        "custom_search": {
            "groups": [True, False, True, False, True, False, True, False],
        },
        "custom_search_ranges": [
            {"index": i + 1, "lower": 140 + i * 10, "upper": 149 + i * 10}
            for i in range(10)
        ],
        "weather": {"priority": True},
        "contrast": {"level": 8},
    }


def create_lockouts_response() -> dict:
    return {
        "frequencies": [151.25, 151.5],
        "channels": [5, 10],
        "temporary_channels": [{"channel": 1, "frequency": 145.25}],
    }
