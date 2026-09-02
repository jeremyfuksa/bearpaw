import json
import tempfile
import unittest
from pathlib import Path

from release_preflight import inspect_release, normalized_version


class ReleasePreflightTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        files = {
            "frontend/package.json": json.dumps({"version": "1.1.0"}),
            "frontend/package-lock.json": json.dumps(
                {"version": "1.1.0", "packages": {"": {"version": "1.1.0"}}}
            ),
            "frontend/src-tauri/tauri.conf.json": json.dumps({"version": "1.1.0"}),
            "crates/bearpaw-api/Cargo.toml": '[package]\nversion = "1.1.0"\n',
            "frontend/src-tauri/Cargo.toml": '[package]\nversion = "1.1.0"\n',
            "CHANGELOG.md": "# Changelog\n\n## [1.1.0] — 2026-09-02\n\nReady.\n",
        }
        for relative, contents in files.items():
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(contents, encoding="utf-8")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_matching_release_passes(self) -> None:
        self.assertEqual(inspect_release(self.root, "v1.1.0"), [])

    def test_mismatched_lockfile_and_changelog_fail(self) -> None:
        lockfile = self.root / "frontend/package-lock.json"
        lockfile.write_text(
            json.dumps({"version": "1.0.0", "packages": {"": {"version": "1.0.0"}}}),
            encoding="utf-8",
        )
        (self.root / "CHANGELOG.md").write_text("# Changelog\n", encoding="utf-8")

        errors = inspect_release(self.root, "v1.1.0")

        self.assertEqual(len(errors), 3)
        self.assertTrue(any("package-lock.json declares 1.0.0" in error for error in errors))
        self.assertTrue(any("CHANGELOG.md" in error for error in errors))

    def test_tag_must_be_v_prefixed_semver(self) -> None:
        with self.assertRaisesRegex(ValueError, "start with 'v'"):
            normalized_version("1.1.0")
        with self.assertRaisesRegex(ValueError, "SemVer"):
            normalized_version("vnext")


if __name__ == "__main__":
    unittest.main()
