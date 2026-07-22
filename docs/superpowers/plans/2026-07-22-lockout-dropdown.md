# L/O Lockout Dropdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hidden single-vs-double-click temporary/permanent lockout gesture on the scanner display's `L/O` button with an explicit Popover dropdown.

**Architecture:** Swap the single `<button>` inside `ScannerControls` for a Radix `Popover` (trigger + two-row content), mirroring the VOL button that already lives beside it in the same control row. The `onLockout('temporary' | 'permanent')` prop and all upstream wiring stay unchanged — this is purely the trigger UI.

**Tech Stack:** React + TypeScript, Radix `Popover` (already imported in the file), Tailwind, Vitest + Testing Library.

## Global Constraints

- Frontend CI must be green locally before push, all four checks: `npm test -- --run`, `npm run lint`, `npm run type-check`, `npm run format:check` (run from `frontend/`).
- Do NOT run `PRG`/`EPG` or touch any backend — frontend-only change.
- Popover content renders in a Radix portal *outside* the `container-type: size` display panel, so its content must NOT use `cqmin`/`cqi`/`cqh` units — use normal responsive units (matches the VOL popover's slider).
- Reuse the existing `scanner-select-content` class for `PopoverContent` — do not invent new menu styling.
- Row labels are exactly `Temporary` and `Permanent` (labels only, no hint text).

---

### Task 1: Replace the L/O single/double-click button with a Popover dropdown

**Files:**
- Modify: `frontend/src/app/components/ScannerUI.tsx` (the `ScannerControls` function, currently lines ~116-169)
- Test: `frontend/src/app/components/__tests__/ScannerDisplay.test.tsx` (rewrite the two lockout tests at lines 80-92)

**Interfaces:**
- Consumes: `onLockout: (type: 'temporary' | 'permanent') => void` — already a prop of `ScannerControls` and `ScannerDisplay`; signature unchanged.
- Produces: no new exported interface. The `L/O` trigger button keeps an accessible name matching `/lockout/i`; the two menu items have accessible names `Temporary` and `Permanent`.

- [ ] **Step 1: Rewrite the two failing lockout tests**

In `frontend/src/app/components/__tests__/ScannerDisplay.test.tsx`, replace the two tests at lines 80-92 (the `single click` and `double click` cases) with the dropdown-based versions:

```tsx
    it('opens the lockout dropdown and calls onLockout with temporary', async () => {
      const onLockout = vi.fn();
      render(<ScannerDisplay {...defaultProps} onLockout={onLockout} />);
      await userEvent.click(screen.getByRole('button', { name: /lockout/i }));
      await userEvent.click(screen.getByRole('menuitem', { name: 'Temporary' }));
      expect(onLockout).toHaveBeenCalledWith('temporary');
    });

    it('opens the lockout dropdown and calls onLockout with permanent', async () => {
      const onLockout = vi.fn();
      render(<ScannerDisplay {...defaultProps} onLockout={onLockout} />);
      await userEvent.click(screen.getByRole('button', { name: /lockout/i }));
      await userEvent.click(screen.getByRole('menuitem', { name: 'Permanent' }));
      expect(onLockout).toHaveBeenCalledWith('permanent');
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `frontend/`): `npm test -- --run ScannerDisplay`
Expected: The two rewritten tests FAIL — no element with role `menuitem` / name `Temporary`|`Permanent` exists yet (the current button acts on click, not via a menu). Other `ScannerDisplay` tests still pass.

- [ ] **Step 3: Replace the L/O button with a Popover in `ScannerControls`**

In `frontend/src/app/components/ScannerUI.tsx`, replace the single L/O `<button>` block (currently lines 141-154):

```tsx
      <button
        type="button"
        className={CONTROL_BUTTON_CLASSES}
        aria-label="Lockout — click for temporary, double-click for permanent"
        onClick={(e) => {
          if (e.detail === 2) {
            onLockout('permanent');
          } else {
            onLockout('temporary');
          }
        }}
      >
        L/O
      </button>
```

with a Popover, mirroring the VOL Popover directly above it:

```tsx
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={CONTROL_BUTTON_CLASSES} aria-label="Lockout">
            L/O ▾
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="scanner-select-content w-40 p-1"
          side="bottom"
          align="center"
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            className="w-full rounded-scanner-xs px-3 py-2 text-left font-mono text-sm text-scanner-text-light transition-colors hover:bg-white/10"
            onClick={() => onLockout('temporary')}
          >
            Temporary
          </button>
          <button
            type="button"
            role="menuitem"
            className="w-full rounded-scanner-xs px-3 py-2 text-left font-mono text-sm font-semibold text-scanner-text-light transition-colors hover:bg-white/10"
            onClick={() => onLockout('permanent')}
          >
            Permanent
          </button>
        </PopoverContent>
      </Popover>
```

Notes for the implementer:
- `Popover`, `PopoverTrigger`, `PopoverContent` are already imported at the top of the file (line 4) — no new import needed.
- `scanner-select-content` is the same class the VOL popover uses (line 131) — it carries the panel's menu look.
- The row `<button>`s use plain Tailwind sizing (`text-sm`, `px-3`, `py-2`), NOT `cqmin` units, because `PopoverContent` portals outside the `container-type: size` display panel.
- `Permanent` gets `font-semibold` as a subtle destructive-weight cue; `Temporary` does not. Nothing louder than that.
- Clicking a `menuitem` closes the popover automatically (Radix closes on outside-interaction; the click on the item itself is inside, so also add nothing special — Radix `PopoverContent` does not auto-close on inner click, so the popover stays technically open but is dismissed on next outside click; this matches the VOL slider's behavior and is acceptable. Do NOT add manual open-state management unless a test requires it.)

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `frontend/`): `npm test -- --run ScannerDisplay`
Expected: All `ScannerDisplay` tests PASS, including the two rewritten lockout tests.

- [ ] **Step 5: Run the full frontend check suite**

Run (from `frontend/`), all four:

```bash
npm test -- --run
npm run lint
npm run type-check
npm run format:check
```

Expected: all PASS. If `format:check` flags the edited files, run `npm run format` (or `npx prettier --write`) on them and re-run `format:check`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/components/ScannerUI.tsx \
        frontend/src/app/components/__tests__/ScannerDisplay.test.tsx
git commit -m "feat(scan): L/O opens a temp/permanent dropdown instead of single/double-click

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Popover replaces single/double-click gesture → Task 1, Step 3. ✓
- Two rows `Temporary`/`Permanent`, labels only → Step 3. ✓
- Reuse `scanner-select-content`, no new menu styling → Step 3. ✓
- `onLockout` signature and upstream unchanged → Interfaces block + Step 3 (only the trigger changes). ✓
- Portal content avoids `cqmin` units → Global Constraints + Step 3 note. ✓
- Tests rewritten to open-then-click → Steps 1-4. ✓
- Four-check CI green locally → Step 5. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to" — every code step shows full code. ✓

**Type consistency:** `onLockout('temporary' | 'permanent')` used identically in tests and component; `role="menuitem"` names (`Temporary`, `Permanent`) match between Step 1 tests and Step 3 markup. ✓
