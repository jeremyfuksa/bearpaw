# First-Order Mapping
## Applying the Manifesto to Specific Apps

This document maps first-order principles to three concrete applications. It exists to ensure family resemblance without forcing identical layouts or features.

---

## 1. SDR Listening App

### First Action
Orienting in frequency and time while listening.

### Map
The waterfall.
- Shows time, density, drift, and opportunity.
- Dominates the screen.
- Is the primary navigation surface.

### Posture
**Active**
- user steers continuously
- interruptions are expensive

### First-Order Requirements
- waterfall visible immediately
- manual tuning always wins
- audio never pauses unnecessarily

### Second-Order Capabilities
- logging via confirmation sheet
- discovery as whisper
- sweeps as optional scouts

### Complexity Placement
- advanced DSP and device settings live in declared configuration views
- never around the waterfall

---

## 2. Scanner Frontend App

### First Action
Supervising an automated listener and noticing activity.

### Map
The activity timeline / hit list.
- shows what was heard and when
- reflects density and patterns over time

### Posture
**Guided**
- device runs
- user supervises and reacts

### First-Order Requirements
- live activity visible at a glance
- clear sense of "now" vs "earlier"
- logging is fast and confirmatory

### Second-Order Capabilities
- bank management
- discovery-like analysis of hits
- statistics and summaries

### Complexity Placement
- full scanner configuration exists in a bounded, declared cockpit mode
- exiting configuration returns to calm supervision

---

## 3. SSTV Decoding App

### First Action
Waiting for an image to emerge from noise.

### Map
The decoded image over time.
- live decode preview
- accumulated visual artifact

### Posture
**Passive**
- user observes
- system waits and decodes

### First-Order Requirements
- decode state visible and calm
- partial results are acceptable
- no required interaction during reception

### Second-Order Capabilities
- capture / save
- annotate
- retry decode with different mode

### Complexity Placement
- decoder tuning and thresholds live in advanced configuration
- primary receive view remains quiet

---

## Cross-App Family Constraints

Across all apps:
- the map is always first
- posture is explicit
- confirmation beats configuration
- automation whispers
- memory is first-class

If a feature breaks these constraints, it does not belong in v1.
