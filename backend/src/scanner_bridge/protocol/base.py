from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Dict

from scanner_bridge.models import ChannelData, LiveState


class ScannerDriver(ABC):
    @abstractmethod
    async def get_status(self) -> LiveState:
        """Poll current scanner status (STS equivalent)."""

    @abstractmethod
    async def send_hold(self) -> bool:
        """Enter hold mode."""

    @abstractmethod
    async def send_scan(self) -> bool:
        """Enter scan mode."""

    @abstractmethod
    async def send_key(self, key_code: str) -> bool:
        """Simulate keypress."""

    @abstractmethod
    async def read_channel(self, index: int, assume_program_mode: bool = False) -> ChannelData:
        """Read channel memory (requires PRG mode)."""

    async def begin_memory_sync(self) -> None:
        """Prepare device for bulk memory reads."""

    async def end_memory_sync(self) -> None:
        """Finalize device after bulk memory reads."""

    @abstractmethod
    async def detect_model(self) -> str:
        """Return model string (MDL command)."""

    async def get_banks(self) -> list[bool]:
        """Return enabled/disabled scan banks (True = enabled)."""
        raise NotImplementedError

    async def set_banks(self, banks: list[bool]) -> None:
        """Set enabled/disabled scan banks (True = enabled)."""
        raise NotImplementedError

    async def set_volume(self, volume: int) -> bool:
        """Set volume level (device-specific)."""
        raise NotImplementedError

    async def get_squelch(self) -> int:
        """Return squelch level (device-specific)."""
        raise NotImplementedError

    async def set_squelch(self, level: int) -> bool:
        """Set squelch level (device-specific)."""
        raise NotImplementedError

    async def toggle_channel_lockout(self, index: int) -> ChannelData:
        """Toggle lockout for a specific memory channel."""
        raise NotImplementedError

    async def set_channel_lockout(self, index: int, locked: bool) -> ChannelData:
        """Set lockout state for a specific memory channel."""
        raise NotImplementedError

    async def toggle_frequency_lockout(self, frequency_raw: int) -> bool:
        """Toggle temporary lockout for a frequency. Returns True if locked."""
        raise NotImplementedError

    async def get_frequency_lockouts(self) -> list[int]:
        """Return list of globally locked frequencies (raw values)."""
        raise NotImplementedError

    async def set_frequency_lockout(self, frequency_raw: int, locked: bool) -> bool:
        """Set global frequency lockout state. Returns True on success."""
        raise NotImplementedError

    async def get_firmware_version(self) -> str:
        """Return firmware version (device-specific)."""
        raise NotImplementedError

    async def get_backlight(self) -> str:
        """Return backlight event mode."""
        raise NotImplementedError

    async def set_backlight(self, event: str) -> bool:
        """Set backlight event mode."""
        raise NotImplementedError

    async def get_battery_charge_time(self) -> int:
        """Return battery charge time setting."""
        raise NotImplementedError

    async def set_battery_charge_time(self, charge_time: int) -> bool:
        """Set battery charge time setting."""
        raise NotImplementedError

    async def get_key_beep_settings(self) -> tuple[int, bool]:
        """Return key beep level and key lock flag."""
        raise NotImplementedError

    async def set_key_beep_settings(self, level: int, lock: bool) -> bool:
        """Set key beep level and key lock flag."""
        raise NotImplementedError

    async def get_priority_mode(self) -> int:
        """Return priority mode."""
        raise NotImplementedError

    async def set_priority_mode(self, mode: int) -> bool:
        """Set priority mode."""
        raise NotImplementedError

    async def get_search_settings(self) -> tuple[int, bool]:
        """Return search/close call delay and code search flag."""
        raise NotImplementedError

    async def set_search_settings(self, delay: int, code_search: bool) -> bool:
        """Set search/close call delay and code search flag."""
        raise NotImplementedError

    async def get_close_call_settings(self) -> tuple[int, bool, bool, list[bool], bool]:
        """Return close call settings."""
        raise NotImplementedError

    async def set_close_call_settings(
        self,
        mode: int,
        alert_beep: bool,
        alert_light: bool,
        band: list[bool],
        lockout: bool,
    ) -> bool:
        """Set close call settings."""
        raise NotImplementedError

    async def get_service_search_groups(self) -> list[bool]:
        """Return service search enabled groups."""
        raise NotImplementedError

    async def set_service_search_groups(self, groups: list[bool]) -> bool:
        """Set service search enabled groups."""
        raise NotImplementedError

    async def get_custom_search_groups(self) -> list[bool]:
        """Return custom search enabled groups."""
        raise NotImplementedError

    async def set_custom_search_groups(self, groups: list[bool]) -> bool:
        """Set custom search enabled groups."""
        raise NotImplementedError

    async def get_custom_search_range(self, index: int) -> tuple[float, float]:
        """Return custom search range in MHz."""
        raise NotImplementedError

    async def set_custom_search_range(self, index: int, lower: float, upper: float) -> bool:
        """Set custom search range in MHz."""
        raise NotImplementedError

    async def get_weather_priority(self) -> bool:
        """Return weather alert priority setting."""
        raise NotImplementedError

    async def set_weather_priority(self, priority: bool) -> bool:
        """Set weather alert priority setting."""
        raise NotImplementedError

    async def get_contrast(self) -> int:
        """Return LCD contrast."""
        raise NotImplementedError

    async def set_contrast(self, level: int) -> bool:
        """Set LCD contrast."""
        raise NotImplementedError

    @staticmethod
    def parse_key_value_pairs(payload: str) -> Dict[str, str]:
        fields: Dict[str, str] = {}
        for line in payload.splitlines():
            line = line.strip()
            if not line or "," not in line:
                continue
            key, value = line.split(",", 1)
            fields[key.strip()] = value.strip()
        return fields
