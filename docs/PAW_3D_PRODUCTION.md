# Bearpaw: 3D motion to SVG production specification

Companion research: [PAW_SYNC_ANIMATION.md](PAW_SYNC_ANIMATION.md).
Generation prompt: [PAW_SEEDANCE_PROMPT.md](PAW_SEEDANCE_PROMPT.md).

## Art direction

A single stylized bear forepaw, palm toward the viewer, opens from a compact
cupped fist into the Bearpaw mark. Five short, substantial digits curl and
unroll individually. The gesture is anthropomorphic; the proportions, broad
palm, pads, and fixed claws keep it recognizable as a bear paw.

Use a smooth sculpted surface, subdued gray, and two or three broad tonal
regions. Avoid individual fur strands and detailed skin texture. Depth should
communicate the curl without becoming essential to recognizing the pose.

The exact final geometry is `frontend/src/assets/bearpaw-paw.svg`. The connected
3D skin is temporary supporting geometry. Its silhouette does not need to equal
the disconnected print; the visible pads and claws must align with that print.

## Model and rig

1. Place the source SVG in the camera plane as a locked registration reference.
   Match the open pose before sculpting the closed pose. Preserve its proportions
   and the spacing of all eleven shapes.
2. Build a shallow, broad palm and five tapered digits behind the reference pads.
   Use rounded masses rather than elongated human fingers. Give each digit a
   base pivot and a distal curl control; add corrective shapes for the fist if
   simple joint rotation causes intersections or a hollow-looking palm.
3. Keep each pad attached to the underside of its digit and each claw rigidly
   attached to the tip. Claws may disappear through occlusion, never retraction.
   The palm pad remains attached to the palm.
4. Name digit controls `outer-left`, `inner-left`, `center`, `inner-right`, and
   `outer-right`, from the viewer's perspective. Avoid assigning human thumb
   mechanics to an outer digit. All five curl inward; do not lay a long thumb
   across the knuckles.
5. Separate skin, pads, and claws into renderable objects/material masks. Include
   a `logo_resolve` control to remove supporting skin and flatten the remaining
   pad/claw shading at completion. The app's final frame uses the original SVG,
   rather than relying on a rendered approximation to match it exactly.

## Camera and rendering

- Fixed orthographic camera, looking at the palm. No orbit, perspective drift,
  zoom, or repositioning between poses.
- Square 1024 × 1024 working canvas; fit the open reference into approximately
  80% of the canvas height and preserve its 124:140 aspect ratio. Maintain the
  same registration in every export.
- Soft frontal lighting for the motion study, no floor or cast shadow. Render
  a beauty pass and flat material-ID/shape passes. Disable motion blur and depth
  of field to make silhouettes easy to inspect and translate.
- Export production renders as transparent RGBA PNGs. A generated video may
  require background removal separately; a prompt is not an alpha-channel export.
- Inspect at 56 px as well as full resolution. Give curled digits enough overlap
  and visible creases to read as a fist at the smaller size.

## Motion design

Six persistent poses: zero, one, two, three, four, and five open digits. Open
left to right. Already-open digits stay open; unopened digits remain curled.
Keep the center digit from being the only extended digit in any pose.

Each production transition is initially 300 ms. Over its first 60%, extend the
base joint; begin uncurling the distal joint slightly later, then settle into
the target by the end. These phases overlap. Use restrained easing with no
large bounce or whole-paw wobble. Keep the palm stationary.

| App progress | Motion clip | Held pose |
| --- | --- | --- |
| 0–19% | None | All five digits curled |
| 20–39% | Open outer-left | One open |
| 40–59% | Open inner-left | Two open |
| 60–79% | Open center | Three open |
| 80–99% | Open inner-right | Four open |
| 100% | Open outer-right, then resolve | Original logo |

For the last transition, allow approximately 150 ms after the fifth opening
for the supporting skin to fade, leaving the registered pads and claws. Flatten
their shading and hand off to the exact SVG. Preview this handoff for popping.

The separate ten-second Seedance study deliberately holds poses longer than the
production UI. Its timeline is an art reference, not a clock for real sync.

## Conversion into animated SVG

Recommended route: use the 3D motion as reference for a small, deliberately
authored vector animation.

1. Render the six held poses and a few breakdown poses for each opening.
2. Draw clean filled shapes for palm/skin, pads, and claws over the renders.
   Keep stable object IDs. Use clipping or explicit visibility changes where
   digits overlap instead of forcing a self-intersecting path to morph.
3. Within each morphing shape, normalize path command order, point count, winding,
   and start points. Independently traced frames do not reliably preserve these.
   Animate transforms where appropriate; use authored path interpolation only
   where shape deformation is needed.
4. Drive the five transitions with application progress. Retain the original
   eleven logo paths for the terminal pose. Do not embed a raster movie inside
   an SVG and treat it as a vector conversion.
5. Keep PNG sequences as a fallback if preserving sculpted shading matters more
   than compact vector output. Export clips without baked-in long holds; freeze
   the last frame of each clip until the next milestone.

Blender's historical Freestyle SVG exporter documents frame and animation output
for Freestyle rendering. It is worth evaluating for contours, but it does not
establish a general conversion of a shaded render into a compact, editable rig.
The available documentation is for Blender 4.1; availability and compatibility
must be checked for the installed Blender 5.1.1 before choosing that route.
[Blender exporter documentation](https://docs.blender.org/manual/en/4.1/addons/render/render_freestyle_svg.html)

## Runtime behavior and acceptance criteria

- Clamp progress to 0–100 and map to `floor(progress / 20)` open digits.
- If progress jumps, animate newly eligible digits with a short stagger and cap
  catch-up duration; do not queue seconds of stale animation.
- Hold at each milestone. Only a new sync resets the pose. Cancellation or an
  error must not manufacture a completed logo state.
- With reduced motion, show the appropriate static pose immediately.
- Keep numeric percentage and existing accessible progress messaging outside
  the illustration. Reserve a brief completion display if needed so the final
  logo is actually visible before the overlay dismisses.
- Review six static poses, all five transitions, the final logo registration,
  readability at 56 px, and a simulated 0 → 65 → 100% jump.

## Current deliverable status

The first motion study is available in `design/paw-sync`: an editable Blender
scene with two curl controls per digit, six-pose contact sheet, MP4/GIF preview,
transparent PNG sequence, and animated SVG projected from the geometry. Open
`preview.html` through the local preview server to scrub both versions together.

The exact final SVG paths are preserved, and the last PNG frame is verified
against the registered original-logo render. The vector study uses discrete
frames and approximate object depth sorting; intersecting contours and the
closed-paw silhouette still need art refinement. It is not the compact production
morph implementation. The application's sync behavior remains unchanged.
