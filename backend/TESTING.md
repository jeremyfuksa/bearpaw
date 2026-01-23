# Backend Testing Guide

## Running Tests

```bash
# Activate virtual environment
source .venv/bin/activate

# Run all tests
python -m unittest discover -s tests

# Run specific test file
python -m unittest tests.test_api.ApiTests

# Run specific test class
python -m unittest tests.test_api.ApiTests.test_status

# Run specific test method
python -m unittest tests.test_api.ApiTests.test_status

# Run with verbose output
python -m unittest discover -s tests -v

# Run only hardware tests (requires device)
HARDWARE_TESTS=1 python -m unittest tests.test_hardware.HardwareTests
```

## Test Structure

```
backend/tests/
├── test_api.py           # API endpoint tests
├── test_state_store.py     # State management tests
├── test_persistence.py      # Persistence layer tests
├── test_protocol.py         # Protocol driver tests
├── test_replay.py         # Serial replay tests
├── test_hardware.py        # Hardware-in-the-loop tests
├── fixtures.py            # Test data factories
├── stubs.py              # Mock classes
└── helpers.py             # Test utilities
```

## Writing Tests

### Test Class Structure

```python
import unittest
from scanner_bridge.models import ChannelData
from tests.fixtures import create_channel, create_live_state
from tests.stubs import MockDriver, MockScheduler, MockTransport


class ApiTests(unittest.TestCase):
    def setUp(self):
        """Set up test fixtures before each test"""
        self.mock_driver = MockDriver()
        self.mock_scheduler = MockScheduler()
        self.mock_transport = MockTransport()

    def test_method_name(self):
        """Test description"""
        result = self.mock_driver.get_status()
        self.assertEqual(result.frequency, 151.25)

    def test_error_case(self):
        """Test error handling"""
        with self.assertRaises(ValueError):
            self.mock_driver.send_scan()

    def test_async_method(self):
        """Test async methods"""
        from tests.helpers import wait_for_condition
        import asyncio
        
        async def run_test():
            status = await self.mock_driver.get_status()
            await wait_for_condition(
                lambda: status.frequency == 151.25,
                timeout=1.0
            )
        
        asyncio.run(run_test())
```

### Async Tests

```python
import unittest


class AsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_async_operation(self):
        driver = MockDriver()
        status = await driver.get_status()
        self.assertEqual(status.mode, "SCAN")
```

### Using Test Fixtures

```python
import unittest
from tests.fixtures import create_channel, create_live_state


class TestsUsingFixtures(unittest.TestCase):
    def test_with_fixture(self):
        channel = create_channel(index=1, frequency=151.25)
        self.assertEqual(channel.frequency, 151.25)

    def test_with_custom_fixture(self):
        state = create_live_state(
            frequency=145.5,
            modulation="FM",
            mode="HOLD"
        )
        self.assertEqual(state.mode, "HOLD")
```

### Using Mock Classes

```python
import unittest
from tests.stubs import MockDriver, MockScheduler, MockTransport


class TestsUsingMocks(unittest.TestCase):
    def test_with_mock_driver(self):
        driver = MockDriver()
        status = driver.get_status()
        self.assertEqual(status.mode, "SCAN")

    def test_with_mock_scheduler(self):
        scheduler = MockScheduler()
        result = scheduler.enqueue("STS", priority=1)
        self.assertEqual(result.result(), "OK")

    def test_call_count_tracking(self):
        driver = MockDriver()
        driver.get_status()
        driver.get_status()
        self.assertEqual(driver.get_call_count("get_status"), 2)
```

### API Testing

```python
import unittest
from fastapi.testclient import TestClient
from tests.helpers import setup_test_app, assert_api_error, assert_success


class ApiEndpointTests(unittest.TestCase):
    def setUp(self):
        from tests.helpers import setup_test_app
        self.app = setup_test_app().__enter__()

    def test_get_status_endpoint(self):
        response = self.client.get("/api/v1/status")
        assert_success(response)

    def test_post_command_endpoint(self):
        response = self.client.post(
            "/api/v1/commands/hold",
            json={}
        )
        assert_success(response)

    def test_error_response(self):
        response = self.client.post(
            "/api/v1/commands/hold",
            json={}
        )
        assert_api_error(response, 503, "Device not connected")
```

### Integration Tests

