from __future__ import annotations

import threading
import time
from concurrent.futures import Future
from queue import Queue, Empty
from typing import Optional

import usb.core
import usb.util


class UsbTransport:
    def __init__(
        self,
        vid: int,
        pid: int,
        serial_number: Optional[str] = None,
        timeout: float = 0.5,
        data_interface: int = 1,
        ep_in: int = 0x81,
        ep_out: int = 0x02,
    ):
        self.vid = vid
        self.pid = pid
        self.serial_number = serial_number
        self.timeout = timeout
        self.data_interface = data_interface
        self.ep_in_addr = ep_in
        self.ep_out_addr = ep_out
        self._device: Optional[usb.core.Device] = None
        self._in_ep = None
        self._out_ep = None
        self._queue: Queue[tuple[str, Future]] = Queue()
        self._thread: Optional[threading.Thread] = None
        self._running = threading.Event()

    def connect(self) -> None:
        if self._device:
            return
        self._device = self._find_device()
        if not self._device:
            raise ConnectionError("USB device not found")
        try:
            self._device.set_configuration()
        except Exception:
            pass
        cfg = self._device.get_active_configuration()

        # Detach kernel driver from BOTH interfaces (macOS CDC drivers can hold both)
        for interface_num in [0, self.data_interface]:
            try:
                if self._device.is_kernel_driver_active(interface_num):
                    self._device.detach_kernel_driver(interface_num)
            except Exception:
                pass  # Interface might not exist or already detached

        intf = usb.util.find_descriptor(cfg, bInterfaceNumber=self.data_interface)
        if intf is None:
            raise ConnectionError("USB data interface not found")
        self._setup_cdc_control()
        usb.util.claim_interface(self._device, intf.bInterfaceNumber)

        # Small delay after claiming interface for device to settle (macOS needs this)
        time.sleep(0.1)

        self._out_ep = usb.util.find_descriptor(intf, bEndpointAddress=self.ep_out_addr)
        self._in_ep = usb.util.find_descriptor(intf, bEndpointAddress=self.ep_in_addr)
        if not self._out_ep or not self._in_ep:
            raise ConnectionError("USB endpoints not found")
        self._running.set()
        self._thread = threading.Thread(target=self._worker_loop, daemon=True)
        self._thread.start()

    def disconnect(self) -> None:
        self._running.clear()
        if self._thread:
            self._thread.join(timeout=1.0)
        if self._device:
            try:
                usb.util.release_interface(self._device, self.data_interface)
            except Exception:
                pass
        self._device = None
        self._out_ep = None
        self._in_ep = None

    def reconnect(self, backoff: list[float]) -> None:
        self.disconnect()
        for delay in backoff:
            try:
                time.sleep(delay)
                self.connect()
                return
            except Exception:
                continue
        raise ConnectionError("Failed to reconnect USB transport")

    def send_command(self, cmd: str) -> Future:
        future: Future = Future()
        self._queue.put((cmd, future))
        return future

    def _worker_loop(self) -> None:
        while self._running.is_set():
            try:
                cmd, future = self._queue.get(timeout=0.1)
            except Empty:
                continue
            if future.cancelled():
                continue
            try:
                response = self._execute(cmd)
                if not future.cancelled() and not future.done():
                    future.set_result(response)
            except Exception as exc:
                if not future.cancelled() and not future.done():
                    future.set_exception(exc)

    def _execute(self, cmd: str) -> str:
        if not self._device or not self._out_ep or not self._in_ep:
            raise ConnectionError("USB device not open")
        if not self._is_device_present():
            self._device = None
            self._out_ep = None
            self._in_ep = None
            raise ConnectionError("USB device not open")
        payload = cmd if cmd.endswith("\r") else cmd + "\r"
        self._out_ep.write(payload.encode("ascii"), timeout=int(self.timeout * 1000))
        return self._read_response()

    def _read_response(self) -> str:
        if not self._in_ep:
            raise ConnectionError("USB endpoint not open")
        deadline = time.monotonic() + self.timeout
        buffer = bytearray()
        while time.monotonic() < deadline:
            try:
                data = self._in_ep.read(64, timeout=int(self.timeout * 1000))
            except usb.core.USBTimeoutError:
                continue
            if data:
                buffer.extend(bytes(data))
                if b"\r" in buffer:
                    break
        if not buffer:
            raise TimeoutError("USB response timeout")
        text = buffer.decode("ascii", errors="ignore")
        return text.strip("\r")

    def _find_device(self) -> Optional[usb.core.Device]:
        if self.serial_number:
            return usb.core.find(
                idVendor=self.vid, idProduct=self.pid, serial_number=self.serial_number
            )
        return usb.core.find(idVendor=self.vid, idProduct=self.pid)

    def _is_device_present(self) -> bool:
        try:
            return self._find_device() is not None
        except Exception:
            return False

    def _setup_cdc_control(self) -> None:
        if not self._device:
            return
        # Set line coding: 115200 8N1
        line_coding = bytes([0x00, 0xC2, 0x01, 0x00, 0x00, 0x00, 0x08])
        try:
            self._device.ctrl_transfer(
                0x21, 0x20, 0, 0, line_coding, timeout=int(self.timeout * 1000)
            )
            self._device.ctrl_transfer(
                0x21, 0x22, 0x03, 0, None, timeout=int(self.timeout * 1000)
            )
        except Exception:
            return
