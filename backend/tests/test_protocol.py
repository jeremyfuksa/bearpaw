import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from bearpaw.protocol.base import ScannerDriver
from bearpaw.protocol.bc125at import BC125ATDriver
from bearpaw.protocol.sr30c import SR30CDriver


class StubScheduler:
    def __init__(self, responses):
        self._responses = iter(responses)

    def enqueue(self, raw, priority):
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        future.set_result(next(self._responses))
        return future


class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    def test_parse_key_value_pairs(self) -> None:
        payload = "SQL,0\rRSSI,75\rFRQ,151.2500\r"
        fields = ScannerDriver.parse_key_value_pairs(payload)
        self.assertEqual(fields["SQL"], "0")
        self.assertEqual(fields["RSSI"], "75")
        self.assertEqual(fields["FRQ"], "151.2500")

    async def test_bc125at_get_status(self) -> None:
        response = "SQL,0\rRSSI,75\rSYS,USA\rMOD,FM\rCH,025\rFRQ,151.2500\rVOL,10\rBAT,100\r"
        driver = BC125ATDriver(StubScheduler([response]))
        state = await driver.get_status()
        self.assertEqual(state.frequency, 151.25)
        self.assertEqual(state.modulation, "FM")
        self.assertEqual(state.rssi, 75)
        self.assertTrue(state.squelch_open)
        self.assertEqual(state.channel, 25)
        self.assertEqual(state.volume, 10)
        self.assertEqual(state.battery, 100)

    async def test_sr30c_get_status_defaults(self) -> None:
        response = "SQL,1\rRSSI,68\rCH,012\rFRQ,154.6000\r"
        driver = SR30CDriver(StubScheduler([response]))
        state = await driver.get_status()
        self.assertEqual(state.modulation, "AUTO")
        self.assertIsNone(state.battery)
        self.assertFalse(state.squelch_open)

    async def test_bc125at_read_channel(self) -> None:
        responses = [
            "OK",
            "OK",
            "CIN,001,151.2500,FM,Police,2,0,1,103.5,1",
            "OK",
            "OK",
        ]
        driver = BC125ATDriver(StubScheduler(responses))
        channel = await driver.read_channel(1)
        self.assertEqual(channel.frequency, 151.25)
        self.assertEqual(channel.modulation, "FM")
        self.assertEqual(channel.alpha_tag, "Police")
        self.assertEqual(channel.delay, 2)
        self.assertFalse(channel.lockout)
        self.assertTrue(channel.priority)
        self.assertEqual(channel.tone_squelch, 103.5)
        self.assertEqual(channel.bank, 1)


if __name__ == "__main__":
    unittest.main()
