# Data Lifecycle Policy

## Purpose

Define how Bearpaw stores, migrates, retains, and cleans up local data so app updates and restarts behave predictably.

## Storage Locations

- The desktop app sets `BEARPAW_DATA_DIR` to Tauri app-data (`app.path().app_data_dir()`).
- Backend DB files resolve in this order:
1. `BEARPAW_PREFERENCES_DB` / `BEARPAW_ANALYTICS_DB` (explicit path override)
2. `BEARPAW_DATA_DIR` + default filename
3. OS data directory fallback (`~/Library/Application Support/Bearpaw` on macOS)
- Repository-local DB files are not used for runtime persistence.

## Databases

- Preferences DB: `scanner.db` (key/value preferences)
- Analytics DB: `analytics.db` (scan hit history and aggregates)

## Update & Migration Rules

- Each DB uses SQLite `PRAGMA user_version`.
- Migrations are forward-only and idempotent.
- Before applying a version bump migration, backend creates a `.bak` copy in the same directory.
- On startup, backend runs migrations before reads/writes.

## Persistence Guarantees

- Data persists across app restarts.
- Data survives app updates as long as app-data directory is preserved by OS installer/update path.
- Uninstall behavior depends on platform uninstall semantics (some platforms may remove app-data).

## Retention Rules

- Preferences: retained indefinitely unless user reset.
- Analytics: retained by `data_retention_days` preference (default 30 days).
- Cleanup runs:
1. Once at backend startup
2. Daily while backend is running
- Manual cleanup endpoint remains available.

## SQLite Runtime Settings

- `journal_mode = WAL`
- `synchronous = NORMAL`
- `busy_timeout = 5s`

These settings balance durability and responsiveness for concurrent access patterns in desktop runtime.

## Ground Rules for Contributors

- Never commit runtime DB files (`*.db`, `*.db-wal`, `*.db-shm`) from backend runtime directories.
- Schema changes must include:
1. migration step
2. version bump
3. migration test for upgrade from prior schema
- Do not introduce cwd-relative DB paths for production runtime.
