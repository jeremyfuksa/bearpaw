---
name: Bearpaw
description: >-
  Desktop control interface for the Uniden BC125AT scanner. A dark instrument
  shell wrapped around a backlit amber display panel — the software equivalent
  of the physical radio sitting on the desk.
colors:
  # Brand — the amber display. This is the only saturated hue in the app.
  brandPrimary: '#ef991f'
  brandHover: '#d97706'
  brandLight: '#f9c574'
  brandGlow: 'rgba(239, 153, 31, 0.5)'

  # Shell surfaces
  bgScannerDark: '#1c1f26'
  bgScannerPanel: '#11131b'
  borderInset: '#b06105'

  # Status — resolved in JS as var() strings, never as utility classes
  statusConnected: '#67e79e'
  statusConnecting: '#f59e0b'
  statusDisconnected: '#dc3a38'

  # "Ink on amber" ramp. Not tokens — literal rgba, by opacity step.
  ink900: 'rgba(28, 31, 38, 0.9)'   # text on amber
  ink800: 'rgba(28, 31, 38, 0.8)'   # borders, filled signal bars, pressed fill
  ink700: 'rgba(28, 31, 38, 0.7)'   # active bank fill
  ink600: 'rgba(28, 31, 38, 0.6)'   # dividers, frequency subtext
  ink350: 'rgba(28, 31, 38, 0.35)'  # separators
  ink200: 'rgba(28, 31, 38, 0.2)'   # empty signal bars
  ink100: 'rgba(28, 31, 38, 0.1)'   # hover wash

  # "Chrome on dark" ramp. Also literal — Tailwind opacity utilities.
  surfaceFill: 'rgba(0, 0, 0, 0.2)'        # bg-black/20 — panel fill
  surfaceBorder: 'rgba(255, 255, 255, 0.05)' # border-white/5 — panel edge
  inputFill: 'rgba(0, 0, 0, 0.4)'          # bg-black/40
  inputBorder: 'rgba(255, 255, 255, 0.4)'  # border-white/40 — WCAG 1.4.11 floor
  textPrimary: '#ffffff'
  textSecondary: 'rgba(255, 255, 255, 0.7)'
  textMuted: 'rgba(255, 255, 255, 0.6)'

  heatmap:
    level0: 'rgba(255, 255, 255, 0.05)'
    level1: 'rgba(16, 185, 129, 0.2)'
    level2: 'rgba(16, 185, 129, 0.4)'
    level3: 'rgba(16, 185, 129, 0.6)'
    level4: 'rgba(16, 185, 129, 0.8)'
    level5: 'rgba(16, 185, 129, 1)'

typography:
  fontFamily:
    sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    mono: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"
  fontWeight:
    normal: 400
    medium: 500
    bold: 700
    extrabold: 800
  # Static scale — chrome only. Note xs/sm are LARGER than Tailwind defaults.
  fontSize:
    xs: '0.875rem'
    sm: '0.9375rem'
    base: '1rem'
    lg: '1.25rem'
    xl: '1.5rem'
    '2xl': '2rem'
  # Fluid scale — inside container-query roots. clamp(floor, Ncqmin, ceiling).
  fluidFontSize:
    displayMain: 'clamp(28px, 22cqmin, 360px)'
    displayFrequency: 'clamp(12px, 9cqmin, 160px)'
    bankButton: 'clamp(11px, 6cqmin, 80px)'
    controlButton: 'clamp(9px, 4.5cqmin, 52px)'
    hitFrequency: 'clamp(13px, 5cqmin, 72px)'
    widgetHeading: 'clamp(14px, 3cqmin, 56px)'
    widgetLabel: 'clamp(10px, 2.4cqmin, 40px)'

spacing:
  scale: '0.25rem' # Tailwind 4px grid
  clusterGap: '0.5rem'   # gap-2 — dominant intra-cluster gap
  panelGap: '1.5rem'     # gap-6 — macro gap between panels
  contentPadding: '1.5rem' # p-6 — main content area
  widgetPadding: '1rem'  # p-4 — dashboard widget cards
  railPadding: '1rem 0.375rem' # px-4 py-1.5 — top/bottom shell rails
  buttonPill: '0.375rem 0.75rem' # py-1.5 px-3

