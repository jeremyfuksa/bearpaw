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
