import os
import sys
import time
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

import usb.core

from bearpaw.transport_usb import UsbTransport

VID = 0x1965
PID = 0x0017


def _device_present() -> bool:
    return usb.core.find(idVendor=VID, idProduct=PID) is not None


@unittest.skipUnless(
    os.environ.get("HARDWARE_TESTS") == "1" and _device_present(),
    "Hardware tests require HARDWARE_TESTS=1 and attached BC125AT",
)
class HardwareTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        serial = os.environ.get("SCANNER_USB_SERIAL")
        cls.transport = UsbTransport(VID, PID, serial_number=serial, timeout=0.5)
        cls.transport.connect()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.transport.disconnect()

    def _send(self, cmd: str) -> str:
        future = self.transport.send_command(cmd)
        return future.result(timeout=2.0)

    def test_mdl(self) -> None:
        response = self._send("MDL")
        self.assertIn("BC125AT", response)

    def test_glg(self) -> None:
        response = self._send("GLG")
        self.assertTrue(response.startswith("GLG,"))

    def test_sts(self) -> None:
        response = self._send("STS")
        self.assertTrue(response.startswith("STS,"))

    def test_hold_scan_toggle(self) -> None:
        hold = self._send("KEY,H,P")
        self.assertTrue(hold.strip().endswith("OK"))
        time.sleep(0.1)
        scan = self._send("KEY,S,P")
        self.assertTrue(scan.strip().endswith("OK"))

    def test_memory_read_channel_1(self) -> None:
        self._send("KEY,H,P")
        self._send("PRG")
        response = self._send("CIN,1")
        self._send("EPG")
        self.assertTrue(response.startswith("CIN,") or response.startswith("CIN"))


if __name__ == "__main__":
    unittest.main()
