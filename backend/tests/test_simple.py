import unittest
from scanner_bridge.models import LiveState, AppConfig
from tests.fixtures import (
    create_channel,
    create_live_state,
    create_analytics_hit,
    create_device_info,
)
from tests.helpers import setup_test_app
from tests.stubs import MockDriver, MockScheduler, MockTransport


class SimpleIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_app_can_start_and_stop(self):
        """Test that app can start and stop cleanly"""
        app = await setup_test_app()

        try:
            self.assertIsNotNone(app.state.runtime.driver)
            self.assertIsNotNone(app.state.scheduler)

            state = app.state.runtime.state_store.live_state
            self.assertIsNotNone(state)

            await app.state.startup()

            await asyncio.sleep(0.1)

            self.assertIsNotNone(app.state.runtime.driver)
            self.assertIsNotNone(app.state.scheduler)

        finally:
            await app.state.shutdown()

    async def test_status_polling(self):
        """Test that status updates are retrieved and stored"""
        app = await setup_test_app()

        try:
            # Mock get_status return
            test_state = create_live_state()
            (app.state.runtime.driver as MockDriver).get_status.return_value = test_state

            # Get status from store
            state = app.state.runtime.state_store.live_state
            self.assertEqual(state.frequency, test_state.frequency)

        finally:
            await app.state.shutdown()

    async def test_state_persistence(self):
        """Test that state is persisted"""
        app = await setup_test_app()

        try:
            # Update state
            test_state = create_live_state()
            await app.state.runtime.state_store.update_live_state(test_state)

            # Get state from store
            state = app.state.runtime.state_store.live_state
            self.assertEqual(state.frequency, test_state.frequency)

        finally:
            await app.state.shutdown()
