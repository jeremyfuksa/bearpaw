from __future__ import annotations

import threading
import time
from typing import Dict, Optional

from scanner_bridge.models import ChannelData, LiveState, ShadowState
from scanner_bridge.persistence import JsonPersistence, SQLitePersistence


class StateStore:
    def __init__(self, persistence: Optional[object] = None):
        self._lock = threading.Lock()
        self._live_state: Optional[LiveState] = None
        self._shadow_state = ShadowState()
        self._persistence = persistence

    def load_shadow(self) -> None:
        if not self._persistence:
            return
        self._shadow_state = self._persistence.load()

    def save_shadow(self) -> None:
        if not self._persistence:
            return
        self._persistence.save(self._shadow_state)

    def update_live_state(self, state: LiveState) -> Dict[str, object]:
        with self._lock:
            changes: Dict[str, object] = {}
            if not self._live_state:
                self._live_state = state
                return state.__dict__
            for field, value in state.__dict__.items():
                if getattr(self._live_state, field) != value:
                    changes[field] = value
            self._live_state = state
            return changes

    def mark_live_state_stale(self) -> Dict[str, object]:
        with self._lock:
            if not self._live_state:
                return {}
            if not self._live_state.stale:
                self._live_state.stale = True
                self._live_state.timestamp = time.time()
                return {"stale": True, "timestamp": self._live_state.timestamp}
            return {}

    def get_live_state(self) -> LiveState:
        with self._lock:
            if self._live_state:
                return self._live_state
            return LiveState(
                timestamp=time.time(),
                frequency=0.0,
                modulation="AUTO",
                squelch_open=False,
                rssi=0,
                mode="SCAN",
                channel=None,
                alpha_tag=None,
                volume=0,
                battery=None,
                stale=True,
            )

    def set_shadow_channel(self, channel: ChannelData) -> None:
        with self._lock:
            self._shadow_state.channels[channel.index] = channel
            self._shadow_state.dirty = False
            self._shadow_state.last_sync = time.time()

    def set_shadow_state(self, channels: Dict[int, ChannelData]) -> None:
        with self._lock:
            self._shadow_state.channels = channels
            self._shadow_state.last_sync = time.time()
            self._shadow_state.dirty = False

    def mark_shadow_dirty(self) -> None:
        with self._lock:
            self._shadow_state.dirty = True

    def get_shadow_channels(self, bank: Optional[int] = None) -> Dict[int, ChannelData]:
        with self._lock:
            if bank is None:
                return dict(self._shadow_state.channels)
            return {
                idx: chan
                for idx, chan in self._shadow_state.channels.items()
                if chan.bank == bank
            }

    def get_shadow_channel(self, index: int) -> Optional[ChannelData]:
        with self._lock:
            return self._shadow_state.channels.get(index)

    def has_shadow_channels(self) -> bool:
        with self._lock:
            return bool(self._shadow_state.channels)

    def is_shadow_dirty(self) -> bool:
        with self._lock:
            return self._shadow_state.dirty


def build_persistence(kind: str, path: str) -> object:
    if kind == "sqlite":
        return SQLitePersistence(path)
    if kind == "json":
        return JsonPersistence(path)
    raise ValueError(f"Unsupported persistence type: {kind}")
