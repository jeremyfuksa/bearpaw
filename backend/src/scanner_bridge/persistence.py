from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from typing import Dict

from scanner_bridge.models import ChannelData, ShadowState


class SQLitePersistence:
    def __init__(self, db_path: str):
        self._db_path = db_path
        self._init_db()

    def _init_db(self) -> None:
        conn = sqlite3.connect(self._db_path)
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS channels (
                    idx INTEGER PRIMARY KEY,
                    frequency REAL NOT NULL,
                    modulation TEXT NOT NULL,
                    alpha_tag TEXT,
                    delay INTEGER DEFAULT 2,
                    lockout INTEGER DEFAULT 0,
                    priority INTEGER DEFAULT 0,
                    tone_squelch REAL,
                    bank INTEGER
                );
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT
                );
                """
            )
            conn.execute(
                "INSERT OR IGNORE INTO metadata (key, value) VALUES ('last_sync', '0');"
            )
            conn.commit()
        finally:
            conn.close()

    def load(self) -> ShadowState:
        conn = sqlite3.connect(self._db_path)
        try:
            channels: Dict[int, ChannelData] = {}
            for row in conn.execute(
                "SELECT idx, frequency, modulation, alpha_tag, delay, lockout, priority, tone_squelch, bank FROM channels"
            ):
                channel = ChannelData(
                    index=row[0],
                    frequency=row[1],
                    modulation=row[2],
                    alpha_tag=row[3] or "",
                    delay=row[4],
                    lockout=bool(row[5]),
                    priority=bool(row[6]),
                    tone_squelch=row[7],
                    bank=row[8] or 0,
                )
                channels[channel.index] = channel
            last_sync_row = conn.execute(
                "SELECT value FROM metadata WHERE key='last_sync'"
            ).fetchone()
            last_sync = float(last_sync_row[0]) if last_sync_row else 0.0
            return ShadowState(channels=channels, last_sync=last_sync, dirty=False)
        finally:
            conn.close()

    def save(self, shadow: ShadowState) -> None:
        conn = sqlite3.connect(self._db_path)
        try:
            conn.execute("DELETE FROM channels")
            for channel in shadow.channels.values():
                conn.execute(
                    """
                    INSERT INTO channels (idx, frequency, modulation, alpha_tag, delay, lockout, priority, tone_squelch, bank)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        channel.index,
                        channel.frequency,
                        channel.modulation,
                        channel.alpha_tag,
                        channel.delay,
                        int(channel.lockout),
                        int(channel.priority),
                        channel.tone_squelch,
                        channel.bank,
                    ),
                )
            conn.execute(
                "UPDATE metadata SET value = ? WHERE key = 'last_sync'",
                (str(shadow.last_sync),),
            )
            conn.commit()
        finally:
            conn.close()


class JsonPersistence:
    def __init__(self, path: str, keep_backups: int = 3):
        self._path = path
        self._keep_backups = keep_backups

    def load(self) -> ShadowState:
        if not os.path.exists(self._path):
            return ShadowState()
        with open(self._path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        channels: Dict[int, ChannelData] = {}
        for key, data in payload.get("channels", {}).items():
            index = int(key)
            channels[index] = ChannelData(
                index=index,
                frequency=data.get("frequency", 0.0),
                modulation=data.get("modulation", "FM"),
                alpha_tag=data.get("alpha_tag", ""),
                delay=data.get("delay", 2),
                lockout=bool(data.get("lockout", False)),
                priority=bool(data.get("priority", False)),
                tone_squelch=data.get("tone_squelch"),
                bank=data.get("bank", 0),
            )
        return ShadowState(
            channels=channels,
            last_sync=float(payload.get("last_sync", 0.0)),
            dirty=bool(payload.get("dirty", False)),
        )

    def save(self, shadow: ShadowState) -> None:
        self._rotate_backups()
        payload = {
            "version": "1.0",
            "last_sync": shadow.last_sync,
            "dirty": shadow.dirty,
            "channels": {
                str(channel.index): {
                    "frequency": channel.frequency,
                    "modulation": channel.modulation,
                    "alpha_tag": channel.alpha_tag,
                    "delay": channel.delay,
                    "lockout": channel.lockout,
                    "priority": channel.priority,
                    "tone_squelch": channel.tone_squelch,
                    "bank": channel.bank,
                }
                for channel in shadow.channels.values()
            },
        }
        os.makedirs(os.path.dirname(self._path) or ".", exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(prefix="shadow-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2, sort_keys=True)
            os.replace(tmp_path, self._path)
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

    def _rotate_backups(self) -> None:
        if self._keep_backups <= 0:
            return
        if not os.path.exists(self._path):
            return
        for idx in range(self._keep_backups, 0, -1):
            src = f"{self._path}.{idx}"
            dst = f"{self._path}.{idx + 1}"
            if os.path.exists(src):
                os.replace(src, dst)
        os.replace(self._path, f"{self._path}.1")
