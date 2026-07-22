# L/O dropdown replaces single/double-click — design

**Date:** 2026-07-22
**Status:** Approved, ready for implementation plan

## Problem

The `L/O` button in the scanner display (Scan tab) encodes the temporary-vs-permanent
lockout choice as single-click vs. double-click
([`ScannerUI.tsx:141-154`](../../../frontend/src/app/components/ScannerUI.tsx)):

```tsx
onClick={(e) => {
  if (e.detail === 2) {
    onLockout('permanent');
  } else {
    onLockout('temporary');
  }
}}
```

The distinction is invisible — only an `aria-label` mentions it — and double-click is an
error-prone gesture for a destructive action (permanent lockout writes the lockout to the
channel via a PRG bracket). This is the UX the change targets.

## Solution

Replace the click-count trick with a `Popover` dropdown that lets the user pick between
**Temporary** and **Permanent** explicitly. Mirror the VOL button that already sits beside
it in the same control row and already uses a Radix `Popover`.

### Interaction

- Click `L/O` → a dropdown opens inside the display panel, anchored under the button.
- Two rows, **labels only** (no supporting hint text): `Temporary` and `Permanent`.
- Clicking a row calls the existing `onLockout('temporary' | 'permanent')` and closes the
  popover.

### Component changes — one file: [`ScannerUI.tsx`](../../../frontend/src/app/components/ScannerUI.tsx)

Inside `ScannerControls`:

- Swap the single `<button>` for a `<Popover>` / `<PopoverTrigger asChild>` /
  `<PopoverContent>` trio, matching the VOL button's structure directly above it.
- The trigger stays visually identical: same `CONTROL_BUTTON_CLASSES`, still reads `L/O`.
  Add a small `▾` caret so it reads as a menu (it is one now).
- `PopoverContent` uses the `scanner-select-content` class — the same class the VOL popover
  and every `Select` in the app already use — so it inherits the panel's visual language
  with no new menu styling.
- Each row is a full-width, left-aligned `<button>` with a hover state and mono font to sit
  at home in the display. `Permanent` carries a subtle weight cue (it is the destructive
  one) — nothing loud.
- The `onLockout` prop signature is unchanged. `ScannerDisplay`, `ScanView`, and `App.tsx`
  stay untouched.

### Test changes — [`ScannerDisplay.test.tsx`](../../../frontend/src/app/components/__tests__/ScannerDisplay.test.tsx)

Two existing tests (lines 80–91) assert single-click→temporary and double-click→permanent.
Both get rewritten to: open the popover, click the named row, assert the corresponding
`onLockout` call. Same coverage, new interaction.

## Scale / responsiveness

The display panel scales fluidly with `cqmin` units (`container-type: size` box). The
popover renders in a Radix portal outside that container, so its content cannot use the
panel's `cqmin` units — size it with normal responsive units, matching how the VOL
popover's slider already works, so it stays legible from desktop window to 4K kiosk.

## Out of scope

- No backend changes.
- No state changes.
- No changes to the lockout API or the temporary/permanent semantics.
- Purely the trigger UI.

## Definition of done

- Popover replaces the single/double-click gesture; both paths reachable by explicit click.
- `ScannerDisplay.test.tsx` rewritten and passing.
- Frontend CI green locally: `npm test -- --run`, `npm run lint`, `npm run type-check`,
  `npm run format:check`.
