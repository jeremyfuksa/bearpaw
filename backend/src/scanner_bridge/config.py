from __future__ import annotations

import os
try:
    import tomllib
except ImportError:  # pragma: no cover
    import tomli as tomllib
from typing import List, Optional

import yaml
from pydantic import BaseModel, Field


class DeviceConfig(BaseModel):
    port: Optional[str] = None
    auto_detect: bool = True
    transport: str = "auto"
    usb_vid: int = 0x1965
    usb_pid: int = 0x0017
    usb_serial: Optional[str] = None


class ApiConfig(BaseModel):
    host: str = "127.0.0.1"
    port: int = 8000
    cors_origins: List[str] = Field(
        default_factory=lambda: [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ]
    )


class PollingConfig(BaseModel):
    sts_interval: float = 0.1
    reconnect_backoff: List[float] = Field(default_factory=lambda: [1, 2, 5, 10, 30])


class StateConfig(BaseModel):
    persistence: str = "sqlite"
    db_path: str = "./scanner.db"


class TextFileExporterConfig(BaseModel):
    enabled: bool = False
    path: str = "./now_scanning.txt"
    template: str = "{frequency} MHz {modulation} - {alpha_tag}"
    update_on: List[str] = Field(default_factory=lambda: ["frequency", "squelch_open"])
    blank_on_squelch_closed: bool = False


class JsonStreamExporterConfig(BaseModel):
    enabled: bool = False
    path: str = "./events.jsonl"
    max_bytes: int = 10 * 1024 * 1024
    rotate_daily: bool = True


class MqttExporterConfig(BaseModel):
    enabled: bool = False
    host: str = "127.0.0.1"
    port: int = 1883
    topic_prefix: str = "scanner"
    qos: int = 0
    retain: bool = False


class ExporterConfig(BaseModel):
    text_file: TextFileExporterConfig = Field(default_factory=TextFileExporterConfig)
    json_stream: JsonStreamExporterConfig = Field(default_factory=JsonStreamExporterConfig)
    mqtt: MqttExporterConfig = Field(default_factory=MqttExporterConfig)


class AppConfig(BaseModel):
    device: DeviceConfig = Field(default_factory=DeviceConfig)
    api: ApiConfig = Field(default_factory=ApiConfig)
    polling: PollingConfig = Field(default_factory=PollingConfig)
    state: StateConfig = Field(default_factory=StateConfig)
    exporters: ExporterConfig = Field(default_factory=ExporterConfig)


def load_config(path: Optional[str]) -> AppConfig:
    if not path:
        return AppConfig()
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    if path.endswith(".toml"):
        with open(path, "rb") as handle:
            data = tomllib.load(handle)
    else:
        with open(path, "r", encoding="ascii") as handle:
            data = yaml.safe_load(handle) or {}
    return AppConfig(**data)
