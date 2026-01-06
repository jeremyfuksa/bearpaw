from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Dict, Optional

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from scanner_bridge.config import AppConfig
from scanner_bridge.discovery import discover_devices
from scanner_bridge.models import (
    ChannelDataModel,
    DeviceInfo,
    DeviceInfoModel,
    ErrorResponse,
    BanksModel,
    KeyRequest,
    LockoutRequest,
    LiveState,
    LiveStateModel,
    VolumeRequest,
)
from scanner_bridge.protocol import BC125ATDriver, SR30CDriver
from scanner_bridge.scheduler import CommandScheduler, PRIORITY_BACKGROUND, PRIORITY_TELEMETRY
from scanner_bridge.state import StateStore, build_persistence
from scanner_bridge.sync import MemorySyncTask
from scanner_bridge.transport import SerialTransport
from scanner_bridge.transport_usb import UsbTransport
from scanner_bridge.websocket import WebSocketManager
from scanner_bridge.exporters.text_exporter import TextFileExporter
from scanner_bridge.exporters.json_stream import JsonEventStream
from scanner_bridge.exporters.mqtt import MqttExporter
from scanner_bridge.exporters.bc125at_ss import export_bc125at_ss

logger = logging.getLogger("scanner_bridge")


@dataclass
class RuntimeState:
    config: AppConfig
    transport: Optional[SerialTransport]
    scheduler: Optional[CommandScheduler]
    driver: Optional[object]
    state_store: StateStore
    ws_manager: WebSocketManager
    device_info: DeviceInfo
    poller_task: Optional[asyncio.Task] = None
    sync_task: Optional[MemorySyncTask] = None
    heartbeat_task: Optional[asyncio.Task] = None
    reconnect_task: Optional[asyncio.Task] = None
    text_exporter: Optional[TextFileExporter] = None
    json_exporter: Optional[JsonEventStream] = None
    mqtt_exporter: Optional[MqttExporter] = None


