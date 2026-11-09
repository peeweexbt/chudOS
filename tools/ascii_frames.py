"""Turn the logo + any extra images/GIFs into ASCII frames for the hero animation.

usage: python3 tools/ascii_frames.py assets/logo.png assets/face2.jpg [more.gif ...] > public/frames.json
Every frame is rendered on the same grid with the same character ramp, so new art
(e.g. all frames of a GIF) drops in looking consistent with the logo.
"""
import json, sys
from PIL import Image, ImageOps, ImageFilter, ImageSequence

COLS, ROWS = 96, 54          # grid; chars are ~2x taller than wide
RAMP = " .,:;-=+*#%@"

def line_mask(im):
    g = im.convert("L")
    # dark-on-light drawings get inverted so lines are always bright
    hist = g.histogram(); light = sum(hist[128:]) > sum(hist[:128])
    if light: g = ImageOps.invert(g)
    g = g.point(lambda v: 255 if v > 90 else 0)
    bbox = g.getbbox() or (0, 0, *g.size)
    g = g.crop(bbox)
    # fit into the grid's pixel aspect, centred, with a small margin
    cw, ch = 8, 16
    W, H = COLS * cw, ROWS * ch
    s = min(W * 0.94 / g.width, H * 0.94 / g.height)
    g = g.resize((max(1, int(g.width * s)), max(1, int(g.height * s))), Image.LANCZOS)
    g = g.filter(ImageFilter.MaxFilter(3))  # thicken thin strokes so they survive downsampling
    canvas = Image.new("L", (W, H), 0)
    canvas.paste(g, ((W - g.width) // 2, (H - g.height) // 2))
    return canvas, cw, ch

def to_ascii(im):
    m, cw, ch = line_mask(im)
    px = m.load(); rows = []
    for r in range(ROWS):
        row = ""
        for c in range(COLS):
            tot = 0
            for y in range(r * ch, r * ch + ch, 2):
                for x in range(c * cw, c * cw + cw, 2):
                    tot += px[x, y]
            cov = tot / (255 * (cw // 2) * (ch // 2))
            row += RAMP[min(len(RAMP) - 1, int((cov ** 0.6) * (len(RAMP) - 1) * 1.25 + (0.5 if cov > 0.04 else 0)))]
        rows.append(row)
    return rows

frames = []
for path in sys.argv[1:]:
    im = Image.open(path)
    for i, f in enumerate(ImageSequence.Iterator(im)):
        frames.append({"src": f"{path.split('/')[-1]}#{i}", "rows": to_ascii(f.convert("RGB")),
                       "hold": int(f.info.get("duration", 0)) or None})
json.dump({"cols": COLS, "rows": ROWS, "frames": frames}, sys.stdout)
