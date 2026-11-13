# jodrell icon: 90s-style pixel art, drawn pixel by pixel on a 32x32 grid.
from PIL import Image
import math

PAL = {
    ".": None,              # transparent
    "K": (0, 0, 0),         # outline
    "D": (96, 96, 96),      # dark grey
    "G": (160, 160, 160),   # grey
    "L": (200, 200, 200),   # light grey
    "W": (255, 255, 255),   # white
    "g": (46, 94, 30),      # dark green
    "m": (78, 139, 48),     # green
    "l": (118, 183, 74),    # light green
    "y": (255, 213, 74),    # yellow
    "o": (224, 165, 38),    # gold
    "b": (160, 98, 10),     # dark gold
    "n": (31, 58, 110),     # navy (inside of the dish)
    "s": (64, 104, 168),    # blue
}

def blank(n): return [["." for _ in range(n)] for _ in range(n)]

def icon32():
    N = 32
    px = blank(N)
    def put(x, y, c):
        if 0 <= x < N and 0 <= y < N: px[y][x] = c
    # 1. Grassy hill: a half-ellipse, lit from the top left, dithered.
    cx, cy, rx, ry = 15.5, 31.5, 14.5, 7.5
    for y in range(N):
        for x in range(N):
            d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2
            if d <= 1:
                light = (x - cx) / rx * 0.7 + (y - cy) / ry * 0.9  # negative = lit
                if light < -0.75: c = "l"
                elif light < -0.45: c = "l" if (x + y) % 2 == 0 else "m"
                elif light < 0.15: c = "m"
                elif light < 0.45: c = "m" if (x + y) % 2 == 0 else "g"
                else: c = "g"
                put(x, y, c)
    # little tufts of grass on the crest
    for x, y in [(6, 25), (9, 24), (21, 24), (24, 25)]:
        put(x, y, "l"); put(x, y - 1, "m")
    # 2. Mast: a short grey post into the hill (drawn first, so the dish sits in front).
    for y in range(15, 25):
        put(13, y, "L"); put(14, y, "G"); put(15, y, "D")
    for x in range(10, 19): put(x, 25, "D")
    for x in range(11, 18): put(x, 24, "G")
    # 3. The dish, seen from the side, facing up and to the right.
    ang = math.radians(42)
    dcx, dcy, arx, ary = 12.0, 13.0, 9.2, 4.0
    ca, sa = math.cos(ang), math.sin(ang)
    face = (sa, -ca)  # the direction the dish points
    for y in range(N):
        for x in range(N):
            u = (x - dcx) * ca + (y - dcy) * sa
            v = -(x - dcx) * sa + (y - dcy) * ca
            d = (u / arx) ** 2 + (v / ary) ** 2
            if d <= 1:
                if d > 0.6:   # the rim: bright where the light catches it
                    c = "W" if (u < 2 and v > -0.5) else ("L" if u < 5 else "G")
                    if v < -1.2 and u > 1: c = "G"
                else:         # inside the bowl: deep blue, with a dithered sheen near the lit side
                    c = "s" if v > 1.2 else ("n" if v < -0.4 else ("s" if (x + y) % 2 else "n"))
                put(x, y, c)
    # 4. Feed arm out of the middle of the dish, to the receiver.
    for i in range(1, 8):
        x, y = round(dcx + face[0] * i), round(dcy + face[1] * i)
        put(x, y, "G"); put(x + 1, y, "D")
    rx, ry = round(dcx + face[0] * 8.2), round(dcy + face[1] * 8.2)
    for x, y, c in [(rx, ry, "y"), (rx + 1, ry, "o"), (rx, ry - 1, "y"), (rx + 1, ry - 1, "o"), (rx + 1, ry + 1, "b"), (rx + 2, ry, "b"), (rx - 1, ry, "o"), (rx, ry + 1, "o")]:
        put(x, y, c)
    # 5. Signal: three clean one-pixel arcs, the classic broadcast symbol.
    fx, fy = rx + 0.5, ry - 0.5
    aim = math.atan2(-face[1], face[0])
    for r, col, spread in [(3.4, "y", 0.62), (5.8, "o", 0.56), (8.2, "y", 0.52)]:
        seen = set()
        for k in range(200):
            t = aim - spread + 2 * spread * k / 199
            x, y = round(fx + r * math.cos(t)), round(fy - r * math.sin(t))
            if (x, y) not in seen and 0 <= x < N and 0 <= y < N and px[y][x] == ".":
                seen.add((x, y)); put(x, y, col)
    # 6. A twinkling star, top left.
    for x, y, c in [(4, 3, "W"), (4, 2, "y"), (4, 4, "y"), (3, 3, "y"), (5, 3, "y"), (4, 1, "o"), (4, 5, "o"), (2, 3, "o"), (6, 3, "o")]:
        put(x, y, c)
    put(9, 2, "y")
    return px

