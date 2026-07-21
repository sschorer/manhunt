"""Regenerate the PWA icons in ../public. Requires Pillow (`pip install Pillow`)."""
from PIL import Image, ImageDraw
import math, os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public")
BG = (6, 8, 12, 255)      # #06080c
RED = (255, 66, 66, 255)  # #ff4242
TEAL = (36, 227, 198, 255)# #24e3c6

def draw(size, maskable=False):
    S = size * 4  # supersample
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # background: rounded rect (full bleed for maskable, rounded for normal)
    if maskable:
        d.rectangle([0, 0, S, S], fill=BG)
    else:
        r = int(S * 0.18)
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=BG)
    cx = cy = S / 2
    # concentric rings
    for rad, col, w in ((0.40, TEAL, 0.028), (0.30, RED, 0.032)):
        rr = S * rad
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=col, width=max(1, int(S * w)))
    # rotated red square (diamond)
    side = S * 0.24
    pts = []
    for ang in (45, 135, 225, 315):
        a = math.radians(ang)
        pts.append((cx + side * math.cos(a), cy + side * math.sin(a)))
    d.polygon(pts, fill=RED)
    img = img.resize((size, size), Image.LANCZOS)
    return img

draw(192).save(os.path.join(OUT, "pwa-192x192.png"))
draw(512).save(os.path.join(OUT, "pwa-512x512.png"))
draw(512, maskable=True).save(os.path.join(OUT, "pwa-maskable-512x512.png"))
draw(180).save(os.path.join(OUT, "apple-touch-icon.png"))
draw(32).save(os.path.join(OUT, "favicon.png"))
print("icons written to", OUT)
