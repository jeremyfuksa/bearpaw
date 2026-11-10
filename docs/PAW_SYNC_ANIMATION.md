# Paw sync animation reference

Source asset: `frontend/src/assets/bearpaw-paw.svg`.

The asset extracts the original logo's eleven paths without changing their
geometry or gray fill (`#A8A9AD`). Its transparent 124 × 140 canvas excludes the
wordmark. The palm has its own ID; each of the five named digit groups contains
one pad and one claw. Left/right refer to the viewer's perspective.

## Modeling brief

Use the SVG as the front-facing silhouette and exact final pose. Model a curled
bear paw facing the viewer, with all five digits tucked into the palm at 0%.
Uncurl one digit at each completed 20% milestone, keeping previously opened
digits extended. A proposed order is left to right:

| Progress | Newly opened group | Pose |
| --- | --- | --- |
| 0–19% | None | Closed fist |
| 20–39% | `digit-outer-left` | One digit open |
| 40–59% | `digit-inner-left` | Two digits open |
| 60–79% | `digit-center` | Three digits open |
| 80–99% | `digit-inner-right` | Four digits open |
| 100% | `digit-outer-right` | Exact logo silhouette |

The logo is a paw print, not an anatomical hand: it has disconnected pads and
claws. Closed and intermediate poses need authored geometry. Simply hiding pads
or scaling them would not depict a fist opening. If using a solid 3D paw, resolve
its connected surface into the separated logo shapes at completion.

Keep the camera, canvas, scale, and palm position fixed across all poses. Use a
transparent background. For SVG, retain stable group IDs and compatible path
topology for morphing. For PNG, export consistently sized RGBA frames with no
per-frame trimming. Author five short opening transitions that can play once
and hold at their endpoints; sync progress must drive them rather than a loop.
Allow progress to jump across multiple milestones and provide static milestone
poses for reduced-motion users.

## Integration target

The existing progress component is
`frontend/src/app/components/SyncSpinner.tsx`; the memory-sync overlay in
`frontend/src/app/App.tsx` passes `sync.percent` to it. Preserve the numeric
percentage and accessible progress messaging when replacing the visual. Ensure
the complete pose can be seen before the overlay dismisses.

This extraction does not change the current sync UI or supply the newly modeled
closed/intermediate poses.

## Anatomy and animation research — October 21, 2026

### Anatomical anchors

- Bears have five digits per foot and non-retractile claws. The giant panda's
  additional grasping structure is an enlarged radial sesamoid, not a sixth
  finger. Keep five digits and make claws rotate with their digits rather than
  extend like a cat's claws. [University of Michigan Animal Diversity Web](https://animaldiversity.org/accounts/Ursidae/)
- Black bear toes form a more separated, curved arc; brown/grizzly toes sit
  closer together in a straighter row. Black bear front claws are shorter and
  more curved. The logo's strongly arched arrangement suggests black bear as a
  useful visual starting point, although the logo is stylized and does not
  establish a species. [National Park Service comparison](https://www.nps.gov/articles/bear-identification.htm)
- Front and hind prints differ. Use the front paw as the reference for this
  hand-like gesture; avoid importing the elongated hind-foot silhouette.
  The Alaska guide illustrates pads and front/hind distinctions.
  [Alaska Department of Fish and Game track guide](https://www.adfg.alaska.gov/static/education/educators/pdfs/wild_wonders_issue2.pdf)

### Reference shortlist

1. **Baloo, The Jungle Book (1967): first meeting and boxing lesson with Mowgli.**
   Andreas Deja's page presents pencil animation from this sequence and identifies
   the work of Ollie Johnston and Frank Thomas. This is the strongest located
   reference for bear anatomy adapted to human acting. Study the compact paw
   poses and their transition into broad gestures, keeping the palm substantial.
   [Pencil animation and animator commentary](https://andreasdeja.blogspot.com/2013/04/jungle-book-pencil-animation.html)
   A separate shot analysis explicitly discusses the paws circling in boxing
   motions and opening outward; it is a useful navigation aid to the sequence,
   rather than an anatomical source.
   [Sequence analysis](https://www.animatedspirit.com/film-analysis-a-jungle-book-sequence-part-4/)
2. **Aaron Blaise, How to Draw Bears.** The published curriculum includes
   dedicated Grizzly Bear Paws, Polar Bear Paws, and Black Bear Feet lessons,
   plus skeleton/muscle and locomotion material. This is the most directly
   relevant construction resource located. The curriculum was inspected, not
   the paid lessons; a sequential fist-opening demonstration is not verified.
   [Course and sample](https://creatureartteacher.com/product/how-to-draw-bears-aaron-blaise/)
3. **Kenai and Koda, Brother Bear.** A secondary visual direction for combining
   bear bodies with human emotion. Disney confirms Kenai's human-to-bear premise
   and Aaron Blaise's co-direction. Use as a character-design reference; this
   research did not verify an isolated five-digit opening shot.
   [Official film reference](https://www.disneyanimation.com/films/brother-bear/)
4. **Queen Elinor, Brave.** A complementary 3D reference for a human personality
   expressed through a bear body. Pixar's page includes trailers and character
   material. Useful for the modeling direction, but no exact sequential
   fist-to-open-paw clip was verified here.
   [Official film and trailers](https://www.pixar.com/brave)

These references support construction and acting choices. None was verified as
an exact five-step finger-counting animation. Do not treat them as an existing
motion sequence ready to reproduce or as a source of production assets.

### Recommended interpretation for Bearpaw

The following are design proposals, not claims about natural bear behavior:

- Start with a soft, cupped fist: five short, thick digits curling toward the
  broad palm. Avoid a strongly human thumb laid across four knuckles. Keep
  enough palm visible that the initial silhouette still reads as an animal paw.
- Give each digit a base bend and a tip curl. Open from the base with a slight
  delay in the tip, allowing the pad to turn toward the viewer. The claw follows
  the tip and may be occluded while curled; it never retracts into the digit.
- Keep the agreed left-to-right milestone sequence. Do not start with the center
  digit alone, which could read as a different hand gesture.
- Use the logo as a fixed front-facing target for every open digit. Stabilize
  palm position and scale; use only a small settling motion after each opening.
- Prototype each opening at roughly 250–350 ms, then hold. These timings are an
  initial art-direction choice to evaluate at the actual 56 px display size.
- Solve the connected-paw-to-separated-print transition explicitly. A promising
  approach is a restrained outer paw silhouette with prominent pads and claws;
  as the fifth digit opens, remove the supporting silhouette and retain the exact
  logo paths. Test this in six static poses before investing in a full rig.
- For a flat graphic result, authored SVG poses offer direct control over the
  final logo. A 3D model can provide curl and overlap reference or transparent PNG
  renders, but converting a render into editable SVG would be a separate step.