def outline(px, keep_inner=False):
    """90s icons: a black outline around everything (signals and star excepted)."""
    N = len(px)
    out = [row[:] for row in px]
    soft = set("yo")  # glows don't get outlined
    for y in range(N):
        for x in range(N):
            if px[y][x] != ".": continue
            for dx, dy in [(1, 0), (-1, 0), (0, 1), (0, -1)]:
                nx, ny = x + dx, y + dy
                if 0 <= nx < N and 0 <= ny < N and px[ny][nx] not in (".",) and px[ny][nx] not in soft:
                    out[y][x] = "K"; break
    return out

def to_image(px):
    N = len(px)
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    for y in range(N):
        for x in range(N):
            c = PAL[px[y][x]]
            if c: img.putpixel((x, y), c + (255,))
    return img

def icon16():
    """A simpler drawing for 16 px, not a shrunk copy."""
    rows = [
        "..y.............",
        ".yWy.......o.y..",
        "..y......o..o...",
        "...KKK..y.o..y..",
        "..KWWsK.yo.o....",
        ".KWsnnsKoy......",
        ".KWsnnnGK.......",
        ".KLsnnGK........",
        "..KLnGsK........",
        "...KKGsK........",
        "....KLGDK.......",
        "....KLGDK.......",
        "...KKKKKKKK.....",
        "..KllllmmmmgK...",
        ".KlllmmmmmggggK.",
        "KlllmmmmmgggggggK"[:16],
    ]
    return [list(r) for r in rows]

if __name__ == "__main__":
    big = to_image(outline(icon32()))
    small = to_image(icon16())
    big.save("jodrell-32.png"); small.save("jodrell-16.png")
    # previews: enlarged on light, dark, and a Windows 95 teal desktop
    pad = 6
    sheet = Image.new("RGBA", ((32 * 8 + pad * 2) * 3, 32 * 8 + pad * 2 + 80), (255, 255, 255, 255))
    for i, bg in enumerate([(252, 251, 244), (20, 25, 20), (0, 128, 128)]):
        tile = Image.new("RGBA", (32 * 8 + pad * 2, 32 * 8 + pad * 2 + 80), bg + (255,))
        tile.alpha_composite(big.resize((256, 256), Image.NEAREST), (pad, pad))
        tile.alpha_composite(big, (pad, 32 * 8 + pad * 2 + 20))
        tile.alpha_composite(big.resize((64, 64), Image.NEAREST), (pad + 50, 32 * 8 + pad * 2 + 6))
        tile.alpha_composite(small, (pad + 130, 32 * 8 + pad * 2 + 28))
        tile.alpha_composite(small.resize((32, 32), Image.NEAREST), (pad + 160, 32 * 8 + pad * 2 + 20))
        sheet.alpha_composite(tile, (i * (32 * 8 + pad * 2), 0))
    sheet.save("preview.png")
    print("ok")
