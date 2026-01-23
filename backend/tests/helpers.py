import asyncio
from contextlib import asynccontextmanager
from fastapi.testclient import TestClient
from scanner_bridge.main import app
from scanner_bridge.state import RuntimeState
from scanner_bridge.scheduler import CommandScheduler
from scanner_bridge.models import AppConfig
from tests.stubs import MockDriver, MockScheduler, MockTransport


@asynccontextmanager
async def setup_test_app():
    mock_driver = MockDriver()
    mock_scheduler = MockScheduler()
    mock_transport = MockTransport()

    runtime = RuntimeState(
        config=AppConfig(),
        transport=mock_transport,
        scheduler=mock_scheduler,
        driver=mock_driver,
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
