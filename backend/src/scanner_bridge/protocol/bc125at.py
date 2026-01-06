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


class BC125ATDriver(ScannerDriver):
    def __init__(self, scheduler: CommandScheduler):
        self._scheduler = scheduler
        self._mode = "SCAN"
        self._pre_program_mode: Optional[str] = None
        self.last_error: Optional[str] = None
        self._last_volume: int = 0
        self._last_volume_poll: float = 0.0
        self._logged_status: bool = False

        self._logger = logging.getLogger(__name__)

    async def detect_model(self) -> str:
        response = await self._send("MDL", PRIORITY_CONTROL)
        if response.startswith("MDL,"):
            return response.split(",", 1)[1].strip()
        return response.strip()

    async def get_status(self) -> LiveState:
        response = await self._send("STS", PRIORITY_TELEMETRY)
        if not self._logged_status:
            self._logger.info("STS response: %s", response)
            self._logged_status = True
        fields = self.parse_key_value_pairs(response)
        if not fields or "FRQ" not in fields or "SQL" not in fields:
            await self._refresh_volume()
            response = await self._send("GLG", PRIORITY_TELEMETRY)
            return self._parse_glg_status(response)
        frequency = float(fields.get("FRQ", "0"))
        modulation = fields.get("MOD", "AUTO")
        squelch_open = fields.get("SQL", "1") == "0"
        rssi = int(fields.get("RSSI", "0"))
        channel = int(fields.get("CH", "0")) if fields.get("CH") else None
        if "VOL" in fields:
            try:
                self._last_volume = int(fields["VOL"])
            except ValueError:
                self._logger.warning("Invalid VOL value: %s", fields["VOL"])
        else:
            await self._refresh_volume()
        volume = self._last_volume
        battery = int(fields.get("BAT", "0")) if fields.get("BAT") else None
        return LiveState(
            timestamp=time.time(),
            frequency=frequency,
            modulation=modulation,
            squelch_open=squelch_open,
            rssi=rssi,
            mode=self._mode,
            channel=channel,
            alpha_tag=None,
            volume=volume,
            battery=battery,
        )

    async def get_glg_status(self) -> LiveState:
        response = await self._send("GLG", PRIORITY_TELEMETRY)
        return self._parse_glg_status(response)

    def _parse_glg_status(self, response: str) -> LiveState:
        parts = [part.strip() for part in response.split(",")]
        freq_raw = parts[1] if len(parts) > 1 else "0"
        try:
            frequency = int(freq_raw) / 10000.0
        except ValueError:
            frequency = 0.0
        modulation = parts[2] if len(parts) > 2 and parts[2] else "AUTO"
        squelch_open = False
        squelch_token_alt = parts[8] if len(parts) > 8 else ""
        if squelch_token_alt in ("0", "1"):
            squelch_open = squelch_token_alt == "1"
        else:
            squelch_token = parts[4] if len(parts) > 4 else ""
            if squelch_token in ("0", "1"):
                squelch_open = squelch_token == "0"
        alpha_tag = parts[7] if len(parts) > 7 and parts[7] else None
        channel = None
        for value in reversed(parts):
            if value.isdigit():
                channel = int(value)
                break
        rssi_raw = parts[11] if len(parts) > 11 else "0"
        try:
            rssi = min(100, int(rssi_raw))
        except ValueError:
            rssi = 0
        return LiveState(
            timestamp=time.time(),
            frequency=frequency,
            modulation=modulation,
            squelch_open=squelch_open,
            rssi=rssi,
            mode=self._mode,
            channel=channel,
            alpha_tag=alpha_tag,
            volume=self._last_volume,
            battery=None,
        )

    async def _refresh_volume(self) -> None:
        now = time.time()
        if now - self._last_volume_poll < 5.0:
            return
        self._last_volume_poll = now
        try:
            response = await self._send("VOL", PRIORITY_BACKGROUND)
        except Exception as exc:
            self._logger.debug("VOL poll failed: %s", exc)
            return
        parts = [part.strip() for part in response.split(",") if part.strip() != ""]
        if parts and parts[0].isalpha():
            parts = parts[1:]
        if not parts:
            return
        try:
            self._last_volume = int(parts[0])
        except ValueError:
            self._logger.debug("Invalid VOL response: %s", response)

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

    async def set_volume(self, volume: int) -> bool:
        if not 0 <= volume <= 15:
            raise ValueError("volume_out_of_range")
        response = await self._send(f"VOL,{volume}", PRIORITY_CONTROL)
        ok = self._is_ok_response(response)
        if not ok and response.strip().upper().startswith("VOL,"):
            ok = True
        if ok:
            self._last_volume = volume
            self.last_error = None
        else:
            self.last_error = response.strip() or "volume_failed"
            self._logger.warning("Set volume failed: %s", self.last_error)
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

    async def toggle_channel_lockout(self, index: int) -> ChannelData:
        await self._enter_program_mode()
        try:
            response = await self._send(f"CIN,{index}", PRIORITY_BACKGROUND)
            parts = [part.strip() for part in response.split(",")]
            if parts and parts[0] == "CIN":
                parts = parts[1:]
            if parts and parts[0].isdigit():
                parts = parts[1:]
            while len(parts) < 7:
                parts.append("")
            name, freq, mod, tone, delay, lockout, priority = parts[:7]
            lockout_value = "0" if lockout == "1" else "1"
            write_command = (
                f"CIN,{index},{name},{freq},{mod},{tone},{delay},{lockout_value},{priority}"
            )
            write_response = await self._send(write_command, PRIORITY_BACKGROUND)
            if not self._is_ok_response(write_response) and "OK" not in write_response.upper():
                raise ValueError(write_response.strip() or "lockout_failed")
            response = await self._send(f"CIN,{index}", PRIORITY_BACKGROUND)
            return self._parse_channel_response(index, response)
        finally:
            await self._exit_program_mode()

    async def set_channel_lockout(self, index: int, locked: bool) -> ChannelData:
        await self._enter_program_mode()
        try:
            response = await self._send(f"CIN,{index}", PRIORITY_BACKGROUND)
            parts = [part.strip() for part in response.split(",")]
            if parts and parts[0] == "CIN":
                parts = parts[1:]
            if parts and parts[0].isdigit():
                parts = parts[1:]
            while len(parts) < 7:
                parts.append("")
            name, freq, mod, tone, delay, lockout, priority = parts[:7]
            lockout_value = "1" if locked else "0"
            write_command = (
                f"CIN,{index},{name},{freq},{mod},{tone},{delay},{lockout_value},{priority}"
            )
            write_response = await self._send(write_command, PRIORITY_BACKGROUND)
            if not self._is_ok_response(write_response) and "OK" not in write_response.upper():
                raise ValueError(write_response.strip() or "lockout_failed")
            response = await self._send(f"CIN,{index}", PRIORITY_BACKGROUND)
            return self._parse_channel_response(index, response)
        finally:
            await self._exit_program_mode()

    async def toggle_frequency_lockout(self, frequency_raw: int) -> bool:
        await self._enter_program_mode()
        try:
            locked = await self._is_frequency_locked(frequency_raw)
            command = "ULF" if locked else "LOF"
            response = await self._send(f"{command},{frequency_raw}", PRIORITY_BACKGROUND)
            if not self._is_ok_response(response) and "OK" not in response.upper():
                raise ValueError(response.strip() or "lockout_failed")
            result = await self._is_frequency_locked(frequency_raw)
            self._logger.info(
                "Frequency lockout %s %s -> %s (response=%s)",
                command,
                frequency_raw,
                "locked" if result else "unlocked",
                response.strip(),
            )
            return result
        finally:
            await self._exit_program_mode()

    async def _is_frequency_locked(self, frequency_raw: int) -> bool:
        locked = await self.get_frequency_lockouts()
        return frequency_raw in locked

    async def get_frequency_lockouts(self) -> list[int]:
        await self._enter_program_mode()
        try:
            return await self._read_glf_list()
        finally:
            await self._exit_program_mode()

    async def set_frequency_lockout(self, frequency_raw: int, locked: bool) -> bool:
        await self._enter_program_mode()
        try:
            command = "LOF" if locked else "ULF"
            response = await self._send(f"{command},{frequency_raw}", PRIORITY_BACKGROUND)
            if not self._is_ok_response(response) and "OK" not in response.upper():
                raise ValueError(response.strip() or "lockout_failed")
            return True
        finally:
            await self._exit_program_mode()

    async def debug_glf_sequence(self, limit: int = 20) -> list[str]:
        await self._enter_program_mode()
        try:
            responses: list[str] = []
            response = await self._send("GLF,***", PRIORITY_BACKGROUND)
            responses.append(f"GLF,*** => {response}")
            next_key = self._parse_glf_response(response)
            if next_key is None:
                while len(responses) < limit:
                    response = await self._send("GLF", PRIORITY_BACKGROUND)
                    responses.append(f"GLF => {response}")
                    next_key = self._parse_glf_response(response)
                    if next_key is None:
                        break
            else:
                while len(responses) < limit:
                    response = await self._send(f"GLF,{next_key}", PRIORITY_BACKGROUND)
                    responses.append(f"GLF,{next_key} => {response}")
                    next_key = self._parse_glf_response(response)
                    if next_key is None:
                        break
            self._logger.info("GLF debug responses: %s", responses)
            return responses
        finally:
            await self._exit_program_mode()

    @staticmethod
    def _parse_glf_response(response: str) -> Optional[int]:
        lines = [line.strip() for line in response.splitlines() if line.strip()]
        if not lines:
            return None
        for line in lines:
            parts = [part.strip() for part in line.split(",")]
            if parts and parts[0].upper() == "GLF":
                parts = parts[1:]
            if not parts:
                continue
            value = parts[0]
            if value == "-1":
                return None
            if value.upper() == "OK":
                continue
            try:
                return int(value)
            except ValueError:
                continue
        return None

    async def _read_glf_list(self) -> list[int]:
        response = await self._send("GLF,***", PRIORITY_BACKGROUND)
        first = self._parse_glf_response(response)
        if first is None:
            return await self._read_glf_list_no_params()
        locked = [first]
        while True:
            response = await self._send(f"GLF,{locked[-1]}", PRIORITY_BACKGROUND)
            next_key = self._parse_glf_response(response)
            if next_key is None:
                break
            locked.append(next_key)
        return locked

    async def _read_glf_list_no_params(self) -> list[int]:
        locked: list[int] = []
        while True:
            response = await self._send("GLF", PRIORITY_BACKGROUND)
            next_key = self._parse_glf_response(response)
            if next_key is None:
                break
            locked.append(next_key)
        return locked

    async def send_program_command(self, command: str) -> str:
        return await self._send(command, PRIORITY_BACKGROUND)

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

        freq_value = 0.0
        modulation = "FM"
        alpha_tag = ""
        delay = 2
        lockout = False
        priority = False
        tone = None
        bank = 0

        if len(parts) >= 2 and looks_like_frequency(parts[1]) and not looks_like_frequency(parts[0]):
            alpha_tag = parts[0]
            freq_value = parse_frequency(parts[1])
            modulation = parts[2] if len(parts) > 2 and parts[2] else "FM"
            remaining = parts[3:]
            if len(remaining) > 0 and remaining[0] != "":
                tone = parse_float(remaining[0])
            if len(remaining) > 1 and remaining[1] != "":
                delay = int(remaining[1])
            if len(remaining) > 2 and remaining[2] != "":
                lockout = remaining[2] == "1"
            if len(remaining) > 3 and remaining[3] != "":
                priority = remaining[3] == "1"
            if len(remaining) > 4 and remaining[4] != "":
                bank = int(remaining[4])
        else:
            if len(parts) > 0:
                freq_value = parse_frequency(parts[0])
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
            frequency=freq_value,
            modulation=modulation,
            alpha_tag=alpha_tag,
            delay=delay,
            lockout=lockout,
            priority=priority,
            tone_squelch=tone,
            bank=bank,
        )

    @staticmethod
    def _is_ok_response(response: str) -> bool:
        value = response.strip().upper()
        return value == "OK" or value.endswith(",OK")

    async def _send(self, raw: str, priority: int) -> str:
        future = self._scheduler.enqueue(raw, priority)
        response = await future
        return response
