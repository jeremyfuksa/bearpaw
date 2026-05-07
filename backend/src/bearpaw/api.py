from __future__ import annotations

import asyncio
import csv
import io
import logging
import os
import time
import uuid
from dataclasses import dataclass
from typing import Dict, Optional, Union

from fastapi import FastAPI, HTTPException, Request, Response, UploadFile, WebSocket
from fastapi.responses import JSONResponse, Response as StarletteResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from bearpaw.config import AppConfig
from bearpaw.discovery import discover_devices
from bearpaw.models import (
    BacklightSettings,
    BanksModel,
    BatterySettings,
    ChannelData,
    ChannelDataModel,
    ChannelLockoutClearRequest,
    ChannelUpdateModel,
    CloseCallSettings,
    ConfigSnapshot,
    ContrastSettings,
    CustomSearchRange,
    CustomSearchSettings,
    DeviceInfo,
    DeviceInfoModel,
    ErrorResponse,
    FirmwareInfo,
    KeyBeepSettings,
    KeyRequest,
    LiveState,
    LiveStateModel,
    LockoutRequest,
    PrioritySettings,
    SearchSettings,
    ServiceSearchSettings,
    SquelchRequest,
    SquelchSettings,
    VolumeRequest,
    WeatherSettings,
)
from bearpaw.protocol import BC125ATDriver, SR30CDriver
from bearpaw.scheduler import (
    CommandScheduler,
    PRIORITY_BACKGROUND,
    PRIORITY_TELEMETRY,
)
from bearpaw.state import StateStore, build_persistence
from bearpaw.sync import MemorySyncTask
from bearpaw.transport import SerialTransport
from bearpaw.transport_usb import UsbTransport
from bearpaw.websocket import WebSocketManager
from bearpaw.exporters.text_exporter import TextFileExporter
from bearpaw.exporters.json_stream import JsonEventStream
from bearpaw.exporters.mqtt import MqttExporter
from bearpaw.exporters.bc125at_ss import export_bc125at_ss
from bearpaw.analytics.database import AnalyticsDatabase
from bearpaw.preferences import PreferencesStore

logger = logging.getLogger("bearpaw")


def _set_device_diagnostic(
    device_info: DeviceInfo, code: str, message: str
) -> None:
    device_info.diagnostic_code = code
    device_info.diagnostic_message = message


def _clear_device_diagnostic(device_info: DeviceInfo) -> None:
    device_info.diagnostic_code = None
    device_info.diagnostic_message = None


async def _broadcast_device_info(runtime: "RuntimeState") -> None:
    from bearpaw.models import DeviceInfoModel as _DeviceInfoModel

    payload = _DeviceInfoModel.model_validate(runtime.device_info).model_dump()
    await runtime.ws_manager.broadcast(
        {
            "type": "device_info",
            "timestamp": time.time(),
            "data": payload,
        }
    )


def _safe_create_task(coro):
    """Create a task with error logging to prevent silent failures."""
    task = asyncio.create_task(coro)
    task.add_done_callback(
        lambda t: logger.exception("Background task failed: %s", t.exception())
        if t.exception()
        else None
    )
    return task


_NOISY_PATHS = {
    "/api/v1/status",
    "/api/v1/device/info",
    "/api/v1/lockouts",
    "/api/v1/analytics/busiest-channels",
    "/api/v1/analytics/hourly-heatmap",
    "/api/v1/analytics/session-stats",
}


@dataclass
class RuntimeState:
    config: AppConfig
    transport: Optional[Union[SerialTransport, UsbTransport]]
    scheduler: Optional[CommandScheduler]
    driver: Optional[object]
    state_store: StateStore
    ws_manager: WebSocketManager
    device_info: DeviceInfo
    session_id: str
    poller_task: Optional[asyncio.Task] = None
    sync_task: Optional[MemorySyncTask] = None
    heartbeat_task: Optional[asyncio.Task] = None
    reconnect_task: Optional[asyncio.Task] = None
    text_exporter: Optional[TextFileExporter] = None
    json_exporter: Optional[JsonEventStream] = None
    mqtt_exporter: Optional[MqttExporter] = None
    analytics_db: Optional[object] = None
    preferences_store: Optional[PreferencesStore] = None


