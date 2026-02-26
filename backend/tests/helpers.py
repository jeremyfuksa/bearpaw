import asyncio
from contextlib import asynccontextmanager

from bearpaw.api import RuntimeState, create_app
from bearpaw.config import AppConfig
from bearpaw.models import DeviceInfo
from bearpaw.state import StateStore
from bearpaw.websocket import WebSocketManager
from tests.stubs import MockDriver, MockScheduler, MockTransport


@asynccontextmanager
async def setup_test_app():
    app = create_app(AppConfig(), startup_enabled=False)
    mock_driver = MockDriver()
    mock_scheduler = MockScheduler()
    mock_transport = MockTransport()
    state_store = StateStore(persistence=None)
    ws_manager = WebSocketManager(AppConfig().websocket)

    runtime = RuntimeState(
        config=AppConfig(),
        transport=mock_transport,
        scheduler=mock_scheduler,
        driver=mock_driver,
        state_store=state_store,
        ws_manager=ws_manager,
        device_info=DeviceInfo(
            model="BC125AT",
            port="/dev/ttyACM0",
            vid=0x1965,
            pid=0x0017,
            serial_number=None,
            description="Uniden Scanner",
            connection_status="connected",
        ),
        session_id="test-session",
    )

    app.state.runtime = runtime

    try:
        yield app
    finally:
        await mock_scheduler.stop()


async def wait_for_condition(condition, timeout: float = 1.0, interval: float = 0.01):
    start = asyncio.get_event_loop().time()
    while True:
        if condition():
            return
        if asyncio.get_event_loop().time() - start > timeout:
            raise TimeoutError(f"Condition not met after {timeout}s")
        await asyncio.sleep(interval)


def assert_api_error(
    response, expected_status: int, expected_message: str = None
) -> None:
    assert response.status_code == expected_status
    data = response.json()
    assert "error" in data
    if expected_message:
        assert expected_message in data.get("message", "")


def assert_success(response, expected_data=None) -> None:
    assert response.status_code >= 200 and response.status_code < 300
    if expected_data is not None:
        data = response.json()
        assert data == expected_data
