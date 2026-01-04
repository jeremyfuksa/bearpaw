from __future__ import annotations

import time
from typing import Optional

from scanner_bridge.models import ChannelData, LiveState
from scanner_bridge.protocol.base import ScannerDriver
from scanner_bridge.scheduler import (
    PRIORITY_BACKGROUND,
    PRIORITY_CONTROL,
    PRIORITY_TELEMETRY,
    CommandScheduler,
)


class SR30CDriver(ScannerDriver):
    def __init__(self, scheduler: CommandScheduler):
        self._scheduler = scheduler
        self._mode = "SCAN"
        self._pre_program_mode: Optional[str] = None

    async def detect_model(self) -> str:
        response = await self._send("MDL", PRIORITY_CONTROL)
        if response.startswith("MDL,"):
            return response.split(",", 1)[1].strip()
        return response.strip()

    async def get_status(self) -> LiveState:
        response = await self._send("STS", PRIORITY_TELEMETRY)
        fields = self.parse_key_value_pairs(response)
        frequency = float(fields.get("FRQ", "0"))
        modulation = fields.get("MOD", "AUTO")
        squelch_open = fields.get("SQL", "1") == "0"
        rssi = int(fields.get("RSSI", "0"))
        channel = int(fields.get("CH", "0")) if fields.get("CH") else None
        return LiveState(
            timestamp=time.time(),
            frequency=frequency,
            modulation=modulation,
            squelch_open=squelch_open,
            rssi=rssi,
            mode=self._mode,
            channel=channel,
            volume=0,
            battery=None,
        )

    async def send_hold(self) -> bool:
        response = await self._send("KEY,H,P", PRIORITY_CONTROL)
        self._mode = "HOLD"
        return response.strip() == "OK"

    async def send_scan(self) -> bool:
        response = await self._send("KEY,S,P", PRIORITY_CONTROL)
        self._mode = "SCAN"
        return response.strip() == "OK"

    async def send_key(self, key_code: str) -> bool:
        response = await self._send(f"KEY,{key_code},P", PRIORITY_CONTROL)
        return response.strip() == "OK"

    async def set_frequency(self, freq_mhz: float, modulation: str = "AUTO") -> bool:
        response = await self._send(
            f"DO,{freq_mhz:.4f},{modulation}", PRIORITY_CONTROL
        )
        self._mode = "DIRECT"
        return response.strip() == "OK"

    async def read_channel(self, index: int) -> ChannelData:
        await self._enter_program_mode()
        response = await self._send(f"CIN,{index}", PRIORITY_BACKGROUND)
        await self._exit_program_mode()
        return self._parse_channel_response(index, response)

    def _parse_channel_response(self, index: int, response: str) -> ChannelData:
        parts = [part.strip() for part in response.split(",")]
        if parts and parts[0] == "CIN":
            parts = parts[1:]
        freq = float(parts[1]) if len(parts) > 1 and parts[1] else 0.0
        modulation = parts[2] if len(parts) > 2 else "FM"
        alpha_tag = parts[3] if len(parts) > 3 else ""
        delay = int(parts[4]) if len(parts) > 4 and parts[4] else 2
        lockout = parts[5] == "1" if len(parts) > 5 else False
        priority = parts[6] == "1" if len(parts) > 6 else False
        tone = float(parts[7]) if len(parts) > 7 and parts[7] else None
        bank = int(parts[8]) if len(parts) > 8 and parts[8] else 0
        return ChannelData(
            index=index,
            frequency=freq,
            modulation=modulation,
            alpha_tag=alpha_tag,
            delay=delay,
            lockout=lockout,
            priority=priority,
            tone_squelch=tone,
            bank=bank,
        )

    async def _send(self, raw: str, priority: int) -> str:
        future = self._scheduler.enqueue(raw, priority)
        response = await future
        return response

    async def _enter_program_mode(self) -> None:
        self._pre_program_mode = self._mode
        if self._mode == "SCAN":
            await self._send("KEY,H,P", PRIORITY_CONTROL)
            self._mode = "HOLD"
        await self._send("PRG", PRIORITY_BACKGROUND)

    async def _exit_program_mode(self) -> None:
        await self._send("EPG", PRIORITY_BACKGROUND)
        if self._pre_program_mode == "SCAN":
            await self._send("KEY,S,P", PRIORITY_CONTROL)
        self._mode = self._pre_program_mode or self._mode
        self._pre_program_mode = None
