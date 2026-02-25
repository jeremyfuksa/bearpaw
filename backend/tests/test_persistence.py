import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from bearpaw.models import ChannelData, ShadowState
from bearpaw.persistence import JsonPersistence, SQLitePersistence


class JsonPersistenceTests(unittest.TestCase):
    def test_save_and_load_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = f"{tmpdir}/shadow.json"
            persistence = JsonPersistence(path)
            shadow = ShadowState(
                channels={
                    1: ChannelData(
                        index=1,
                        frequency=151.25,
                        modulation="FM",
                        alpha_tag="Police",
                        delay=2,
                        lockout=False,
                        priority=True,
                        tone_squelch=103.5,
                        bank=1,
                    )
                },
                last_sync=123.45,
                dirty=False,
            )
            persistence.save(shadow)
            loaded = persistence.load()
            self.assertEqual(loaded.last_sync, 123.45)
            self.assertFalse(loaded.dirty)
            self.assertIn(1, loaded.channels)
            self.assertEqual(loaded.channels[1].alpha_tag, "Police")


class SQLitePersistenceTests(unittest.TestCase):
    def test_save_and_load_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = f"{tmpdir}/shadow.db"
            persistence = SQLitePersistence(path)
            shadow = ShadowState(
                channels={
                    2: ChannelData(
                        index=2,
                        frequency=154.6,
                        modulation="FM",
                        alpha_tag="Fire",
                        delay=2,
                        lockout=True,
                        priority=False,
                        tone_squelch=None,
                        bank=2,
                    )
                },
                last_sync=42.0,
                dirty=False,
            )
            persistence.save(shadow)
            loaded = persistence.load()
            self.assertEqual(loaded.last_sync, 42.0)
            self.assertIn(2, loaded.channels)
            self.assertTrue(loaded.channels[2].lockout)


if __name__ == "__main__":
    unittest.main()
