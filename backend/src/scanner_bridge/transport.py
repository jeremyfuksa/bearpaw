from __future__ import annotations

import os
import threading
import time
from concurrent.futures import Future
from queue import Queue, Empty
from typing import Optional

import serial


class SerialTransport:
    def __init__(self, port: str, baud: int = 115200, timeout: float = 0.5):
        self.port_name = port
        self.baud = baud
        self.timeout = timeout
        self._port: Optional[serial.Serial] = None
        self._queue: Queue[tuple[str, Future]] = Queue()
        self._thread: Optional[threading.Thread] = None
        self._running = threading.Event()
        self._lock_fd: Optional[int] = None

    def connect(self) -> None:
        if self._port and self._port.is_open:
            return
        self._acquire_lock()
        try:
            self._port = serial.Serial(self.port_name, self.baud, timeout=self.timeout)
        except PermissionError as exc:
            self._release_lock()
            raise PermissionError(
                f"Permission denied opening serial port {self.port_name}"
            ) from exc
        except OSError as exc:
            self._release_lock()
            raise ConnectionError(f"Failed to open serial port {self.port_name}") from exc
        self._running.set()
        self._thread = threading.Thread(target=self._worker_loop, daemon=True)
        self._thread.start()

    def disconnect(self) -> None:
        self._running.clear()
        if self._thread:
            self._thread.join(timeout=1.0)
        if self._port and self._port.is_open:
            self._port.close()
        self._port = None
        self._release_lock()

    def reconnect(self, backoff: list[float]) -> None:
        self.disconnect()
        for delay in backoff:
            try:
                time.sleep(delay)
                self.connect()
                return
            except Exception:
                continue
        raise ConnectionError("Failed to reconnect serial transport")

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
                future.set_result(response)
            except Exception as exc:
                future.set_exception(exc)

    def _execute(self, cmd: str) -> str:
        if not self._port or not self._port.is_open:
            raise ConnectionError("Serial port is not open")

        payload = cmd if cmd.endswith("\r") else cmd + "\r"
        self._port.write(payload.encode("ascii"))
        self._port.flush()

        try:
            return self._read_response()
        except TimeoutError:
            self._port.reset_input_buffer()
            return self._read_response()

    def _read_response(self) -> str:
        if not self._port:
            raise ConnectionError("Serial port is not open")

        deadline = time.monotonic() + self.timeout
        buffer = bytearray()
        while time.monotonic() < deadline:
            chunk = self._port.read(1)
            if chunk:
                buffer.extend(chunk)
                deadline = time.monotonic() + self.timeout
                continue
            if buffer:
                break
        if not buffer:
            raise TimeoutError("Serial response timeout")
        text = buffer.decode("ascii", errors="ignore")
        if "\r" not in text:
            raise TimeoutError("Incomplete serial response")
        return text.strip("\r")

    def _lock_path(self) -> str:
        safe = self.port_name.replace("/", "_").replace("\\", "_").replace(":", "_")
        return f"/tmp/scanner-bridge-{safe}.lock"

    def _acquire_lock(self) -> None:
        path = self._lock_path()
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_RDWR)
        except FileExistsError as exc:
            raise RuntimeError(f"Serial port already locked: {path}") from exc
        self._lock_fd = fd

    def _release_lock(self) -> None:
        if self._lock_fd is None:
            return
        path = self._lock_path()
        try:
            os.close(self._lock_fd)
        finally:
            self._lock_fd = None
            if os.path.exists(path):
                os.unlink(path)
