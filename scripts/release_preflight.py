#!/usr/bin/env python3
"""Fail a release when its tag and shipped version sources disagree, or when
`tauri build` would refuse to run because a Tauri crate and its npm package
have drifted apart (#808)."""

from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
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


# Tauri's own check (tauri-cli `info/plugins.rs`, `check_mismatched_packages`)
# pairs each crate with its npm package, requires the same major.minor, and
# skips any crate whose version does not parse as a full X.Y.Z. Without a
# committed Cargo.lock it reads the version straight from Cargo.toml, so a bare
# "2" is never compared while "2.7.2" is. Mirror that exactly: stricter would
# fail PRs `tauri build` accepts, looser would miss the v1.2.0 failure.
# If Cargo.lock is ever committed, Tauri reads the LOCKED version instead and
# this must follow.
FULL_VERSION = re.compile(r"^\d+\.\d+\.\d+$")


def tauri_drift_errors(root: Path) -> list[str]:
    manifest = tomllib.loads(
        (root / "frontend/src-tauri/Cargo.toml").read_text(encoding="utf-8")
    )
    lock = json.loads((root / "frontend/package-lock.json").read_text(encoding="utf-8"))
    installed = lock.get("packages", {})
    errors = []
    for crate, spec in manifest.get("dependencies", {}).items():
        if crate == "tauri":
            npm = "@tauri-apps/api"
        elif crate.startswith("tauri-plugin-"):
            npm = "@tauri-apps/plugin-" + crate.removeprefix("tauri-plugin-")
        else:
            continue
        crate_version = spec.get("version") if isinstance(spec, dict) else spec
        npm_version = installed.get(f"node_modules/{npm}", {}).get("version")
        if not crate_version or not FULL_VERSION.match(crate_version) or not npm_version:
            continue
        if crate_version.split(".")[:2] != npm_version.split(".")[:2]:
            errors.append(
                f"{crate} {crate_version} (frontend/src-tauri/Cargo.toml) and "
                f"{npm} {npm_version} (frontend/package-lock.json) are on "
                "different minor releases; `tauri build` refuses to run"
            )
    return errors


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
    errors.extend(tauri_drift_errors(root))
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
