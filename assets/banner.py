# Draws the README banner and the GitHub social preview from the app's own icon and font.
from PIL import Image, ImageDraw, ImageFont
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
FONT = os.path.join(ROOT, "ui", "fonts", "PixelifySans.ttf")
icon = Image.open(os.path.join(ROOT, "ui", "icons", "jodrell-32.png")).convert("RGBA")

def font(size, weight=700):
    f = ImageFont.truetype(FONT, size)
    try: f.set_variation_by_axes([weight])
    except Exception: pass
    return f

def make(w, h, scale, title_size, tag_size, out, sub=True):
    img = Image.new("RGBA", (w, h))
    d = ImageDraw.Draw(img)
    top, bottom = (166, 210, 119), (124, 178, 78)          # the command bar's meadow green
    for y in range(h):
        t = y / h
        d.line([(0, y), (w, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,))
    # pixel grass along the bottom, like the GUI's command bar edge
    g = [(94, 158, 58), (118, 183, 74), (78, 139, 48), (106, 170, 67)]
    px = max(4, scale // 2)
    for x in range(0, w, px):
        c = g[(x // px) % 4]
        hgt = px * (2 + ((x // px) * 7 % 3))
        d.rectangle([x, h - hgt, x + px - 1, h], fill=c + (255,))
    d.rectangle([0, h - px, w, h], fill=(79, 127, 46, 255))
    # icon, scaled with hard edges
    big = icon.resize((32 * scale, 32 * scale), Image.NEAREST)
    ix, iy = int(w * 0.07), (h - px * 3 - big.height) // 2
    shadow = Image.new("RGBA", big.size, (0, 0, 0, 0)); shadow.putalpha(big.getchannel("A").point(lambda a: 70 if a else 0))
    img.alpha_composite(shadow, (ix + scale, iy + scale)); img.alpha_composite(big, (ix, iy))
    # wordmark and tagline
    tx = ix + big.width + int(w * 0.04)
    ft = font(title_size, 700)
    tb = d.textbbox((0, 0), "jodrell", font=ft)
    title_h = tb[3] - tb[1]
    fs = font(tag_size, 500)
    lines = ["The AI-first API client.", "Your agent sends the requests. You see every one."] if sub else []
    line_h = int(tag_size * 1.4)
    gap = int(title_h * 0.35)
    block = title_h + (gap + line_h * len(lines) if lines else 0)
    top_y = (h - px * 3 - block) // 2                     # centre the text block above the grass
    sh = max(2, scale // 3)
    d.text((tx + sh, top_y - tb[1] + sh), "jodrell", font=ft, fill=(46, 94, 30, 255))
    d.text((tx, top_y - tb[1]), "jodrell", font=ft, fill=(255, 248, 220, 255))
    y = top_y + title_h + gap
    for line in lines:
        # No ligatures: the pixel font's "fi" ligature makes "first" read as "Arst".
        try: opts = {"features": ["-liga", "-clig"]}; d.textbbox((0, 0), "fi", font=fs, **opts)
        except Exception: opts = {}
        lb = d.textbbox((0, 0), line, font=fs, **opts)
        d.text((tx, y - lb[1]), line, font=fs, fill=(27, 48, 15, 255), **opts); y += line_h
    img.convert("RGB").save(out, optimize=True)
    print(out, img.size)

make(1280, 360, 6, 120, 30, os.path.join(ROOT, "docs", "images", "banner.png"))
make(1280, 640, 9, 150, 36, os.path.join(ROOT, "docs", "images", "social-preview.png"))
