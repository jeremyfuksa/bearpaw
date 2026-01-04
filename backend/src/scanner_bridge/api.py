from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Dict, Optional

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from scanner_bridge.config import AppConfig
from scanner_bridge.discovery import discover_devices
from scanner_bridge.models import (
    ChannelDataModel,
    DeviceInfo,
    DeviceInfoModel,
    ErrorResponse,
    FrequencyRequest,
    KeyRequest,
    LiveStateModel,
)
from scanner_bridge.protocol import BC125ATDriver, SR30CDriver
from scanner_bridge.scheduler import CommandScheduler
from scanner_bridge.state import StateStore, build_persistence
from scanner_bridge.sync import MemorySyncTask
from scanner_bridge.transport import SerialTransport
from scanner_bridge.transport_usb import UsbTransport
from scanner_bridge.websocket import WebSocketManager
from scanner_bridge.exporters.text_exporter import TextFileExporter
from scanner_bridge.exporters.json_stream import JsonEventStream
from scanner_bridge.exporters.mqtt import MqttExporter

logger = logging.getLogger("scanner_bridge")


@dataclass
class RuntimeState:
    config: AppConfig
    transport: Optional[SerialTransport]
    scheduler: Optional[CommandScheduler]
    driver: object
    state_store: StateStore
    ws_manager: WebSocketManager
    device_info: DeviceInfo
    poller_task: Optional[asyncio.Task] = None
    sync_task: Optional[MemorySyncTask] = None
    heartbeat_task: Optional[asyncio.Task] = None
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
            transport.connect()
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

        scheduler = CommandScheduler(transport)
        await scheduler.start()

        model = await asyncio.wrap_future(transport.send_command("MDL"))
        model = model.split(",", 1)[1].strip() if model.startswith("MDL,") else model
        driver = SR30CDriver(scheduler) if "SR30C" in model else BC125ATDriver(scheduler)
        device_info.model = model.strip()

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
        runtime.poller_task = asyncio.create_task(_poll_status(app))

    async def shutdown() -> None:
        runtime: RuntimeState = app.state.runtime
        if runtime.poller_task:
            runtime.poller_task.cancel()
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

    @app.post("/api/v1/commands/hold")
    async def hold_command() -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        ok = await runtime.driver.send_hold()
        if not ok:
            raise HTTPException(status_code=500, detail="hold_failed")
        return {"status": "ok"}

    @app.post("/api/v1/commands/scan")
    async def scan_command() -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        ok = await runtime.driver.send_scan()
        if not ok:
            raise HTTPException(status_code=500, detail="scan_failed")
        return {"status": "ok"}

    @app.post("/api/v1/commands/key")
    async def key_command(request: KeyRequest) -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        ok = await runtime.driver.send_key(request.key)
        if not ok:
            raise HTTPException(status_code=500, detail="key_failed")
        return {"status": "ok"}

    @app.post("/api/v1/frequency")
    async def set_frequency(request: FrequencyRequest) -> Dict[str, str]:
        runtime: RuntimeState = app.state.runtime
        ok = await runtime.driver.set_frequency(request.frequency, request.modulation)
        if not ok:
            raise HTTPException(status_code=400, detail="invalid_frequency")
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
        if runtime.sync_task:
            return {"status": "already_running", "task_id": runtime.sync_task.task_id}
        task = MemorySyncTask(runtime.driver, runtime.state_store, runtime.ws_manager)
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


async def _poll_status(app: FastAPI) -> None:
    runtime: RuntimeState = app.state.runtime
    failures = 0
    while True:
        try:
            if runtime.scheduler.has_high_priority():
                await asyncio.sleep(0.01)
                continue
            state = await runtime.driver.get_status()
            changes = runtime.state_store.update_live_state(state)
            if changes:
                await runtime.ws_manager.broadcast(
                    {
                        "type": "state_update",
                        "timestamp": state.timestamp,
                        "sequence": int(state.timestamp * 1000),
                        "data": changes,
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
        except Exception as exc:
            failures += 1
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
