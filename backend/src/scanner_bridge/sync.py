from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Dict, Optional

from scanner_bridge.models import ChannelData
from scanner_bridge.protocol.base import ScannerDriver
from scanner_bridge.state import StateStore
from scanner_bridge.websocket import WebSocketManager


class MemorySyncTask:
    def __init__(
        self,
        driver: ScannerDriver,
        state_store: StateStore,
        ws_manager: Optional[WebSocketManager] = None,
        max_channels: int = 500,
    ):
        self.driver = driver
        self.state_store = state_store
        self.ws_manager = ws_manager
        self.max_channels = max_channels
        self.task_id = f"sync-{uuid.uuid4().hex[:8]}"
        self._cancel = asyncio.Event()
        self._logger = logging.getLogger(__name__)

    def cancel(self) -> None:
        self._cancel.set()

    async def run(self) -> None:
        channels: Dict[int, ChannelData] = {}
        start = time.time()
        try:
            begin_sync = getattr(self.driver, "begin_memory_sync", None)
            if callable(begin_sync):
                await begin_sync()
            for idx in range(1, self.max_channels + 1):
                if self._cancel.is_set():
                    await self._publish_progress(idx - 1, "Sync cancelled")
                    return
                channel = await self.driver.read_channel(idx, assume_program_mode=True)
                channels[idx] = channel
                if idx % 10 == 0:
                    await self._publish_progress(idx, f"Syncing channel {idx}/{self.max_channels}")
                await asyncio.sleep(0)
            self.state_store.set_shadow_state(channels)
            self.state_store.save_shadow()
            elapsed = time.time() - start
            await self._publish_progress(
                self.max_channels, f"Sync complete in {elapsed:.1f}s"
            )
        except Exception as exc:
            self._logger.exception("Memory sync failed: %s", exc)
            await self._publish_progress(0, f"Sync failed: {exc}")
        finally:
            end_sync = getattr(self.driver, "end_memory_sync", None)
            if callable(end_sync):
                try:
                    await end_sync()
                except Exception as exc:
                    self._logger.warning("Failed to exit program mode: %s", exc)

    async def _publish_progress(self, current: int, message: str) -> None:
        if not self.ws_manager:
            return
        percent = int((current / self.max_channels) * 100) if self.max_channels else 100
        await self.ws_manager.broadcast(
            {
                "type": "progress",
                "task_id": self.task_id,
                "percent": percent,
                "message": message,
            }
        )
