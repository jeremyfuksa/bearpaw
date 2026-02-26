#!/usr/bin/env python3
"""Verify Python/FastAPI and Rust/Axum API route parity.

Compares method + normalized path sets between:
- backend/src/bearpaw/api.py
- crates/bearpaw-api/src/api/mod.rs

Normalization:
- Python `{param}` and Rust `:param` both normalize to `{}`
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PY_API = ROOT / "backend" / "src" / "bearpaw" / "api.py"
RS_API = ROOT / "crates" / "bearpaw-api" / "src" / "api" / "mod.rs"


def normalize_python_path(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "{}", path)


def normalize_rust_path(path: str) -> str:
    return re.sub(r":[A-Za-z_][A-Za-z0-9_]*", "{}", path)


def parse_python_routes(text: str) -> set[tuple[str, str]]:
    matches = re.findall(
        r'@app\.(get|post|put|delete)\(\s*"([^"]+)"',
        text,
        flags=re.S,
    )
    return {(method.upper(), normalize_python_path(path)) for method, path in matches}


def parse_rust_routes(text: str) -> set[tuple[str, str]]:
    routes: set[tuple[str, str]] = set()
    for match in re.finditer(r'\.route\(\s*"([^"]+)"', text):
        path = match.group(1)
        route_start = match.start()
        open_paren = text.find("(", route_start)
        depth = 0
        end = open_paren
        for idx in range(open_paren, len(text)):
            char = text[idx]
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    end = idx
                    break
        body = text[text.find(",", match.end() - 1) + 1 : end]
        norm_path = normalize_rust_path(path)
        for method in ("get", "post", "put", "delete"):
            if re.search(rf"\b{method}\s*\(", body):
                routes.add((method.upper(), norm_path))
    return routes


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--strict-extra",
        action="store_true",
        help="Fail if Rust has method/path pairs not present in Python.",
    )
    args = parser.parse_args()

    py_routes = parse_python_routes(PY_API.read_text())
    rs_routes = parse_rust_routes(RS_API.read_text())

    missing_in_rust = sorted(py_routes - rs_routes)
    extra_in_rust = sorted(rs_routes - py_routes)

    print(f"python method/path count: {len(py_routes)}")
    print(f"rust method/path count:   {len(rs_routes)}")
    print(f"missing in rust:          {len(missing_in_rust)}")
    for method, path in missing_in_rust:
        print(f"  MISSING {method} {path}")
    print(f"extra in rust:            {len(extra_in_rust)}")
    for method, path in extra_in_rust:
        print(f"  EXTRA   {method} {path}")

    if missing_in_rust:
        return 1
    if args.strict_extra and extra_in_rust:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
