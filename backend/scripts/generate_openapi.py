from __future__ import annotations

import json
from pathlib import Path

from scanner_bridge.api import create_app
from scanner_bridge.config import AppConfig


def main() -> None:
    app = create_app(AppConfig(), startup_enabled=False)
    output = Path(__file__).resolve().parents[2] / "docs" / "openapi.json"
    output.write_text(json.dumps(app.openapi(), indent=2), encoding="ascii")


if __name__ == "__main__":
    main()
