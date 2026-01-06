import os
import sys
import time
import unittest

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from scanner_bridge.api import RuntimeState, create_app
from scanner_bridge.config import AppConfig
from scanner_bridge.models import ChannelData, DeviceInfo, LiveState
from scanner_bridge.state import StateStore
from scanner_bridge.websocket import WebSocketManager


class StubDriver:
    async def get_status(self):
        return LiveState(
            timestamp=time.time(),
            frequency=151.25,
            modulation="FM",
            squelch_open=True,
            rssi=75,
            mode="SCAN",
            channel=1,
            volume=10,
            battery=100,
        )

    async def send_hold(self):
        return True

    async def send_scan(self):
        return True

    async def send_key(self, key_code: str):
        return True

    async def read_channel(self, index: int):
        raise NotImplementedError

    async def detect_model(self):
        return "BC125AT"


class ApiTests(unittest.TestCase):
    def setUp(self) -> None:
        app = create_app(AppConfig(), startup_enabled=False)
        state_store = StateStore()
        state_store.update_live_state(
            LiveState(
                timestamp=time.time(),
                frequency=151.25,
                modulation="FM",
                squelch_open=True,
                rssi=75,
                mode="SCAN",
                channel=1,
                volume=10,
                battery=100,
            )
        )
        state_store.set_shadow_state(
            {
                1: ChannelData(
                    index=1,
                    frequency=151.25,
                    modulation="FM",
                    alpha_tag="Police",
                    delay=2,
                    lockout=False,
                    priority=True,
                    tone_squelch=None,
                    bank=1,
                )
            }
        )
        app.state.runtime = RuntimeState(
            config=AppConfig(),
            transport=None,
            scheduler=None,
            driver=StubDriver(),
            state_store=state_store,
            ws_manager=WebSocketManager(),
            device_info=DeviceInfo(
                model="BC125AT",
                port="/dev/ttyACM0",
                vid=0x1965,
                pid=0x0017,
                serial_number=None,
                description="Uniden Scanner",
            ),
        )
        self.client = TestClient(app)

    def test_status(self) -> None:
        response = self.client.get("/api/v1/status")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["frequency"], 151.25)

    def test_health(self) -> None:
        response = self.client.get("/api/v1/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")

    def test_device_info(self) -> None:
        response = self.client.get("/api/v1/device/info")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["model"], "BC125AT")

    def test_commands(self) -> None:
        response = self.client.post("/api/v1/commands/hold")
        self.assertEqual(response.status_code, 200)
        response = self.client.post("/api/v1/commands/scan")
        self.assertEqual(response.status_code, 200)
        response = self.client.post("/api/v1/commands/key", json={"key": "UP"})
        self.assertEqual(response.status_code, 200)

    def test_memory_queries(self) -> None:
        response = self.client.get("/api/v1/memory/channels")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()), 1)
        response = self.client.get("/api/v1/memory/channels/1")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["alpha_tag"], "Police")


if __name__ == "__main__":
    unittest.main()
