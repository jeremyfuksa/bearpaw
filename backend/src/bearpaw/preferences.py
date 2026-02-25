from __future__ import annotations

import json
import sqlite3
import time
from typing import Any, Dict, Optional


class PreferencesStore:
    DEFAULTS = {
        "auto_connect": False,
        "start_dashboard_mode": True,
        "check_updates": True,
        "recording_buffer_size": 30,
        "data_retention_days": 30,
        "audio_output_device": "default",
        "theme": "dark",
        "recordings_path": "./recordings",
        "mqtt_enabled": False,
        "mqtt_host": "127.0.0.1",
        "mqtt_port": 1883,
        "mqtt_topic_prefix": "scanner",
        "mqtt_qos": 0,
        "mqtt_retain": False,
    }

    def __init__(self, db_path: str):
        self._db_path = db_path
        self._init_schema()

    def _init_schema(self):
        conn = sqlite3.connect(self._db_path)
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS preferences (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )
            conn.commit()
        finally:
            conn.close()

    def get(self, key: str) -> Optional[Any]:
        conn = sqlite3.connect(self._db_path)
        try:
            row = conn.execute(
                "SELECT value FROM preferences WHERE key = ?", (key,)
            ).fetchone()
            if row:
                return json.loads(row[0])
            return self.DEFAULTS.get(key)
        finally:
            conn.close()

    def get_all(self) -> Dict[str, Any]:
        result = dict(self.DEFAULTS)
        conn = sqlite3.connect(self._db_path)
        try:
            for key, value in conn.execute("SELECT key, value FROM preferences"):
                result[key] = json.loads(value)
        finally:
            conn.close()
        return result

    def set(self, key: str, value: Any) -> None:
        conn = sqlite3.connect(self._db_path)
        try:
            conn.execute(
                "INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, ?)",
                (key, json.dumps(value), time.time()),
            )
            conn.commit()
        finally:
            conn.close()

    def set_multiple(self, prefs: Dict[str, Any]) -> None:
        conn = sqlite3.connect(self._db_path)
        try:
            for key, value in prefs.items():
                conn.execute(
                    "INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, ?)",
                    (key, json.dumps(value), time.time()),
                )
            conn.commit()
        finally:
            conn.close()

    def reset(self) -> Dict[str, Any]:
        conn = sqlite3.connect(self._db_path)
        try:
            conn.execute("DELETE FROM preferences")
            conn.commit()
        finally:
            conn.close()
        return dict(self.DEFAULTS)
