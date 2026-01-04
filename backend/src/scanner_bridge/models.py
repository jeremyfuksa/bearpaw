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


@dataclass
class LiveState:
    timestamp: float
    frequency: float
    modulation: str
    squelch_open: bool
    rssi: int
    mode: str
    channel: Optional[int]
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

    model_config = {"from_attributes": True}


class LiveStateModel(BaseModel):
    timestamp: float
    frequency: float
    modulation: str
    squelch_open: bool
    rssi: int
    mode: str
    channel: Optional[int]
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


class FrequencyRequest(BaseModel):
    frequency: float
    modulation: str = "AUTO"


class KeyRequest(BaseModel):
    key: str
