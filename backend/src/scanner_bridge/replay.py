from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Iterator, List


@dataclass
class ReplayEvent:
    timestamp: float
    direction: str
    data: str


class SerialReplay:
    def __init__(self, events: List[ReplayEvent]):
        self._events = events
        self._index = 0

    @classmethod
    def from_file(cls, path: str) -> "SerialReplay":
        with open(path, "r", encoding="ascii") as handle:
            payload = json.load(handle)
        events = [ReplayEvent(**item) for item in payload]
        return cls(events)

    def __iter__(self) -> Iterator[ReplayEvent]:
        return self

    def __next__(self) -> ReplayEvent:
        if self._index >= len(self._events):
            raise StopIteration
        event = self._events[self._index]
        self._index += 1
        return event

    def reset(self) -> None:
        self._index = 0
