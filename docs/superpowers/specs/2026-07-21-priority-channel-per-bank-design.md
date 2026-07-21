# Priority Channel (One-Per-Bank) — Design Spec

**Date:** 2026-07-21
**Status:** Approved, ready for implementation plan
**Related:** #195 (drag-reorder, which surfaced this), #198 (verify tolerance for refused priority-downgrade), #203 (priority-clear hardware probe + finding)

## Problem

The channel edit sheet has a per-channel Priority toggle that is a lie: it can turn priority **on** but not **off**. Uploading a channel with priority cleared failed with `channel_not_persisted` until #198 stopped the crash — but clearing still doesn't work. Users expect to be able to set, move, and remove a channel's priority.

## Hardware truth (capture-confirmed, fw 1.06.06)

All verified live — see `docs/wire_captures/2026-05-21/audit-reconciliation.md` (2026-07-21 finding) and `examples/priority_clear_probe.rs`.

- A bank holds **0 or 1** priority channel. "One priority channel per bank max" (BC125AT manual p.41; the manual's "10 in all" = 10 banks × 1, **not** 10 per bank). Verified: bank 1 had exactly one, banks 2/3 had zero.
- **SET** priority: plain `CIN,<n>,...,priority=1` — works, fast, safe.
- **CLEAR** priority: the firmware **refuses** an in-place `priority=1→0` CIN write (reads back 1). The only working clear is **`DCH,<n>` (delete to factory-empty) then rewrite** the full channel payload with `priority=0`. Creating a channel fresh with priority off is allowed; only the in-place downgrade is guarded.
- The scanner does **not** auto-enforce one-per-bank — setting a second priority channel in a bank left the first one priority too. **The app enforces the invariant.**

## Model

### Operations

`set_priority(N)` is a transaction:
1. Look up the bank's current priority channel (`oldP`) from the shadow cache.
2. If `oldP` exists and `oldP != N`: **clear `oldP`** (safe DCH+rewrite, see below).
3. **Set `N`**: plain `CIN,<N>,...,priority=1`.

`clear_priority(N)`: safe DCH+rewrite of `N` with `priority=0`.

### Safe clear sequence (the DCH hazard)

`DCH` wipes the channel to factory-empty; the clear is delete→rewrite. If interrupted between, the channel's data is **lost**. Mitigation — all inside a single `ProgramModeGuard` bracket:

1. **Read** `CIN,<N>` and parse every field.
2. **Guard:** if the read fails, abort **before** any destructive command (never DCH an unread channel). If the channel is already empty or already `priority=0`, return success as a no-op — nothing to clear, no DCH issued.
3. **`DCH,<N>`** — wipe to factory-empty.
4. **Rewrite** `CIN,<N>,...` from the saved copy, with `priority=0`.
5. **Read-back-verify** the rewrite matches the saved copy (minus priority). On mismatch: log loudly, return an error.

**Atomicity:** the whole `set_priority` swap (clear `oldP`, then set `N`) runs in one program-mode bracket. If clearing `oldP` fails, **do not** set `N` — abort and report state. No interleaving.

## Backend

New functions in `crates/bearpaw-api/src/api/mod.rs`, near `write_channel_to_scanner`:

- `clear_channel_priority(state, index) -> Result<ChannelData, ApiError>` — the safe read→DCH→rewrite→verify sequence.
- `set_channel_priority(state, index) -> Result<Vec<ChannelData>, ApiError>` — the transaction; returns every channel it changed (old + new).

Bank-priority lookup reads the shadow cache (`AppState.shadow` / `ShadowState.channels`), scanning the target bank's 50 channels for `priority == true`. No extra hardware reads. Extract this as a pure function (`bank_priority_index(channels, bank) -> Option<u16>`) so it is unit-testable.

### API

`POST /api/v1/memory/channels/{index}/priority` with body `{ "priority": true | false }`:
- `true` → `set_channel_priority` (swap)
- `false` → `clear_channel_priority`
- Response: `{ "changed": [ChannelData, ...] }` — the channels whose state changed.

Rationale for a dedicated endpoint (not the generic `PUT /channels/{index}`): the PUT writes via plain CIN, which can't clear priority and must not silently trigger a destructive DCH swap. Priority is a heavyweight, one-per-bank, destructive-on-clear operation — it gets its own explicit route. The generic PUT keeps its behavior; #198's read-back-verify tolerance stays as a safety net for any priority field riding along on a normal edit.

**Consequence:** priority is no longer part of the batched "upload drafts" flow. It becomes an immediate, explicit action.

## Frontend

### Edit sheet (`ChannelEditSheet.tsx`)

The Priority `Switch` stays visually but changes behavior — it is no longer a draft field:
- Toggling fires the priority endpoint **immediately** (not on "Upload Changes").
- **Toggle ON** while the bank already has a priority channel → confirm: *"CH{old} '{name}' is the priority channel for Bank {b}. Move priority to CH{new}?"* On confirm, the swap runs; the sheet reflects both channels.
- **Toggle OFF** → confirm noting the rewrite: *"Clear priority on CH{n}? (The channel is rewritten in place.)"*
- During the operation: toggle disabled + spinner; on error, revert the toggle and toast the failure.
- Optional hint under the toggle: *"One priority channel per bank."*

### Channel row (`ChannelsTab.tsx`)

The existing priority dot stays as the indicator. No per-row toggle.

### Store

Priority leaves `memoryDrafts` (not a draft anymore). The endpoint returns changed channels; update `channels` in the store directly.

## Testing

### Backend (unit, no hardware)
- `bank_priority_index`: given a channel set, returns the correct priority index for a bank (or None).
- `set_channel_priority` decision logic: CH2 priority in bank 1, setting CH9 → clear(CH2)+set(CH9) sequence.
- `clear_channel_priority` safety: read→DCH→rewrite ordering; abort-before-DCH when the pre-read fails.
- **Atomic-abort regression guard:** if clearing `oldP` fails, `N` is not set.

### Frontend (vitest)
- Toggle ON with existing bank priority → confirm fires, swap endpoint called.
- Toggle OFF → clear endpoint called, dot clears.
- Error path → toggle reverts, toast shown.

### Hardware (deferred, user's desk)
- Real DCH+rewrite swap end-to-end; the one thing tests cannot cover.

## Third-rail registration

Add a `REGRESSION GUARD:` comment + paired test on the atomic swap, and a row to the CLAUDE.md third-rail table:

| Flow | Code site | Test | Why it broke before |
|---|---|---|---|
| Priority swap is atomic (clear-old fails → new not set) | `set_channel_priority` in `api/mod.rs` | `priority_swap_aborts_when_clear_fails` | The clear is a destructive DCH+rewrite; a partial swap could leave a bank with two priority channels or a deleted channel. |

## Out of scope

- Bulk priority operations.
- Changing the global priority *scan mode* (`PRI` — already a separate control).
- Any change to the drag-reorder flow.
