"""Build an editable 3D paw motion study from the original logo paths.

Run: Blender --background --python tools/paw-sync/build.py -- --render
Outputs are under design/paw-sync. No application files are modified.
"""

import argparse
import json
import math
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'design/paw-sync'
OUT.mkdir(parents=True, exist_ok=True)
args = argparse.ArgumentParser()
args.add_argument('--render', action='store_true')
args.add_argument('--poses-only', action='store_true')
opts = args.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])


def sample_path(d):
    """Sample the absolute M/L/C/H/V/Z commands used by this source logo."""
    tokens = re.findall(r'[A-Za-z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?', d)
    pts, i, command = [], 0, None
    current = Vector((0, 0))
    while i < len(tokens):
        if tokens[i].isalpha():
            command = tokens[i]
            i += 1
        if command == 'Z':
            break
        count = {'M': 2, 'L': 2, 'C': 6, 'H': 1, 'V': 1}[command]
        nums = [float(x) for x in tokens[i:i + count]]
        i += count
        if command == 'C':
            p0, p1, p2, p3 = current.copy(), Vector(nums[:2]), Vector(nums[2:4]), Vector(nums[4:])
            for n in range(1, 9):
                t = n / 8
                pts.append((1-t)**3*p0 + 3*(1-t)**2*t*p1 + 3*(1-t)*t*t*p2 + t**3*p3)
            current = p3
        else:
            current = Vector((nums[0], current.y)) if command == 'H' else Vector((current.x, nums[0])) if command == 'V' else Vector(nums)
            pts.append(current.copy())
            if command == 'M':
                command = 'L'
    return [Vector(((p.x-62)/50, (70-p.y)/50, 0)) for p in pts]


bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'
scene.render.resolution_x = scene.render.resolution_y = 480
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.film_transparent = True
scene.render.fps = 30
scene.frame_start, scene.frame_end = 1, 180
scene.world.color = (0.12, 0.12, 0.12)
scene.view_settings.view_transform = 'Standard'
shading = scene.display.shading
shading.light = 'STUDIO'
shading.studiolight_rotate_z = 0.3
shading.color_type = 'MATERIAL'
shading.show_shadows = True
shading.show_cavity = True
shading.cavity_type = 'BOTH'
shading.curvature_ridge_factor = 1.2
shading.curvature_valley_factor = 1.0
shading.show_specular_highlight = False


def material(name, rgb):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1)
    return m


skin = material('Skin • warm graphite', (0.21, 0.23, 0.26))
pad = material('Pads • logo gray', (0.66, 0.66, 0.68))
claw = material('Claws • pale gray', (0.76, 0.77, 0.79))


def empty(name, location, parent=None):
    ob = bpy.data.objects.new(name, None)
    scene.collection.objects.link(ob)
    ob.empty_display_type = 'PLAIN_AXES'
    ob.empty_display_size = 0.15
    ob.parent = parent
    ob.location = location
    return ob


def ellipsoid(name, center, scale, mat, parent=None):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12)
    ob = bpy.context.object
    ob.name = name
    ob.parent = parent
    ob.location = center
    ob.scale = scale
    ob.data.materials.append(mat)
    for polygon in ob.data.polygons:
        polygon.use_smooth = True
    return ob


def relief(name, pts, mat, parent=None):
    curve = bpy.data.curves.new(name, 'CURVE')
    curve.dimensions = '2D'
    curve.resolution_u = 1
    curve.fill_mode = 'BOTH'
    curve.extrude = 0.025
    curve.bevel_depth = 0.012
    curve.bevel_resolution = 2
    spline = curve.splines.new('POLY')
    spline.points.add(len(pts)-1)
    for p, co in zip(spline.points, pts):
        p.co = (*co, 1)
    spline.use_cyclic_u = True
    ob = bpy.data.objects.new(name, curve)
    scene.collection.objects.link(ob)
    ob.parent = parent
    ob.data.materials.append(mat)
    return ob


svg = ET.parse(ROOT / 'frontend/src/assets/bearpaw-paw.svg').getroot()
paths = {p.attrib['id']: sample_path(p.attrib['d']) for p in svg.iter() if p.tag.endswith('path')}
rig = empty('PAW • fixed registration', (0, 0, 0))
rig['description'] = 'Two editable curl joints per digit; logo is authoritative final pose.'
ellipsoid('Palm • supporting skin', (0, -0.57, -0.08), (1.08, 0.87, 0.31), skin, rig)
palm = relief('Palm pad • original SVG', paths['palm'], pad, rig)
palm.location.z = 0.245

