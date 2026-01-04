# Driver Extension Guide

## Overview

Scanner drivers live in `backend/src/scanner_bridge/protocol/`. Each driver implements the `ScannerDriver` interface and is responsible for command formatting, response parsing, and mapping status fields into `LiveState`.

## Steps to Add a New Driver

1) Create a new module in `backend/src/scanner_bridge/protocol/`.
2) Implement the `ScannerDriver` abstract methods.
3) Parse status responses into `LiveState`.
4) Implement `read_channel()` for memory sync.
5) Add model detection and selection in `backend/src/scanner_bridge/api.py`.

## Command/Response Template

```python
class NewModelDriver(ScannerDriver):
    def __init__(self, scheduler: CommandScheduler):
        self._scheduler = scheduler
        self._mode = "SCAN"

    async def detect_model(self) -> str:
        response = await self._send("MDL", PRIORITY_CONTROL)
        return response.split(",", 1)[1].strip()

    async def get_status(self) -> LiveState:
        response = await self._send("STS", PRIORITY_TELEMETRY)
        fields = self.parse_key_value_pairs(response)
        # Map fields here
        return LiveState(...)

    async def _send(self, raw: str, priority: int) -> str:
        future = self._scheduler.enqueue(raw, priority)
        return await future
```

## Testing Requirements

- Unit tests for status parsing and command formatting.
- Mock scheduler responses for deterministic test coverage.
- Update `backend/tests/test_protocol.py` with representative samples.

## Integration Checklist

- Device detection VID:PID or serial signature added to discovery.
- Command set documented in `docs/BACKEND_SPEC.md`.
- Update OpenAPI and WebSocket docs if schema changes.
