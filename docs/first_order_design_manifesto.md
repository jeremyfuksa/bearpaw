# The First-Order Design Manifesto

> *Design from the first action outward.*  
> *If the primary action is not effortless, no amount of features will save the tool.*

---

## 0. Purpose

This manifesto defines a first-order approach to designing tools that observe, listen, decode, supervise, or make sense of complex systems over time.

It is intentionally app-agnostic. It applies to radio software, but also to any system where time, change, and attention matter.

The goal is not minimalism. The goal is **clarity of intent**.

---

## 1. Identify the First Action

Every tool has a *first action*.

Not a feature. Not a capability. An action the user performs before conscious thought.

Examples:
- orienting in a signal space
- waiting for something to appear
- supervising an automated process
- watching an image emerge
- listening for change

If the interface does not make this first action obvious, continuous, and trustworthy, the tool has failed before it begins.

**Constraint**  
Never design secondary actions until the first action is effortless.

---

## 2. The Map Comes First

The first action always requires orientation. Orientation requires a map.

The map is how the user understands:
- time
- change
- density
- possibility

The map might be a waterfall, timeline, live trace, decoded artifact, or event stream.

Regardless of form:
- the map is visible by default
- the map dominates the screen
- controls serve the map, not frame it

If the map is removed, the interface must clearly justify how orientation survives.

**Constraint**  
If the user cannot see change over time, they are guessing, not working.

---

## 3. Declare Posture Before Features

Every screen operates in one posture:

- **Active** – the user steers continuously
- **Guided** – the system runs, the user supervises
- **Passive** – the system waits, observes, or decodes

Posture determines:
- acceptable density
- interruption tolerance
- control visibility

Mixing postures without declaration produces anxiety and clutter.

**Constraint**  
If the user does not know how attentive they need to be, the interface is lying.

---

## 4. Effortless First, Powerful Later

Power is not exposed. Power is *available*.

The first action must:
- work without configuration
- tolerate ambiguity
- require minimal explanation

Advanced capability belongs behind intent, modes, or explicit entry points.

**Constraint**  
If a beginner must understand internals to begin, the design is upside-down.

---

## 5. Automation Serves the Hand

Automation reduces effort; it does not assert authority.

- automation yields instantly to manual intent
- automation never nags
- automation never blocks
- automation never assumes correctness

Automation may notice, suggest, or prepare. It may not decide.

**Constraint**  
The moment the user touches the tool, the tool listens.

---

## 6. Confirmation Beats Configuration

When the user acts, the system prepares the result.

- outcomes are prepopulated
- the user confirms, corrects, or dismisses
- typing is optional
- notes are optional
- “unknown” is valid

Configuration is second-order work.

**Constraint**  
If the user is filling out forms during a live moment, the system failed to prepare.

---

## 7. Memory Is First-Order

If a system produces fleeting moments, remembering them is core functionality.

Memory should:
- activate after intent
- be calm to review
- grow lighter over time

Logs, captures, and results are memories, not files.

**Constraint**  
If reviewing the past feels like administration, memory was designed last.

---

## 8. Complexity Lives in Workshops

Deep configuration is allowed.

But complexity must be:
- bounded
- declared
- reversible

Complexity is never the default posture.

**Constraint**  
If a user could accidentally live in complexity, it has leaked.

---

## 9. Use Familiar Grammar

A family of tools shares interaction language.

Prefer:
- overlays over permanent clutter
- sheets for momentary decisions
- drawers for review
- palettes for power actions
- subtle markers over alerts

**Constraint**  
If every screen teaches a new interaction, the tool has no language.

---

## 10. Calm Is a Feature

Silence and waiting are not failures.

A good tool:
- does not fill space to prove activity
- does not panic on behalf of the user
- makes time passing visible and understandable

**Constraint**  
If the interface looks anxious, the user will be too.

---

## Closing Check

Before adding any feature, ask:

1. What is the first action?
2. Where is the map?
3. Does this help or hinder orientation?
4. Is this first-order, or premature?

If unclear, stop.

---

## One Sentence

> **The first job of a tool is to get out of the way of the thing it exists to do.**
