from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Optional

from pydantic import BaseModel, Field


@dataclass
class DeviceDescriptor:
    port: str
    vid: Optional[int]
    pid: Optional[int]
    serial_number: Optional[str]
    description: str


@dataclass
class DeviceInfo:
    model: Optional[str]
    port: Optional[str]
    vid: Optional[int]
    pid: Optional[int]
    serial_number: Optional[str]
    description: Optional[str]
    firmware: Optional[str] = None
    connection_status: str = "connecting"


@dataclass
class LiveState:
    timestamp: float
    frequency: float
    modulation: str
    squelch_open: bool
    rssi: int
    mode: str
    channel: Optional[int]
    alpha_tag: Optional[str]
    volume: int
    battery: Optional[int]
    stale: bool = False


@dataclass
class ChannelData:
    index: int
    frequency: float
    modulation: str
    alpha_tag: str
    delay: int
    lockout: bool
    priority: bool
    tone_squelch: Optional[float]
    bank: int


@dataclass
class ShadowState:
    channels: Dict[int, ChannelData] = field(default_factory=dict)
    last_sync: float = 0.0
    dirty: bool = True


class DeviceInfoModel(BaseModel):
    model: Optional[str]
    port: Optional[str]
    vid: Optional[int]
    pid: Optional[int]
    serial_number: Optional[str]
    description: Optional[str]
    firmware: Optional[str] = None
    connection_status: str = "connecting"

    model_config = {"from_attributes": True}


class LiveStateModel(BaseModel):
    timestamp: float
    frequency: float
    modulation: str
    squelch_open: bool
    rssi: int
    mode: str
    channel: Optional[int]
    alpha_tag: Optional[str] = None
    volume: int
    battery: Optional[int]
    stale: bool = False

    model_config = {"from_attributes": True}


class ChannelDataModel(BaseModel):
    index: int
    frequency: float
    modulation: str
    alpha_tag: str
    delay: int
    lockout: bool
    priority: bool
    tone_squelch: Optional[float]
    bank: int

    model_config = {"from_attributes": True}


class ErrorResponse(BaseModel):
    error: str
    message: str
    code: int = Field(400, description="HTTP status code")


class BanksModel(BaseModel):
    banks: list[bool]


class KeyRequest(BaseModel):
    key: str


class VolumeRequest(BaseModel):
    volume: int


class SquelchRequest(BaseModel):
    level: int


class LockoutRequest(BaseModel):
    mode: str = "temporary"
    channel: Optional[int] = None
    frequency: Optional[float] = None


class ChannelLockoutClearRequest(BaseModel):
    channels: list[int] = Field(default_factory=list)


class BacklightSettings(BaseModel):
    event: str


class BatterySettings(BaseModel):
    charge_time: int


class KeyBeepSettings(BaseModel):
    level: int
    lock: bool


class PrioritySettings(BaseModel):
    mode: int


class SearchSettings(BaseModel):
    delay: int
    code_search: bool


class CloseCallSettings(BaseModel):
    mode: int
    alert_beep: bool
    alert_light: bool
    band: list[bool]
    lockout: bool


class ServiceSearchSettings(BaseModel):
    groups: list[bool]


class CustomSearchSettings(BaseModel):
    groups: list[bool]


class CustomSearchRange(BaseModel):
    index: int
    lower: float
    upper: float


class WeatherSettings(BaseModel):
    priority: bool


class ContrastSettings(BaseModel):
    level: int


class FirmwareInfo(BaseModel):
    firmware: str


class ConfigSnapshot(BaseModel):
    firmware: Optional[str] = None
    backlight: Optional[BacklightSettings] = None
    battery: Optional[BatterySettings] = None
    key_beep: Optional[KeyBeepSettings] = None
    priority: Optional[PrioritySettings] = None
    search: Optional[SearchSettings] = None
    close_call: Optional[CloseCallSettings] = None
    service_search: Optional[ServiceSearchSettings] = None
    custom_search: Optional[CustomSearchSettings] = None
    custom_search_ranges: list[CustomSearchRange] = Field(default_factory=list)
    weather: Optional[WeatherSettings] = None
    contrast: Optional[ContrastSettings] = None
