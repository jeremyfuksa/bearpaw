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

- Preferences DB: `scanner.db` — key/value preferences, plus the
  `channel_memory` table (schema version 2, #413): cached channel memory keyed
  by `(scanner_id, channel_index)`. `scanner_id` is the fixed placeholder
  `_default` until #414 introduces real scanner identity.
- Analytics DB: `analytics.db` (scan hit history and aggregates)

Cached channel memory is **disposable**. It is a read accelerator; the scanner
is the source of truth, and losing the cache costs a memory sync, never data.
Deleting `scanner.db` therefore loses real preferences but only a convenience
for channels.

## Update & Migration Rules

- Each DB uses SQLite `PRAGMA user_version`.
- Migrations are forward-only and idempotent.
- Before applying a version bump migration, backend creates a `.bak` copy in the same directory.
  It is taken with SQLite's `VACUUM INTO`, **not** a file copy (#574). The databases run in WAL
  mode, so a committed transaction lives in the `-wal` sidecar until something checkpoints it —
  copying the main file alone silently omitted the most recent committed state, and restoring
  such a file next to a newer `-wal` produced a mismatched pair rather than the old database.
  `VACUUM INTO` is consistent by construction and writes ONE self-contained file, which is what
  makes "put the `.bak` back" a complete instruction. It preserves `user_version`.
- On startup, backend runs migrations before reads/writes.

### What forward-only obligates (#418)

Because there is no down migration, these are enforced in code rather than left
to convention:

- **A failed step does not bump `user_version`.** The bump happens inside the
  same transaction as the schema change, so the next launch retries instead of
  querying a schema that was never created.
- **Each version step is one transaction.** A step that creates a table and then
  fails leaves neither behind — a half-applied schema is a state no version of
  the code expects.
- **A failed backup aborts the migration.** The `.bak` is the only recovery
  path, so proceeding without it would destroy the fallback exactly when it is
  most needed.
- **Nothing deletes a `.bak`.** Pruning them to reclaim disk would remove the
  documented way back. If retention is ever wanted it belongs behind an explicit
  user action, never a startup side effect.
- **A database from a newer Bearpaw is refused, not run against.** Old code
  querying a newer schema is silent misbehaviour; the refusal names the version
  gap, a next step, and any `.bak` sitting beside the database. This is reachable
  through ordinary use — reinstalling a previous version after a bad release,
  two machines sharing a data directory, or restoring from a backup taken before
  an upgrade.
- **Failures surface as a `migration_failed` diagnostic** rather than a crash or
  a silent degrade. Bearpaw is offline-first and starts with no network, so a
  failure must be visible without being a blocking dialog.

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
1. migration step (added via `run_migration_step`, which makes it transactional
   and bumps the version only on success)
2. version bump on the `*_SCHEMA_VERSION` constant
3. migration test for upgrade from prior schema
4. a test that the step is atomic — that a failure inside it leaves neither the
   partial schema nor the new version behind
- Do not introduce cwd-relative DB paths for production runtime.
