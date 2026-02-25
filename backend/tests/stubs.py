import asyncio
from typing import Optional
from bearpaw.models import ChannelData, LiveState
from bearpaw.protocol.base import ScannerDriver
from bearpaw.scheduler import Command, CommandScheduler


class MockDriver(ScannerDriver):
    def __init__(self, responses: dict = None):
        self.responses = responses or {}
        self.call_count = {}
        self.in_program_mode = False

    async def get_status(self) -> LiveState:
        self._record_call("get_status")
        return self.responses.get(
            "status",
            LiveState(
                timestamp=0.0,
                frequency=151.25,
                modulation="FM",
                squelch_open=False,
                rssi=60,
                mode="SCAN",
                channel=1,
                alpha_tag="Test Channel",
                volume=10,
                battery=85,
                stale=False,
            ),
        )

    async def send_hold(self) -> bool:
        self._record_call("send_hold")
        return True

    async def send_scan(self) -> bool:
        self._record_call("send_scan")
        return True

    async def send_key(self, key_code: str) -> bool:
        self._record_call("send_key", key_code=key_code)
        return True

    async def read_channel(
        self, index: int, assume_program_mode: bool = False
    ) -> ChannelData:
        self._record_call("read_channel", index=index)
        return self.responses.get(
            "channel",
            ChannelData(
                index=index,
                frequency=151.25,
                modulation="FM",
                alpha_tag="Test Channel",
                delay=2,
                lockout=False,
                priority=False,
                tone_squelch=None,
                bank=1,
            ),
        )

    async def set_channel(self, channel: ChannelData) -> ChannelData:
        self._record_call("set_channel", channel=channel)
        return channel

    async def detect_model(self) -> str:
        self._record_call("detect_model")
        return "BC125AT"

    def _record_call(self, method: str, **kwargs) -> None:
        key = f"{method}_{kwargs}"
        self.call_count[key] = self.call_count.get(key, 0) + 1

    def get_call_count(self, method: str, **kwargs) -> int:
        key = f"{method}_{kwargs}"
        return self.call_count.get(key, 0)

    def reset(self) -> None:
        self.call_count.clear()


class MockScheduler:
    def __init__(self, responses: list = None):
        self._responses = iter(responses or [])
        self._pending: dict[str, asyncio.Future] = {}
        self._sequence = 0

    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        for future in self._pending.values():
            if not future.done():
                future.cancel()

    async def enqueue(self, raw: str, priority: int) -> asyncio.Future:
        loop = asyncio.get_running_loop()
        future = loop.create_future()

        try:
            response = next(self._responses)
        except StopIteration:
            response = "OK"

        future.set_result(response)
        self._sequence += 1
        return future

    def has_high_priority(self) -> bool:
        return False

    def reset(self) -> None:
        self._responses = iter([])
        self._pending.clear()
        self._sequence = 0


class MockTransport:
    def __init__(self, responses: dict = None):
        self.responses = responses or {}
        self.call_count = {}
        self.connected = True

    async def connect(self) -> None:
        self.call_count["connect"] = self.call_count.get("connect", 0) + 1
        self.connected = True

    async def disconnect(self) -> None:
        self.call_count["disconnect"] = self.call_count.get("disconnect", 0) + 1
        self.connected = False

    async def send_command(self, command: str) -> str:
        self.call_count["send_command"] = self.call_count.get("send_command", 0) + 1
        if not self.connected:
            raise RuntimeError("Transport not connected")
        return self.responses.get(command, "OK")

    def get_call_count(self, method: str) -> int:
        return self.call_count.get(method, 0)

    def reset(self) -> None:
        self.call_count.clear()
        self.connected = True
