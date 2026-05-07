from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass, field
from typing import Optional

from bearpaw.transport import SerialTransport

PRIORITY_CONTROL = 0
PRIORITY_TELEMETRY = 1
PRIORITY_BACKGROUND = 2


@dataclass(order=True)
class Command:
    priority: int
    sequence: int
    raw: str = field(compare=False)
    future: asyncio.Future = field(compare=False)


class CommandScheduler:
    def __init__(self, transport: SerialTransport):
        self._transport = transport
        self._queue: asyncio.PriorityQueue[Command] = asyncio.PriorityQueue()
        self._sequence = 0
        self._pending_raw: dict[str, asyncio.Future] = {}
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._pending_counts = {PRIORITY_CONTROL: 0}

    def has_high_priority(self) -> bool:
        return self._pending_counts.get(PRIORITY_CONTROL, 0) > 0

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._worker_loop())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    def enqueue(self, raw: str, priority: int) -> asyncio.Future:
        existing = self._pending_raw.get(raw)
        if existing is not None:
            return existing
        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        self._sequence += 1
        cmd = Command(
            priority=priority, sequence=self._sequence, raw=raw, future=future
        )
        self._pending_raw[raw] = future
        if priority == PRIORITY_CONTROL:
            self._pending_counts[PRIORITY_CONTROL] = (
                self._pending_counts.get(PRIORITY_CONTROL, 0) + 1
            )
        self._queue.put_nowait(cmd)
        return future

    async def _worker_loop(self) -> None:
        while self._running:
            cmd = await self._queue.get()
            self._pending_raw.pop(cmd.raw, None)
            if cmd.priority == PRIORITY_CONTROL:
                self._pending_counts[PRIORITY_CONTROL] = max(
                    0, self._pending_counts.get(PRIORITY_CONTROL, 0) - 1
                )
            if cmd.future.cancelled():
                continue
            try:
                response = await asyncio.wrap_future(
                    self._transport.send_command(cmd.raw)
                )
                cmd.future.set_result(response)
            except Exception as exc:
                cmd.future.set_exception(exc)
