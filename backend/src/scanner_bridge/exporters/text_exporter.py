from __future__ import annotations

import os
import tempfile
from typing import Iterable

from scanner_bridge.models import LiveState


class TextFileExporter:
    def __init__(
        self,
        path: str,
        template: str,
        update_on: Iterable[str],
        blank_on_squelch_closed: bool = False,
    ):
        self._path = path
        self._template = template
        self._update_on = set(update_on)
        self._blank_on_squelch_closed = blank_on_squelch_closed

    def should_update(self, changes: dict) -> bool:
        return any(field in changes for field in self._update_on)

    def write(self, state: LiveState, alpha_tag: str = "") -> None:
        if self._blank_on_squelch_closed and not state.squelch_open:
            payload = ""
        else:
            payload = self._template.format(
                frequency=f"{state.frequency:.4f}",
                modulation=state.modulation,
                alpha_tag=alpha_tag,
            )
        os.makedirs(os.path.dirname(self._path) or ".", exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(prefix="now-scanning-", suffix=".txt")
        try:
            with os.fdopen(fd, "w", encoding="ascii") as handle:
                handle.write(payload)
            os.replace(tmp_path, self._path)
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