```python
import unittest
import asyncio
from tests.helpers import setup_test_app, wait_for_condition


class WorkflowTests(unittest.TestCase):
    def test_status_polling_workflow(self):
        from tests.helpers import setup_test_app
        app = setup_test_app().__enter__()
        
        async def run_test():
            # Initial state
            response = self.client.get("/api/v1/status")
            self.assertEqual(response.status_code, 200)
            
            # Wait for state update
            await wait_for_condition(
                lambda: app.state.runtime.state_store.live_state.mode == "HOLD",
                timeout=2.0
            )
        
        asyncio.run(run_test())

    def test_lockout_workflow(self):
        """Test complete lockout with auto-resume"""
        from tests.helpers import setup_test_app
        app = setup_test_app().__enter__()
        
        async def run_test():
            # Send lockout
            response = self.client.post("/api/v1/commands/lockout", json={
                "mode": "permanent",
                "channel": 1
            })
            assert_success(response)
            
            # Wait for scan resume
            await wait_for_condition(
                lambda: app.state.runtime.state_store.live_state.mode == "SCAN",
                timeout=2.0
            )
        
        asyncio.run(run_test())
```

## Test Data Fixtures

### Available Functions

```python
from tests.fixtures import (
    create_channel,
    create_live_state,
    create_device_info,
    create_shadow_state,
    create_analytics_hit,
    create_settings,
    create_lockouts_response,
)
```

### Creating Custom Data

```python
from tests.fixtures import create_channel

# Basic usage
channel = create_channel(index=1)

# With overrides
custom_channel = create_channel(
    index=5,
    frequency=155.5,
    modulation="AM",
    alpha_tag="Custom Tag",
    delay=5,
    lockout=True,
    priority=True,
    tone_squelch=162.2,
    bank=2
)
```

## Mock Classes

### MockDriver

```python
from tests.stubs import MockDriver

driver = MockDriver()
status = driver.get_status()  # Returns mock LiveState

# Track calls
driver.get_status()
count = driver.get_call_count("get_status")  # Returns 2

# Reset tracking
driver.reset()
```

### MockScheduler

```python
from tests.stubs import MockScheduler

scheduler = MockScheduler(responses=["OK", "OK", "OK"])
future = scheduler.enqueue("STS", priority=1)
result = await future  # Returns "OK"

# Check priority
has_high_priority = scheduler.has_high_priority()  # Returns False
```

### MockTransport

```python
from tests.stubs import MockTransport

transport = MockTransport()
await transport.connect()
await transport.send_command("STS")
await transport.disconnect()

# Check connection
connected = transport.connected  # Returns False

# Check call count
count = transport.get_call_count("send_command")
```

## Test Helpers

### setup_test_app

```python
from tests.helpers import setup_test_app

async with setup_test_app() as app:
    response = app.client.get("/api/v1/status")
    print(response.status_code)
```

### wait_for_condition

```python
from tests.helpers import wait_for_condition

import asyncio

async def example():
    condition_met = await wait_for_condition(
        lambda: some_variable == expected_value,
        timeout=2.0,
        interval=0.1
    )
    print(condition_met)
```

### assert_api_error

```python
from tests.helpers import assert_api_error

response = client.post("/api/v1/commands/hold")
assert_api_error(response, 503, "Device not connected")
```

### assert_success

```python
from tests.helpers import assert_success

response = client.get("/api/v1/status")
assert_success(response, {"frequency": 151.25})
```

## Best Practices

1. **Use test data factories**
   - Always use fixtures for consistent test data
   - Avoid hard-coding values

2. **Reset mocks in setUp**
   - Reset call counts and state before each test
   - Ensures test independence

3. **Test error cases**
   - Test both success and failure paths
   - Verify error messages and status codes

4. **Use async tests for async code**
   - Use `IsolatedAsyncioTestCase` for async test classes
   - Use `async def` for test methods

5. **Keep tests focused**
   - Each test should verify one thing
   - Use descriptive test names

6. **Mock external dependencies**
   - Use MockDriver, MockScheduler, MockTransport
   - Don't test driver code itself

7. **Test edge cases**
   - Test boundary values (min/max)
   - Test invalid inputs
   - Test empty/null values

## Debugging Tests

```bash
# Run specific test with verbose output
python -m unittest tests.test_api.ApiTests.test_status -v

# Run all tests in a module
python -m unittest tests.test_api -v

# Run with coverage
coverage run -m unittest discover -s tests
coverage report
```

## Hardware Tests

Hardware tests require:
1. Physical scanner connected
2. `HARDWARE_TESTS=1` environment variable
3. Specific model (BC125AT or SR30C)

```bash
# Run hardware tests
HARDWARE_TESTS=1 python -m unittest tests.test_hardware.HardwareTests
```

**Note:** Hardware tests are skipped by default in CI/CD.
