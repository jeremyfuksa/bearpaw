import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from bearpaw.replay import SerialReplay


class ReplayTests(unittest.TestCase):
    def test_replay_iterates_events(self) -> None:
        events = [
            {"timestamp": 0.0, "direction": "tx", "data": "STS\r"},
            {"timestamp": 0.05, "direction": "rx", "data": "SQL,0\r"},
        ]
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "capture.json")
            with open(path, "w", encoding="ascii") as handle:
                json.dump(events, handle)
            replay = SerialReplay.from_file(path)
            data = [event.data for event in replay]
            self.assertEqual(data, ["STS\r", "SQL,0\r"])


if __name__ == "__main__":
    unittest.main()
