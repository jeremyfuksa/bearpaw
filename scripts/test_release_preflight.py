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

    def write_tauri_versions(self, crates: str, npm: dict[str, str]) -> None:
        (self.root / "frontend/src-tauri/Cargo.toml").write_text(
            '[package]\nversion = "1.1.0"\n\n[dependencies]\n' + crates, encoding="utf-8"
        )
        packages = {"": {"version": "1.1.0"}}
        for name, version in npm.items():
            packages[f"node_modules/{name}"] = {"version": version}
        (self.root / "frontend/package-lock.json").write_text(
            json.dumps({"version": "1.1.0", "packages": packages}), encoding="utf-8"
        )

    # #808: the v1.2.0 tag build failed on every platform with exactly this pair.
    def test_tauri_plugin_minor_drift_fails(self) -> None:
        self.write_tauri_versions(
            'tauri-plugin-dialog = "2.7.2"\n',
            {"@tauri-apps/plugin-dialog": "2.8.2"},
        )

        errors = inspect_release(self.root, "v1.1.0")

        self.assertEqual(
            errors,
            [
                "tauri-plugin-dialog 2.7.2 (frontend/src-tauri/Cargo.toml) and "
                "@tauri-apps/plugin-dialog 2.8.2 (frontend/package-lock.json) are on "
                "different minor releases; `tauri build` refuses to run"
            ],
        )

    def test_tauri_api_drift_fails_through_a_table_dependency(self) -> None:
        self.write_tauri_versions(
            'tauri = { version = "2.11.0", features = ["image-png"] }\n',
            {"@tauri-apps/api": "2.12.4"},
        )

        errors = inspect_release(self.root, "v1.1.0")

        self.assertEqual(len(errors), 1)
        self.assertIn("tauri 2.11.0", errors[0])
        self.assertIn("@tauri-apps/api 2.12.4", errors[0])

    def test_matching_minors_and_bare_majors_pass(self) -> None:
        # Tauri only compares a crate whose version parses as full X.Y.Z, so a
        # bare "2" is skipped by `tauri build` and must be skipped here too.
        self.write_tauri_versions(
            'tauri = { version = "2" }\n'
            'tauri-plugin-fs = "2.7.1"\n'
            'tauri-plugin-shell = "2"\n'
            'tauri-plugin-opener = "2"\n',
            {
                "@tauri-apps/api": "2.12.4",
                "@tauri-apps/plugin-fs": "2.7.9",
                "@tauri-apps/plugin-shell": "2.6.0",
            },
        )

        self.assertEqual(inspect_release(self.root, "v1.1.0"), [])

    def test_tag_must_be_v_prefixed_semver(self) -> None:
        with self.assertRaisesRegex(ValueError, "start with 'v'"):
            normalized_version("1.1.0")
        with self.assertRaisesRegex(ValueError, "SemVer"):
            normalized_version("vnext")


if __name__ == "__main__":
    unittest.main()
