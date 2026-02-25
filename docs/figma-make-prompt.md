# Bearpaw UI Refinement Prompt

## Context: What Already Works
The current Bearpaw UI is strong. Keep these core elements:
- VirtualDisplay as the primary scanner information display
- Recent Hits table for activity logging
- Dashboard analytics widgets (session stats, busiest channels, activity heatmap)
- Device configuration interface with comprehensive scanner parameter access
- Bank controls for operational scanning
- Overall visual style, typography, and color scheme

**Goal:** Evolve the visual hierarchy and information architecture, not replace it.

---

## Refinement Focus Areas

### 1. Strengthen VirtualDisplay Dominance (Scan View)

**Current state:** VirtualDisplay shares screen space with multiple widgets in a grid layout.

**Refinement goal:** Make VirtualDisplay feel like the undisputed primary element while keeping other widgets accessible.

**Exploration prompts:**
- Increase VirtualDisplay vertical space to 50-60% of viewport
- Try larger typography for frequency display (currently good, explore even bolder)
- Position analytics widgets as "supporting context" below or to the side
- Consider: Can session stats become a one-line summary instead of a card? ("42 hits • 15m uptime")
- Keep busiest channels and heatmap, but visually subordinate them (lighter backgrounds, smaller scale, or collapsible headers)

**Don't change:** Core widget functionality, data shown, or interaction patterns.

---

### 2. Add "Mode Gravity" to Configuration (Device Tab)

**Current state:** Device tab feels like a peer to Scan tab. Configuration parameters are comprehensive (which is correct) but lack spatial organization.

**Refinement goal:** Make entering configuration feel like "stepping into a workshop" while keeping all parameters accessible.

**Exploration prompts:**
- Add visual transition cue: "Configure Scanner" header or entry state
- Group parameters into clear sections with headers:
  - Audio Controls (volume, squelch, key beep)
  - Display Settings (backlight, contrast)
  - Scanning Behavior (priority mode, search settings)
  - Close Call Configuration (mode, bands, alerts)
  - Power Management (battery, key lock)
- Try section cards with subtle background differentiation
- Add a prominent "Done" or "Back to Scan" button to signal reversibility
- Consider warmer or slightly different background tone to indicate "different mode"

**Don't change:** The parameters themselves, the comprehensive parity with device features.

---

### 3. Explore Analytics as Optional Density

**Current state:** Dashboard widgets are always visible in scan view.

**Refinement goal:** Allow both minimal (calm) and full dashboard (power user) configurations without mode switching.

**Exploration prompts:**
- **Design A:** Default minimal view (VirtualDisplay dominant + Recent Hits), with setting to enable optional widgets
- **Design B:** Add manual toggle in scan view header ("Expand Dashboard" / "Collapse Dashboard")
- **Design C:** Create separate "Analytics" tab as peer to Scan/Device/Channels for deep dashboard review
- Try compact vs expanded widget states (e.g., busiest channels could collapse to "Top 3" vs full list)

**Don't change:** The widgets themselves or the data they display.

---

## Design Constraints

1. **Preserve existing visual language:** Keep current typography, colors, spacing system, component shapes
2. **No layout thrashing:** Don't auto-show/hide elements based on scanner state (squelch, mode)
3. **Maintain functionality:** All current features should remain accessible
4. **Progressive enhancement:** Default to calm, allow opt-in to density
5. **Stable structure:** User controls information density, not machine state

---

## Deliverable Variations to Explore

Generate 2-3 variations showing:

**Variation A: "Hierarchy Refinement"**
- Same overall layout
- VirtualDisplay much larger/more prominent
- Analytics widgets visually subordinated but still present
- Config sections organized with card grouping

**Variation B: "Mode Separation"**
- Scan view: minimal (VirtualDisplay + Recent Hits only)
- New Analytics tab for full dashboard
- Config mode with clear visual entry/exit cues

**Variation C: "User-Controlled Density"**
- Toggle or settings to show/hide analytics widgets
- Collapsed vs expanded widget states
- Config with progressive disclosure sections

---

## Visual Principles to Maintain

- **Clarity over capability** (except in declared expert modes)
- **Spatial hierarchy** over hiding
- **Grouped by human intent** over device registers
- **One clear primary focus** per view
- **Typography and spacing create hierarchy**, not just size

---

## What Success Looks Like

After refinement, the UI should feel:
- **Calm by default** (newcomers aren't overwhelmed)
- **Deep when needed** (power users access full analytics/config)
- **Deliberately structured** (not accidental information density)
- **Bounded complexity** (clear when you're in operational vs expert mode)

The existing design is the foundation. Refine the hierarchy, organization, and density controls - don't start over.
