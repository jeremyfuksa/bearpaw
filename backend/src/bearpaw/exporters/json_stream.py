from __future__ import annotations

import json
import os
import time
from datetime import datetime
from typing import Optional


class JsonEventStream:
    def __init__(
        self, path: str, max_bytes: int = 10 * 1024 * 1024, rotate_daily: bool = True
    ):
        self._path = path
        self._max_bytes = max_bytes
        self._rotate_daily = rotate_daily
        self._last_day = datetime.utcnow().date()

    def append(self, event: str, data: dict, timestamp: Optional[float] = None) -> None:
        payload = {
            "timestamp": timestamp or time.time(),
            "event": event,
            **data,
        }
        os.makedirs(os.path.dirname(self._path) or ".", exist_ok=True)
        self._rotate_if_needed()
        with open(self._path, "a", encoding="ascii") as handle:
            handle.write(json.dumps(payload, separators=(",", ":")) + "\n")

    def _rotate_if_needed(self) -> None:
        if not os.path.exists(self._path):
            return
        if self._rotate_daily:
            today = datetime.utcnow().date()
            if today != self._last_day:
                self._rotate()
                self._last_day = today
                return
        if os.path.getsize(self._path) < self._max_bytes:
            return
        self._rotate()

    def _rotate(self) -> None:
        base = f"{self._path}.{int(time.time())}"
        os.replace(self._path, base)
