from __future__ import annotations

import asyncio
import logging
import time
from typing import Dict, Optional, Set

from fastapi import WebSocket, WebSocketDisconnect

from scanner_bridge.config import WebSocketConfig

logger = logging.getLogger(__name__)


class WebSocketManager:
    def __init__(self, config: WebSocketConfig) -> None:
        self._config = config
        self._connections: Set[WebSocket] = set()
        self._last_pong: Dict[WebSocket, float] = {}
        self._last_ping: Dict[WebSocket, float] = {}
        self._topics: Dict[WebSocket, Optional[Set[str]]] = {}

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        logger.info(
            "Client connected, total connections: %d", len(self._connections) + 1
        )
        self._connections.add(websocket)
        self._last_pong[websocket] = time.time()
        self._topics[websocket] = None

    def disconnect(self, websocket: WebSocket) -> None:
        self._connections.discard(websocket)
        self._last_pong.pop(websocket, None)
        self._last_ping.pop(websocket, None)
        self._topics.pop(websocket, None)

    async def broadcast(self, message: dict, force: bool = False) -> None:
        topic = _topic_for_message(message) if not force else None
        for websocket in list(self._connections):
            if topic and not self._is_subscribed(websocket, topic):
                continue
            try:
                await websocket.send_json(message)
            except Exception:
                self.disconnect(websocket)

    async def heartbeat(self) -> None:
        while True:
            await asyncio.sleep(self._config.ping_interval)
            now = time.time()
            for websocket in list(self._connections):
                last_ping = self._last_ping.get(websocket)
                last_pong = self._last_pong.get(websocket, 0)
                if (
                    last_ping
                    and last_pong < last_ping
                    and now - last_ping > self._config.ping_timeout
                ):
                    self.disconnect(websocket)
                    try:
                        await websocket.close(code=1001)
                    except Exception:
                        pass
                    continue
                try:
                    await websocket.send_json({"type": "ping"})
                    self._last_ping[websocket] = now
                except Exception:
                    self.disconnect(websocket)

    async def handle_messages(self, websocket: WebSocket) -> None:
        try:
            while True:
                data = await websocket.receive_json()
                if data.get("type") == "pong":
                    self._last_pong[websocket] = time.time()
                if data.get("type") == "subscribe":
                    topics = data.get("topics", [])
                    if isinstance(topics, list):
                        self._topics[websocket] = set(topics)
        except WebSocketDisconnect:
            return
        except Exception:
            return

    def _is_subscribed(self, websocket: WebSocket, topic: str) -> bool:
        topics = self._topics.get(websocket)
        if topics is None:
            return True
        return topic in topics


def _topic_for_message(message: dict) -> Optional[str]:
    msg_type = message.get("type")
    if msg_type == "state_update":
        return "state"
    if msg_type == "event":
        return "events"
    if msg_type == "progress":
        return "progress"
    if msg_type == "error":
        return "errors"
    return None
