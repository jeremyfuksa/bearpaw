import os
import sys
import time
import unittest

sys.path.insert(
    0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src"))
)

from scanner_bridge.models import ChannelData, LiveState
from scanner_bridge.state import StateStore


class StateStoreTests(unittest.TestCase):
    def test_get_live_state_defaults_to_stale(self) -> None:
        store = StateStore()
        state = store.get_live_state()
        self.assertTrue(state.stale)
        self.assertEqual(state.frequency, 0.0)

    def test_update_live_state_returns_changes(self) -> None:
        store = StateStore()
        now = time.time()
        state1 = LiveState(
            timestamp=now,
            frequency=151.25,
            modulation="FM",
            squelch_open=True,
            rssi=75,
            mode="SCAN",
            channel=1,
            alpha_tag="TEST",
            volume=10,
            battery=100,
            stale=False,
        )
        changes = store.update_live_state(state1)
        self.assertIn("frequency", changes)

        state2 = LiveState(
            timestamp=now + 1,
            frequency=151.25,
            modulation="FM",
            squelch_open=False,
            rssi=60,
            mode="SCAN",
            channel=1,
            alpha_tag="TEST",
            volume=10,
            battery=100,
            stale=False,
        )
        changes = store.update_live_state(state2)
        self.assertEqual(
            changes, {"squelch_open": False, "rssi": 60, "timestamp": now + 1}
        )

    def test_mark_live_state_stale(self) -> None:
        store = StateStore()
        state = LiveState(
            timestamp=time.time(),
            frequency=151.25,
            modulation="FM",
            squelch_open=True,
            rssi=75,
            mode="SCAN",
            channel=1,
            alpha_tag="TEST",
            volume=10,
            battery=100,
            stale=False,
        )
        store.update_live_state(state)
        changes = store.mark_live_state_stale()
        self.assertTrue(changes.get("stale"))

    def test_shadow_channel_filters_by_bank(self) -> None:
        store = StateStore()
        store.set_shadow_state(
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
                ),
                2: ChannelData(
                    index=2,
                    frequency=154.6,
                    modulation="FM",
                    alpha_tag="Fire",
                    delay=2,
                    lockout=False,
                    priority=False,
                    tone_squelch=None,
                    bank=2,
                ),
            }
        )
        bank1 = store.get_shadow_channels(bank=1)
        self.assertEqual(list(bank1.keys()), [1])


if __name__ == "__main__":
    unittest.main()