def create_app(
    config: AppConfig,
    port_override: Optional[str] = None,
    startup_enabled: bool = True,
) -> FastAPI:
    app = FastAPI(title="Scanner Bridge", version="1.0.0")

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
        logger.info(
            "%s %s %s %.1fms",
            request.method,
            request.url.path,
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

    def require_driver(runtime: RuntimeState) -> object:
        if not runtime.driver or not runtime.scheduler or not runtime.transport:
            raise HTTPException(status_code=503, detail="device_disconnected")
        return runtime.driver

    async def startup() -> None:
        device_port = port_override or config.device.port
        transport: Optional[SerialTransport] = None
        if config.device.transport == "usb":
            device_info = DeviceInfo(
                model=None,
                port=None,
                vid=config.device.usb_vid,
                pid=config.device.usb_pid,
                serial_number=config.device.usb_serial,
                description="USB CDC",
            )
            transport = UsbTransport(
                config.device.usb_vid,
                config.device.usb_pid,
                serial_number=config.device.usb_serial,
                timeout=0.5,
            )
            try:
                transport.connect()
                device_info.connection_status = "connected"
            except ConnectionError as exc:
                logger.warning("USB device not found: %s", exc)
                device_info.connection_status = "disconnected"
                transport = None
        else:
            if not device_port and config.device.auto_detect:
                devices = discover_devices()
                if devices:
                    device_port = devices[0].port
                    device_info = DeviceInfo(
                        model=None,
                        port=device_port,
                        vid=devices[0].vid,
                        pid=devices[0].pid,
                        serial_number=devices[0].serial_number,
                        description=devices[0].description,
                    )
                elif config.device.transport in ("auto", "usb"):
                    device_info = DeviceInfo(
                        model=None,
                        port=None,
                        vid=config.device.usb_vid,
                        pid=config.device.usb_pid,
                        serial_number=config.device.usb_serial,
                        description="USB CDC",
                    )
                    transport = UsbTransport(
                        config.device.usb_vid,
                        config.device.usb_pid,
                        serial_number=config.device.usb_serial,
                        timeout=0.5,
                    )
                    transport.connect()
                else:
                    raise RuntimeError("No scanner devices detected")
            else:
                device_info = DeviceInfo(
                    model=None,
                    port=device_port,
                    vid=None,
                    pid=None,
                    serial_number=None,
                    description=None,
                )

            if not transport:
                if not device_port:
                    raise RuntimeError("No scanner port specified")

                transport = SerialTransport(device_port, timeout=0.5)
                transport.connect()

        scheduler: Optional[CommandScheduler] = None
        driver: Optional[object] = None
        if transport:
            scheduler = CommandScheduler(transport)
            await scheduler.start()

            model = await asyncio.wrap_future(transport.send_command("MDL"))
            model = model.split(",", 1)[1].strip() if model.startswith("MDL,") else model
            driver = SR30CDriver(scheduler) if "SR30C" in model else BC125ATDriver(scheduler)
            device_info.model = model.strip()
            device_info.connection_status = "connected"

        persistence = build_persistence(config.state.persistence, config.state.db_path)
        state_store = StateStore(persistence)
        state_store.load_shadow()

        ws_manager = WebSocketManager()
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

        runtime = RuntimeState(
            config=config,
            transport=transport,
            scheduler=scheduler,
            driver=driver,
            state_store=state_store,
            ws_manager=ws_manager,
            device_info=device_info,
            heartbeat_task=heartbeat_task,
            text_exporter=text_exporter,
            json_exporter=json_exporter,
            mqtt_exporter=mqtt_exporter,
        )
        app.state.runtime = runtime
        if runtime.driver and runtime.transport:
            runtime.poller_task = asyncio.create_task(_poll_status(app))
        if (
            config.device.transport == "usb"
            or isinstance(runtime.transport, UsbTransport)
            or (runtime.transport is None and config.device.transport in ("usb", "auto"))
        ):
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

    if startup_enabled:
        app.add_event_handler("startup", startup)
        app.add_event_handler("shutdown", shutdown)

    @app.get("/api/v1/status", response_model=LiveStateModel, responses={503: {"model": ErrorResponse}})
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
        logger.info("Lockout request mode=%s channel=%s frequency=%s", mode, request.channel, request.frequency)

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
                    runtime.state_store.toggle_temporary_lockout(channel_id, updated.frequency)
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
            return {"mode": "permanent", "channel": ChannelDataModel.model_validate(updated)}
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
                logger.warning("Failed to clear temporary lockout %s: %s", channel_id, exc)
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
            frequency = raw / 10000.0
            try:
                await set_lock(raw, False)
                cleared_list.append(frequency)
            except Exception as exc:
                failed_list.append(frequency)
                logger.warning("Failed to clear global lockout %s: %s", raw, exc)
        return {"cleared": cleared_list, "failed": failed_list}

    @app.post("/api/v1/lockouts/channels/clear")
    async def clear_channel_lockouts() -> dict:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        setter = getattr(driver, "set_channel_lockout", None)
        if not callable(setter):
            raise HTTPException(status_code=400, detail="lockout_unsupported")
        channels = runtime.state_store.get_shadow_channels()
        locked_ids = sorted([chan.index for chan in channels.values() if chan.lockout])
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
                logger.warning("Failed to clear channel lockout %s: %s", channel_id, exc)
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
        locked_channels = sorted([chan.index for chan in channels.values() if chan.lockout])
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

    @app.post("/api/v1/memory/sync")
    async def memory_sync() -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        driver = require_driver(runtime)
        if runtime.sync_task:
            return {"status": "already_running", "task_id": runtime.sync_task.task_id}
        if runtime.state_store.has_shadow_channels() and not runtime.state_store.is_shadow_dirty():
            return {"status": "already_synced"}
        task = MemorySyncTask(driver, runtime.state_store, runtime.ws_manager)
        runtime.sync_task = task
        asyncio.create_task(_run_sync(app, task))
        return {"status": "started", "task_id": task.task_id}

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
            model = model.split(",", 1)[1].strip() if model.startswith("MDL,") else model
            runtime.driver = SR30CDriver(runtime.scheduler) if "SR30C" in model else BC125ATDriver(runtime.scheduler)
            runtime.device_info.model = model.strip()
            runtime.device_info.connection_status = "connected"
            if not runtime.poller_task or runtime.poller_task.done():
                runtime.poller_task = asyncio.create_task(_poll_status(app))
        except Exception as exc:
            runtime.device_info.connection_status = "disconnected"
            logger.warning("USB reconnect failed: %s", exc)


async def _poll_status(app: FastAPI) -> None:
    runtime: RuntimeState = app.state.runtime
    failures = 0
    while True:
        try:
            if runtime.scheduler.has_high_priority():
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
                            frequency=glg_state.frequency or state.frequency,
                            modulation=glg_state.modulation or state.modulation,
                            squelch_open=glg_state.squelch_open,
                            rssi=glg_state.rssi or state.rssi,
                            mode=state.mode,
                            channel=glg_state.channel or state.channel,
                            alpha_tag=glg_state.alpha_tag or state.alpha_tag,
                            volume=state.volume,
                            battery=state.battery,
                            stale=state.stale,
                        )
                    except Exception as exc:
                        logger.warning("GLG poll failed: %s", exc)
            changes = runtime.state_store.update_live_state(state)
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
                    runtime.mqtt_exporter.publish("state", {"timestamp": state.timestamp, **changes})
                if changes.get("squelch_open") is True:
                    event_payload = {
                        "type": "event",
                        "timestamp": state.timestamp,
                        "event": "scan_hit",
                        "data": {
                            "frequency": state.frequency,
                            "channel": state.channel,
                        },
                    }
                    await runtime.ws_manager.broadcast(event_payload)
                    if runtime.json_exporter:
                        runtime.json_exporter.append(
                            "scan_hit",
                            {"frequency": state.frequency, "channel": state.channel},
                            timestamp=state.timestamp,
                        )
                    if runtime.mqtt_exporter:
                        runtime.mqtt_exporter.publish(
                            "events/scan_hit",
                            {"timestamp": state.timestamp, "frequency": state.frequency, "channel": state.channel},
                        )
                if runtime.text_exporter and runtime.text_exporter.should_update(changes):
                    runtime.text_exporter.write(state)
            failures = 0
            if runtime.device_info.connection_status != "connected":
                runtime.device_info.connection_status = "connected"
        except Exception as exc:
            failures += 1
            if failures == 1 and runtime.device_info.connection_status != "connecting":
                runtime.device_info.connection_status = "connecting"
            if isinstance(exc, (ConnectionError, OSError)):
                try:
                    await asyncio.to_thread(
                        runtime.transport.reconnect, runtime.config.polling.reconnect_backoff
                    )
                except Exception as reconnect_exc:
                    logger.warning("Reconnect failed: %s", reconnect_exc)
            if failures >= 3:
                stale_changes = runtime.state_store.mark_live_state_stale()
                if stale_changes:
                    runtime.device_info.connection_status = "disconnected"
                    await runtime.ws_manager.broadcast(
                        {
                            "type": "event",
                            "timestamp": stale_changes.get("timestamp"),
                            "event": "state_stale",
                            "data": {"message": "Live state stale"},
                        }
                    )
            logger.warning("Status poll failed: %s", exc)
        await asyncio.sleep(runtime.config.polling.sts_interval)
