# Priority Channel (One-Per-Bank) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the channel Priority control work correctly against BC125AT hardware: set priority (plain CIN), clear priority (DCH+rewrite), and enforce one-priority-channel-per-bank with an atomic swap.

**Architecture:** A dedicated backend endpoint `POST /memory/channels/{index}/priority` owns two operations — `set_channel_priority` (find the bank's current priority, clear it via DCH+rewrite, set the new one) and `clear_channel_priority` (DCH+rewrite the channel with priority=0). Both run inside a single `ProgramModeGuard` bracket for atomicity. The frontend edit-sheet toggle fires this endpoint immediately (no longer a batched draft).

**Tech Stack:** Rust (Axum) backend; React + TypeScript + Zustand frontend; hardware over USB/serial CDC-ACM.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-21-priority-channel-per-bank-design.md`. Hardware facts: `docs/wire_captures/2026-05-21/audit-reconciliation.md` (2026-07-21 finding).
- CIN write order (fixed): `name, freq, mod, tone, delay, lockout, priority`.
- CLEAR priority is `DCH,<n>` then rewrite full payload with `priority=0`. In-place `1→0` is firmware-refused. SET is a plain `CIN,...,priority=1`.
- A bank holds 0 or 1 priority channel. `index_to_bank(u16) -> u8` maps indices to banks 1–10 (0 = out of range).
- Never `DCH` an unread channel. Read → DCH → rewrite → verify, all in one `ProgramModeGuard`.
- PR discipline (CLAUDE.md / bearpaw-pr): tiny single-concern PRs, all four frontend checks + backend `cargo test`/`clippy`/`cargo check --workspace --all-targets` green locally before push. Branch `feat/`, `fix/`, `chore/`. Never push to main.
- Backend tests: `cargo test -p bearpaw-api --lib`. Frontend from `frontend/`: `npm test -- --run`, `npm run lint`, `npm run type-check`, `npm run format:check`.

---

### Task 1: Bank priority lookup (pure function)

**Files:**
- Modify: `crates/bearpaw-api/src/api/mod.rs` (add fn near `readback_matches`, ~line 1487)
- Test: same file, `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `index_to_bank(u16) -> u8` (from `crate::protocol`), `ChannelData` (`.index: u16`, `.priority: bool`), `std::collections::HashMap<u16, ChannelData>`.
- Produces: `fn bank_priority_index(channels: &HashMap<u16, ChannelData>, bank: u8) -> Option<u16>` — the index of the bank's current priority channel, if any.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn bank_priority_index_finds_the_one_priority_channel() {
    use std::collections::HashMap;
    let mut ch = HashMap::new();
    // Bank 1 = indices 1..=50. CH2 is priority; CH9 is not.
    let mut c2 = test_channel();
    c2.index = 2;
    c2.priority = true;
    let mut c9 = test_channel();
    c9.index = 9;
    c9.priority = false;
    ch.insert(2, c2);
    ch.insert(9, c9);
    assert_eq!(bank_priority_index(&ch, 1), Some(2));
    assert_eq!(bank_priority_index(&ch, 2), None); // bank 2 empty
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p bearpaw-api --lib bank_priority_index -- --nocapture`
Expected: FAIL — `cannot find function bank_priority_index`.

- [ ] **Step 3: Write minimal implementation**

Add near `readback_matches` in `mod.rs` (import `HashMap` if not already: it is used via `crate::state::ShadowState`; add `use std::collections::HashMap;` at the top of the function's module scope only if the file doesn't already import it — check the existing `use` block first):

```rust
/// The index of the bank's current priority channel, if any. A bank holds
/// 0 or 1 priority channel (one-per-bank). `bank` is 1..=10.
fn bank_priority_index(
    channels: &std::collections::HashMap<u16, ChannelData>,
    bank: u8,
) -> Option<u16> {
    channels
        .values()
        .filter(|c| c.priority && crate::protocol::index_to_bank(c.index) == bank)
        .map(|c| c.index)
        .min()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p bearpaw-api --lib bank_priority_index`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/priority-bank-lookup
git add crates/bearpaw-api/src/api/mod.rs
git commit -m "feat: bank_priority_index helper for one-per-bank priority"
```

---

### Task 2: Clear a channel's priority (DCH + rewrite, safe)

**Files:**
- Modify: `crates/bearpaw-api/src/api/mod.rs` (add fn near `write_channel_to_scanner`, ~line 1513)
- Test: same file test module

**Interfaces:**
- Consumes: `read_channel_from_scanner(state, index) -> Result<ChannelData, ApiError>`, `send_raw_command(state, cmd, false) -> Result<String, ApiError>`, `build_cin_write_payload(&ChannelData) -> Result<String, ApiError>`, `parse_cin_response(index, &str) -> Option<ChannelData>`, `readback_matches(&wrote, &readback, wrote_alpha) -> bool`, `ProgramModeGuard::enter(state) -> Result<ProgramModeGuard, ApiError>`, `classify_response(&str) -> ScannerReply`.
- Produces: `async fn clear_channel_priority(state: &AppState, index: u16) -> Result<ChannelData, ApiError>` — returns the rewritten channel (priority=0). No-op success if already empty or already priority=0.

**Note on testing:** this function does hardware I/O and cannot be unit-tested without a device. Its *decision logic* (no-op vs. DCH) is thin; the atomic-swap guard test lives in Task 3. Here we add one test for the no-op guard by testing the extracted predicate `needs_priority_clear`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn needs_priority_clear_only_when_programmed_and_priority() {
    let mut ch = test_channel(); // freq 145.13
    ch.priority = true;
    assert!(needs_priority_clear(&ch)); // programmed + priority => clear needed

    ch.priority = false;
    assert!(!needs_priority_clear(&ch)); // not priority => no-op

    let empty = empty_channel_readback(); // freq 0 (helper below)
    assert!(!needs_priority_clear(&empty)); // empty slot => no-op
}
```

Add this helper to the test module if not already present (mirrors `factory_empty_readback` but as a plain empty channel):

```rust
fn empty_channel_readback() -> ChannelData {
    let mut c = test_channel();
    c.frequency = 0.0;
    c.priority = false;
    c
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p bearpaw-api --lib needs_priority_clear`
Expected: FAIL — `cannot find function needs_priority_clear`.

- [ ] **Step 3: Write the predicate + the clear function**

Add the predicate near `readback_matches`:

```rust
/// A channel needs an actual DCH+rewrite clear only if it is programmed
/// (freq != 0) and currently priority. Empty or already-non-priority
/// channels are a no-op.
fn needs_priority_clear(ch: &ChannelData) -> bool {
    ch.frequency.abs() >= 0.00005 && ch.priority
}
```

Add the clear function near `write_channel_to_scanner`:

```rust
/// Clear a channel's priority. The firmware refuses an in-place priority
/// 1->0 CIN write, so the only mechanism is DCH (wipe to factory-empty)
/// then rewrite the channel with priority=0 (verified: #203 probe).
///
/// DATA-LOSS SAFETY: DCH deletes the channel. We read the full channel
/// FIRST, abort before DCH if the read fails, then rewrite from the saved
/// copy and read-back-verify. All inside one ProgramModeGuard.
pub(crate) async fn clear_channel_priority(
    state: &AppState,
    index: u16,
) -> Result<ChannelData, ApiError> {
    let _guard = ProgramModeGuard::enter(state).await?;

    // 1. Read the full channel first. Never DCH an unread channel.
    let current = read_channel_from_scanner(state, index).await?;

    // 2. No-op if nothing to clear.
    if !needs_priority_clear(&current) {
        return Ok(current);
    }

    // 3. Build the rewrite payload (same fields, priority off) BEFORE deleting,
    //    so a payload-build error can't strand us post-DCH.
    let mut rewritten = current.clone();
    rewritten.priority = false;
    let payload = build_cin_write_payload(&rewritten)?;

    // 4. DCH — wipe to factory-empty.
    match classify_response(&send_raw_command(state, &format!("DCH,{index}"), false).await?) {
        ScannerReply::Ok => {}
        _ => return Err(ApiError::BadRequest("priority_clear_dch_failed".to_string())),
    }

    // 5. Rewrite with priority=0.
    let write_cmd = format!("CIN,{index},{payload}");
    match classify_response(&send_raw_command(state, &write_cmd, false).await?) {
        ScannerReply::Ok => {}
        _ => return Err(ApiError::BadRequest("priority_clear_rewrite_failed".to_string())),
    }

    // 6. Read-back-verify the rewrite.
    let read_response = send_raw_command(state, &format!("CIN,{index}"), false).await?;
    let readback = parse_cin_response(index, &read_response)
        .ok_or_else(|| ApiError::BadRequest("priority_clear_readback_failed".to_string()))?;
    let wrote_alpha = rewritten
        .alpha_tag
        .replace(',', " ")
        .trim()
        .chars()
        .take(16)
        .collect::<String>();
    if !readback_matches(&rewritten, &readback, &wrote_alpha) {
        warn!(
            index = index,
            wrote = %write_cmd,
            read_back = %read_response.trim(),
            "priority clear rewrite not persisted as sent"
        );
        return Err(ApiError::BadRequest("priority_clear_not_persisted".to_string()));
    }
    Ok(readback)
}
```

- [ ] **Step 4: Run test + full backend gate**

Run: `cargo test -p bearpaw-api --lib needs_priority_clear && cargo test -p bearpaw-api --lib && cargo clippy -p bearpaw-api && cargo check --workspace --all-targets`
Expected: the new test PASSES; all lib tests pass; clippy no new warnings; workspace clean.

- [ ] **Step 5: Commit**

```bash
git add crates/bearpaw-api/src/api/mod.rs
git commit -m "feat: clear_channel_priority via safe DCH+rewrite"
```

---

### Task 3: Atomic set-priority swap

**Files:**
- Modify: `crates/bearpaw-api/src/api/mod.rs`
- Test: same file test module

**Interfaces:**
- Consumes: `bank_priority_index` (Task 1), `clear_channel_priority` (Task 2), `read_channel_from_scanner`, `build_cin_write_payload`, `send_raw_command`, `parse_cin_response`, `readback_matches`, `ProgramModeGuard`, `index_to_bank`, `state.shadow: Arc<RwLock<ShadowState>>` with `.channels: HashMap<u16, ChannelData>`.
- Produces: `async fn set_channel_priority(state: &AppState, index: u16) -> Result<Vec<ChannelData>, ApiError>` — clears the bank's existing priority channel (if any and different), sets `index` priority=1, returns all changed channels (cleared-old first, then the new one). Also a pure planner `fn plan_priority_swap(channels, index) -> (Option<u16>, u16)` returning `(old_to_clear, new_to_set)`.

- [ ] **Step 1: Write the failing test (planner + atomic-abort guard)**

```rust
#[test]
fn plan_priority_swap_identifies_old_and_new() {
    use std::collections::HashMap;
    let mut ch = HashMap::new();
    let mut c2 = test_channel();
    c2.index = 2;
    c2.priority = true; // current bank-1 priority
    ch.insert(2, c2);
    // Setting CH9 (also bank 1) must clear CH2 and set CH9.
    assert_eq!(plan_priority_swap(&ch, 9), (Some(2), 9));
    // Setting the channel that is ALREADY priority: no clear needed.
    assert_eq!(plan_priority_swap(&ch, 2), (None, 2));
    // Bank with no current priority: nothing to clear.
    let empty = HashMap::new();
    assert_eq!(plan_priority_swap(&empty, 9), (None, 9));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p bearpaw-api --lib plan_priority_swap`
Expected: FAIL — `cannot find function plan_priority_swap`.

- [ ] **Step 3: Write the planner + swap**

Planner (near `bank_priority_index`):

```rust
/// Decide the swap: which channel (if any) must be cleared, and which is set.
/// Returns (old_to_clear, new_to_set). old is Some only when a DIFFERENT
/// channel in the same bank currently holds priority.
fn plan_priority_swap(
    channels: &std::collections::HashMap<u16, ChannelData>,
    index: u16,
) -> (Option<u16>, u16) {
    let bank = crate::protocol::index_to_bank(index);
    let old = bank_priority_index(channels, bank).filter(|&old| old != index);
    (old, index)
}
```

Swap function (near `clear_channel_priority`):

```rust
/// Set `index` as its bank's priority channel, enforcing one-per-bank.
/// Clears the bank's current priority channel first (if a different one
/// exists), then sets `index`. Atomic: if the clear fails, `index` is NOT
/// set. Returns every channel changed (cleared-old first, then the new one).
pub(crate) async fn set_channel_priority(
    state: &AppState,
    index: u16,
) -> Result<Vec<ChannelData>, ApiError> {
    let (old_to_clear, new_to_set) = {
        let shadow = state.shadow.read().unwrap();
        plan_priority_swap(&shadow.channels, index)
    };

    let mut changed = Vec::new();

    // Clear the old priority channel first. If this fails, abort BEFORE
    // setting the new one — never leave the bank with two priority channels.
    if let Some(old) = old_to_clear {
        let cleared = clear_channel_priority(state, old).await?;
        state.shadow.write().unwrap().channels.insert(old, cleared.clone());
        changed.push(cleared);
    }

    // Set the new priority channel with a plain CIN write (SET works in place).
    let _guard = ProgramModeGuard::enter(state).await?;
    let current = read_channel_from_scanner(state, new_to_set).await?;
    if current.frequency.abs() < 0.00005 {
        return Err(ApiError::BadRequest("priority_set_empty_channel".to_string()));
    }
    let mut wrote = current.clone();
    wrote.priority = true;
    let payload = build_cin_write_payload(&wrote)?;
    let write_cmd = format!("CIN,{new_to_set},{payload}");
    match classify_response(&send_raw_command(state, &write_cmd, false).await?) {
        ScannerReply::Ok => {}
        _ => return Err(ApiError::BadRequest("priority_set_failed".to_string())),
    }
    let read_response = send_raw_command(state, &format!("CIN,{new_to_set}"), false).await?;
    let readback = parse_cin_response(new_to_set, &read_response)
        .ok_or_else(|| ApiError::BadRequest("priority_set_readback_failed".to_string()))?;
    if !readback.priority {
        return Err(ApiError::BadRequest("priority_set_not_persisted".to_string()));
    }
    state
        .shadow
        .write()
        .unwrap()
        .channels
        .insert(new_to_set, readback.clone());
    changed.push(readback);
    Ok(changed)
}
```

- [ ] **Step 4: Run test + full backend gate**

Run: `cargo test -p bearpaw-api --lib plan_priority_swap && cargo test -p bearpaw-api --lib && cargo clippy -p bearpaw-api && cargo check --workspace --all-targets`
Expected: new test PASSES; all pass; clippy clean; workspace clean.

- [ ] **Step 5: Add REGRESSION GUARD comment + commit**

Add above the `if let Some(old) = old_to_clear` block:

```rust
// REGRESSION GUARD (priority swap atomicity): clear the OLD priority
// channel before setting the new one, and propagate the clear's error
// with `?` so a failed clear ABORTS the swap. Setting first (or ignoring
// the clear error) can leave a bank with two priority channels, or delete
// a channel via DCH and never restore it. See the priority spec.
```

```bash
git add crates/bearpaw-api/src/api/mod.rs
git commit -m "feat: atomic set_channel_priority swap (one-per-bank)"
```

---

### Task 4: Priority endpoint + route

**Files:**
- Modify: `crates/bearpaw-api/src/api/handlers/memory.rs` (new handler)
- Modify: `crates/bearpaw-api/src/api/mod.rs` (route registration ~line 197; export the two fns if needed)
- Test: `crates/bearpaw-api/src/api/mod.rs` test module (router-level test, mirrors the existing `get_memory_channel_rejects_out_of_range_index` at ~line 1930)

**Interfaces:**
- Consumes: `set_channel_priority`, `clear_channel_priority` (Tasks 2–3), `AppState`, `ApiError`, Axum `State`/`Path`/`Json`.
- Produces: `POST /api/v1/memory/channels/:index/priority` → `put_memory_channel_priority` handler. Request `{ "priority": bool }`. Response `{ "changed": [ChannelData, ...] }`.

- [ ] **Step 1: Write the failing test (out-of-range guard, no hardware)**

```rust
#[tokio::test]
async fn priority_endpoint_rejects_out_of_range_index() {
    let app = build_test_router(); // same helper the existing channel test uses
    let req = axum::http::Request::builder()
        .method("POST")
        .uri("/api/v1/memory/channels/999/priority")
        .header("content-type", "application/json")
        .body(axum::body::Body::from(r#"{"priority":true}"#))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), axum::http::StatusCode::BAD_REQUEST);
}
```

(If the existing out-of-range test uses a different router-builder name, match it — check `get_memory_channel_rejects_out_of_range_index` near mod.rs:1930 and reuse its exact setup.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p bearpaw-api --lib priority_endpoint_rejects_out_of_range_index`
Expected: FAIL — route not found (404) or handler missing.

- [ ] **Step 3: Add the handler + route**

In `memory.rs`:

```rust
#[derive(serde::Deserialize)]
pub(crate) struct PriorityBody {
    priority: bool,
}

#[derive(serde::Serialize)]
pub(crate) struct PriorityResponse {
    changed: Vec<ChannelData>,
}

pub(crate) async fn put_memory_channel_priority(
    State(state): State<AppState>,
    Path(index): Path<u16>,
    Json(body): Json<PriorityBody>,
) -> Result<Json<PriorityResponse>, ApiError> {
    let _ = command_sender(&state)?;
    if !(1..=500).contains(&index) {
        return Err(ApiError::BadRequest("channel_out_of_range".to_string()));
    }
    let changed = if body.priority {
        super::super::set_channel_priority(&state, index).await?
    } else {
        vec![super::super::clear_channel_priority(&state, index).await?]
    };
    Ok(Json(PriorityResponse { changed }))
}
```

(Ensure `ChannelData` is imported in `memory.rs`; it is used by `put_memory_channel` already.)

In `mod.rs`, after the `/api/v1/memory/channels/:index` route (~line 197):

```rust
        .route(
            "/api/v1/memory/channels/:index/priority",
            post(handlers::memory::put_memory_channel_priority),
        )
```

Make `set_channel_priority` / `clear_channel_priority` reachable from the handler (they are `pub(crate)` in `mod.rs`; `super::super::` reaches them). Confirm `post` is imported in mod.rs's router `use` block (it is — other routes use it).

- [ ] **Step 4: Run test + full backend gate**

Run: `cargo test -p bearpaw-api --lib priority_endpoint_rejects_out_of_range_index && cargo test -p bearpaw-api --lib && cargo clippy -p bearpaw-api && cargo check --workspace --all-targets`
Expected: PASS; all pass; clippy clean; workspace clean.

- [ ] **Step 5: Commit**

```bash
git add crates/bearpaw-api/src/api/handlers/memory.rs crates/bearpaw-api/src/api/mod.rs
git commit -m "feat: POST /memory/channels/:index/priority endpoint"
```

---

### Task 5: Frontend API client method

**Files:**
- Modify: `frontend/src/api/client.ts` (near `updateChannel`, ~line 155)
- Modify: `frontend/src/types.ts` if a response type is needed (check existing `ChannelData` import in client.ts first)
- Test: `frontend/src/api/__tests__/client.test.ts` (mirror an existing method test)

**Interfaces:**
- Consumes: `this.request<T>(path, opts)`, `ChannelData` type.
- Produces: `async setChannelPriority(index: number, priority: boolean): Promise<ChannelData[]>` — POSTs `{ priority }`, returns `changed`.

- [ ] **Step 1: Write the failing test**

The client class is `ScannerAPIClient`; fetch mocks come from `../../test/utils` (`mockFetch`, `mockApiResponse`, `resetMockFetch`). Follow the existing `client.test.ts` structure (import block + `beforeEach`/`afterEach` shown at the top of that file). Add a case like:

```ts
it('setChannelPriority posts priority and returns changed channels', async () => {
  const changed = [
    { index: 2, priority: false },
    { index: 9, priority: true },
  ];
  mockFetch(mockApiResponse({ changed }));
  const result = await client.setChannelPriority(9, true);
  expect(result).toEqual(changed);
});
```

Confirm the exact `mockApiResponse` signature in `src/test/utils.ts` before writing — mirror whatever the other channel-method tests in this file already do for request-body/URL assertions.

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npm test -- --run client.test`
Expected: FAIL — `setChannelPriority is not a function`.

- [ ] **Step 3: Add the client method**

In `client.ts` near `updateChannel`:

```ts
async setChannelPriority(index: number, priority: boolean): Promise<ChannelData[]> {
  const res = await this.request<{ changed: ChannelData[] }>(
    `/memory/channels/${index}/priority`,
    { method: 'POST', body: JSON.stringify({ priority }) },
  );
  return res.changed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `frontend/`): `npm test -- --run client.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/api/__tests__/client.test.ts
git commit -m "feat: setChannelPriority API client method"
```

---

### Task 6: Edit-sheet toggle fires priority endpoint immediately

**Files:**
- Modify: `frontend/src/app/components/views/ChannelEditSheet.tsx` (Priority `Switch`, ~line 283)
- Modify: `frontend/src/app/components/views/ChannelsTab.tsx` (pass a handler + current channels to the sheet; wire `setChannelPriority`, update store with returned channels)
- Modify: `frontend/src/store/useStore.ts` if a bulk channel-update helper is needed (there is `setChannels`; reuse it)
- Test: `frontend/src/app/components/views/__tests__/ChannelEditSheet.test.tsx` and/or `ChannelsTab.test.tsx` (both already exist — extend them). Use the `useStore` mock at `src/test/mocks/mockStore.ts` and follow how these files already render the sheet/tab and mock `tauri-shell` (`confirmDialog`) and the API client.

**Interfaces:**
- Consumes: `setChannelPriority(index, priority)` (Task 5), `confirmDialog(message, title)` (from `tauri-shell`), `toast` (sonner), `useStore` `channels`/`setChannels`.
- Produces: priority toggle behavior — immediate action, confirm on ON-with-existing and on OFF, disabled+revert on error.

- [ ] **Step 1: Write the failing test**

```tsx
it('toggling priority ON calls setChannelPriority and updates channels', async () => {
  const setChannelPriority = vi.fn().mockResolvedValue([
    { index: 2, priority: false },
    { index: 9, priority: true },
  ]);
  // render the edit sheet for CH9 with a bank that has CH2 as priority,
  // stubbing the API client's setChannelPriority and confirmDialog=>true.
  // ...render...
  fireEvent.click(screen.getByRole('switch', { name: /priority/i }));
  await waitFor(() => expect(setChannelPriority).toHaveBeenCalledWith(9, true));
});
```

(Match the repo's existing component-test setup — check an existing `*.test.tsx` under `frontend/src/app/components` for the render/mount helpers, the `useStore` mock from `src/test/mocks/mockStore.ts`, and how `tauri-shell` is mocked. Reuse those exact patterns.)

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npm test -- --run ChannelEditSheet`
Expected: FAIL — the toggle still mutates a draft instead of calling the API.

- [ ] **Step 3: Implement the immediate-toggle behavior**

In `ChannelEditSheet.tsx`, replace the Priority `Switch`'s `onCheckedChange` (currently `handleFieldChange('priority', checked)`) with a handler passed from the parent, e.g. `onPriorityChange(checked: boolean)`. In `ChannelsTab.tsx`, implement it:

```tsx
const handlePriorityChange = useCallback(
  async (channelIndex: number, next: boolean) => {
    const bank = deriveBankFromIndex(channelIndex);
    if (next) {
      const existing = channels.find(
        (c) => c.priority && deriveBankFromIndex(c.index) === bank && c.index !== channelIndex,
      );
      if (existing) {
        const ok = await confirmDialog(
          `CH${existing.index} "${existing.alpha_tag || 'unnamed'}" is the priority channel for Bank ${bank}. Move priority to CH${channelIndex}?`,
          'Move priority',
        );
        if (!ok) return;
      }
    } else {
      const ok = await confirmDialog(
        `Clear priority on CH${channelIndex}? The channel is rewritten in place.`,
        'Clear priority',
      );
      if (!ok) return;
    }
    try {
      const changed = await getAPI().setChannelPriority(channelIndex, next);
      const byIndex = new Map(changed.map((c) => [c.index, c]));
      setChannels(channels.map((c) => byIndex.get(c.index) ?? c));
    } catch {
      toast.error(`Failed to ${next ? 'set' : 'clear'} priority on CH${channelIndex}`);
    }
  },
  [channels, setChannels],
);
```

Wire `onPriorityChange` down to the sheet; remove `priority` from the draft/upload path (it is no longer a draft field — drop it from `buildDraft`'s comparison in `draftChanges` `hasChanges`, and from the payload sent by `handleUploadDrafts`, so priority never rides the plain-CIN PUT). Keep the priority DOT indicator in the row.

- [ ] **Step 4: Run test + full frontend gate**

Run (from `frontend/`): `npm test -- --run && npm run lint && npm run type-check && npm run format:check`
Expected: new test PASSES; all pass; lint 0 errors; type-check clean; prettier clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/components/views/ChannelEditSheet.tsx frontend/src/app/components/views/ChannelsTab.tsx frontend/src/store/useStore.ts frontend/src/app/components/views/__tests__/
git commit -m "feat: priority toggle fires endpoint immediately with confirms"
```

---

### Task 7: Third-rail registration + docs

**Files:**
- Modify: `CLAUDE.md` (third-rail table)
- Modify: `docs/API_SPEC.md` (document the new endpoint)

**Interfaces:** none (docs only).

- [ ] **Step 1: Add the third-rail row to CLAUDE.md**

Add to the "Third-rail flows" table:

```markdown
| Priority swap is atomic (clear-old fails → new not set) | `set_channel_priority` in `crates/bearpaw-api/src/api/mod.rs` | `plan_priority_swap_identifies_old_and_new` + the REGRESSION GUARD comment | The clear is a destructive DCH+rewrite; setting the new channel before (or despite) a failed clear can leave a bank with two priority channels or a DCH-deleted channel. |
```

- [ ] **Step 2: Document the endpoint in API_SPEC.md**

Add under the memory/channels section:

```markdown
### POST /api/v1/memory/channels/{index}/priority

Set or clear a channel's priority. Enforces one priority channel per bank.

Request: `{ "priority": true | false }`
- `true`: sets this channel as its bank's priority, clearing the bank's previous priority channel (atomic swap).
- `false`: clears this channel's priority (delete-then-rewrite; the channel data is preserved).

Response: `{ "changed": [ChannelData, ...] }` — the channels whose state changed.

Note: clearing uses `DCH` + rewrite because the firmware refuses an in-place priority downgrade (see docs/wire_captures/2026-05-21/audit-reconciliation.md).
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/API_SPEC.md
git commit -m "docs: register priority-swap third-rail + document endpoint"
```

---

## Execution notes

- Tasks 1–4 are backend, each independently green — ship as one or more PRs (Tasks 1–3 can bundle as "backend priority operations"; Task 4 the endpoint). Tasks 5–6 frontend. Task 7 docs. Follow bearpaw-pr tiny-PR discipline; the natural PR seams are: [1–3], [4], [5–6], [7] — or finer.
- **Hardware verification is deferred to the user's desk** for the real DCH+rewrite swap end-to-end. Every task's automated tests avoid hardware (pure logic + router guards + mocked frontend).
- After Task 6, remove any now-dead priority-in-draft code paths surfaced by the change (don't leave `priority` half-wired through `memoryDrafts`).
