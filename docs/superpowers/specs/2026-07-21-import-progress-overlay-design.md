# Import progress overlay — design

Date: 2026-07-21
Status: approved, pre-implementation

## Problem

A channel/config import takes ~80s (500 wire writes). It's currently signalled
only by a static loading toast, which is a weak signal for a minute-plus
blocking operation and doesn't stop the user clicking into other tabs mid-import
(which contends for the single-threaded wire). The backend already streams
progress over WebSocket; the UI just doesn't show it.

## Scope

Import only. CSV export is instant (reads the shadow cache) and needs nothing.
`.ss` export takes ~5s and keeps its existing loading toast — 5s doesn't warrant
an overlay, and it has no progress broadcasting.

## Backend (mostly done)

`import_progress` (`crates/bearpaw-api/src/api/handlers/exports.rs`) already
broadcasts `{ "type": "progress", "task_id": "import-csv", "percent", "message" }`
during both CSV and `.ss` imports, with messages like `"Importing 230/500"`,
`"Applying settings…"`, and a final `"Import complete"` at 100%.

**One change:** the `.ss` import currently reuses `task_id: "import-csv"`. Give
it its own `"import-ss"` so the two are distinguishable in logs/handlers. The
overlay treats both identically (any `task_id` starting with `"import"`).

## Frontend

### New state — `importProgress` (App.tsx `useState`, NOT Zustand `sync`)

```ts
const [importProgress, setImportProgress] = useState<{
  active: boolean;
  percent: number;
  message: string;
}>({ active: false, percent: 0, message: '' });
```

Kept separate from the regression-guarded `sync` state so import progress can
never bleed into the memory-sync overlay or its WS handling.

### WS routing — isolated from the sync path

In the existing `ws.on('progress', ...)` handler, at the very top:

```ts
if (payload.task_id?.startsWith('import')) {
  setImportProgress((prev) => ({
    active: true,
    percent:
      typeof payload.percent === 'number' && Number.isFinite(payload.percent)
        ? Math.max(0, Math.min(100, payload.percent))
        : prev.percent,
    message: payload.message || prev.message,
  }));
  return; // never fall through to the sync logic
}
```

The early `return` is load-bearing: it guarantees import messages never reach
`updateSync` or the sync-specific `"Syncing channel"` / completion logic. The
sync path runs only for non-import task_ids, exactly as today.

Note: the final `"Import complete"` (percent 100) arrives over WS, but the
overlay is dismissed by `handleImport`'s `finally` (below), not by the WS
message — the WS just drives the live 0–99% updates. This avoids a race where
the overlay vanishes before `handleImport` finishes reading the response.

### New component — `ImportProgressOverlay`

`frontend/src/app/components/ImportProgressOverlay.tsx`. Mirrors the memory-sync
overlay's look (fixed backdrop, `SyncSpinner` ring, percent, message) but:
- Title: "Importing" ; sub-message from `importProgress.message`.
- **No Cancel button** (cancelling mid-PRG-bracket risks a partial config).
- Props: `{ active: boolean; percent: number; message: string }`.
- Gated by the caller on `active`.

```tsx
interface ImportProgressOverlayProps {
  active: boolean;
  percent: number;
  message: string;
}
```

### Drive it from `handleImport` (ChannelsTab? No — App.tsx owns the overlay)

The overlay lives in App.tsx (alongside the sync overlay), driven by
`importProgress`. But `handleImport` is in `ChannelsTab.tsx`. Two options:
- **A (chosen):** lift the `importProgress` state to App.tsx and pass a setter
  down to `ChannelsTab` via a prop (`onImportStateChange`), OR expose it via the
  store. Simplest: a small Zustand slice `importProgress` + `setImportProgress`,
  since `ChannelsTab` already reads the store and App.tsx renders the overlay.

Revised decision: put `importProgress` in the **Zustand store** (not App.tsx
useState) — `ChannelsTab.handleImport` sets active on start / clears on finish,
the WS handler in App.tsx updates percent/message, and App.tsx renders the
overlay from the store. This avoids prop-drilling a setter through ChannelsTab.
It is a NEW store slice, fully separate from the `sync` slice.

`handleImport` (`ChannelsTab.tsx`):
- On start (after confirm, before fetch): `setImportProgress({ active: true, percent: 0, message: 'Starting…' })`.
- Drop the `toast.loading(...)` — the overlay is now the primary signal. Keep
  the final success/error `toast` (a brief confirmation after the overlay clears).
- In `finally`: `setImportProgress({ active: false, percent: 0, message: '' })`.

### Toast changes

Remove the `toast.loading` / `toastId` threading from `handleImport`. Replace
with a plain `toast.success`/`toast.error` at the end (no `{ id }`), so there's
a short confirmation once the overlay dismisses.

## Testing

- **ImportProgressOverlay**: renders backdrop + ring + percent + message when
  `active`; renders nothing when `!active`.
- **Store slice**: `setImportProgress` updates `importProgress`; independent of
  `sync`.
- **WS routing** (App.regression or a focused test): a `progress` message with
  `task_id: "import-csv"` updates `importProgress` and does NOT touch `sync`; a
  `task_id`-less sync message (`"Syncing channel…"`) still drives `sync` and does
  NOT touch `importProgress`. This is the load-bearing isolation guarantee.
- **handleImport**: sets `importProgress.active` true around the fetch, false in
  `finally` (csv and ss paths).

## Out of scope

- Cancel support (mid-bracket cancel risks partial config).
- Export overlays (CSV instant; `.ss` export keeps its 5s toast).
- Per-item error detail in the overlay (stays in the final toast / response).
