# `.ss` full-config import + unified Import dialog — design

Date: 2026-07-21
Status: approved, pre-implementation

## Problem

The app can **export** a full Sentinel `.ss` config (channels + all global
settings) but can only **import** channels from CSV. There is no way to restore
a `.ss` file. Users also want a single Import button that accepts either format
and imports accordingly, rather than a CSV-only import.

A `.ss` import is *not* a speed win over CSV — both write one `CIN,N` command
per channel and the BC125AT has no bulk-write command, so channel-write time is
identical (wire-bound at ~210ms/command on this hardware). The value is
**completeness**: `.ss` restores the whole radio config (settings, search
ranges, close-call, banks), not just the 500 channels.

## Scope

Full config restore: 500 channels **plus** all global settings the `.ss`
export writes. Not channels-only (that would duplicate CSV import).

## The `.ss` format (what we parse)

Tab-separated lines, exactly as `export_bc125at_ss_file` emits them
(`crates/bearpaw-api/src/api/handlers/exports.rs`):

| Line | Fields | Maps to wire write |
| --- | --- | --- |
| `Misc` | backlight, beep, keylock, contrast, volume, squelch, charge_time, region | `BLT`, `KBP`, `CNT`, `VOL`, `SQL`, `BSV` |
| `Priority` | mode | `PRI` |
| `WxPri` | on/off | `WXS` |
| `Service N` | idx, name, on/off (×10) | `SSG` (10-char avoid mask) |
| `Custom N` | idx, name, lower_hz, upper_hz, on/off (×10) | `CSP,N,lo,hi` + `CSG` mask |
| `CloseCall` + `CloseCallBands` | mode, beep, light, lockout + 5× band on/off | one combined `CLC,mode,beep,light,bands,lockout` write |
| `GeneralSearch` | delay, code_search | `SCO` |
| `Conventional N` | idx, name, on/off (×10) | `SCG` (10-char bank mask) |
| `C-Freq N` | idx, name, freq_hz, mod, tone, lockout, delay, priority | `CIN,N,...` |

Notes:
- Bank/service/custom masks use `'1'` = disabled, `'0'` = enabled (SCG/SSG/CSG
  convention). The parser aggregates the 10 per-line On/Off values into one
  10-char mask per group: `Service N` → `SSG`, `Conventional N` → `SCG`,
  `Custom N` enabled-flag → `CSG` (the `Custom N` lower/upper go to `CSP,N`).
  Each mask is a single write, not ten.
- `C-Freq` frequency is in Hz (integer); channel write payload is built via the
  existing `build_cin_write_payload`.
- Unrecognized line types are ignored (forward-compatible), not errored.

## Backend

### New endpoint: `POST /api/v1/memory/import/bc125at_ss`

Multipart upload (same shape as `/import/csv`). Handler:

1. Parse the whole file into a `SsConfig { settings, channels }` up front.
   Malformed lines → per-line errors, collected, non-fatal.
2. Enter **one** `ProgramModeGuard` for the entire import.
3. **Channels** — fast path, reusing the CSV bulk-write logic already built:
   `CIN,N` write, trust `CIN,OK`, retry once on failure, empty (freq-0) rows
   skipped. Commit each success to the shadow cache.
4. **Settings** — each setting **write → read back → verify**. On rejection or
   non-persist, record `{ setting, error }` and **continue** (do not abort).
   This catches unproven writes (notably `CSP`, whose write path has never been
   exercised on real hardware — see Protocol notes).
5. Stream progress over the WS (`import_progress`, task_id `import-ss`):
   channels phase (`Importing N/total`) then a settings phase (`Applying
   settings…`).
6. Return `{ imported, settings_applied, errors: [ { row|setting, error } ] }`.

### Channel-write reuse

The CSV import's `write_channel_no_readback` + retry-once + empty-skip
(`parse_import_csv_row` returning `Ok(None)` for freq-0) are reused verbatim for
the `.ss` channel phase. No new channel-write logic.

### Settings write helpers

Each setting maps to an existing write path (all present in
`handlers/settings.rs`, `handlers/commands.rs`, `handlers/banks.rs`):
`BLT`, `BSV`, `KBP`, `CNT`, `VOL`, `SQL`, `PRI`, `WXS`, `SSG`, `CSP`, `CSG`,
`CLC`, `SCG`. The import calls these under the already-open program-mode
bracket and read-back-verifies each.

## Frontend

### Unified Import button (`ChannelsTab.tsx`, `tauri-shell.ts`)

- `pickAndReadFile(['csv', 'bc125at_ss'])` — the native picker shows both
  extensions.
- Dispatch on the picked file's **extension**:
  - `.csv` → `POST /import/csv` (existing channel import, no confirm).
  - `.bc125at_ss` → `POST /import/bc125at_ss` (full-config restore).
- `.ss` path shows a **confirm dialog first** (`confirmDialog`): "Restore full
  config from this file? This overwrites all channels and settings." CSV import
  stays no-confirm.
- Loading toast reflects the operation ("Restoring config…" vs "Importing
  channels…") and resolves to the result, including error count if any.
- Button keeps the existing `isImporting` disabled/label state.

### Result reporting

On completion, the toast shows imported count and, if `errors.length > 0`, a
short summary (e.g. "Restored config — 3 settings could not be applied"). Full
error detail stays in the JSON response (and console) rather than a wall of
toast text.

## Safety / Protocol notes (per bearpaw-protocol-audit)

- **CSP write is unproven on this hardware.** A write path exists
  (`settings.rs:694`, `CSP,{},{},{}`) but CLAUDE.md and `defaults.rs` note it is
  never exercised. The write-verify step is what makes using it safe here: if
  the scanner rejects or silently drops a `CSP` write, it surfaces as a
  per-setting error, not a silent no-op. After a successful hardware run,
  document the finding in `docs/wire_captures/2026-05-21/audit-reconciliation.md`
  and correct the CLAUDE.md "no CSP write path" note.
- **All writes under one `ProgramModeGuard`**; never send PRG/EPG manually.
- **Channels trust `CIN,OK`** (proven, 500×, wire-bound); **settings
  write-verify** (cheaper, some unproven). This split is deliberate.
- **Per-item, non-fatal errors.** A bad line or rejected setting does not abort
  the restore — the rest still applies, and the user gets a report.

## Out of scope (v1)

- Editing/round-tripping `.ss` in the UI (this is import only).
- A save-location preference for exports (separate, already-designed feature).
- Global lockouts (`LOF`/`GLF`) — the `.ss` export does not currently emit
  them, so import does not restore them.

## Testing

- **Backend unit tests:** `.ss` parser — each line type → expected setting;
  mask polarity (On/Off → `'0'`/`'1'`); malformed lines → collected errors;
  freq-0 `C-Freq` → skipped.
- **Live hardware:** export `.ss` → import same `.ss` → verify channels and
  settings round-trip; confirm CSP write behavior (persists or reports error).
- **Frontend:** import dispatch by extension (mock `pickAndReadFile` returning
  a `.csv` vs `.bc125at_ss` name → correct endpoint); `.ss` confirm gate fires.

## PR breakdown

Likely two PRs (each independently shippable):
1. **Backend `.ss` import** — parser + endpoint + tests. CSV import unchanged.
2. **Frontend unified dialog** — extension dispatch, `.ss` confirm, toasts.

The CSV import speedup / empty-skip / retry work (currently uncommitted) lands
first as its own PR, since `.ss` channel import reuses it.
