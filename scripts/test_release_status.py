"""Tests for the pure parsing in release_status."""

import unittest

import release_status


class UnreleasedEntriesTest(unittest.TestCase):
    def test_reads_only_the_unreleased_section(self):
        changelog = (
            "# Changelog\n\n"
            "## [Unreleased]\n\n"
            "- **A fix that has not shipped.** Detail.\n"
            "- **A second one.**\n\n"
            "## [1.1.0] - 2026-09-02\n\n"
            "- **An entry that already shipped.**\n"
        )
        self.assertEqual(
            release_status.unreleased_entries(changelog),
            ["**A fix that has not shipped.** Detail.", "**A second one.**"],
        )

    def test_empty_unreleased_section_reports_nothing(self):
        changelog = "# Changelog\n\n## [Unreleased]\n\n## [1.1.0] - 2026-09-02\n\n- **Shipped.**\n"
        self.assertEqual(release_status.unreleased_entries(changelog), [])

    def test_missing_unreleased_section_reports_nothing(self):
        self.assertEqual(release_status.unreleased_entries("# Changelog\n\n## [1.1.0]\n"), [])

    def test_unreleased_last_in_file_still_reads(self):
        # Guards the slice: with no following heading there is no match to
        # bound the section, and a naive implementation returns nothing.
        changelog = "# Changelog\n\n## [Unreleased]\n\n- **Only entry.**\n"
        self.assertEqual(release_status.unreleased_entries(changelog), ["**Only entry.**"])


if __name__ == "__main__":
    unittest.main()