rounded:
  xs: '1px'
  sm: '2px'
  md: '6px'
  display: '7px'
  lg: '0.5rem' # rounded-lg — panel corners

elevation:
  displayInset: 'inset 4px 4px 4px 0px #b06105'
  modal: 'shadow-2xl'
  buttonPress: 'translateY(1px)'

components:
  appShell:
    background: bgScannerDark
    backgroundImage: 'radial-gradient(circle at 50% 22%, rgba(61,68,84,1) 0%, rgba(45,50,61,1) 50%, rgba(28,31,38,1) 100%)'
    color: textPrimary
    size: '100% x 100%'
  displayPanel:
    background: 'radial-gradient(ellipse at 50% 30%, #ef991f 0%, #e48813 50%, #d97706 100%)'
    borderRadius: rounded.display
    boxShadow: elevation.displayInset
    containerType: size
  surface:
    background: surfaceFill
    border: surfaceBorder
    borderRadius: rounded.lg
  input:
    background: inputFill
    border: inputBorder
    focusBorder: brandPrimary
  buttonPrimary:
    background: brandPrimary
    color: '#000000'
    fontWeight: bold
    hoverBackground: brandHover
  buttonMuted:
    background: 'rgba(255, 255, 255, 0.05)'
    color: textSecondary
    hoverBackground: 'rgba(255, 255, 255, 0.1)'
  controlButton:
    border: ink800
    color: ink900
    hoverBackground: ink100
    activeBackground: ink800
    activeColor: brandPrimary
---

# Bearpaw Design System

## Overview

Bearpaw is a Tauri desktop app that controls a Uniden BC125AT handheld scanner.
The interface is a **single dark instrument shell** with a **backlit amber
display panel** at its focal point — deliberately echoing the physical radio it
drives.

Two consequences fall out of that metaphor and govern nearly everything below:

1. **There is one theme.** Dark. See "Light mode is not a supported state."
2. **There are two coordinate systems.** The shell chrome (tab rail, status bar,
   modals, sidebars) uses a static 4px spacing grid and a fixed type scale. The
   display panel and the dashboard widgets are **container-query roots** where
   every size — type, padding, gap, icon — is a `clamp()` in `cqmin` units, so
   the "instrument" scales as one object from a small window up to a 4K kiosk.

Do not mix them. Inside a `[container-type:size]` box, use `clamp()`. Outside
it, use the Tailwind scale.

### Where tokens actually live

