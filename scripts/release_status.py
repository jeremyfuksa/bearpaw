#!/usr/bin/env python3
"""Report where the current release stands. Reports; never gates.

`release_preflight.py` decides whether a tag may be built. This answers the
question you ask before you get there — "is 1.1 ready, and if not, what is
outstanding?" — so the answer is a command rather than an archaeology dig.

It reuses release_preflight's checks rather than restating them. Two
implementations of one question is the defect this process exists to remove.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import release_preflight as preflight  # noqa: E402  (needs the path above)

UNRELEASED = re.compile(r"^## \[Unreleased\]\s*$", re.MULTILINE)
NEXT_HEADING = re.compile(r"^## \[", re.MULTILINE)


def unreleased_entries(changelog: str) -> list[str]:
    """The bullet leads recorded under [Unreleased], in order."""
    start = UNRELEASED.search(changelog)
    if not start:
        return []
    rest = changelog[start.end() :]
    end = NEXT_HEADING.search(rest)
    body = rest[: end.start()] if end else rest
    return [line.strip()[2:].strip() for line in body.splitlines() if line.startswith("- ")]


def gh(*args: str) -> str | None:
    """Run gh, returning None when it is absent or the call fails."""
    try:
        done = subprocess.run(
            ["gh", *args], capture_output=True, text=True, timeout=30, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout.strip() if done.returncode == 0 else None


def merged_undeleted_branches() -> list[str] | None:
    """Remote branches with no commits of their own left to land."""
    if subprocess.run(["git", "fetch", "--prune", "origin"], capture_output=True).returncode:
        return None
    listing = subprocess.run(
        ["git", "branch", "-r", "--no-merged", "origin/main"],
        capture_output=True,
        text=True,
        check=False,
    )
    stale = []
    for line in listing.stdout.splitlines():
        branch = line.strip()
        if not branch.startswith("origin/"):
            continue  # a different remote, e.g. a security-advisory fork
        cherry = subprocess.run(
            ["git", "cherry", "origin/main", branch],
            capture_output=True,
            text=True,
            check=False,
        )
        if not any(l.startswith("+") for l in cherry.stdout.splitlines()):
            stale.append(branch)
    return stale


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    root = args.root

    version = preflight.package_version(root)
    tag = f"v{version}"
    print(f"Declared version   {version}   (release would be tagged {tag})")

    errors = preflight.inspect_release(root, tag)
    if errors:
        print("Release preflight  FAILING")
        for error in errors:
            print(f"                   - {error}")
    else:
        print("Release preflight  passing (version sources agree, changelog section present)")

    tags = subprocess.run(
        ["git", "tag", "--list", tag], capture_output=True, text=True, check=False
    ).stdout.strip()
    print(f"Tag {tag:<14} {'exists' if tags else 'DOES NOT EXIST — this release is unpublished'}")

    milestones = gh("api", "--paginate", "repos/{owner}/{repo}/milestones?state=all")
    if milestones is None:
        print("Milestone          unknown (gh unavailable or not authenticated)")
    else:
        found = next((m for m in json.loads(milestones) if m["title"] == tag), None)
        if found is None:
            print(f"Milestone          MISSING — no milestone named {tag}")
        elif found["open_issues"]:
            print(f"Milestone          {found['open_issues']} OPEN, {found['closed_issues']} closed — the release gate will refuse this tag")
        else:
            print(f"Milestone          clear ({found['closed_issues']} closed)")

    entries = unreleased_entries((root / "CHANGELOG.md").read_text(encoding="utf-8"))
    if entries:
        print(f"[Unreleased]       {len(entries)} entr{'y' if len(entries) == 1 else 'ies'} not yet in a release:")
        for entry in entries:
            print(f"                   - {entry[:88]}")
    else:
        print("[Unreleased]       empty")

    stale = merged_undeleted_branches()
    if stale is None:
        print("Stale branches     unknown (could not fetch)")
    elif stale:
        print(f"Stale branches     {len(stale)} fully merged and undeleted:")
        for branch in stale:
            print(f"                   - {branch}")
    else:
        print("Stale branches     none")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
