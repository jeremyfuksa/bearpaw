# Paw LED / reveal studies

Current creative direction: the whole isolated logo starts as dark LED segments.
The palm illuminates when progress begins; each pad/claw pair lights at its
completed 20% milestone, left to right. The LED study uses the app theme’s
brand amber (#ef991f), scanner shell (#1c1f26), and panel (#11131b), with
subtle/bright/no glow controls. `index.html` and `led.html` contain this study.
`reveal.html` preserves the earlier fade / big-pop / instant experiment.
This replaces the 3D approach as the active study. No app components were edited.

Open `index.html` directly in a browser, or serve this folder locally:

```sh
python3 -m http.server 8769 --bind 127.0.0.1 --directory design/paw-reveal
```

The earlier reveal page compares fade, big pop, and instant reveals, offers three durations,
shows the actual 56 px size, and supports manual progress, playback, and a
0 → 65 → 100% jump. It embeds all geometry and has no external dependencies.
Reduced-motion preferences disable the preview's transitions.

`paw-reveal.svg` is a standalone looping fade study. It includes review holds;
it is not wired to actual sync progress. `paw-reveal.gif` is an easy-to-view
raster preview. `pose-*.svg`, `pose-*.png`, and `pose-sheet.png` record the six
milestones. All silhouettes come from the isolated logo without deformation.

The HTML template is an authoring aid; use `index.html` for the working preview.