def create_app(
    config: AppConfig,
    port_override: Optional[str] = None,
    startup_enabled: bool = True,
) -> FastAPI:
    app = FastAPI(title="Bearpaw", version="1.0.0")

    if config.api.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=config.api.cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    @app.middleware("http")
    async def request_logger(request: Request, call_next):
        start = asyncio.get_running_loop().time()
        response = await call_next(request)
        duration_ms = (asyncio.get_running_loop().time() - start) * 1000
        path = request.url.path
        if request.method == "OPTIONS":
            return response
        if path in _NOISY_PATHS or path.startswith("/api/v1/analytics/"):
            return response
        logger.info(
            "%s %s %s %.1fms",
            request.method,
            path,
            response.status_code,
            duration_ms,
        )
        return response

    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException):
        payload = ErrorResponse(
            error=str(exc.detail),
            message=str(exc.detail),
            code=exc.status_code,
        )
        return JSONResponse(status_code=exc.status_code, content=payload.model_dump())

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        logger.exception("Unhandled error: %s", exc)
        payload = ErrorResponse(
            error="internal_error",
            message="Internal server error",
            code=500,
        )
        return JSONResponse(status_code=500, content=payload.model_dump())

    async def call_or_unsupported(action, detail: str):
        try:
            return await action()
        except NotImplementedError as exc:
            raise HTTPException(status_code=400, detail=detail) from exc

    def require_driver(runtime: RuntimeState) -> object:
        if not runtime.driver or not runtime.scheduler or not runtime.transport:
            raise HTTPException(status_code=503, detail="device_disconnected")
        return runtime.driver

    async def startup() -> None:
        device_port = port_override or config.device.port
        transport: Optional[Union[SerialTransport, UsbTransport]] = None
        device_info = DeviceInfo(
            model=None,
            port=device_port,
            vid=config.device.usb_vid,
            pid=config.device.usb_pid,
            serial_number=config.device.usb_serial,
            description=None,
            connection_status="disconnected",
        )
        if config.device.transport == "usb":
            device_info.port = None
            device_info.description = "USB CDC"
            transport = UsbTransport(
                config.device.usb_vid,
                config.device.usb_pid,
                serial_number=config.device.usb_serial,
                timeout=0.5,
            )
            try:
                transport.connect()
                device_info.connection_status = "connected"
                _clear_device_diagnostic(device_info)
            except ConnectionError as exc:
                logger.warning("USB device not found: %s", exc)
                device_info.connection_status = "disconnected"
                _set_device_diagnostic(
                    device_info,
                    "usb_device_not_accessible",
                    "No accessible USB scanner endpoint found. Verify cable, USB mode, and endpoint security policy.",
                )
                transport = None
        else:
            if not device_port and config.device.auto_detect:
                try:
                    devices = discover_devices()
                except PermissionError as exc:
                    logger.warning("Serial discovery failed: %s", exc)
                    devices = []
                    _set_device_diagnostic(
                        device_info,
                        "serial_enumeration_failed",
                        str(exc),
                    )
                if devices:
                    device_port = devices[0].port
                    device_info.port = device_port
                    device_info.vid = devices[0].vid
                    device_info.pid = devices[0].pid
                    device_info.serial_number = devices[0].serial_number
                    device_info.description = devices[0].description
                    _clear_device_diagnostic(device_info)
                elif config.device.transport in ("auto", "usb"):
                    if os.getenv("NO_HARDWARE"):
                        device_info.model = "MOCK"
                        device_info.port = None
                        device_info.description = "Mock Device"
                        transport = None
                        _clear_device_diagnostic(device_info)
                    else:
                        device_info.port = None
                        device_info.description = "USB CDC"
                        transport = UsbTransport(
                            config.device.usb_vid,
                            config.device.usb_pid,
                            serial_number=config.device.usb_serial,
                            timeout=0.5,
                        )
                        try:
                            transport.connect()
                            device_info.connection_status = "connected"
                            _clear_device_diagnostic(device_info)
                        except ConnectionError as exc:
                            logger.warning(
                                "USB fallback connection failed during startup: %s",
                                exc,
                            )
                            transport = None
                            _set_device_diagnostic(
                                device_info,
                                "usb_detected_no_serial_endpoint",
                                "Scanner USB device may be present, but no usable serial endpoint is available to the app.",
                            )
                else:
                    _set_device_diagnostic(
                        device_info,
                        "no_scanner_detected",
                        "No scanner device was detected.",
                    )
            else:
                device_info.port = device_port
                device_info.vid = None
                device_info.pid = None
                device_info.serial_number = None
                device_info.description = "Serial Port"
                _clear_device_diagnostic(device_info)

            if not transport:
                if device_port:
                    transport = SerialTransport(device_port, timeout=0.5)
                    try:
                        transport.connect()
                        device_info.connection_status = "connected"
                        _clear_device_diagnostic(device_info)
                    except Exception as exc:
                        logger.warning("Serial connection failed on %s: %s", device_port, exc)
                        transport = None
                        device_info.connection_status = "disconnected"
                        _set_device_diagnostic(
                            device_info,
                            "serial_open_failed",
                            f"Unable to open scanner port {device_port}.",
                        )
                elif not os.getenv("NO_HARDWARE") and not device_info.diagnostic_code:
                    _set_device_diagnostic(
                        device_info,
                        "no_scanner_detected",
                        "No scanner device was detected.",
                    )

        scheduler: Optional[CommandScheduler] = None
        driver: Optional[object] = None
        if transport:
            try:
                scheduler = CommandScheduler(transport)
                await scheduler.start()

                model = await asyncio.wrap_future(transport.send_command("MDL"))
                model = (
                    model.split(",", 1)[1].strip() if model.startswith("MDL,") else model
                )
                driver = (
                    SR30CDriver(scheduler) if "SR30C" in model else BC125ATDriver(scheduler)
                )
                device_info.model = model.strip()
                device_info.connection_status = "connected"
                _clear_device_diagnostic(device_info)

                # Fetch firmware version if supported
                firmware_getter = getattr(driver, "get_firmware_version", None)
                if callable(firmware_getter):
                    try:
                        firmware = await firmware_getter()
                        device_info.firmware = firmware
                    except Exception as exc:
                        logger.warning("Failed to read firmware during startup: %s", exc)
                        device_info.firmware = None
            except Exception as exc:
                logger.warning("Transport initialization failed: %s", exc)
                if scheduler:
                    await scheduler.stop()
                transport.disconnect()
                transport = None
                scheduler = None
                driver = None
                device_info.connection_status = "disconnected"
                if not device_info.diagnostic_code:
                    _set_device_diagnostic(
                        device_info,
                        "transport_init_failed",
                        "Scanner transport initialized but did not respond to control commands.",
                    )

        persistence = build_persistence(config.state.persistence, config.state.db_path)
        state_store = StateStore(persistence)
        state_store.load_shadow()

        ws_manager = WebSocketManager(config.websocket)
        heartbeat_task = asyncio.create_task(ws_manager.heartbeat())

        text_exporter = None
        if config.exporters.text_file.enabled:
            text_exporter = TextFileExporter(
                config.exporters.text_file.path,
                config.exporters.text_file.template,
                config.exporters.text_file.update_on,
                config.exporters.text_file.blank_on_squelch_closed,
            )
        json_exporter = None
        if config.exporters.json_stream.enabled:
            json_exporter = JsonEventStream(
                config.exporters.json_stream.path,
                max_bytes=config.exporters.json_stream.max_bytes,
                rotate_daily=config.exporters.json_stream.rotate_daily,
            )
        mqtt_exporter = None
        if config.exporters.mqtt.enabled:
            mqtt_exporter = MqttExporter(
                config.exporters.mqtt.host,
                config.exporters.mqtt.port,
                config.exporters.mqtt.topic_prefix,
                config.exporters.mqtt.qos,
                config.exporters.mqtt.retain,
            )

        session_id = str(uuid.uuid4())
        analytics_db = None
        if config.analytics.enabled:
            analytics_db = AnalyticsDatabase(config.analytics.db_path)
            await analytics_db.initialize()

        preferences_store = PreferencesStore(config.state.db_path)

        runtime = RuntimeState(
            config=config,
            transport=transport,
            scheduler=scheduler,
            driver=driver,
            state_store=state_store,
            ws_manager=ws_manager,
            device_info=device_info,
            session_id=session_id,
            heartbeat_task=heartbeat_task,
            text_exporter=text_exporter,
            json_exporter=json_exporter,
            mqtt_exporter=mqtt_exporter,
            analytics_db=analytics_db,
            preferences_store=preferences_store,
        )
        app.state.runtime = runtime
        if runtime.driver and runtime.transport:
            await _broadcast_device_info(runtime)
            runtime.poller_task = asyncio.create_task(_poll_status(app))
        if (
            config.device.transport == "usb"
            or isinstance(runtime.transport, UsbTransport)
            or (
                runtime.transport is None and config.device.transport in ("usb", "auto")
            )
        ) and not os.getenv("NO_HARDWARE"):
            runtime.reconnect_task = asyncio.create_task(_monitor_usb(app))

    async def shutdown() -> None:
        runtime: RuntimeState = app.state.runtime
        if runtime.poller_task:
            runtime.poller_task.cancel()
        if runtime.reconnect_task:
            runtime.reconnect_task.cancel()
        if runtime.heartbeat_task:
            runtime.heartbeat_task.cancel()
        runtime.state_store.save_shadow()
        if runtime.scheduler:
            await runtime.scheduler.stop()
        if runtime.transport:
            runtime.transport.disconnect()
        if runtime.mqtt_exporter:
            runtime.mqtt_exporter.close()
        if runtime.analytics_db:
            await runtime.analytics_db.close()

    if startup_enabled:
        app.add_event_handler("startup", startup)
        app.add_event_handler("shutdown", shutdown)

    @app.get(
        "/api/v1/status",
        response_model=LiveStateModel,
        responses={503: {"model": ErrorResponse}},
    )
    async def get_status() -> LiveStateModel:
        runtime: RuntimeState = app.state.runtime
        return LiveStateModel.model_validate(runtime.state_store.get_live_state())

    @app.get("/api/v1/health")
    async def health() -> Dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/v1/device/info", response_model=DeviceInfoModel)
    async def get_device_info() -> DeviceInfoModel:
        runtime: RuntimeState = app.state.runtime
        return DeviceInfoModel.model_validate(runtime.device_info)

    @app.get("/api/v1/banks", response_model=BanksModel)
    async def get_banks() -> BanksModel:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        banks = await driver.get_banks()
        return BanksModel(banks=banks)

    @app.post("/api/v1/banks", response_model=BanksModel)
    async def set_banks(payload: BanksModel) -> BanksModel:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        if len(payload.banks) != 10:
            raise HTTPException(status_code=400, detail="banks_length_invalid")
        await driver.set_banks(payload.banks)
        return BanksModel(banks=payload.banks)

    @app.post("/api/v1/commands/hold")
    async def hold_command() -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        ok = await driver.send_hold()
        if not ok:
            detail = getattr(driver, "last_error", None) or "hold_failed"
            logger.warning("Hold command failed: %s", detail)
            raise HTTPException(status_code=500, detail=detail)
        return {"status": "ok"}

    @app.post("/api/v1/commands/scan")
    async def scan_command() -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        ok = await driver.send_scan()
        if not ok:
            detail = getattr(driver, "last_error", None) or "scan_failed"
            logger.warning("Scan command failed: %s", detail)
            raise HTTPException(status_code=500, detail=detail)
        return {"status": "ok"}

    @app.post("/api/v1/commands/key")
    async def key_command(request: KeyRequest) -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        ok = await driver.send_key(request.key)
        if not ok:
            detail = getattr(driver, "last_error", None) or "key_failed"
            logger.warning("Key command failed (%s): %s", request.key, detail)
            raise HTTPException(status_code=500, detail=detail)
        return {"status": "ok"}

    @app.post("/api/v1/commands/lockout")
    async def toggle_lockout(request: LockoutRequest) -> dict:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        mode = request.mode.lower()
        logger.info("Lockout request mode=%s", mode)

        async def _resume_scan_with_retry() -> None:
            await asyncio.sleep(1.0)
            ok = await driver.send_scan()
            if not ok:
                detail = getattr(driver, "last_error", None) or "scan_failed"
                logger.warning("Auto-resume scan failed: %s", detail)
                return
            await asyncio.sleep(0.6)
            ok = await driver.send_scan()
            if not ok:
                detail = getattr(driver, "last_error", None) or "scan_failed"
                logger.warning("Auto-resume scan retry failed: %s", detail)
            try:
                await asyncio.sleep(0.8)
                status = await driver.get_status()
            except Exception as exc:
                logger.warning("Auto-resume scan status check failed: %s", exc)
                return
            if (status.mode or "").upper() != "SCAN":
                logger.warning("Auto-resume scan failed after retries: %s", status.mode)

        if mode == "temporary":
            live_state = runtime.state_store.get_live_state()
            channel_id = request.channel or live_state.channel
            if not channel_id:
                raise HTTPException(status_code=400, detail="channel_required")
            set_lock = getattr(driver, "set_channel_lockout", None)
            if not callable(set_lock):
                raise HTTPException(status_code=400, detail="lockout_unsupported")
            try:
                temporary = runtime.state_store.get_temporary_lockouts()
                if channel_id in temporary:
                    updated = await set_lock(channel_id, False)
                    runtime.state_store.set_shadow_channel(updated)
                    runtime.state_store.clear_temporary_lockout(channel_id)
                    locked = False
                else:
                    updated = await set_lock(channel_id, True)
                    runtime.state_store.set_shadow_channel(updated)
                    runtime.state_store.toggle_temporary_lockout(
                        channel_id, updated.frequency
                    )
                    locked = True
            except Exception as exc:
                detail = str(exc) or "lockout_failed"
                logger.warning("Temporary lockout failed: %s", detail)
                raise HTTPException(status_code=500, detail=detail) from exc
            asyncio.create_task(_resume_scan_with_retry())
            return {
                "mode": "temporary",
                "channel": channel_id,
                "frequency": live_state.frequency,
                "locked": locked,
            }
        if mode == "permanent":
            live_state = runtime.state_store.get_live_state()
            channel_id = request.channel or live_state.channel
            if not channel_id:
                raise HTTPException(status_code=400, detail="channel_required")
            toggle = getattr(driver, "toggle_channel_lockout", None)
            if not callable(toggle):
                raise HTTPException(status_code=400, detail="lockout_unsupported")
            try:
                updated = await toggle(channel_id)
            except Exception as exc:
                detail = str(exc) or "lockout_failed"
                logger.warning("Lockout toggle failed: %s", detail)
                raise HTTPException(status_code=500, detail=detail) from exc
            runtime.state_store.set_shadow_channel(updated)
            runtime.state_store.clear_temporary_lockout(updated.index)
            asyncio.create_task(_resume_scan_with_retry())
            return {
                "mode": "permanent",
                "channel": ChannelDataModel.model_validate(updated),
            }
        raise HTTPException(status_code=400, detail="invalid_lockout_mode")

    @app.post("/api/v1/lockouts/temporary/clear")
    async def clear_temporary_lockouts() -> dict:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        set_lock = getattr(driver, "set_channel_lockout", None)
        if not callable(set_lock):
            raise HTTPException(status_code=400, detail="lockout_unsupported")
        cleared = runtime.state_store.clear_temporary_lockouts()
        cleared_list: list[int] = []
        failed_list: list[int] = []
        for channel_id, _frequency in sorted(cleared.items()):
            try:
                updated = await set_lock(channel_id, False)
                runtime.state_store.set_shadow_channel(updated)
                if not updated.lockout:
                    cleared_list.append(channel_id)
                else:
                    failed_list.append(channel_id)
            except Exception as exc:
                failed_list.append(channel_id)
                runtime.state_store.toggle_temporary_lockout(channel_id, _frequency)
                logger.warning(
                    "Failed to clear temporary lockout %s: %s", channel_id, exc
                )
        return {"cleared": cleared_list, "failed": failed_list}

    @app.post("/api/v1/lockouts/clear")
    async def clear_global_lockouts() -> dict:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        getter = getattr(driver, "get_frequency_lockouts", None)
        set_lock = getattr(driver, "set_frequency_lockout", None)
        if not callable(getter) or not callable(set_lock):
            raise HTTPException(status_code=400, detail="lockout_unsupported")
        try:
            raw_list = await getter()
        except Exception as exc:
            logger.warning("Failed to list lockouts: %s", exc)
            raise HTTPException(status_code=500, detail="lockout_failed") from exc
        cleared_list: list[float] = []
        failed_list: list[float] = []
        for raw in raw_list:
            frequency = raw / 10000.0 if raw > 0 else 0.0
            try:
                await set_lock(raw, False)
                if frequency > 0:
                    cleared_list.append(frequency)
            except Exception as exc:
                if frequency > 0:
                    failed_list.append(frequency)
                logger.warning("Failed to clear global lockout %s: %s", raw, exc)
        return {"cleared": cleared_list, "failed": failed_list}

    @app.post("/api/v1/lockouts/channels/clear")
    async def clear_channel_lockouts(request: ChannelLockoutClearRequest) -> dict:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        setter = getattr(driver, "set_channel_lockout", None)
        if not callable(setter):
            raise HTTPException(status_code=400, detail="lockout_unsupported")
        channels = runtime.state_store.get_shadow_channels()
        if request.channels is not None and len(request.channels) > 0:
            locked_ids = sorted(
                [
                    chan_id
                    for chan_id in request.channels
                    if channels.get(chan_id) and channels[chan_id].lockout
                ]
            )
        else:
            locked_ids = sorted(
                [chan.index for chan in channels.values() if chan.lockout]
            )
        cleared_list: list[int] = []
        failed_list: list[int] = []
        for channel_id in locked_ids:
            try:
                updated = await setter(channel_id, False)
                runtime.state_store.set_shadow_channel(updated)
                if not updated.lockout:
                    cleared_list.append(channel_id)
                else:
                    failed_list.append(channel_id)
            except Exception as exc:
                failed_list.append(channel_id)
                logger.warning(
                    "Failed to clear channel lockout %s: %s", channel_id, exc
                )
        return {"cleared": cleared_list, "failed": failed_list}

    @app.get("/api/v1/lockouts")
    async def list_lockouts(include_frequencies: bool = True) -> dict:
        runtime: RuntimeState = app.state.runtime
        raw: list[int] = []
        if include_frequencies:
            driver = require_driver(runtime)
            getter = getattr(driver, "get_frequency_lockouts", None)
            if not callable(getter):
                raise HTTPException(status_code=400, detail="lockout_unsupported")
            try:
                raw = await getter()
            except Exception as exc:
                logger.warning("Failed to list lockouts: %s", exc)
                raise HTTPException(status_code=500, detail="lockout_failed") from exc
        channels = runtime.state_store.get_shadow_channels()
        locked_channels = sorted(
            [chan.index for chan in channels.values() if chan.lockout]
        )
        temporary_lockouts = runtime.state_store.get_temporary_lockouts()
        return {
            "frequencies": [value / 10000.0 for value in raw],
            "channels": locked_channels,
            "temporary_channels": [
                {"channel": channel_id, "frequency": frequency}
                for channel_id, frequency in sorted(temporary_lockouts.items())
            ],
        }

    @app.get("/api/v1/lockouts/{frequency}")
    async def get_lockout_status(frequency: float) -> dict:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        checker = getattr(driver, "_is_frequency_locked", None)
        if not callable(checker):
            raise HTTPException(status_code=400, detail="lockout_unsupported")
        raw = int(round(frequency * 10000))
        try:
            locked = await checker(raw)
        except Exception as exc:
            logger.warning("Failed to check lockout: %s", exc)
            raise HTTPException(status_code=500, detail="lockout_failed") from exc
        return {"frequency": frequency, "locked": locked}

    @app.post("/api/v1/volume")
    async def set_volume(request: VolumeRequest) -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        set_volume = getattr(driver, "set_volume", None)
        if not callable(set_volume):
            raise HTTPException(status_code=400, detail="volume_unsupported")
        try:
            ok = await set_volume(request.volume)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not ok:
            detail = getattr(driver, "last_error", None) or "volume_failed"
            logger.warning("Volume command failed: %s", detail)
            raise HTTPException(status_code=500, detail=detail)
        return {"status": "ok"}

    @app.get("/api/v1/squelch")
    async def get_squelch() -> Dict[str, int]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        get_squelch = getattr(driver, "get_squelch", None)
        if not callable(get_squelch):
            raise HTTPException(status_code=400, detail="squelch_unsupported")
        try:
            level = await get_squelch()
        except Exception as exc:
            logger.warning("Get squelch failed: %s", exc)
            raise HTTPException(status_code=500, detail="squelch_failed") from exc
        return {"level": level}

    @app.post("/api/v1/squelch")
    async def set_squelch(request: SquelchRequest) -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        set_squelch = getattr(driver, "set_squelch", None)
        if not callable(set_squelch):
            raise HTTPException(status_code=400, detail="squelch_unsupported")
        try:
            ok = await set_squelch(request.level)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not ok:
            detail = getattr(driver, "last_error", None) or "squelch_failed"
            logger.warning("Squelch command failed: %s", detail)
            raise HTTPException(status_code=500, detail=detail)
        return {"status": "ok"}

    @app.get("/api/v1/config", response_model=ConfigSnapshot)
    async def get_config_snapshot() -> ConfigSnapshot:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        getter = getattr(driver, "get_settings_snapshot", None)
        if not callable(getter):
            raise HTTPException(status_code=400, detail="config_unsupported")
        firmware_getter = getattr(driver, "get_firmware_version", None)
        firmware = None
        if callable(firmware_getter):
            try:
                firmware = await call_or_unsupported(
                    firmware_getter, "firmware_unsupported"
                )
            except Exception as exc:
                logger.warning("Failed to read firmware: %s", exc)
        settings = await call_or_unsupported(getter, "config_unsupported")
        return ConfigSnapshot(
            firmware=firmware,
            squelch=SquelchSettings(level=settings.get("squelch", 0)),
            backlight=BacklightSettings(event=settings.get("backlight", "")),
            battery=BatterySettings(charge_time=settings.get("battery", 0)),
            key_beep=KeyBeepSettings(
                level=settings.get("key_beep", (0, False))[0],
                lock=settings.get("key_beep", (0, False))[1],
            ),
            priority=PrioritySettings(mode=settings.get("priority", 0)),
            search=SearchSettings(
                delay=settings.get("search", (0, False))[0],
                code_search=settings.get("search", (0, False))[1],
            ),
            close_call=CloseCallSettings(
                mode=settings.get("close_call", (0, False, False, [False] * 5, False))[
                    0
                ],
                alert_beep=settings.get(
                    "close_call", (0, False, False, [False] * 5, False)
                )[1],
                alert_light=settings.get(
                    "close_call", (0, False, False, [False] * 5, False)
                )[2],
                band=settings.get("close_call", (0, False, False, [False] * 5, False))[
                    3
                ],
                lockout=settings.get(
                    "close_call", (0, False, False, [False] * 5, False)
                )[4],
            ),
            service_search=ServiceSearchSettings(
                groups=settings.get("service_search", [])
            ),
            custom_search=CustomSearchSettings(
                groups=settings.get("custom_search", [])
            ),
            custom_search_ranges=[
                CustomSearchRange(index=idx + 1, lower=vals[0], upper=vals[1])
                for idx, vals in enumerate(settings.get("custom_search_ranges", []))
            ],
            weather=WeatherSettings(priority=settings.get("weather", False)),
            contrast=ContrastSettings(level=settings.get("contrast", 0)),
        )

    @app.get("/api/v1/settings/firmware", response_model=FirmwareInfo)
    async def get_firmware() -> FirmwareInfo:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        getter = getattr(driver, "get_firmware_version", None)
        if not callable(getter):
            raise HTTPException(status_code=400, detail="firmware_unsupported")
        firmware = await call_or_unsupported(getter, "firmware_unsupported")
        return FirmwareInfo(firmware=firmware)

    @app.get("/api/v1/settings/all", response_model=ConfigSnapshot)
    async def get_all_settings() -> ConfigSnapshot:
        """Bulk endpoint that reads all device settings in a single program mode session."""
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)

        # Get firmware (doesn't require program mode)
        firmware_getter = getattr(driver, "get_firmware_version", None)
        firmware = None
        if callable(firmware_getter):
            try:
                firmware = await call_or_unsupported(
                    firmware_getter, "firmware_unsupported"
                )
            except Exception as exc:
                logger.warning("Failed to read firmware: %s", exc)

        # Get all settings using existing snapshot method
        # (enters program mode once and reads all settings including squelch)
        snapshot_getter = getattr(driver, "get_settings_snapshot", None)
        if not callable(snapshot_getter):
            raise HTTPException(status_code=400, detail="settings_snapshot_unsupported")

        try:
            settings = await call_or_unsupported(snapshot_getter, "config_unsupported")
        except HTTPException:
            raise
        except Exception as exc:
            logger.error("Failed to read device settings: %s", exc)
            raise HTTPException(status_code=500, detail="config_read_failed") from exc

        # Build the config snapshot
        return ConfigSnapshot(
            firmware=firmware,
            squelch=SquelchSettings(level=settings.get("squelch", 0)),
            backlight=BacklightSettings(event=settings.get("backlight", "")),
            battery=BatterySettings(charge_time=settings.get("battery", 0)),
            key_beep=KeyBeepSettings(
                level=settings.get("key_beep", (0, False))[0],
                lock=settings.get("key_beep", (0, False))[1],
            ),
            priority=PrioritySettings(mode=settings.get("priority", 0)),
            search=SearchSettings(
                delay=settings.get("search", (0, False))[0],
                code_search=settings.get("search", (0, False))[1],
            ),
            close_call=CloseCallSettings(
                mode=settings.get("close_call", (0, False, False, [False] * 5, False))[
                    0
                ],
                alert_beep=settings.get(
                    "close_call", (0, False, False, [False] * 5, False)
                )[1],
                alert_light=settings.get(
                    "close_call", (0, False, False, [False] * 5, False)
                )[2],
                band=settings.get("close_call", (0, False, False, [False] * 5, False))[
                    3
                ],
                lockout=settings.get(
                    "close_call", (0, False, False, [False] * 5, False)
                )[4],
            ),
            service_search=ServiceSearchSettings(
                groups=settings.get("service_search", [])
            ),
            custom_search=CustomSearchSettings(
                groups=settings.get("custom_search", [])
            ),
            custom_search_ranges=[
                CustomSearchRange(index=idx + 1, lower=vals[0], upper=vals[1])
                for idx, vals in enumerate(settings.get("custom_search_ranges", []))
            ],
            weather=WeatherSettings(priority=settings.get("weather", False)),
            contrast=ContrastSettings(level=settings.get("contrast", 0)),
        )

    @app.get("/api/v1/settings/backlight", response_model=BacklightSettings)
    async def get_backlight() -> BacklightSettings:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        getter = getattr(driver, "get_backlight", None)
        if not callable(getter):
            raise HTTPException(status_code=400, detail="backlight_unsupported")
        event = await call_or_unsupported(getter, "backlight_unsupported")
        return BacklightSettings(event=event)

    @app.post("/api/v1/settings/backlight")
    async def set_backlight(request: BacklightSettings) -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        setter = getattr(driver, "set_backlight", None)
        if not callable(setter):
            raise HTTPException(status_code=400, detail="backlight_unsupported")
        try:
            ok = await call_or_unsupported(
                lambda: setter(request.event), "backlight_unsupported"
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not ok:
            raise HTTPException(status_code=500, detail="backlight_failed")
        return {"status": "ok"}

    @app.get("/api/v1/settings/battery", response_model=BatterySettings)
    async def get_battery_charge_time() -> BatterySettings:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        getter = getattr(driver, "get_battery_charge_time", None)
        if not callable(getter):
            raise HTTPException(status_code=400, detail="battery_unsupported")
        value = await call_or_unsupported(getter, "battery_unsupported")
        return BatterySettings(charge_time=value)

    @app.post("/api/v1/settings/battery")
    async def set_battery_charge_time(request: BatterySettings) -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        setter = getattr(driver, "set_battery_charge_time", None)
        if not callable(setter):
            raise HTTPException(status_code=400, detail="battery_unsupported")
        try:
            ok = await call_or_unsupported(
                lambda: setter(request.charge_time), "battery_unsupported"
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not ok:
            raise HTTPException(status_code=500, detail="battery_failed")
        return {"status": "ok"}

    @app.get("/api/v1/settings/key-beep", response_model=KeyBeepSettings)
    async def get_key_beep() -> KeyBeepSettings:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        getter = getattr(driver, "get_key_beep_settings", None)
        if not callable(getter):
            raise HTTPException(status_code=400, detail="key_beep_unsupported")
        level, lock = await call_or_unsupported(getter, "key_beep_unsupported")
        return KeyBeepSettings(level=level, lock=lock)

    @app.post("/api/v1/settings/key-beep")
    async def set_key_beep(request: KeyBeepSettings) -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        setter = getattr(driver, "set_key_beep_settings", None)
        if not callable(setter):
            raise HTTPException(status_code=400, detail="key_beep_unsupported")
        try:
            ok = await call_or_unsupported(
                lambda: setter(request.level, request.lock), "key_beep_unsupported"
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not ok:
            raise HTTPException(status_code=500, detail="key_beep_failed")
        return {"status": "ok"}

    @app.get("/api/v1/settings/priority", response_model=PrioritySettings)
    async def get_priority_mode() -> PrioritySettings:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        getter = getattr(driver, "get_priority_mode", None)
        if not callable(getter):
            raise HTTPException(status_code=400, detail="priority_unsupported")
        mode = await call_or_unsupported(getter, "priority_unsupported")
        return PrioritySettings(mode=mode)

    @app.post("/api/v1/settings/priority")
    async def set_priority_mode(request: PrioritySettings) -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        setter = getattr(driver, "set_priority_mode", None)
        if not callable(setter):
            raise HTTPException(status_code=400, detail="priority_unsupported")
        try:
            ok = await call_or_unsupported(
                lambda: setter(request.mode), "priority_unsupported"
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not ok:
            raise HTTPException(status_code=500, detail="priority_failed")
        return {"status": "ok"}

    @app.get("/api/v1/settings/search", response_model=SearchSettings)
    async def get_search_settings() -> SearchSettings:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        getter = getattr(driver, "get_search_settings", None)
        if not callable(getter):
            raise HTTPException(status_code=400, detail="search_unsupported")
        delay, code_search = await call_or_unsupported(getter, "search_unsupported")
        return SearchSettings(delay=delay, code_search=code_search)

    @app.post("/api/v1/settings/search")
    async def set_search_settings(request: SearchSettings) -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        setter = getattr(driver, "set_search_settings", None)
        if not callable(setter):
            raise HTTPException(status_code=400, detail="search_unsupported")
        try:
            ok = await call_or_unsupported(
                lambda: setter(request.delay, request.code_search), "search_unsupported"
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not ok:
            raise HTTPException(status_code=500, detail="search_failed")
        return {"status": "ok"}

    @app.get("/api/v1/settings/close-call", response_model=CloseCallSettings)
    async def get_close_call_settings() -> CloseCallSettings:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        getter = getattr(driver, "get_close_call_settings", None)
        if not callable(getter):
            raise HTTPException(status_code=400, detail="close_call_unsupported")
        mode, alert_beep, alert_light, band, lockout = await call_or_unsupported(
            getter, "close_call_unsupported"
        )
        return CloseCallSettings(
            mode=mode,
            alert_beep=alert_beep,
            alert_light=alert_light,
            band=band,
            lockout=lockout,
        )

    @app.post("/api/v1/settings/close-call")
    async def set_close_call_settings(request: CloseCallSettings) -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        setter = getattr(driver, "set_close_call_settings", None)
        if not callable(setter):
            raise HTTPException(status_code=400, detail="close_call_unsupported")
        try:
            ok = await call_or_unsupported(
                lambda: setter(
                    request.mode,
                    request.alert_beep,
                    request.alert_light,
                    request.band,
                    request.lockout,
                ),
                "close_call_unsupported",
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not ok:
            raise HTTPException(status_code=500, detail="close_call_failed")
        return {"status": "ok"}

    @app.get("/api/v1/settings/service-search", response_model=ServiceSearchSettings)
    async def get_service_search() -> ServiceSearchSettings:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        getter = getattr(driver, "get_service_search_groups", None)
        if not callable(getter):
            raise HTTPException(status_code=400, detail="service_search_unsupported")
        groups = await call_or_unsupported(getter, "service_search_unsupported")
        return ServiceSearchSettings(groups=groups)

    @app.post("/api/v1/settings/service-search")
    async def set_service_search(request: ServiceSearchSettings) -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        setter = getattr(driver, "set_service_search_groups", None)
        if not callable(setter):
            raise HTTPException(status_code=400, detail="service_search_unsupported")
        try:
            ok = await call_or_unsupported(
                lambda: setter(request.groups), "service_search_unsupported"
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not ok:
            raise HTTPException(status_code=500, detail="service_search_failed")
        return {"status": "ok"}

    @app.get("/api/v1/settings/custom-search", response_model=CustomSearchSettings)
    async def get_custom_search() -> CustomSearchSettings:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        getter = getattr(driver, "get_custom_search_groups", None)
        if not callable(getter):
            raise HTTPException(status_code=400, detail="custom_search_unsupported")
        groups = await call_or_unsupported(getter, "custom_search_unsupported")
        return CustomSearchSettings(groups=groups)

    @app.post("/api/v1/settings/custom-search")
    async def set_custom_search(request: CustomSearchSettings) -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        setter = getattr(driver, "set_custom_search_groups", None)
        if not callable(setter):
            raise HTTPException(status_code=400, detail="custom_search_unsupported")
        try:
            ok = await call_or_unsupported(
                lambda: setter(request.groups), "custom_search_unsupported"
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not ok:
            raise HTTPException(status_code=500, detail="custom_search_failed")
        return {"status": "ok"}

    @app.get(
        "/api/v1/settings/custom-search/ranges/{index}",
        response_model=CustomSearchRange,
    )
    async def get_custom_search_range(index: int) -> CustomSearchRange:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        getter = getattr(driver, "get_custom_search_range", None)
        if not callable(getter):
            raise HTTPException(
                status_code=400, detail="custom_search_range_unsupported"
            )
        lower, upper = await call_or_unsupported(
            lambda: getter(index), "custom_search_range_unsupported"
        )
        return CustomSearchRange(index=index, lower=lower, upper=upper)

    @app.post("/api/v1/settings/custom-search/ranges/{index}")
    async def set_custom_search_range(
        index: int, request: CustomSearchRange
    ) -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        setter = getattr(driver, "set_custom_search_range", None)
        if not callable(setter):
            raise HTTPException(
                status_code=400, detail="custom_search_range_unsupported"
            )
        try:
            ok = await call_or_unsupported(
                lambda: setter(index, request.lower, request.upper),
                "custom_search_range_unsupported",
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not ok:
            raise HTTPException(status_code=500, detail="custom_search_range_failed")
        return {"status": "ok"}

    @app.get("/api/v1/settings/weather", response_model=WeatherSettings)
    async def get_weather_settings() -> WeatherSettings:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        getter = getattr(driver, "get_weather_priority", None)
        if not callable(getter):
            raise HTTPException(status_code=400, detail="weather_unsupported")
        priority = await call_or_unsupported(getter, "weather_unsupported")
        return WeatherSettings(priority=priority)

    @app.post("/api/v1/settings/weather")
    async def set_weather_settings(request: WeatherSettings) -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        setter = getattr(driver, "set_weather_priority", None)
        if not callable(setter):
            raise HTTPException(status_code=400, detail="weather_unsupported")
        ok = await call_or_unsupported(
            lambda: setter(request.priority), "weather_unsupported"
        )
        if not ok:
            raise HTTPException(status_code=500, detail="weather_failed")
        return {"status": "ok"}

    @app.get("/api/v1/settings/contrast", response_model=ContrastSettings)
    async def get_contrast() -> ContrastSettings:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        getter = getattr(driver, "get_contrast", None)
        if not callable(getter):
            raise HTTPException(status_code=400, detail="contrast_unsupported")
        level = await call_or_unsupported(getter, "contrast_unsupported")
        return ContrastSettings(level=level)

    @app.post("/api/v1/settings/contrast")
    async def set_contrast(request: ContrastSettings) -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        setter = getattr(driver, "set_contrast", None)
        if not callable(setter):
            raise HTTPException(status_code=400, detail="contrast_unsupported")
        try:
            ok = await call_or_unsupported(
                lambda: setter(request.level), "contrast_unsupported"
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not ok:
            raise HTTPException(status_code=500, detail="contrast_failed")
        return {"status": "ok"}

    @app.get("/api/v1/memory/channels", response_model=list[ChannelDataModel])
    async def list_channels(bank: Optional[int] = None) -> list[ChannelDataModel]:
        runtime: RuntimeState = app.state.runtime
        channels = runtime.state_store.get_shadow_channels(bank)
        return [ChannelDataModel.model_validate(chan) for chan in channels.values()]

    @app.get("/api/v1/memory/channels/{channel_id}", response_model=ChannelDataModel)
    async def get_channel(channel_id: int) -> ChannelDataModel:
        runtime: RuntimeState = app.state.runtime
        channel = runtime.state_store.get_shadow_channel(channel_id)
        if not channel:
            raise HTTPException(status_code=404, detail="not_found")
        return ChannelDataModel.model_validate(channel)

    @app.put("/api/v1/memory/channels/{channel_id}", response_model=ChannelDataModel)
    async def update_channel(
        channel_id: int, request: ChannelUpdateModel
    ) -> ChannelDataModel:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        if channel_id < 1 or channel_id > 500:
            raise HTTPException(status_code=400, detail="channel_out_of_range")
        if request.delay < 0 or request.delay > 30:
            raise HTTPException(status_code=400, detail="delay_out_of_range")
        if request.bank < 0 or request.bank > 10:
            raise HTTPException(status_code=400, detail="bank_out_of_range")
        if len(request.alpha_tag) > 16:
            raise HTTPException(status_code=400, detail="alpha_tag_too_long")
        setter = getattr(driver, "set_channel", None)
        if not callable(setter):
            raise HTTPException(status_code=400, detail="channel_write_unsupported")
        payload = ChannelData(
            index=channel_id,
            frequency=request.frequency,
            modulation=request.modulation,
            alpha_tag=request.alpha_tag,
            delay=request.delay,
            lockout=request.lockout,
            priority=request.priority,
            tone_squelch=request.tone_squelch,
            bank=request.bank,
        )
        try:
            updated = await call_or_unsupported(
                lambda: setter(payload), "channel_write_unsupported"
            )
            runtime.state_store.set_shadow_channel(updated)
            runtime.state_store.save_shadow()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return ChannelDataModel.model_validate(updated)

    class MemorySyncRequest(BaseModel):
        force: bool = False

    @app.post("/api/v1/memory/sync")
    async def memory_sync(
        request: Optional[MemorySyncRequest] = None, force: bool = False
    ) -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        if request and request.force:
            force = True
        if runtime.sync_task:
            return {"status": "already_running", "task_id": runtime.sync_task.task_id}
        task = MemorySyncTask(driver, runtime.state_store, runtime.ws_manager)
        runtime.sync_task = task
        asyncio.create_task(_run_sync(app, task))
        return {"status": "started", "task_id": task.task_id}

    @app.post("/api/v1/memory/program-mode/start")
    async def program_mode_start() -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        if runtime.sync_task:
            raise HTTPException(status_code=409, detail="sync_in_progress")
        begin_sync = getattr(driver, "begin_memory_sync", None)
        if not callable(begin_sync):
            raise HTTPException(status_code=400, detail="program_mode_unsupported")
        await begin_sync()
        return {"status": "ok"}

    @app.post("/api/v1/memory/program-mode/end")
    async def program_mode_end() -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        end_sync = getattr(driver, "end_memory_sync", None)
        if not callable(end_sync):
            raise HTTPException(status_code=400, detail="program_mode_unsupported")
        await end_sync()
        return {"status": "ok"}

    @app.post("/api/v1/memory/sync/cancel")
    async def memory_sync_cancel() -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        if not runtime.sync_task:
            return {"status": "no_task"}
        runtime.sync_task.cancel()
        return {"status": "cancelling", "task_id": runtime.sync_task.task_id}

    @app.get("/api/v1/memory/export/bc125at_ss")
    async def export_bc125at_ss_file() -> Response:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        if not isinstance(driver, BC125ATDriver):
            raise HTTPException(status_code=400, detail="unsupported_model")
        if runtime.sync_task:
            raise HTTPException(status_code=409, detail="sync_in_progress")
        region = "USA"
        if runtime.device_info.model and "UBC" in runtime.device_info.model:
            region = "EUR"
        payload = await export_bc125at_ss(driver, region=region)
        headers = {"Content-Disposition": "attachment; filename=scanner.bc125at_ss"}
        return Response(content=payload, media_type="text/plain", headers=headers)

    @app.get("/api/v1/memory/export/csv")
    async def export_csv() -> Response:
        runtime: RuntimeState = app.state.runtime
        channels = runtime.state_store.get_shadow_channels()
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(
            [
                "Index",
                "Frequency",
                "Modulation",
                "Alpha Tag",
                "Delay",
                "Lockout",
                "Priority",
                "CTCSS/DCS",
                "Bank",
            ]
        )
        for idx, ch in sorted(channels.items()):
            writer.writerow(
                [
                    idx,
                    ch.frequency,
                    ch.modulation,
                    ch.alpha_tag,
                    ch.delay,
                    ch.lockout,
                    ch.priority,
                    ch.tone_squelch if ch.tone_squelch else "",
                    ch.bank,
                ]
            )
        headers = {"Content-Disposition": "attachment; filename=channels.csv"}
        return Response(
            content=output.getvalue(), media_type="text/csv", headers=headers
        )

    @app.post("/api/v1/memory/import/csv")
    async def import_csv(file: UploadFile) -> dict:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        content = await file.read()
        reader = csv.DictReader(io.StringIO(content.decode()))

        errors = []
        imported = 0
        for row in reader:
            try:
                idx = int(row.get("Index", 0))
                if idx < 1 or idx > 500:
                    raise ValueError(f"Invalid channel index: {idx} (must be 1-500)")

                frequency = float(row.get("Frequency", 0))
                if frequency < 25 or frequency > 1300:
                    raise ValueError(f"Invalid frequency: {frequency}")

                delay = int(row.get("Delay", 2))
                if delay < 0 or delay > 30:
                    raise ValueError(f"Invalid delay: {delay}")

                lockout = str(row.get("Lockout", "")).lower() == "true"
                priority = str(row.get("Priority", "")).lower() == "true"

                tone_str = row.get("CTCSS/DCS", "")
                tone_squelch = None
                if tone_str and tone_str.strip():
                    tone_squelch = float(tone_str)

                bank = int(row.get("Bank", 1))
                if bank < 1 or bank > 10:
                    raise ValueError(f"Invalid bank: {bank}")

                payload = ChannelData(
                    index=idx,
                    frequency=frequency,
                    modulation=row.get("Modulation", "FM").upper(),
                    alpha_tag=row.get("Alpha Tag", ""),
                    delay=delay,
                    lockout=lockout,
                    priority=priority,
                    tone_squelch=tone_squelch,
                    bank=bank,
                )

                setter = getattr(driver, "set_channel", None)
                if not callable(setter):
                    raise HTTPException(
                        status_code=400, detail="channel_write_unsupported"
                    )

                await setter(payload)
                runtime.state_store.set_shadow_channel(payload)
                imported += 1
            except Exception as exc:
                errors.append({"row": row, "error": str(exc)})

        runtime.state_store.save_shadow()
        return {"imported": imported, "errors": errors}

    @app.get("/api/v1/preferences")
    async def get_preferences() -> JSONResponse:
        runtime: RuntimeState = app.state.runtime
        try:
            if not runtime.preferences_store:
                logger.error("Preferences store is None - not configured")
                raise HTTPException(
                    status_code=503, detail="preferences_not_configured"
                )
            return JSONResponse(content=runtime.preferences_store.get_all())
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("Error loading preferences: %s", exc)
            raise HTTPException(status_code=500, detail="internal_error")

    @app.get("/api/v1/preferences/{key}")
    async def get_preference(key: str) -> JSONResponse:
        runtime: RuntimeState = app.state.runtime
        try:
            if not runtime.preferences_store:
                logger.error("Preferences store is None - not configured")
                raise HTTPException(
                    status_code=503, detail="preferences_not_configured"
                )
            value = runtime.preferences_store.get(key)
            if value is None:
                raise HTTPException(
                    status_code=404, detail=f"Unknown preference: {key}"
                )
            return JSONResponse(content={"key": key, "value": value})
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("Error loading preference %s: %s", key, exc)
            raise HTTPException(status_code=500, detail="internal_error")

    @app.get("/api/v1/preferences/{key}")
    async def get_preference(key: str) -> Dict[str, Any]:
        runtime: RuntimeState = app.state.runtime
        if not runtime.preferences_store:
            raise HTTPException(status_code=503, detail="preferences_not_configured")
        value = runtime.preferences_store.get(key)
        if value is None:
            raise HTTPException(status_code=404, detail=f"Unknown preference: {key}")
        return {"key": key, "value": value}

    @app.put("/api/v1/preferences/{key}")
    async def set_preference(key: str, request: Dict[str, Any]) -> Dict[str, Any]:
        runtime: RuntimeState = app.state.runtime
        if not runtime.preferences_store:
            raise HTTPException(status_code=503, detail="preferences_not_configured")
        if "value" not in request:
            raise HTTPException(status_code=400, detail="value_required")
        runtime.preferences_store.set(key, request["value"])
        return {"key": key, "value": request["value"]}

    @app.put("/api/v1/preferences")
    async def set_preferences(request: Dict[str, Any]) -> JSONResponse:
        runtime: RuntimeState = app.state.runtime
        try:
            if not runtime.preferences_store:
                logger.error("Preferences store is None - not configured")
                raise HTTPException(
                    status_code=503, detail="preferences_not_configured"
                )
            runtime.preferences_store.set_multiple(request)

            mqtt_keys = {
                "mqtt_enabled",
                "mqtt_host",
                "mqtt_port",
                "mqtt_topic_prefix",
                "mqtt_qos",
                "mqtt_retain",
            }
            if mqtt_keys.intersection(request.keys()):
                if runtime.mqtt_exporter:
                    runtime.mqtt_exporter.close()
                mqtt_enabled = runtime.preferences_store.get("mqtt_enabled")
                if mqtt_enabled:
                    runtime.mqtt_exporter = MqttExporter(
                        runtime.preferences_store.get("mqtt_host"),
                        runtime.preferences_store.get("mqtt_port"),
                        runtime.preferences_store.get("mqtt_topic_prefix"),
                        runtime.preferences_store.get("mqtt_qos"),
                        runtime.preferences_store.get("mqtt_retain"),
                    )
                else:
                    runtime.mqtt_exporter = None

            return JSONResponse(content=runtime.preferences_store.get_all())
        except Exception as exc:
            logger.exception("Error saving preferences: %s", exc)
            raise HTTPException(status_code=500, detail="internal_error")

    @app.post("/api/v1/preferences/reset")
    async def reset_preferences() -> Dict[str, Any]:
        runtime: RuntimeState = app.state.runtime
        if not runtime.preferences_store:
            raise HTTPException(status_code=503, detail="preferences_not_configured")
        return runtime.preferences_store.reset()

    @app.get("/api/v1/debug/glg")
    async def debug_glg() -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        get_glg = getattr(driver, "get_glg_status", None)
        if not callable(get_glg):
            raise HTTPException(status_code=400, detail="glg_unsupported")
        response = await driver._send("GLG", PRIORITY_TELEMETRY)
        return {"response": response}

    @app.get("/api/v1/debug/scg")
    async def debug_scg() -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        try:
            await driver._send("PRG", PRIORITY_BACKGROUND)
            response = await driver._send("SCG", PRIORITY_BACKGROUND)
        finally:
            await driver._send("EPG", PRIORITY_BACKGROUND)
        return {"response": response}

    @app.get("/api/v1/debug/glf")
    async def debug_glf() -> Dict[str, list[str]]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        debugger = getattr(driver, "debug_glf_sequence", None)
        if not callable(debugger):
            raise HTTPException(status_code=400, detail="glf_unsupported")
        responses = await debugger()
        return {"responses": responses}

    @app.get("/api/v1/analytics/busiest-channels")
    async def get_busiest_channels(limit: int = 10, hours: float = 24.0) -> Dict:
        runtime: RuntimeState = app.state.runtime
        if not runtime.analytics_db:
            raise HTTPException(status_code=503, detail="Analytics not enabled")
        min_duration = runtime.config.analytics.min_hit_duration
        channels = await runtime.analytics_db.get_busiest_channels(
            limit, hours, min_duration
        )
        return {
            "channels": [
                {
                    "rank": ch.rank,
                    "frequency": ch.frequency,
                    "alpha_tag": ch.alpha_tag,
                    "channel": ch.channel,
                    "hit_count": ch.hit_count,
                    "avg_duration": ch.avg_duration,
                    "last_seen": ch.last_seen,
                }
                for ch in channels
            ]
        }

    @app.get("/api/v1/analytics/hourly-heatmap")
    async def get_hourly_heatmap(days: int = 7) -> Dict:
        runtime: RuntimeState = app.state.runtime
        if not runtime.analytics_db:
            raise HTTPException(status_code=503, detail="Analytics not enabled")
        min_duration = runtime.config.analytics.min_hit_duration
        heatmap, stats = await runtime.analytics_db.get_hourly_heatmap(
            days, min_duration
        )
        return {
            "heatmap": [
                {"hour": cell.hour, "day": cell.day, "count": cell.count}
                for cell in heatmap
            ],
            "stats": {
                "min": stats.get("min_count", stats.get("min", 0)),
                "max": stats.get("max_count", stats.get("max", 0)),
                "avg": stats.get("avg_count", stats.get("avg", 0)),
            },
        }

    @app.get("/api/v1/analytics/session-stats")
    async def get_session_stats() -> Dict:
        runtime: RuntimeState = app.state.runtime
        if not runtime.analytics_db:
            raise HTTPException(status_code=503, detail="Analytics not enabled")
        min_duration = runtime.config.analytics.min_hit_duration
        stats = await runtime.analytics_db.get_session_stats(
            runtime.session_id, min_duration
        )
        return {
            "total_hits": stats.total_hits,
            "avg_rssi": stats.avg_rssi,
            "active_time_seconds": stats.active_time_seconds,
            "unique_channels": stats.unique_channels,
        }

    @app.post("/api/v1/analytics/cleanup")
    async def cleanup_analytics(retention_days: Optional[int] = None) -> Dict:
        runtime: RuntimeState = app.state.runtime
        if not runtime.analytics_db:
            raise HTTPException(status_code=503, detail="Analytics not enabled")
        days = (
            retention_days
            if retention_days is not None
            else runtime.config.analytics.retention_days
        )
        deleted = await runtime.analytics_db.cleanup_old_data(days)
        return {"deleted_records": deleted}

    @app.post("/api/v1/test/simulate-hit")
    async def simulate_hit() -> dict:
        """Simulate a scanner hit for testing purposes"""
        from bearpaw.models import LiveState

        runtime: RuntimeState = app.state.runtime

        # Create a fake hit
        import time

        timestamp = time.time()

        # Update state to simulate squelch opening
        live_state = LiveState(
            timestamp=timestamp,
            frequency=162.550,
            modulation="FM",
            squelch_open=True,
            rssi=75,
            mode="SCAN",
            channel=1,
            alpha_tag="Test Channel",
            volume=5,
            battery=None,
            stale=False,
        )
        changes = runtime.state_store.update_live_state(live_state)

        # Send state update
        await runtime.ws_manager.broadcast(
            {
                "type": "state_update",
                "timestamp": timestamp,
                "sequence": int(timestamp * 1000),
                "data": changes,
            }
        )

        # Simulate squelch closing after a short delay
        async def close_squelch():
            await asyncio.sleep(2)  # 2 second hit
            close_timestamp = time.time()
            close_state = LiveState(
                timestamp=close_timestamp,
                frequency=162.550,
                modulation="FM",
                squelch_open=False,
                rssi=0,
                mode="SCAN",
                channel=1,
                alpha_tag="Test Channel",
                volume=5,
                battery=None,
                stale=False,
            )
            close_changes = runtime.state_store.update_live_state(close_state)
            await runtime.ws_manager.broadcast(
                {
                    "type": "state_update",
                    "timestamp": close_timestamp,
                    "sequence": int(close_timestamp * 1000),
                    "data": close_changes,
                }
            )

        # Run in background
        asyncio.create_task(close_squelch())

        return {"message": "Simulated hit", "frequency": 162.550, "duration": 2}

    @app.get("/api/v1/analytics/activity-log")
    async def get_activity_log(
        limit: int = 100,
        offset: int = 0,
        start_time: Optional[float] = None,
        end_time: Optional[float] = None,
        channel: Optional[int] = None,
    ) -> list:
        runtime: RuntimeState = app.state.runtime
        if not runtime.analytics_db:
            raise HTTPException(status_code=503, detail="Analytics not enabled")
        hits = await runtime.analytics_db.get_activity_log(
            limit=limit,
            offset=offset,
            start_time=start_time,
            end_time=end_time,
            channel=channel,
        )
        return [
            {
                "id": hit.id,
                "timestamp": hit.timestamp,
                "frequency": hit.frequency,
                "channel": hit.channel,
                "alpha_tag": hit.alpha_tag,
                "rssi": hit.rssi,
                "duration": hit.duration,
                "modulation": hit.modulation,
                "mode": hit.mode,
                "bank": hit.bank,
                "session_id": hit.session_id,
                "ended_at": hit.ended_at,
            }
            for hit in hits
        ]

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        runtime: RuntimeState = app.state.runtime
        await runtime.ws_manager.connect(websocket)
        try:
            await runtime.ws_manager.handle_messages(websocket)
        finally:
            runtime.ws_manager.disconnect(websocket)

    return app


async def _run_sync(app: FastAPI, task: MemorySyncTask) -> None:
    runtime: RuntimeState = app.state.runtime
    try:
        await task.run()
    finally:
        runtime.sync_task = None


async def _monitor_usb(app: FastAPI) -> None:
    runtime: RuntimeState = app.state.runtime
    backoff = runtime.config.polling.reconnect_backoff
    while True:
        await asyncio.sleep(1.0)
        if runtime.transport and not isinstance(runtime.transport, UsbTransport):
            continue
        if runtime.device_info.connection_status == "connected" and runtime.transport:
            continue
        runtime.device_info.connection_status = "connecting"
        created_transport = False
        try:
            if runtime.transport:
                await asyncio.to_thread(runtime.transport.reconnect, backoff)
            else:
                transport = UsbTransport(
                    runtime.config.device.usb_vid,
                    runtime.config.device.usb_pid,
                    serial_number=runtime.config.device.usb_serial,
                    timeout=0.5,
                )
                transport.connect()
                runtime.transport = transport
                created_transport = True

            if created_transport or not runtime.scheduler:
                if runtime.scheduler:
                    await runtime.scheduler.stop()
                runtime.scheduler = CommandScheduler(runtime.transport)
                await runtime.scheduler.start()

            model = await asyncio.wrap_future(runtime.transport.send_command("MDL"))
            model = (
                model.split(",", 1)[1].strip() if model.startswith("MDL,") else model
            )
            runtime.driver = (
                SR30CDriver(runtime.scheduler)
                if "SR30C" in model
                else BC125ATDriver(runtime.scheduler)
            )
            runtime.device_info.model = model.strip()
            runtime.device_info.connection_status = "connected"
            _clear_device_diagnostic(runtime.device_info)
            if not runtime.poller_task or runtime.poller_task.done():
                runtime.poller_task = asyncio.create_task(_poll_status(app))
        except Exception as exc:
            runtime.device_info.connection_status = "disconnected"
            _set_device_diagnostic(
                runtime.device_info,
                "usb_device_not_accessible",
                "USB scanner endpoint is not accessible yet. Verify cable, USB mode, and endpoint security policy.",
            )
            logger.warning("USB reconnect failed: %s", exc)


async def _poll_status(app: FastAPI) -> None:
    runtime: RuntimeState = app.state.runtime
    failures = 0
    while True:
        try:
            if not runtime.scheduler or not runtime.driver or not runtime.state_store:
                await asyncio.sleep(0.1)
                continue
            if runtime.scheduler.has_high_priority() or getattr(
                runtime.driver, "in_program_mode", False
            ):
                await asyncio.sleep(0.01)
                continue
            state = await runtime.driver.get_status()
            if state.squelch_open:
                get_glg = getattr(runtime.driver, "get_glg_status", None)
                if callable(get_glg):
                    try:
                        glg_state = await get_glg()
                        state = LiveState(
                            timestamp=glg_state.timestamp,
                            frequency=(
                                glg_state.frequency
                                if glg_state.frequency is not None
                                else state.frequency
                            ),
                            modulation=(
                                glg_state.modulation
                                if glg_state.modulation is not None
                                else state.modulation
                            ),
                            squelch_open=glg_state.squelch_open,
                            rssi=(
                                glg_state.rssi
                                if glg_state.rssi is not None
                                else state.rssi
                            ),
                            mode=state.mode,
                            channel=(
                                glg_state.channel
                                if glg_state.channel is not None
                                else state.channel
                            ),
                            alpha_tag=(
                                glg_state.alpha_tag
                                if glg_state.alpha_tag is not None
                                else state.alpha_tag
                            ),
                            volume=state.volume,
                            battery=state.battery,
                            stale=state.stale,
                        )
                    except Exception as exc:
                        logger.warning("GLG poll failed: %s", exc)
            changes = runtime.state_store.update_live_state(state)
            is_first_poll = changes.pop("_first_poll", False)
            if changes:
                payload = changes
                if len(changes) == 1 and "timestamp" in changes:
                    payload = state.__dict__
                await runtime.ws_manager.broadcast(
                    {
                        "type": "state_update",
                        "timestamp": state.timestamp,
                        "sequence": int(state.timestamp * 1000),
                        "data": payload,
                    }
                )
                if runtime.mqtt_exporter:
                    runtime.mqtt_exporter.publish(
                        "state", {"timestamp": state.timestamp, **changes}
                    )
                if changes.get("squelch_open") is True and not is_first_poll:
                    event_payload = {
                        "type": "event",
                        "timestamp": state.timestamp,
                        "event": "scan_hit",
                        "data": {
                            "frequency": state.frequency,
                            "channel": state.channel,
                            "alpha_tag": state.alpha_tag,
                            "rssi": state.rssi,
                        },
                    }
                    await runtime.ws_manager.broadcast(event_payload)
                    if runtime.json_exporter:
                        runtime.json_exporter.append(
                            "scan_hit",
                            {
                                "frequency": state.frequency,
                                "channel": state.channel,
                                "alpha_tag": state.alpha_tag,
                                "rssi": state.rssi,
                            },
                            timestamp=state.timestamp,
                        )
                    if runtime.mqtt_exporter:
                        runtime.mqtt_exporter.publish(
                            "events/scan_hit",
                            {
                                "timestamp": state.timestamp,
                                "frequency": state.frequency,
                                "channel": state.channel,
                                "alpha_tag": state.alpha_tag,
                                "rssi": state.rssi,
                            },
                        )
                    if runtime.analytics_db:
                        _safe_create_task(
                            runtime.analytics_db.record_hit_start(
                                timestamp=state.timestamp,
                                frequency=state.frequency,
                                channel=state.channel,
                                alpha_tag=state.alpha_tag,
                                modulation=state.modulation,
                                rssi=state.rssi,
                                mode=state.mode,
                                session_id=runtime.session_id,
                            )
                        )
                if changes.get("squelch_open") is False and not is_first_poll:
                    if runtime.analytics_db:
                        _safe_create_task(
                            runtime.analytics_db.record_hit_end(
                                frequency=state.frequency,
                                timestamp=state.timestamp,
                            )
                        )
                if runtime.text_exporter and runtime.text_exporter.should_update(
                    changes
                ):
                    runtime.text_exporter.write(state)
            failures = 0
            if runtime.device_info.connection_status != "connected":
                runtime.device_info.connection_status = "connected"
                await _broadcast_device_info(runtime)
        except Exception as exc:
            failures += 1
            if failures == 1 and runtime.device_info.connection_status != "connecting":
                runtime.device_info.connection_status = "connecting"
                logger.info("Device disconnected, attempting to reconnect...")
                await _broadcast_device_info(runtime)
            if isinstance(exc, (ConnectionError, OSError)):
                try:
                    if runtime.transport:
                        logger.info("Attempting USB reconnection...")
                        await asyncio.to_thread(
                            runtime.transport.reconnect,
                            runtime.config.polling.reconnect_backoff,
                        )
                        logger.info("USB reconnection successful")
                except Exception as reconnect_exc:
                    logger.warning("Reconnect failed: %s", reconnect_exc)
            if failures >= 3:
                if runtime.device_info.connection_status != "disconnected":
                    stale_changes = runtime.state_store.mark_live_state_stale()
                    if stale_changes:
                        runtime.device_info.connection_status = "disconnected"
                        await _broadcast_device_info(runtime)
                        await runtime.ws_manager.broadcast(
                            {
                                "type": "event",
                                "timestamp": stale_changes.get("timestamp"),
                                "event": "state_stale",
                                "data": {"message": "Live state stale"},
                            }
                        )
            if failures < 3 or failures % 10 == 0:
                logger.warning(
                    "Status poll failed: %s: %s", type(exc).__name__, exc, exc_info=True
                )
        poll_interval = runtime.config.polling.sts_interval * (
            5 if runtime.device_info.connection_status == "disconnected" else 1
        )
        await asyncio.sleep(poll_interval)
