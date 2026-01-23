#!/usr/bin/env python3
"""
Mock BC125AT scanner hardware server for E2E testing.

Simulates the BC125AT serial protocol responses without requiring physical hardware.
Runs as a pseudo-terminal that responds to scanner commands.
"""

import asyncio
import sys
from typing import Optional, List, Dict, Tuple


class MockBC125ATScanner:
    def __init__(self):
        self.in_program_mode = False
        self.current_channel = 1
        self.frequency = 151.25
        self.mode = "SCAN"
        self.volume = 10
        self.squelch = 5
        self.channels = self._generate_default_channels()

    def _generate_default_channels(self) -> Dict[int, Dict]:
        return {
            i: {
                "index": i,
                "frequency": 140.0 + (i * 0.5),
                "modulation": "FM" if i % 3 == 0 else "NFM",
                "alpha_tag": f"Test Channel {i}",
                "delay": 2,
                "lockout": False,
                "priority": False,
                "tone_squelch": None,
                "bank": ((i - 1) // 50) + 1,
            }
            for i in range(1, 501)
        }

    async def handle_command(self, command: str) -> str:
        if not command:
            return "ERROR: Empty command"

        command = command.strip()

        if command == "STS":
            return self._handle_status()
        elif command == "GLG":
            return self._handle_glg()
        elif command.startswith("PRG"):
            return await self._handle_prg(command)
        elif command == "EPG":
            return "EPG"
        elif command == "MDL":
            return "BC125AT,1.0.12"
        elif command == "KEY":
            return self._handle_key(command)
        elif command == "KEY" and len(command) > 3:
            return await self._handle_key(command)
        elif command == "SIN":
            return "0"
        elif command.startswith("SIN"):
            return await self._handle_scan(command)
        elif command == "HLD":
            return self._handle_hold()
        elif command == "SCN":
            return self._handle_scan()
        elif command == "SQS":
            return f"SQ,{self.squelch:03d}"
        elif command == "SQL":
            self.squelch = max(0, self.squelch - 1)
            return f"SQ,{self.squelch:03d}"
        elif command == "VOL":
            return self._handle_volume(command)
        elif command.startswith("VOL"):
            return self._handle_volume(command)
        else:
            return f"ERR: Unknown command: {command}"

    def _handle_status(self) -> str:
        return f"STS,{self.frequency:07.4f},{self.mode:4s},{self.current_channel:03d},{self.alpha_tag_for_channel():16s},{self.volume:02d},{85:03d},{0}"

    def _handle_glg(self) -> str:
        return f"GLG,{self.alpha_tag_for_channel():16s},{self.frequency: 151.2500}"

    def _alpha_tag_for_channel(self) -> str:
        channel_data = self.channels.get(self.current_channel, {})
        return channel_data.get("alpha_tag", "")[:16]

    async def _handle_prg(self, command: str) -> str:
        if command == "PRG":
            self.in_program_mode = True
            return "OK"
        elif command.startswith("PRG,"):
            parts = command.split(",")
            if len(parts) >= 2:
                self.current_channel = int(parts[1].strip())
        return "OK"

    async def _handle_key(self, command: str) -> str:
        if command == "KEY":
            return "KEY"
        elif command.startswith("KEY"):
            return "KEY"
        elif command == "KEY,H":
            return "KEY,H"
        elif command.startswith("KEY,"):
            return command
        else:
            return "OK"

    def _handle_hold(self) -> str:
        self.mode = "HLD"
        return "HLD"

    def _handle_scan(self) -> str:
        self.mode = "SCN"
        return "SCN"

    def _handle_scan_commands(self, command: str) -> str:
        if command == "SIN":
            return "0"
        elif command == "SCN":
            self.mode = "SCN"
            return "SCN"
        elif command == "HLD":
            self.mode = "HLD"
            return "HLD"
        else:
            return f"ERR: Unknown command: {command}"

    def _handle_volume(self, command: str) -> str:
        if command == "VOL":
            return f"VOL,{self.volume:02d}"
        elif command.startswith("VOL,"):
            try:
                new_vol = int(command.split(",")[1].strip())
                if 0 <= new_vol <= 15:
                    self.volume = new_vol
                return f"VOL,{new_vol:02d}"
            except (ValueError, IndexError):
                return "ERR: Invalid volume"
        elif command.startswith("VOL,"):
            return self._handle_volume(command)
        else:
            return f"ERR: Unknown volume command: {command}"


class MockSerialPort:
    def __init__(self, mock_scanner: MockBC125ATScanner):
        self.mock_scanner = mock_scanner

    def write(self, data: bytes):
        command_str = data.decode('utf-8').strip()
        print(f"[RECV] {command_str}")
        return asyncio.create_task(self._process_command(command_str))

    async def process_command(self, command: str) -> str:
        response = self.mock_scanner.handle_command(command)
        print(f"[SEND] {response}")
        return response

    async def readline(self) -> bytes:
        return b"\r\n"

    async def read(self, size: int = -1) -> bytes:
        return b""


async def mock_scanner_server():
    """Run mock BC125AT scanner server on pseudo-terminal"""
    print("=" * 60)
    print("Mock BC125AT Scanner Server for E2E Testing")
    print("=" * 60)
    print("Starting server on /dev/pts/1 (pseudo-terminal)")
    print("Press Ctrl+C to stop")
    print()

    mock_scanner = MockBC125ATScanner()

    try:
        from serial_asyncio import create_serial_connection

        ser = await create_serial_connection('/dev/pts/1', baudrate=57600)
        ser = MockSerialPort(mock_scanner)

        print("Mock scanner server started")
        print("Waiting for commands...")
        print()

        while True:
            try:
                data = await ser.readline()
                if data:
                    command = data.decode('utf-8').strip()
                    if command:
                        response = await ser.process_command(command)

            except (KeyboardInterrupt, asyncio.CancelledError):
                print("\n" + "=" * 60)
                print("Mock scanner server stopped")
                print("=" * 60)
                break


if __name__ == "__main__":
    try:
        asyncio.run(mock_scanner_server())
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)