**Add new tokens to the `@theme inline` block in
[`frontend/src/styles/theme.css`](frontend/src/styles/theme.css#L250-L332).**

[`frontend/tailwind.config.cjs`](frontend/tailwind.config.cjs) is a Tailwind v3–shaped
JS config sitting in a Tailwind v4 project. **It is not loaded.** v4 only honors a
JS config through an explicit `@config` directive, and no such directive exists
in `src/styles/`. Anything declared only in that file produces no CSS.

This has already leaked into shipped code. These classes appear in components and
emit nothing:

| Broken class | Sites |
| --- | --- |
| `bg-scanner-bg-dark`, `border-scanner-bg-dark` | [App.tsx:1070](frontend/src/app/App.tsx#L1070), [TabBar.tsx:55](frontend/src/app/components/TabBar.tsx#L55), [ScannerUI.tsx:66](frontend/src/app/components/ScannerUI.tsx#L66), [ChannelsTab.tsx:791](frontend/src/app/components/views/ChannelsTab.tsx#L791), [ImportProgressOverlay.tsx:30](frontend/src/app/components/ImportProgressOverlay.tsx#L30) |
| `text-scanner-text-light`, `text-scanner-text-secondary` | [App.tsx:1076](frontend/src/app/App.tsx#L1076), [App.tsx:1089](frontend/src/app/App.tsx#L1089), [TabBar.tsx:75](frontend/src/app/components/TabBar.tsx#L75), [ScanView.tsx:218](frontend/src/app/components/views/ScanView.tsx#L218) |
| `font-display` | [ScannerUI.tsx:325](frontend/src/app/components/ScannerUI.tsx#L325), [ScanView.tsx:218,310,354](frontend/src/app/components/views/ScanView.tsx#L218) |

None of them *look* broken, because in each case a sibling class or an inherited
value covers for the miss — the shell's own `color` stands in for the missing text
color, `bg-white/10` still reads as an active tab, and `--font-display` is
byte-identical to `--font-sans` anyway. That is precisely why they persist.

**The class-name shapes differ between the two systems, and this is the trap.**
`@theme inline` produces flat names: `--color-brand-primary` → `bg-brand-primary`.
The unloaded `.cjs` used nesting (`scanner.bg.dark`), which yields
`bg-scanner-bg-dark` — a shape `@theme inline` **cannot produce at all**. Copying
an existing `scanner-bg-*` class from a component will silently give you nothing.

### Light mode is not a supported state

[`theme.css:3-127`](frontend/src/styles/theme.css#L3-L127) defines a full light
`:root` palette. **It never executes.**
[`main.tsx:6`](frontend/src/main.tsx#L6) applies `document.documentElement.classList.add('dark')`
unconditionally at boot — no toggle, no persistence, no media query, no theme
provider anywhere in the tree.

Treat that `:root` block as reserved-and-unimplemented. Do not spend effort
keeping it in sync, and do not assume a component will be seen in light mode.

### The shadcn layer is sealed off

The generic shadcn/Radix tokens (`--primary`, `--card`, `--muted-foreground`,
`--sidebar-*`) are live, but **only inside
[`frontend/src/app/components/ui/`](frontend/src/app/components/ui/)**. App-level
components use them exactly three times in the entire tree.

The convention is: drop in a Radix primitive, then override its palette at the
boundary with one `scanner-*` class. Don't reach for `bg-card` or
`text-muted-foreground` in app code — reach for the scanner vocabulary.

---

## Colors

### The amber display is the only saturated surface

`#ef991f` and its neighbors appear on exactly one thing: the display panel and
elements that read as cut from it. Everything else in the app is a neutral —
near-black shell, white-at-low-opacity chrome. That contrast *is* the design. A
second saturated hue anywhere in the shell breaks the instrument read.

Brand amber does double duty as the accent for active/primary states outside the
panel (`bg-brand-primary` on primary buttons, `text-brand-primary` on the active
control state, `focus:border-brand-primary` on inputs).

### Two opacity ramps, not two palettes

Most color in Bearpaw is not a token. It's an opacity step on one of two inks:

- **On amber:** `rgba(28, 31, 38, α)` — the shell's own near-black, laid over the
  display. The steps carry meaning: `0.9` text, `0.8` borders and filled bars,
  `0.7` active fill, `0.6` dividers, `0.2` empty bars, `0.1` hover.
- **On dark:** `white/α` via Tailwind utilities — `border-white/5` panel edges,
  `bg-white/5` muted button fills, `text-white/60` secondary text.

Stay on these ramps. A new gray that isn't a step on one of them will read as a
foreign object.

> **Known inconsistency:** [ScannerUI.tsx:325](frontend/src/app/components/ScannerUI.tsx#L325)
> and [:334](frontend/src/app/components/ScannerUI.tsx#L334) use
> `rgba(28,31,39,…)` — `39`, not `38`. A one-off typo, not a variant. Use `38`.

### Status colors are resolved in JS, not as classes

There are **no LED components** in the app despite `--led-green` / `--led-red`
tokens existing. The single status affordance is an 8px inline SVG circle at
[ScannerUI.tsx:66-72](frontend/src/app/components/ScannerUI.tsx#L66-L72), filled
from a `var(--color-status-*)` **string** returned by `getStatusDisplay`. No glow,
no `led-*` utility class. Follow that pattern for new status indicators.

---

## Typography

**System font stack only.** No `@import`, no CDN, no Google Fonts — the app must
render fully offline. `--font-sans` and `--font-mono` are declared in
[`theme.css`](frontend/src/styles/theme.css#L5-L9); adding a network font is a
functional regression, not a style choice.

### Mono means machine-read numbers

`font-mono` is semantic here, and the rule is consistent across ~22 usages:
anything the user reads as *data* is mono. Frequencies, channel numbers, session
stat values, device numeric inputs, sync percentages, and — notably — the
physical-button labels (VOL, L-O, HOLD, bank digits 1–0), because those mimic
silkscreen on hardware.

Prose, headings, and labels are sans.

### The real scale is fluid, not stepped

The static scale (`--text-xs` … `--text-2xl`) covers chrome. It's used lightly —
there is exactly one `text-2xl` in the app layer and zero `text-3xl`/`text-4xl`,
so those two tokens are unused.

The type that matters is `clamp(floor, Ncqmin, ceiling)` inside the three
container roots. The main readout tops out at **360px**. Per the comment at
[ScannerUI.tsx:316-321](frontend/src/app/components/ScannerUI.tsx#L316-L321),
those ceilings are sized for **4K kiosk readability**, not a desktop window —
they will look absurd if you test only at 1280×800 and "fix" them.

The main readout is additionally wrapped in
[`FitText`](frontend/src/app/components/FitText.tsx), which shrinks toward a 16px
floor until the string fits. **It never wraps and never truncates.** Don't add
`truncate` or a line clamp to it.

---

## Layout

### Shell

The app is fluid, not fixed. Tauri opens at 1280×800 with a 1100×640 minimum and
is resizable; the shell fills 100%×100%.

```
div.scanner-app-shell                    // flex-col, radial-gradient bg
├── h1.sr-only "Bearpaw"
├── Toaster (sonner, top-right)
├── nav[aria-label="Views"] > TabBar     // top rail — shrink-0, px-4 py-1.5
├── main#view-panel                      // flex-1 overflow-hidden p-6
│   └── AnimatePresence → ScanView | ChannelsTab | DeviceTab
├── StatusBar                            // bottom rail — mirrors top rail
├── ScanAnnouncer                        // sr-only live region
└── overlays (memory sync, import)       // fixed inset-0
```

Three views, fixed: `Scan`, `Channels`, `Device`.

The intended chrome is a **tinted top rail + tinted bottom rail bracketing a
`p-6` content area**. Both rails currently render transparent because their
tint classes are the broken `scanner-bg-dark` shape described above.

`html { overflow-y: hidden }` at
[theme.css:352-356](frontend/src/styles/theme.css#L352-L356) is load-bearing — it
suppresses an inherited scrollbar gutter that would otherwise reserve dead space
on the right edge of the Tauri window. Don't remove it.

### Container-query roots

There are exactly three, and they define the fluid zones:

| Root | Contains |
| --- | --- |
| [ScanView.tsx:194](frontend/src/app/components/views/ScanView.tsx#L194) | Display panel + Recent Hits |
| [ScanView.tsx:306](frontend/src/app/components/views/ScanView.tsx#L306) | Busiest Channels + Activity Heatmap |
| [ScannerUI.tsx:290](frontend/src/app/components/ScannerUI.tsx#L290) | Everything inside the amber panel |

`[container-type:size]` on these is what makes every `cqmin` below resolve. Remove
it and the whole fluid scale collapses to its floor.

### Reserved space beats reflow

Recent Hits renders **five fixed slots**, empty ones included, so the layout
doesn't jump when a hit arrives and the oldest rotates out. The timestamp column
is `minmax(14ch, max-content)` specifically so the relative-time string ("2m ago"
→ "10m ago") can't wobble the grid as it ticks.

Generalize this: in a panel showing live scanner data at ~5 Hz, **reserve the
space**. Layout that reflows on data arrival reads as a malfunction.

### Dead layout tokens

`--layout-monitor-bezel` has zero references. It is a leftover from a removed
`monitor` variant — [ScannerUI.tsx:255-262](frontend/src/app/components/ScannerUI.tsx#L255-L262)
notes "there's no longer a `monitor` variant." **There is no bezel metaphor in
the shipping UI.** Roughly a dozen other `--layout-*` / `--size-*` tokens are
likewise unreferenced. Don't treat the token list in `theme.css` as an inventory
of the design — much of it is sediment.

---

## Elevation & Depth

Bearpaw has almost no elevation vocabulary, and that's intentional — a flat
instrument face, not a stack of floating cards.

The three depth cues:

1. **The display inset.** `inset 4px 4px 4px 0px #b06105` on the amber panel —
   a warm inner shadow that makes it read as recessed behind glass. This is the
   only inset in the app.
2. **The shell gradient.** A radial gradient lifting the center of the app
   background, so the shell reads as a curved surface under light.
3. **Button press.** `active:translate-y-[1px]`. Physical, one pixel, no shadow
   change.

Modals use `shadow-2xl`. Nothing else casts a shadow. There is no `z`-scale.

> `--shadow-button` and `--shadow-inset` tokens exist and are unused — the panel
> inlines the identical value as an arbitrary utility. If you need the inset, use
> `shadow-[inset_4px_4px_4px_0px_var(--border-inset)]` to match existing code.

---

## Shapes

Radii are **small and hardware-flavored**. The scale tops out at 7px for the
display itself:

| Token | Value | Use |
| --- | --- | --- |
| `rounded-scanner-xs` | 1px | Control and bank buttons |
| `rounded-scanner-sm` | 2px | Small chips |
| `rounded-scanner-md` | 6px | General controls |
| `rounded-scanner-display` | 7px | The amber display panel |
| `rounded-lg` | 8px | Dashboard panel corners |

Nothing is pill-shaped. Nothing is a circle except the 8px status dot. Large
radii read as "web app" and fight the instrument metaphor.

---

## Components

### Display panel (`ScannerDisplay`)

The centerpiece. An amber radial gradient with an inset shadow, a `container-type:size`
root, and `rounded-scanner-display` corners. Inside it: the main readout
(alpha tag / status), the frequency subtext in mono, the VOL / L-O / HOLD control
cluster, signal bars, and the bank row.

Per [ScannerUI.tsx:255-262](frontend/src/app/components/ScannerUI.tsx#L255-L262),
**all Scan controls live inside this panel** — there is no separate control strip.

> Note: the `.scanner-display-surface` class in `theme.css` has zero usages and a
> *different* gradient geometry (`circle at 50% 50%`) than the one actually
> rendered (`ellipse at 50% 30%`). The inline version is the real one.

### Buttons

Three distinct systems, by context:

**On amber** — `CONTROL_BUTTON_CLASSES`
([ScannerUI.tsx:119-120](frontend/src/app/components/ScannerUI.tsx#L119-L120)):
`rounded-scanner-xs`, ink-800 border, ink-900 mono label, `clamp()` sizing,
`active:translate-y-[1px]`.

**Active state is a color inversion, never a shape or label change:**
`bg-[rgba(28,31,38,0.8)] text-brand-primary`. Bank buttons mirror this exactly —
per [ScannerUI.tsx:355-365](frontend/src/app/components/ScannerUI.tsx#L355-L365),
"so the whole panel speaks one visual language."

**On dark** — the `@layer components` pair:
- `.scanner-button-primary` — amber fill, black bold text
- `.scanner-button-muted` — `white/5` fill, `white/70` text

Both are consistently sized at the call site with
`px-3 py-1.5 text-xs uppercase tracking-wider`.

### Panels

`bg-black/20` + `border border-white/5` + `rounded-lg`. This is exactly the
`.scanner-surface` class — **use the class**. Three sites in `ScanView.tsx`
currently inline the same three utilities instead.

### Radix boundary

Every Radix primitive gets one `scanner-*` class to override the shadcn palette:
`.scanner-select-content`, `.scanner-modal`, `.scanner-input`.

`.scanner-modal` additionally needs neutralizing utilities at the call site —
`max-w-none translate-x-[-50%] translate-y-[-50%] gap-0 p-0` — to beat
`DialogContent`'s own grid/padding/`sm:max-w-lg`.

**One deliberate exception:** the L/O dropdown is styled **amber** (`bg-[#e48813]`),
because it reads as "a chip cut from the display pane." It also uses no `cqmin`
units — it portals outside the `container-type:size` box, where those units have
no referent.

---

## Do's and Don'ts

### Do

- **Put new tokens in `@theme inline`** in `theme.css`, and verify the class
  actually emits CSS before shipping it.
- **Use `clamp(floor, Ncqmin, ceiling)` inside container roots**, and the Tailwind
  4px scale outside them.
- **Use mono for anything read as data** — frequencies, channel numbers, counts,
  hardware-style button labels.
- **Reserve layout space for live data.** Fixed slot counts, `ch`-based minimum
  widths on tickers.
- **Signal state with color + ARIA.** `aria-pressed`, `aria-label`, and a fill
  inversion.
- **Use `.scanner-surface`** for panels rather than re-inlining
  `bg-black/20 border-white/5 rounded-lg`.
- **Mark decorative icons `aria-hidden`.** This is done consistently; match it.

### Don't

- **Don't flip a button's visible label with its state.** The HOLD button reads
  `HOLD` in both held and not-held states. It previously flipped `HOLD` ↔ `SCAN`,
  which implied "press to resume" on the very control that entered HOLD. State is
  carried by `aria-pressed`, `aria-label`, and highlight color.
  Guarded by `ScannerDisplay.test.tsx :: toggles HOLD button aria-pressed and aria-label when isHolding flips`.

- **Don't put `aria-live` on the frequency or RSSI text.** Those change ~5×/sec;
  a live region there floods a screen reader with noise. All announcements go
  through [`ScanAnnouncer`](frontend/src/app/components/ScanAnnouncer.tsx), which
  announces only meaningful transitions — hit, scanning, disconnected. The comment
  at ScanAnnouncer.tsx:22-25 calls this out as a hard prohibition.

- **Don't add `role="status"` to the StatusBar.** Same reason — it holds ticking
  session counters.

- **Don't weaken `.scanner-input`'s border.** `border-white/40` (~3.8:1 on the
  `bg-black/40` fill) is the WCAG 1.4.11 non-text-contrast floor; the input edge
  is the control's only affordance. It was `border-white/10` (~1.3:1, effectively
  invisible) and was deliberately raised.
  **Existing violation:** [ChannelsTab.tsx:834](frontend/src/app/components/views/ChannelsTab.tsx#L834)
  applies `scanner-input w-full border-white/5`, overriding it back below the floor.

- **Don't copy `scanner-bg-*` / `scanner-text-*` / `font-display` classes** from
  existing components. They emit no CSS. See "Where tokens actually live."

- **Don't reach for shadcn tokens** (`bg-card`, `text-muted-foreground`,
  `bg-primary`) in app-level components. They belong to the `ui/` layer.

- **Don't add a second saturated hue.** Amber against neutrals is the whole
  visual thesis.

- **Don't add network fonts.** The app must render fully offline.

- **Don't assume light mode.** It isn't reachable.

- **Don't use large radii or pill shapes.** They break the hardware read.

### Motion

Motion is honored through two independent mechanisms and both must be respected:

- **Motion library** — `<MotionConfig reducedMotion={...}>` wraps the app,
  folding the OS preference together with an in-app toggle.
- **CSS** — an explicit `@media (prefers-reduced-motion: reduce)` rule disables
  the sync spinner.

> **Known gap:** `animate-pulse` on the main readout
> ([ScannerUI.tsx:326](frontend/src/app/components/ScannerUI.tsx#L326)) is a
> Tailwind CSS animation, so it is covered by *neither* mechanism. There is no
> global reduced-motion reset for Tailwind animations. New Tailwind `animate-*`
> usage needs its own media query.
