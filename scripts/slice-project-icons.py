"""Slice the 3x3 GPT engraving sheets into 96px project icons.
Usage: python3 -I scripts/slice-project-icons.py <out-dir> <sheet1> <sheet2> <sheet3> <sheet4>
Sheets in order: tools/keepsakes, objects, hands, castle. Names below follow reading order."""
import sys
from PIL import Image

NAMES = [
    "raven seal scroll lantern compass key gear hourglass map",
    "magnifier chalice pouch dagger banner horn book house tower",
    "pointing thumbsup quill handshake shield hand lock parchment heart",
    "castle door tavern campfire arrow bow fleur crown coin",
]
out, sheets = sys.argv[1], sys.argv[2:]
SIZE = 96
for sheet, names in zip(sheets, NAMES):
    im = Image.open(sheet).convert("RGBA")
    w, h = im.size
    for i, name in enumerate(names.split()):
        r, c = divmod(i, 3)
        cell = im.crop((c * w // 3, r * h // 3, (c + 1) * w // 3, (r + 1) * h // 3))
        box = cell.getchannel("A").point(lambda a: 255 if a > 40 else 0).getbbox()
        cell = cell.crop(box)
        s = (SIZE - 4) / max(cell.size)
        cell = cell.resize((max(1, round(cell.width * s)), max(1, round(cell.height * s))), Image.LANCZOS)
        tile = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        tile.paste(cell, ((SIZE - cell.width) // 2, (SIZE - cell.height) // 2))
        tile.save(f"{out}/{name}.png", optimize=True)
