# Bearpaw — Seedance video prompt

## Reference and generation setup

Use the extracted `frontend/src/assets/bearpaw-paw.svg` as the source of a raster
reference image if the chosen interface does not accept SVG. Export it centered
on a square white canvas, preserving its aspect ratio and gray color. The image
is the final open pose, not the opening frame. Do not include the wordmark.

Use reference-to-video mode where available. If the interface has a dedicated
last-frame control, use the logo reference there. Do not assign the open logo as
a required first frame when asking the video to begin with a fist. The prompt
below refers to the uploaded image in plain language; replace that phrase with
the interface's reference tag if required.

Suggested target: 10 seconds, square 1:1, highest practical resolution, silent.
Choose the nearest supported settings if the interface differs. ByteDance
documents image/video reference support, but controls vary by provider.
[Official Seedance reference capabilities](https://seed.bytedance.com/en/seedance2_0/)

## Copy/paste prompt

Create a ten-second, single-shot 3D animation study for a radio synchronization
progress indicator. Show one isolated stylized bear forepaw opening from a soft,
closed fist into the paw-print symbol in the uploaded reference image. That
reference defines the FINAL pose and exact target arrangement of one broad palm
pad, five toe pads, and five claws. Preserve its proportions, spacing, and gray
color. Do not show the reference as the starting pose.

ART DIRECTION: A smooth, sculpted, friendly bear paw with a broad substantial
palm and exactly five short, thick, tapered digits. Bear anatomy with restrained
human-like acting: the digits can curl and open independently, while retaining
animal proportions. Each digit has one pad and one fixed curved claw. The claws
move with the tips; they do not retract. Use a compact cupped fist with the digits
curled toward the palm, without a human thumb crossing the knuckles. Suggest
volume with soft gray shading and a few broad tonal regions. Keep surfaces
simple, clean, and suitable for later reconstruction as vector shapes.

COMPOSITION: Square image, entire paw visible and centered with generous margins.
The fully open paw occupies about 80 percent of the image height. Palm faces
the viewer. Locked orthographic front view throughout. Hold palm position,
overall scale, camera, and lighting constant. Uniform pure white background,
no floor, no cast shadow. Crisp silhouettes, soft frontal lighting, no motion
blur or depth of field. One paw only; no body or extended arm.

ACTION: Start with all five digits curled into a relaxed closed fist. Open exactly
one new digit at each stage, moving from the viewer's left to the viewer's right.
Each opening is a small organic uncurl: the base extends first, the tip follows
slightly later, the pad turns toward the viewer, and the claw follows the tip.
Previously opened digits remain extended. Digits awaiting their turn stay curled.
The palm stays steady. Use smooth restrained easing and a tiny settling motion.
Do not open all digits together.

TIMING:
0.0–1.0 seconds: hold the closed fist; all five digits curled.
1.0–1.6 seconds: uncurl the outer-left digit; hold one open until 2.4 seconds.
2.4–3.0 seconds: uncurl the inner-left digit; hold two open until 3.8 seconds.
3.8–4.4 seconds: uncurl the center digit; hold three open until 5.2 seconds.
5.2–5.8 seconds: uncurl the inner-right digit; hold four open until 6.6 seconds.
6.6–7.2 seconds: uncurl the outer-right digit; all five are now open.
7.2–8.0 seconds: gently resolve the sculpted paw into the reference paw-print
mark. Keep the pads and claws registered in place while the supporting skin
disappears and shading flattens into a uniform gray matching the reference.
8.0–10.0 seconds: hold the final mark completely still: one palm pad, five separate
toe pads, five separate claws, matching the reference as closely as possible.

The six poses represent 0, 20, 40, 60, 80, and 100 percent synchronization, but
show no numbers, text, progress ring, interface, or labels. This is a single
forward progression, not a loop. Keep the same five digits throughout, with
clean anatomy and consistent identity. No extra or missing digits, fused pads,
human fingernails, realistic fur strands, camera motion, cuts, spins, particles,
glow, dramatic lighting, sound effects, music, or speech.

## Evaluation and fallback

The requested timings and exact logo match are generation targets, not
guarantees. Check every held pose for correct digit count and direction. Keep
the original SVG as the authoritative final production frame.

If the model opens several digits together, generate each transition separately
using approved start/end pose images where the interface supports them:

“Animate only the transition from the supplied starting paw pose to the supplied
ending paw pose. Only the [digit name] uncurls. Preserve the position and curl
state of the other four digits, palm registration, camera, materials, and
background. Hold the starting pose, perform one restrained opening, then hold
the ending pose. No logo dissolve during this clip.”

Make the final skin-to-logo resolve a separate shot if combining it with the
fifth digit opening causes distortion. Composite the actual logo for the terminal
hold. The white background is intended for easy isolation; remove it in
postproduction if transparency is needed. Video output still requires a vector
authoring/conversion step to become animated SVG.
