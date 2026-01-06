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
    async def set_frequency(self, freq_mhz: float, modulation: str = "AUTO") -> bool:
        """Direct frequency tune."""

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

    @staticmethod
    def parse_key_value_pairs(payload: str) -> Dict[str, str]:
        fields: Dict[str, str] = {}
        for line in payload.split("\r"):
            line = line.strip()
            if not line or "," not in line:
                continue
            key, value = line.split(",", 1)
            fields[key.strip()] = value.strip()
        return fields
