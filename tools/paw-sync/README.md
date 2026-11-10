# Paw motion study

Run from the repository root with Blender 5.1.1, macOS Swift/AppKit, Python with
Pillow, and optionally ffmpeg:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --python tools/paw-sync/build.py -- --render
swift tools/paw-sync/export-logo.swift
python3 tools/paw-sync/preview.py
python3 -m http.server 8768 --bind 127.0.0.1 --directory design/paw-sync
```

Open http://127.0.0.1:8768/preview.html to compare and scrub the render and SVG.
`build.py --render --poses-only` renders only the six modeling poses; the full
render is required before `preview.py` can compose the sequence.

The scene uses two animated empty-object joints per digit. Select the named base
or tip curl controls in Blender to adjust their animation. Source pad and claw
outlines come from the SVG, with sampled cubic curves and shallow extrusion.

The animated SVG contains projected vector polygons, not embedded bitmap frames.
It is a discrete frame animation using SMIL visibility, with repeated held
frames collapsed. Skin objects use convex projected silhouettes; original pad
and claw outlines retain their concavities. Object-level depth sorting is an
approximation: it cannot resolve every intersection. This is a visual proof of
the 3D-to-vector route, not the final compact path-morphing implementation.

The final SVG group embeds the original paths unchanged. The PNG sequence's last
frame is checked against a registered render of those original paths. The final
resolve is currently a crossfade in SVG and PNG composition; it is not a skin
material animation inside the Blender scene.

Generated raw renders and composed PNG sequences are ignored by Git. The scene,
SVG, preview, and contact sheet can be retained as review artifacts. No sync UI
code is modified by these scripts.