digits = []
names = ['outer-left', 'inner-left', 'center', 'inner-right', 'outer-right']
bases = [(-0.79, -0.45), (-0.45, -0.12), (-0.02, -0.04), (0.45, -0.12), (0.79, -0.45)]
for index, (name, base) in enumerate(zip(names, bases)):
    points = paths['pad-' + name]
    center = sum(points, Vector()) / len(points)
    base = Vector((*base, -0.08))
    delta = center - base
    length = Vector((delta.x, delta.y)).length
    angle = -math.atan2(delta.x, delta.y)
    alignment = empty(name + ' • spread', base, rig)
    alignment.rotation_euler.z = angle
    proximal = empty(name + ' • base curl', (0, 0, 0), alignment)
    split = length * 0.46
    distal = empty(name + ' • tip curl', (0, split, 0), proximal)
    width = 0.22 if index in (1, 2, 3) else 0.19
    ellipsoid(name + ' • proximal skin', (0, split*0.48, 0), (width, split*0.72+0.08, 0.19), skin, proximal)
    ellipsoid(name + ' • distal skin', (0, length-split, 0), (width, 0.34, 0.19), skin, distal)
    inverse = Matrix.Rotation(-angle, 4, 'Z')
    for kind, mat in [('pad', pad), ('claw', claw)]:
        local = []
        for p in paths[kind + '-' + name]:
            q = inverse @ (p-base)
            q.y -= split
            q.z = 0
            local.append(q)
        ob = relief(name + ' • ' + kind, local, mat, distal)
        ob.location.z = 0.195
    start = 16 + index * 26
    # Both hinges curl toward camera, then tip turns into palm. No claw retraction.
    for ob, closed, delay in [(proximal, 78, 0), (distal, 96, 3)]:
        for frame, degrees in [(1, closed), (start + delay, closed), (start + 12, 0), (180, 0)]:
            ob.rotation_euler.x = math.radians(degrees)
            ob.keyframe_insert('rotation_euler', frame=frame)
    digits.append({'name': name, 'start': start, 'end': start+12})

bpy.ops.object.camera_add(location=(0, 0, 8))
camera = bpy.context.object
camera.name = 'Camera • locked orthographic'
camera.data.type = 'ORTHO'
camera.data.ortho_scale = 3.5
camera.rotation_euler = (0, 0, 0)
scene.camera = camera
for name, frame in [('0% • fist', 1), ('20%', 28), ('40%', 54), ('60%', 80), ('80%', 106), ('100% • open geometry', 132), ('Logo resolve reference', 145)]:
    scene.timeline_markers.new(name, frame=frame)
scene['note'] = 'Prototype: final logo resolve is composited in preview generation, not baked into this rig.'
scene.frame_set(1)
bpy.context.view_layer.update()
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'bearpaw-motion.blend'))
(OUT / 'timing.json').write_text(json.dumps({'fps': 30, 'frames': 180, 'digits': digits, 'poses': [1,28,54,80,106,132], 'resolve': [138,150]}, indent=2))


def hull(points):
    points = sorted(set(points))
    def cross(o, a, b):
        return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0])
    lower, upper = [], []
    for p in points:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(points):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def projected_frame():
    """Flat vector study: orthographic shapes, approximate object depth ordering.

    Skin primitives are convex; logo curves retain their concave outlines.
    This is a blocking preview, not a general hidden-surface renderer.
    """
    shapes = []
    for ob in scene.objects:
        if ob.type not in ('MESH', 'CURVE'):
            continue
        matrix = ob.matrix_world
        if ob.type == 'CURVE':
            if (matrix.to_3x3() @ Vector((0, 0, 1))).z <= 0:
                continue
            points = [matrix @ Vector(p.co[:3]) for p in ob.data.splines[0].points]
        else:
            points = [matrix @ p.co for p in ob.data.vertices]
        screen = [(round(240+p.x*480/3.5, 2), round(240-p.y*480/3.5, 2)) for p in points]
        if ob.type == 'MESH':
            screen = hull(screen)
        coords = ' '.join(f'{x},{y}' for x, y in screen)
        fill = '#626a76' if ob.type == 'MESH' else '#A8A9AD'
        shapes.append((sum(p.z for p in points)/len(points), f'<polygon points="{coords}" fill="{fill}" stroke="#252b34" stroke-width="0.8" stroke-linejoin="round"/>'))
    return ''.join(s for _, s in sorted(shapes))


source = (ROOT / 'frontend/src/assets/bearpaw-paw.svg').read_text()
logo_inner = source[source.index('<g id="paw"'):source.rindex('</svg>')]
logo = f'<g transform="translate({240-62*480/175} 48) scale({480/175})">{logo_inner}</g>'
header = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480" viewBox="0 0 480 480" role="img" aria-label="Bearpaw opening motion study">'
states = []
for frame in range(1, 151):
    scene.frame_set(frame)
    bpy.context.view_layer.update()
    shape = projected_frame()
    if frame > 138:
        amount = (frame-138)/12
        shape = f'<g opacity="{1-amount:.4f}">{shape}</g><g opacity="{amount:.4f}">{logo}</g>'
    if states and shape == states[-1]['shape']:
        states[-1]['end'] = frame
    else:
        states.append({'start': frame, 'end': frame, 'shape': shape})
    if frame in (1,28,54,80,106,132):
        (OUT / f'pose-{[1,28,54,80,106,132].index(frame)*20}.svg').write_text(header+shape+'</svg>')
groups = []
for index, state in enumerate(states):
    begin = (state['start']-1)/30
    duration = (state['end']-state['start']+1)/30
    groups.append(f'<g display="none"><set attributeName="display" to="inline" begin="{begin:.6f}s" dur="{duration:.6f}s"/>{state["shape"]}</g>')
groups.append(f'<g display="none"><set attributeName="display" to="inline" begin="5s" fill="freeze"/>{logo}</g>')
(OUT / 'bearpaw-motion.svg').write_text(header+''.join(groups)+'</svg>')
(OUT / 'logo-final.svg').write_text(header+logo+'</svg>')
scene.frame_set(1)
if opts.render:
    frames = [1,28,54,80,106,132] if opts.poses_only else range(1, 151)
    (OUT / 'frames').mkdir(exist_ok=True)
    for frame in frames:
        scene.frame_set(frame)
        scene.render.filepath = str(OUT / 'frames' / f'{frame:04}.png')
        bpy.ops.render.render(write_still=True)
