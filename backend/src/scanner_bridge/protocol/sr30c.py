from __future__ import annotations

import time
from typing import Optional

import logging

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
        self._in_program_mode = False
        self.last_error: Optional[str] = None

        self._logger = logging.getLogger(__name__)

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
            alpha_tag=None,
            volume=0,
            battery=None,
        )

    async def send_hold(self) -> bool:
        response = await self._send("KEY,H,P", PRIORITY_CONTROL)
        ok = self._is_ok_response(response)
        if ok:
            self._mode = "HOLD"
            self.last_error = None
        else:
            self.last_error = response.strip() or "hold_failed"
            self._logger.warning("Hold command failed: %s", self.last_error)
        return ok

    async def send_scan(self) -> bool:
        response = await self._send("KEY,S,P", PRIORITY_CONTROL)
        ok = self._is_ok_response(response)
        if ok:
            self._mode = "SCAN"
            self.last_error = None
        else:
            self.last_error = response.strip() or "scan_failed"
            self._logger.warning("Scan command failed: %s", self.last_error)
        return ok

    async def send_key(self, key_code: str) -> bool:
        response = await self._send(f"KEY,{key_code},P", PRIORITY_CONTROL)
        ok = self._is_ok_response(response)
        if not ok:
            response = await self._send(f"KEY,{key_code}", PRIORITY_CONTROL)
            ok = self._is_ok_response(response)
        if ok:
            self.last_error = None
        else:
            self.last_error = response.strip() or "key_failed"
            self._logger.warning("Key command failed (%s): %s", key_code, self.last_error)
        return ok

    async def read_channel(self, index: int, assume_program_mode: bool = False) -> ChannelData:
        if not assume_program_mode:
            await self._enter_program_mode()
        response = await self._send(f"CIN,{index}", PRIORITY_BACKGROUND)
        if not assume_program_mode:
            await self._exit_program_mode()
        return self._parse_channel_response(index, response)

    async def begin_memory_sync(self) -> None:
        await self._enter_program_mode()

    async def end_memory_sync(self) -> None:
        await self._exit_program_mode()

    async def read_channel_raw(self, index: int) -> str:
        await self._enter_program_mode()
        response = await self._send(f"CIN,{index}", PRIORITY_BACKGROUND)
        await self._exit_program_mode()
        return response

    def _parse_channel_response(self, index: int, response: str) -> ChannelData:
        parts = [part.strip() for part in response.split(",")]
        if parts and parts[0] == "CIN":
            parts = parts[1:]
        if parts and parts[0].isdigit():
            parts = parts[1:]

        def parse_float(value: str) -> Optional[float]:
            try:
                return float(value)
            except (TypeError, ValueError):
                return None

        def looks_like_frequency(value: str) -> bool:
            value = value.strip()
            if not value:
                return False
            if "." in value:
                return True
            try:
                return int(value) >= 10000
            except ValueError:
                return False

        def parse_frequency(value: str) -> float:
            parsed = parse_float(value)
            if parsed is None:
                return 0.0
            return parsed / 10000.0 if parsed >= 10000 else parsed

        freq = 0.0
        modulation = "FM"
        alpha_tag = ""
        delay = 2
        lockout = False
        priority = False
        tone = None
        bank = 0

        if len(parts) >= 2 and looks_like_frequency(parts[1]) and not looks_like_frequency(parts[0]):
            alpha_tag = parts[0]
            freq = parse_frequency(parts[1])
            modulation = parts[2] if len(parts) > 2 and parts[2] else "FM"
            remaining = parts[3:]
            if len(remaining) > 0 and remaining[0] != "":
                lockout = remaining[0] == "1"
            if len(remaining) > 1 and remaining[1] != "":
                delay = int(remaining[1])
            if len(remaining) > 2 and remaining[2] != "":
                priority = remaining[2] == "1"
            if len(remaining) > 3 and remaining[3] != "":
                if len(remaining) > 4:
                    tone = parse_float(remaining[3])
                    if remaining[4] != "":
                        bank = int(remaining[4])
                else:
                    bank = int(remaining[3])
        else:
            if len(parts) > 0:
                freq = parse_frequency(parts[0])
            modulation = parts[1] if len(parts) > 1 and parts[1] else "FM"
            alpha_tag = parts[2] if len(parts) > 2 else ""
            if len(parts) > 3 and parts[3]:
                delay = int(parts[3])
            if len(parts) > 4 and parts[4]:
                lockout = parts[4] == "1"
            if len(parts) > 5 and parts[5]:
                priority = parts[5] == "1"
            if len(parts) > 6 and parts[6]:
                tone = parse_float(parts[6])
            if len(parts) > 7 and parts[7]:
                bank = int(parts[7])
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
        self._in_program_mode = True
        self._pre_program_mode = self._mode
        if self._mode == "SCAN":
            await self._send("KEY,H,P", PRIORITY_CONTROL)
            self._mode = "HOLD"
        await self._send("PRG", PRIORITY_BACKGROUND)

    async def _exit_program_mode(self) -> None:
        try:
            await self._send("EPG", PRIORITY_BACKGROUND)
            if self._pre_program_mode == "SCAN":
                await self._send("KEY,S,P", PRIORITY_CONTROL)
            self._mode = self._pre_program_mode or self._mode
            self._pre_program_mode = None
        finally:
            self._in_program_mode = False

    @property
    def in_program_mode(self) -> bool:
        return self._in_program_mode

    async def get_banks(self) -> list[bool]:
        await self._enter_program_mode()
        try:
            response = await self._send("SCG", PRIORITY_BACKGROUND)
        finally:
            await self._exit_program_mode()
        parts = [part.strip() for part in response.split(",")]
        if parts and parts[0] == "SCG":
            parts = parts[1:]
        flags = parts[0] if parts else ""
        if len(flags) != 10 or not all(ch in ("0", "1") for ch in flags):
            raise ValueError(f"Invalid SCG response: {response}")
        return [ch == "0" for ch in flags]

    async def set_banks(self, banks: list[bool]) -> None:
        if len(banks) != 10:
            raise ValueError("banks must contain 10 values")
        flags = "".join("0" if enabled else "1" for enabled in banks)
        await self._enter_program_mode()
        try:
            response = await self._send(f"SCG,{flags}", PRIORITY_BACKGROUND)
        finally:
            await self._exit_program_mode()
        if not self._is_ok_response(response):
            raise ValueError(f"SCG set failed: {response}")

    async def get_firmware_version(self) -> str:
        raise NotImplementedError

    async def get_backlight(self) -> str:
        raise NotImplementedError

    async def set_backlight(self, event: str) -> bool:
        raise NotImplementedError

    async def get_battery_charge_time(self) -> int:
        raise NotImplementedError

    async def set_battery_charge_time(self, charge_time: int) -> bool:
        raise NotImplementedError

    async def get_key_beep_settings(self) -> tuple[int, bool]:
        raise NotImplementedError

    async def set_key_beep_settings(self, level: int, lock: bool) -> bool:
        raise NotImplementedError

    async def get_priority_mode(self) -> int:
        raise NotImplementedError

    async def set_priority_mode(self, mode: int) -> bool:
        raise NotImplementedError

    async def get_search_settings(self) -> tuple[int, bool]:
        raise NotImplementedError

    async def set_search_settings(self, delay: int, code_search: bool) -> bool:
        raise NotImplementedError

    async def get_close_call_settings(self) -> tuple[int, bool, bool, list[bool], bool]:
        raise NotImplementedError

    async def set_close_call_settings(
        self,
        mode: int,
        alert_beep: bool,
        alert_light: bool,
        band: list[bool],
        lockout: bool,
    ) -> bool:
        raise NotImplementedError

    async def get_service_search_groups(self) -> list[bool]:
        raise NotImplementedError

    async def set_service_search_groups(self, groups: list[bool]) -> bool:
        raise NotImplementedError

    async def get_custom_search_groups(self) -> list[bool]:
        raise NotImplementedError

    async def set_custom_search_groups(self, groups: list[bool]) -> bool:
        raise NotImplementedError

    async def get_custom_search_range(self, index: int) -> tuple[float, float]:
        raise NotImplementedError

    async def set_custom_search_range(self, index: int, lower: float, upper: float) -> bool:
        raise NotImplementedError

    async def get_weather_priority(self) -> bool:
        raise NotImplementedError

    async def set_weather_priority(self, priority: bool) -> bool:
        raise NotImplementedError

    async def get_contrast(self) -> int:
        raise NotImplementedError

    async def set_contrast(self, level: int) -> bool:
        raise NotImplementedError

    async def get_squelch(self) -> int:
        raise NotImplementedError

    async def set_squelch(self, level: int) -> bool:
        raise NotImplementedError

    @staticmethod
    def _is_ok_response(response: str) -> bool:
        value = response.strip().upper()
        return value == "OK" or value.endswith(",OK")
