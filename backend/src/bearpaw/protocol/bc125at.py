from __future__ import annotations

import asyncio
import time
from typing import Optional

import logging

from bearpaw.models import ChannelData, LiveState
from bearpaw.protocol.base import ScannerDriver
from bearpaw.scheduler import (
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
        self._program_mode_forced_hold = (
            False  # Track if we forced HOLD for program mode
        )
        self._in_program_mode = False
        self.last_error: Optional[str] = None
        self._last_volume: int = 0
        self._last_volume_poll: float = 0.0
        self._last_squelch: int = 0
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
            self._logger.debug("STS response: %s", response)
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

        alpha_tag = None
        alpha_tag_candidates = []
        if (
            len(parts) > 7
            and parts[7]
            and not parts[7].isdigit()
            and parts[7] not in ("FM", "AM", "NFM", "AUTO", "0", "1")
        ):
            alpha_tag_candidates.append((7, parts[7]))
        if (
            len(parts) > 8
            and parts[8]
            and not parts[8].isdigit()
            and parts[8] not in ("FM", "AM", "NFM", "AUTO", "0", "1")
        ):
            alpha_tag_candidates.append((8, parts[8]))

        if alpha_tag_candidates:
            alpha_tag = alpha_tag_candidates[0][1]
            self._logger.debug(
                "GLG alpha_tag: candidates=%s, selected=parts[%d]=%s",
                alpha_tag_candidates,
                alpha_tag_candidates[0][0],
                alpha_tag,
            )
        else:
            self._logger.debug(
                "GLG alpha_tag: no valid candidates found, parts[7]=%s, parts[8]=%s",
                parts[7] if len(parts) > 7 else None,
                parts[8] if len(parts) > 8 else None,
            )
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
            self._logger.warning(
                "Key command failed (%s): %s", key_code, self.last_error
            )
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

    async def get_squelch(self) -> int:
        return await self._get_squelch(assume_program_mode=False)

    async def _get_squelch(self, assume_program_mode: bool) -> int:
        if not assume_program_mode:
            await self._enter_program_mode()
        try:
            response = await self._send("SQL", PRIORITY_BACKGROUND)
        finally:
            if not assume_program_mode:
                await self._exit_program_mode()
        parts = [part.strip() for part in response.split(",") if part.strip() != ""]
        if parts and parts[0].isalpha():
            parts = parts[1:]
        if not parts:
            return self._last_squelch
        try:
            value = int(parts[0])
        except ValueError:
            self._logger.debug("Invalid SQL response: %s", response)
            return self._last_squelch
        self._last_squelch = value
        return value

    async def set_squelch(self, level: int) -> bool:
        if not 0 <= level <= 15:
            raise ValueError("squelch_out_of_range")
        should_exit = False
        if not self._in_program_mode:
            await self._enter_program_mode()
            should_exit = True
        try:
            response = await self._send(f"SQL,{level}", PRIORITY_BACKGROUND)
        finally:
            if should_exit:
                await self._exit_program_mode()
        ok = self._is_ok_response(response)
        if not ok and response.strip().upper().startswith("SQL,"):
            ok = True
        if ok:
            self._last_squelch = level
            self.last_error = None
        else:
            self.last_error = response.strip() or "squelch_failed"
            self._logger.warning("Set squelch failed: %s", self.last_error)
        return ok

    async def get_firmware_version(self) -> str:
        response = await self._send("VER", PRIORITY_CONTROL)
        parts = self._parse_command_parts(response, "VER")
        return ",".join(parts).strip()

    async def get_backlight(self) -> str:
        return await self._get_backlight(assume_program_mode=False)

    async def set_backlight(self, event: str) -> bool:
        if event not in {"AO", "AF", "KY", "SQ", "KS"}:
            raise ValueError("backlight_invalid")
        await self._enter_program_mode()
        try:
            response = await self._send(f"BLT,{event}", PRIORITY_BACKGROUND)
        finally:
            await self._exit_program_mode()
        return self._is_ok_response(response)

    async def get_battery_charge_time(self) -> int:
        return await self._get_battery_charge_time(assume_program_mode=False)

    async def set_battery_charge_time(self, charge_time: int) -> bool:
        if not 1 <= charge_time <= 16:
            raise ValueError("battery_charge_time_out_of_range")
        await self._enter_program_mode()
        try:
            response = await self._send(f"BSV,{charge_time}", PRIORITY_BACKGROUND)
        finally:
            await self._exit_program_mode()
        return self._is_ok_response(response)

    async def get_key_beep_settings(self) -> tuple[int, bool]:
        return await self._get_key_beep_settings(assume_program_mode=False)

    async def set_key_beep_settings(self, level: int, lock: bool) -> bool:
        if level != 99 and not 0 <= level <= 15:
            raise ValueError("beep_level_out_of_range")
        lock_value = "1" if lock else "0"
        await self._enter_program_mode()
        try:
            response = await self._send(
                f"KBP,{level},{lock_value}", PRIORITY_BACKGROUND
            )
        finally:
            await self._exit_program_mode()
        return self._is_ok_response(response)

    async def get_priority_mode(self) -> int:
        return await self._get_priority_mode(assume_program_mode=False)

    async def set_priority_mode(self, mode: int) -> bool:
        if mode not in (0, 1, 2, 3):
            raise ValueError("priority_mode_invalid")
        await self._enter_program_mode()
        try:
            response = await self._send(f"PRI,{mode}", PRIORITY_BACKGROUND)
        finally:
            await self._exit_program_mode()
        return self._is_ok_response(response)

    async def get_search_settings(self) -> tuple[int, bool]:
        return await self._get_search_settings(assume_program_mode=False)

    async def set_search_settings(self, delay: int, code_search: bool) -> bool:
        if delay not in (-10, -5, 0, 1, 2, 3, 4, 5):
            raise ValueError("search_delay_invalid")
        code_value = "1" if code_search else "0"
        await self._enter_program_mode()
        try:
            response = await self._send(
                f"SCO,{delay},{code_value}", PRIORITY_BACKGROUND
            )
        finally:
            await self._exit_program_mode()
        ok = self._is_ok_response(response)
        if not ok and response.strip().upper().startswith("SCO,"):
            ok = True
        return ok

    async def get_close_call_settings(self) -> tuple[int, bool, bool, list[bool], bool]:
        return await self._get_close_call_settings(assume_program_mode=False)

    async def set_close_call_settings(
        self,
        mode: int,
        alert_beep: bool,
        alert_light: bool,
        band: list[bool],
        lockout: bool,
    ) -> bool:
        if mode not in (0, 1, 2):
            raise ValueError("close_call_mode_invalid")
        if len(band) != 5:
            raise ValueError("close_call_band_invalid")
        band_value = "".join("1" if value else "0" for value in band)
        alert_beep_value = "1" if alert_beep else "0"
        alert_light_value = "1" if alert_light else "0"
        lockout_value = "1" if lockout else "0"
        await self._enter_program_mode()
        try:
            command = f"CLC,{mode},{alert_beep_value},{alert_light_value},{band_value},{lockout_value}"
            self._logger.debug("Setting close call: %s", command)
            response = await self._send(command, PRIORITY_BACKGROUND)
            self._logger.debug("Close call response: %s", response)
        finally:
            await self._exit_program_mode()
        is_ok = self._is_ok_response(response)
        if not is_ok:
            self._logger.warning(
                "Close call set failed. Command: %s, Response: %s", command, response
            )
        return is_ok

    async def get_service_search_groups(self) -> list[bool]:
        return await self._get_group_flags("SSG", 10, assume_program_mode=False)

    async def set_service_search_groups(self, groups: list[bool]) -> bool:
        return await self._set_group_flags("SSG", groups)

    async def get_custom_search_groups(self) -> list[bool]:
        return await self._get_group_flags("CSG", 10, assume_program_mode=False)

    async def set_custom_search_groups(self, groups: list[bool]) -> bool:
        return await self._set_group_flags("CSG", groups)

    async def get_custom_search_range(self, index: int) -> tuple[float, float]:
        return await self._get_custom_search_range(index, assume_program_mode=False)

    async def set_custom_search_range(
        self, index: int, lower: float, upper: float
    ) -> bool:
        if not 1 <= index <= 10:
            raise ValueError("search_range_invalid")
        lower_raw = int(round(lower * 10000))
        upper_raw = int(round(upper * 10000))
        await self._enter_program_mode()
        try:
            response = await self._send(
                f"CSP,{index},{lower_raw},{upper_raw}", PRIORITY_BACKGROUND
            )
        finally:
            await self._exit_program_mode()
        return self._is_ok_response(response)

    async def get_weather_priority(self) -> bool:
        return await self._get_weather_priority(assume_program_mode=False)

    async def set_weather_priority(self, priority: bool) -> bool:
        value = "1" if priority else "0"
        await self._enter_program_mode()
        try:
            response = await self._send(f"WXS,{value}", PRIORITY_BACKGROUND)
        finally:
            await self._exit_program_mode()
        return self._is_ok_response(response)

    async def get_contrast(self) -> int:
        return await self._get_contrast(assume_program_mode=False)

    async def set_contrast(self, level: int) -> bool:
        if not 1 <= level <= 15:
            raise ValueError("contrast_out_of_range")
        await self._enter_program_mode()
        try:
            response = await self._send(f"CNT,{level}", PRIORITY_BACKGROUND)
        finally:
            await self._exit_program_mode()
        return self._is_ok_response(response)

    async def read_channel(
        self, index: int, assume_program_mode: bool = False
    ) -> ChannelData:
        if not assume_program_mode:
            await self._enter_program_mode()
        response = await self._send(f"CIN,{index}", PRIORITY_BACKGROUND)
        if not assume_program_mode:
            await self._exit_program_mode()
        return self._parse_channel_response(index, response)

    async def set_channel(self, channel: ChannelData) -> ChannelData:
        def sanitize_tag(value: str) -> str:
            return value.replace(",", " ").strip()[:16]

        def looks_like_frequency(value: str) -> bool:
            if not value:
                return False
            if "." in value:
                return True
            return value.isdigit() and int(value) >= 10000

        def format_frequency(value: float, template: str) -> str:
            if "." in template:
                return f"{value:.4f}"
            raw = int(round(value * 10000))
            width = max(8, len(template)) if template.isdigit() else 8
            return str(raw).zfill(width)

        def format_tone_value(value: Optional[float]) -> str:
            if value is None:
                return "0"
            if float(value).is_integer():
                return str(int(value))
            return str(value)

        modulation = (channel.modulation or "AUTO").upper()
        alpha_tag = sanitize_tag(channel.alpha_tag or "")
        tone_value = "" if channel.tone_squelch is None else str(channel.tone_squelch)
        delay_value = str(channel.delay)
        lockout_value = "1" if channel.lockout else "0"
        priority_value = "1" if channel.priority else "0"
        bank_value = str(channel.bank)

        await self._enter_program_mode()
        try:
            raw = await self._send(f"CIN,{channel.index}", PRIORITY_BACKGROUND)
            parts = [part.strip() for part in raw.split(",")]
            if parts and parts[0] == "CIN":
                parts = parts[1:]
            if parts and parts[0].isdigit():
                parts = parts[1:]

            if not parts:
                raise ValueError("channel_read_failed")

            has_bank = len(parts) >= 8 and parts[-1].isdigit() and int(parts[-1]) <= 10
            has_tone = True
            if len(parts) == 7:
                lockout_candidate = parts[3]
                delay_candidate = parts[4]
                priority_candidate = parts[5]
                bank_candidate = parts[6]
                if (
                    lockout_candidate in {"0", "1"}
                    and delay_candidate.isdigit()
                    and priority_candidate in {"0", "1"}
                    and bank_candidate.isdigit()
                    and int(bank_candidate) <= 10
                ):
                    has_tone = False
            template_freq = (
                parts[1]
                if len(parts) > 1 and looks_like_frequency(parts[1])
                else parts[0]
            )
            tone_value = format_tone_value(channel.tone_squelch)

            if has_tone:
                values = [
                    alpha_tag,
                    format_frequency(channel.frequency, template_freq),
                    modulation,
                    tone_value,
                    delay_value,
                    lockout_value,
                    priority_value,
                ]
                if has_bank:
                    values.append(bank_value)
            else:
                values = [
                    alpha_tag,
                    format_frequency(channel.frequency, template_freq),
                    modulation,
                    lockout_value,
                    delay_value,
                    priority_value,
                    bank_value,
                ]

            write_command = f"CIN,{channel.index}," + ",".join(values)
            self._logger.info("CIN write: %s", write_command)
            write_response = await self._send(write_command, PRIORITY_BACKGROUND)
            self._logger.info("CIN write response: %s", write_response.strip())
            if (
                not self._is_ok_response(write_response)
                and "OK" not in write_response.upper()
            ):
                raise ValueError(write_response.strip() or "channel_write_failed")

            response = await self._send(f"CIN,{channel.index}", PRIORITY_BACKGROUND)
            self._logger.info("CIN readback: %s", response.strip())
            updated = self._parse_channel_response(channel.index, response)
            if (
                updated.priority != channel.priority
                or updated.lockout != channel.lockout
            ):
                await asyncio.sleep(0.2)
                response = await self._send(f"CIN,{channel.index}", PRIORITY_BACKGROUND)
                self._logger.info("CIN readback retry: %s", response.strip())
                updated = self._parse_channel_response(channel.index, response)
            if (
                updated.priority != channel.priority
                or updated.lockout != channel.lockout
            ):
                self._logger.warning(
                    "Channel write mismatch for %s (lockout/priority). Expected lockout=%s priority=%s got lockout=%s priority=%s",
                    channel.index,
                    channel.lockout,
                    channel.priority,
                    updated.lockout,
                    updated.priority,
                )
            return updated
        finally:
            await self._exit_program_mode()

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
            write_command = f"CIN,{index},{name},{freq},{mod},{tone},{delay},{lockout_value},{priority}"
            write_response = await self._send(write_command, PRIORITY_BACKGROUND)
            if (
                not self._is_ok_response(write_response)
                and "OK" not in write_response.upper()
            ):
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
            write_command = f"CIN,{index},{name},{freq},{mod},{tone},{delay},{lockout_value},{priority}"
            write_response = await self._send(write_command, PRIORITY_BACKGROUND)
            if (
                not self._is_ok_response(write_response)
                and "OK" not in write_response.upper()
            ):
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
            response = await self._send(
                f"{command},{frequency_raw}", PRIORITY_BACKGROUND
            )
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
            response = await self._send(
                f"{command},{frequency_raw}", PRIORITY_BACKGROUND
            )
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
        seen: set[int] = set()
        max_iterations = 600
        iterations = 0
        while iterations < max_iterations:
            response = await self._send("GLF", PRIORITY_BACKGROUND)
            next_key = self._parse_glf_response(response)
            if next_key is None:
                break
            if next_key in seen:
                logger.warning(
                    "GLF: detected duplicate key %d, terminating list read", next_key
                )
                break
            if not (1 <= next_key <= 500):
                logger.warning(
                    "GLF: invalid key %d (must be 1-500), terminating list read",
                    next_key,
                )
                break
            seen.add(next_key)
            locked.append(next_key)
            iterations += 1
        return locked

    async def send_program_command(self, command: str) -> str:
        return await self._send(command, PRIORITY_BACKGROUND)

    async def _enter_program_mode(self) -> None:
        self._in_program_mode = True
        self._pre_program_mode = self._mode
        if self._mode == "SCAN":
            await self._send("KEY,H,P", PRIORITY_CONTROL)
            self._mode = "HOLD"
            self._program_mode_forced_hold = True
        else:
            self._program_mode_forced_hold = False
        await self._send("PRG", PRIORITY_BACKGROUND)

    async def _exit_program_mode(self) -> None:
        try:
            await self._send("EPG", PRIORITY_BACKGROUND)
            # Only restore pre-program mode if we forced HOLD and mode hasn't changed
            # If user sent hold/scan command during program mode, respect that
            if self._program_mode_forced_hold and self._mode == "HOLD":
                # Mode is still HOLD (what we forced), safe to restore
                if self._pre_program_mode == "SCAN":
                    await self._send("KEY,S,P", PRIORITY_CONTROL)
                self._mode = self._pre_program_mode
            # If mode changed from HOLD during program mode, user command takes precedence
            self._pre_program_mode = None
            self._program_mode_forced_hold = False
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

    async def get_settings_snapshot(self) -> dict[str, object]:
        await self._enter_program_mode()
        try:
            squelch = await self._get_squelch(assume_program_mode=True)
            backlight = await self._get_backlight(assume_program_mode=True)
            battery = await self._get_battery_charge_time(assume_program_mode=True)
            key_beep = await self._get_key_beep_settings(assume_program_mode=True)
            priority = await self._get_priority_mode(assume_program_mode=True)
            search = await self._get_search_settings(assume_program_mode=True)
            close_call = await self._get_close_call_settings(assume_program_mode=True)
            service_search = await self._get_group_flags(
                "SSG", 10, assume_program_mode=True
            )
            custom_search = await self._get_group_flags(
                "CSG", 10, assume_program_mode=True
            )
            custom_ranges = [
                await self._get_custom_search_range(index, assume_program_mode=True)
                for index in range(1, 11)
            ]
            weather = await self._get_weather_priority(assume_program_mode=True)
            contrast = await self._get_contrast(assume_program_mode=True)
        finally:
            await self._exit_program_mode()
        return {
            "squelch": squelch,
            "backlight": backlight,
            "battery": battery,
            "key_beep": key_beep,
            "priority": priority,
            "search": search,
            "close_call": close_call,
            "service_search": service_search,
            "custom_search": custom_search,
            "custom_search_ranges": custom_ranges,
            "weather": weather,
            "contrast": contrast,
        }

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

        modes = {"FM", "AM", "NFM", "AUTO"}
        mod_index = next(
            (idx for idx, value in enumerate(parts) if value.upper() in modes), None
        )
        format_kind = (
            "name-first"
            if (
                len(parts) >= 2
                and looks_like_frequency(parts[1])
                and not looks_like_frequency(parts[0])
            )
            else "freq-mod-tag"
        )
        if format_kind == "freq-mod-tag" and mod_index == 2 and len(parts) > 1:
            if looks_like_frequency(parts[0]) and looks_like_frequency(parts[1]):
                format_kind = "freq-tone-mod-tag"

        if format_kind == "name-first":
            alpha_tag = parts[0]
            freq_value = parse_frequency(parts[1])
            modulation = parts[2] if len(parts) > 2 and parts[2] else "FM"
            remaining = parts[3:]
            if len(remaining) >= 4:
                if (
                    len(remaining) == 4
                    and remaining[0] in {"0", "1"}
                    and remaining[1].isdigit()
                    and remaining[2] in {"0", "1"}
                    and remaining[3].isdigit()
                ):
                    lockout = remaining[0] == "1"
                    delay = int(remaining[1])
                    priority = remaining[2] == "1"
                    bank = int(remaining[3])
                else:
                    if remaining[0] != "":
                        tone = parse_float(remaining[0])
                    if remaining[1] != "":
                        delay = int(remaining[1])
                    if remaining[2] != "":
                        lockout = remaining[2] == "1"
                    if remaining[3] != "":
                        priority = remaining[3] == "1"
                    if len(remaining) > 4 and remaining[4] != "":
                        bank = int(remaining[4])
            elif len(remaining) >= 3:
                if remaining[0] != "":
                    delay = int(remaining[0])
                if remaining[1] != "":
                    lockout = remaining[1] == "1"
                if remaining[2] != "":
                    priority = remaining[2] == "1"
                if len(remaining) > 3 and remaining[3] != "":
                    bank = int(remaining[3])
        elif format_kind == "freq-tone-mod-tag":
            if len(parts) > 0:
                freq_value = parse_frequency(parts[0])
            if len(parts) > 1 and parts[1]:
                tone = parse_float(parts[1])
            modulation = parts[2] if len(parts) > 2 and parts[2] else "FM"
            alpha_tag = ""
            offset = 3
            if len(parts) > 3 and parts[3] and not parts[3].isdigit():
                alpha_tag = parts[3]
                offset = 4
            if len(parts) > offset and parts[offset]:
                lockout = parts[offset] == "1"
            if len(parts) > offset + 1 and parts[offset + 1]:
                delay = int(parts[offset + 1])
            if len(parts) > offset + 2 and parts[offset + 2]:
                priority = parts[offset + 2] == "1"
            if len(parts) > offset + 3 and parts[offset + 3]:
                bank = int(parts[offset + 3])
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
                tail_value = parts[6]
                if tail_value.isdigit() and int(tail_value) <= 10:
                    bank = int(tail_value)
                else:
                    tone = parse_float(tail_value)
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

    def _parse_command_parts(self, response: str, command: str) -> list[str]:
        parts = [part.strip() for part in response.split(",")]
        if parts and parts[0].upper() == command:
            parts = parts[1:]
        return parts

    async def _get_backlight(self, assume_program_mode: bool) -> str:
        if not assume_program_mode:
            await self._enter_program_mode()
        try:
            response = await self._send("BLT", PRIORITY_BACKGROUND)
        finally:
            if not assume_program_mode:
                await self._exit_program_mode()
        parts = self._parse_command_parts(response, "BLT")
        return parts[0] if parts else ""

    async def _get_battery_charge_time(self, assume_program_mode: bool) -> int:
        if not assume_program_mode:
            await self._enter_program_mode()
        try:
            response = await self._send("BSV", PRIORITY_BACKGROUND)
        finally:
            if not assume_program_mode:
                await self._exit_program_mode()
        parts = self._parse_command_parts(response, "BSV")
        return int(parts[0]) if parts and parts[0].isdigit() else 0

    async def _get_key_beep_settings(
        self, assume_program_mode: bool
    ) -> tuple[int, bool]:
        if not assume_program_mode:
            await self._enter_program_mode()
        try:
            response = await self._send("KBP", PRIORITY_BACKGROUND)
        finally:
            if not assume_program_mode:
                await self._exit_program_mode()
        parts = self._parse_command_parts(response, "KBP")
        level = int(parts[0]) if parts and parts[0].lstrip("-").isdigit() else 0
        lock = parts[1] == "1" if len(parts) > 1 else False
        return level, lock

    async def _get_priority_mode(self, assume_program_mode: bool) -> int:
        if not assume_program_mode:
            await self._enter_program_mode()
        try:
            response = await self._send("PRI", PRIORITY_BACKGROUND)
        finally:
            if not assume_program_mode:
                await self._exit_program_mode()
        parts = self._parse_command_parts(response, "PRI")
        return int(parts[0]) if parts and parts[0].isdigit() else 0

    async def _get_search_settings(self, assume_program_mode: bool) -> tuple[int, bool]:
        if not assume_program_mode:
            await self._enter_program_mode()
        try:
            response = await self._send("SCO", PRIORITY_BACKGROUND)
        finally:
            if not assume_program_mode:
                await self._exit_program_mode()
        parts = self._parse_command_parts(response, "SCO")
        delay = int(parts[0]) if parts and parts[0].lstrip("-").isdigit() else 0
        code_search = parts[1] == "1" if len(parts) > 1 else False

        valid_delays = (-10, -5, 0, 1, 2, 3, 4, 5)
        if delay not in valid_delays:
            delay = 0

        return delay, code_search

    async def _get_close_call_settings(
        self, assume_program_mode: bool
    ) -> tuple[int, bool, bool, list[bool], bool]:
        if not assume_program_mode:
            await self._enter_program_mode()
        try:
            response = await self._send("CLC", PRIORITY_BACKGROUND)
        finally:
            if not assume_program_mode:
                await self._exit_program_mode()
        parts = self._parse_command_parts(response, "CLC")
        mode = int(parts[0]) if parts and parts[0].isdigit() else 0
        alert_beep = parts[1] == "1" if len(parts) > 1 else False
        alert_light = parts[2] == "1" if len(parts) > 2 else False
        band_raw = parts[3] if len(parts) > 3 else "00000"
        band = [char == "1" for char in band_raw.ljust(5, "0")[:5]]
        lockout = parts[4] == "1" if len(parts) > 4 else False
        return mode, alert_beep, alert_light, band, lockout

    async def _get_group_flags(
        self, command: str, length: int, assume_program_mode: bool
    ) -> list[bool]:
        if not assume_program_mode:
            await self._enter_program_mode()
        try:
            response = await self._send(command, PRIORITY_BACKGROUND)
        finally:
            if not assume_program_mode:
                await self._exit_program_mode()
        parts = self._parse_command_parts(response, command)
        flags = parts[0] if parts else ""
        if flags.upper() == "NG":
            self._logger.warning("%s unsupported response: %s", command, response)
            return [False] * length
        if len(flags) != length:
            raise ValueError(f"Invalid {command} response: {response}")
        return [ch == "0" for ch in flags]

    async def _set_group_flags(self, command: str, groups: list[bool]) -> bool:
        if len(groups) != 10:
            raise ValueError("group_length_invalid")
        flags = "".join("0" if enabled else "1" for enabled in groups)
        await self._enter_program_mode()
        try:
            response = await self._send(f"{command},{flags}", PRIORITY_BACKGROUND)
        finally:
            await self._exit_program_mode()
        return self._is_ok_response(response)

    async def _get_custom_search_range(
        self, index: int, assume_program_mode: bool
    ) -> tuple[float, float]:
        if not 1 <= index <= 10:
            raise ValueError("search_range_invalid")
        if not assume_program_mode:
            await self._enter_program_mode()
        try:
            response = await self._send(f"CSP,{index}", PRIORITY_BACKGROUND)
        finally:
            if not assume_program_mode:
                await self._exit_program_mode()
        parts = self._parse_command_parts(response, "CSP")
        if parts and parts[0].isdigit():
            parts = parts[1:]
        lower_raw = int(parts[0]) if len(parts) > 0 and parts[0].isdigit() else 0
        upper_raw = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
        return lower_raw / 10000.0, upper_raw / 10000.0

    async def _get_weather_priority(self, assume_program_mode: bool) -> bool:
        if not assume_program_mode:
            await self._enter_program_mode()
        try:
            response = await self._send("WXS", PRIORITY_BACKGROUND)
        finally:
            if not assume_program_mode:
                await self._exit_program_mode()
        parts = self._parse_command_parts(response, "WXS")
        return parts[0] == "1" if parts else False

    async def _get_contrast(self, assume_program_mode: bool) -> int:
        if not assume_program_mode:
            await self._enter_program_mode()
        try:
            response = await self._send("CNT", PRIORITY_BACKGROUND)
        finally:
            if not assume_program_mode:
                await self._exit_program_mode()
        parts = self._parse_command_parts(response, "CNT")
        return int(parts[0]) if parts and parts[0].isdigit() else 0
