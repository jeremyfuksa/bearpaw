# Release checklist

Use this checklist for every stable or pre-release tag.

- Confirm the version and date in `CHANGELOG.md`.
- Confirm the shipped version fields in both Cargo manifests,
  `frontend/package.json`, `frontend/package-lock.json`, and
  `frontend/src-tauri/tauri.conf.json` agree with the tag.
- Review the supported-version and supported-scanner wording in `README.md`,
  `SECURITY.md`, `CONTRIBUTING.md`, and the installation copy in
  `.github/workflows/build.yml`. A model or support-policy change is not complete
  until all four user-facing locations agree.
- Run `python3 scripts/docs_readability.py` and confirm the guide is inside its
  grade ceiling with no unlinked glossary terms. The release pipeline enforces
  this, but reading the report catches a page drifting toward the ceiling before
  it crosses.
- Run the backend tests and workspace check, then the frontend tests, lint, type
  check, formatting check, and production build.
- Verify the tag points at the exact commit that passed those checks before
  publishing installers.
