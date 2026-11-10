"""Compose exact logo resolve, PNG sequence, GIF, and six-pose contact sheet."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'design/paw-sync'
sequence = OUT / 'sequence'
sequence.mkdir(exist_ok=True)
logo = Image.open(OUT / 'logo-final.png').convert('RGBA')
background = (18, 23, 31, 255)
frames = []
for n in range(1, 181):
    image = Image.open(OUT / 'frames' / f'{min(n,150):04}.png').convert('RGBA')
    if n > 138:
        image = Image.blend(image, logo, min(1, (n-138)/12))
    image.save(sequence / f'{n:04}.png')
    visible = Image.new('RGBA', image.size, background)
    visible.alpha_composite(image)
    frames.append(visible.convert('RGB'))
frames[0].save(OUT / 'bearpaw-preview.gif', save_all=True, append_images=frames[1:],
               duration=33, loop=0, disposal=2)

sheet = Image.new('RGB', (1440, 1020), background[:3])
draw = ImageDraw.Draw(sheet)
try:
    font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 25)
    small = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 16)
except OSError:
    font = small = ImageFont.load_default()
for index, frame in enumerate([1,28,54,80,106,150]):
    x, y = (index%3)*480, (index//3)*510
    sheet.paste(frames[frame-1], (x,y))
    draw.text((x+24,y+474), f'{index*20}%  /  '+('LOGO' if index==5 else 'CURLED' if index==0 else f'{index} OPEN'), font=font, fill='#d5d9e0')
    tiny = frames[frame-1].resize((56,56), Image.Resampling.LANCZOS)
    sheet.paste(tiny, (x+402, y+426))
sheet.save(OUT / 'pose-sheet.png')
assert Image.open(sequence / '0180.png').tobytes() == logo.tobytes()
print('180 RGBA frames, looping review GIF, six-pose sheet; exact logo terminal frame verified.')
