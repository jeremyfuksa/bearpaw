#!/usr/bin/env python3
"""Fail a release when its tag and shipped version sources disagree."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SEMVER = re.compile(
    r"^(?P<version>0|[1-9]\d*)\."
    r"(?:0|[1-9]\d*)\."
    r"(?:0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)


def normalized_version(tag: str) -> str:
    version = tag[1:] if tag.startswith("v") else tag
    if not SEMVER.fullmatch(version):
        raise ValueError(f"release tag must be v-prefixed SemVer, got {tag!r}")
    if not tag.startswith("v"):
        raise ValueError(f"release tag must start with 'v', got {tag!r}")
    return version


def json_version(path: Path, *keys: str) -> str:
    value = json.loads(path.read_text(encoding="utf-8"))
    for key in keys:
        value = value[key]
    if not isinstance(value, str):
        raise ValueError(f"{path}: version is not a string")
    return value


def toml_version(path: Path) -> str:
    in_package = False
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.split("#", 1)[0].strip()
        if stripped.startswith("["):
            in_package = stripped == "[package]"
            continue
        if in_package:
            match = re.fullmatch(r'version\s*=\s*"([^"]+)"', stripped)
            if match:
                return match.group(1)
    raise ValueError(f"{path}: package.version is missing or is not a string")


def inspect_release(root: Path, tag: str) -> list[str]:
    expected = normalized_version(tag)
    sources = {
        "frontend/package.json": json_version(root / "frontend/package.json", "version"),
        "frontend/package-lock.json": json_version(
            root / "frontend/package-lock.json", "version"
        ),
        "frontend/package-lock.json packages['']": json_version(
            root / "frontend/package-lock.json", "packages", "", "version"
        ),
        "frontend/src-tauri/tauri.conf.json": json_version(
            root / "frontend/src-tauri/tauri.conf.json", "version"
        ),
        "crates/bearpaw-api/Cargo.toml": toml_version(
            root / "crates/bearpaw-api/Cargo.toml"
        ),
        "frontend/src-tauri/Cargo.toml": toml_version(
            root / "frontend/src-tauri/Cargo.toml"
        ),
    }
    errors = [
        f"{source} declares {actual}, expected {expected} from {tag}"
        for source, actual in sources.items()
        if actual != expected
    ]

    changelog = (root / "CHANGELOG.md").read_text(encoding="utf-8")
    heading = re.compile(rf"^## \[{re.escape(expected)}\](?:\s|$)", re.MULTILINE)
    if not heading.search(changelog):
        errors.append(f"CHANGELOG.md has no section headed ## [{expected}]")
    return errors


def package_version(root: Path) -> str:
    return json_version(root / "frontend/package.json", "version")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", help="release tag; defaults to v<package version>")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    tag = args.tag or f"v{package_version(args.root)}"

    try:
        errors = inspect_release(args.root, tag)
    except (KeyError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"release preflight failed: {error}", file=sys.stderr)
        return 1
    if errors:
        print("release preflight failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"release preflight passed for {tag}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
