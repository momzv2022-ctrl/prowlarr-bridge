"""Draw docs/assets/how-it-works.svg, the hand-drawn picture in the README.

    pip install fonttools
    python3 docs/assets/make-how-it-works.py PatrickHand-Regular.ttf

Everything in the picture is a path. The text is outlined from Patrick Hand
(SIL OFL 1.1, https://github.com/google/fonts/tree/main/ofl/patrickhand) with
fontTools, so the file depends on no font being installed and looks the same in
every viewer, GitHub's image proxy included. The wobble is deterministic: a
seeded generator, so re-running this script yields the same bytes. The font is
not committed; fetch it from the link above to redraw.
"""

import math
import random
import sys
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

if len(sys.argv) < 2:
    sys.exit("usage: make-how-it-works.py PatrickHand-Regular.ttf [out.svg]")
FONT = TTFont(sys.argv[1])
GLYPHS = FONT.getGlyphSet()
CMAP = FONT.getBestCmap()
UPM = FONT["head"].unitsPerEm
HMTX = FONT["hmtx"]

INK = "#24292f"
MUTED = "#6e7781"
ORANGE = "#f6821f"
HIGHLIGHT = "#ffe58a"
PAPER = "#ffffff"

rng = random.Random(20260821)
out = []


def jitter(amount=1.3):
    return rng.uniform(-amount, amount)


def wobbly_line(x1, y1, x2, y2, amount=1.3, pieces=None):
    """A straight-ish line drawn by a hand: a few slightly off points, as a path."""
    length = math.hypot(x2 - x1, y2 - y1)
    pieces = pieces or max(2, int(length / 40))
    d = [f"M{x1 + jitter(amount):.1f} {y1 + jitter(amount):.1f}"]
    for i in range(1, pieces + 1):
        t = i / pieces
        px = x1 + (x2 - x1) * t
        py = y1 + (y2 - y1) * t
        if i < pieces:
            px += jitter(amount)
            py += jitter(amount)
        else:
            px += jitter(amount * 0.6)
            py += jitter(amount * 0.6)
        d.append(f"L{px:.1f} {py:.1f}")
    return " ".join(d)


def stroke(d, color=INK, width=2.2, dash=None, opacity=1.0):
    extra = f' stroke-dasharray="{dash}"' if dash else ""
    op = f' opacity="{opacity}"' if opacity != 1.0 else ""
    out.append(
        f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}" '
        f'stroke-linecap="round" stroke-linejoin="round"{extra}{op}/>'
    )


def line(x1, y1, x2, y2, color=INK, width=2.2, dash=None, double=True):
    stroke(wobbly_line(x1, y1, x2, y2), color, width, dash)
    if double:
        stroke(wobbly_line(x1, y1, x2, y2, amount=0.9), color, width * 0.7, dash, opacity=0.55)


def box(x, y, w, h, color=INK, width=2.2, dash=None):
    """A rectangle drawn as four strokes that do not quite meet, twice over."""
    for amount, wd, op in ((1.4, width, 1.0), (1.0, width * 0.7, 0.5)):
        o = 3  # overshoot at the corners, the way a pen does
        d = " ".join([
            wobbly_line(x - o, y, x + w + o, y, amount),
            wobbly_line(x + w, y - o, x + w, y + h + o, amount),
            wobbly_line(x + w + o, y + h, x - o, y + h, amount),
            wobbly_line(x, y + h + o, x, y - o, amount),
        ])
        stroke(d, color, wd, dash, op)


def highlight(x, y, w, h, color=HIGHLIGHT):
    """A marker stroke behind a word."""
    d = wobbly_line(x, y + h / 2, x + w, y + h / 2, amount=1.0, pieces=3)
    out.append(
        f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{h:.0f}" '
        f'stroke-linecap="butt" opacity="0.85"/>'
    )


def arrow(x1, y1, x2, y2, color=INK, width=2.2, dash=None, bend=0.0):
    """An arrow with a slight curve and a hand-drawn head."""
    mx, my = (x1 + x2) / 2, (y1 + y2) / 2
    dx, dy = x2 - x1, y2 - y1
    length = math.hypot(dx, dy) or 1
    nx, ny = -dy / length, dx / length  # normal
    cx, cy = mx + nx * bend, my + ny * bend
    for amount, wd, op in ((1.2, width, 1.0), (0.8, width * 0.7, 0.5)):
        d = (
            f"M{x1 + jitter(amount):.1f} {y1 + jitter(amount):.1f} "
            f"Q{cx + jitter(amount):.1f} {cy + jitter(amount):.1f} "
            f"{x2 + jitter(amount * 0.5):.1f} {y2 + jitter(amount * 0.5):.1f}"
        )
        stroke(d, color, wd, dash, op)
    # head: direction at the end of the quadratic curve
    tx, ty = x2 - cx, y2 - cy
    tl = math.hypot(tx, ty) or 1
    tx, ty = tx / tl, ty / tl
    size = 11
    for side in (1, -1):
        hx = x2 - tx * size + (-ty) * side * size * 0.55
        hy = y2 - ty * size + tx * side * size * 0.55
        stroke(wobbly_line(x2, y2, hx, hy, 0.8, 2), color, width)


def cloud(cx, cy, rx, ry, color=INK, width=2.2):
    """A cloud: bumps around an ellipse, drawn twice."""
    for amount, wd, op in ((1.6, width, 1.0), (1.1, width * 0.7, 0.5)):
        bumps = 11
        pts = []
        for i in range(bumps):
            a = 2 * math.pi * i / bumps
            pts.append((cx + rx * math.cos(a), cy + ry * math.sin(a)))
        d = [f"M{pts[0][0] + jitter(amount):.1f} {pts[0][1] + jitter(amount):.1f}"]
        for i in range(bumps):
            p = pts[i]
            q = pts[(i + 1) % bumps]
            mx, my = (p[0] + q[0]) / 2, (p[1] + q[1]) / 2
            # push the control point outward for the bump
            ox, oy = mx - cx, my - cy
            ol = math.hypot(ox, oy) or 1
            k = 1.38
            c = (cx + ox / ol * ol * k, cy + oy / ol * ol * k)
            d.append(
                f"Q{c[0] + jitter(amount):.1f} {c[1] + jitter(amount):.1f} "
                f"{q[0] + jitter(amount):.1f} {q[1] + jitter(amount):.1f}"
            )
        stroke(" ".join(d), color, wd, None, op)


def short_number(value):
    """One decimal at most, and no trailing zero: the difference between 280 KB and 550 KB."""
    return str(int(value)) if value == int(value) else f"{value:.1f}".rstrip("0").rstrip(".")


def measure(text, size):
    scale = size / UPM
    width = 0
    for ch in text:
        name = CMAP.get(ord(ch), ".notdef")
        width += HMTX[name][0] * scale
    return width


def text(x, y, string, size=18, color=INK, anchor="start", weight=0):
    """Outline the string at (x, baseline y). anchor: start | middle | end."""
    scale = size / UPM
    total = measure(string, size)
    if anchor == "middle":
        x -= total / 2
    elif anchor == "end":
        x -= total
    pen = SVGPathPen(GLYPHS, ntos=short_number)
    cursor = x
    for ch in string:
        name = CMAP.get(ord(ch), ".notdef")
        glyph = GLYPHS[name]
        tpen = TransformPen(pen, (scale, 0, 0, -scale, cursor, y))
        glyph.draw(tpen)
        cursor += HMTX[name][0] * scale
    d = pen.getCommands()
    if d:
        extra = f' stroke="{color}" stroke-width="{weight}"' if weight else ""
        out.append(f'<path d="{d}" fill="{color}"{extra}/>')
    return total


def lines(x, y, strings, size=16, color=INK, anchor="start", leading=1.32):
    for i, s in enumerate(strings):
        text(x, y + i * size * leading, s, size, color, anchor)


def stick_figure(x, y, color=INK):
    """Head at (x, y). About 70px tall."""
    r = 11
    for amount, wd, op in ((1.2, 2.2, 1.0), (0.8, 1.5, 0.5)):
        pts = []
        n = 14
        for i in range(n + 1):
            a = 2 * math.pi * i / n
            pts.append((x + r * math.cos(a) + jitter(amount), y + r * math.sin(a) + jitter(amount)))
        d = "M" + " L".join(f"{px:.1f} {py:.1f}" for px, py in pts)
        stroke(d, color, wd, None, op)
    line(x, y + r, x, y + r + 30, color)               # body
    line(x, y + r + 8, x - 16, y + r + 24, color)      # arms
    line(x, y + r + 8, x + 16, y + r + 20, color)
    line(x, y + r + 30, x - 13, y + r + 54, color)     # legs
    line(x, y + r + 30, x + 13, y + r + 54, color)


def laptop(x, y, w=54, h=34, color=INK):
    box(x, y, w, h, color)
    line(x - 6, y + h + 6, x + w + 6, y + h + 6, color)
    line(x, y + h, x - 6, y + h + 6, color, double=False)
    line(x + w, y + h, x + w + 6, y + h + 6, color, double=False)


def phone(x, y, w=22, h=38, color=INK):
    box(x, y, w, h, color)
    line(x + w / 2 - 4, y + h - 5, x + w / 2 + 4, y + h - 5, color, double=False)


def key(x, y, color=INK, scale=1.0):
    """A little key, bow on the left, teeth on the right."""
    s = scale
    r = 7 * s
    for amount, wd, op in ((1.0, 2.2, 1.0), (0.7, 1.5, 0.5)):
        pts = []
        n = 12
        for i in range(n + 1):
            a = 2 * math.pi * i / n
            pts.append((x + r * math.cos(a) + jitter(amount), y + r * math.sin(a) + jitter(amount)))
        d = "M" + " L".join(f"{px:.1f} {py:.1f}" for px, py in pts)
        stroke(d, color, wd, None, op)
    line(x + r, y, x + 30 * s, y, color)
    line(x + 22 * s, y, x + 22 * s, y + 7 * s, color, double=False)
    line(x + 28 * s, y, x + 28 * s, y + 6 * s, color, double=False)


def padlock(x, y, color=INK):
    """Body top-left at (x, y), 22 wide."""
    box(x, y, 22, 17, color)
    for amount, wd, op in ((1.0, 2.2, 1.0), (0.7, 1.5, 0.5)):
        d = (
            f"M{x + 4 + jitter(amount):.1f} {y + jitter(amount):.1f} "
            f"L{x + 4 + jitter(amount):.1f} {y - 6 + jitter(amount):.1f} "
            f"Q{x + 11 + jitter(amount):.1f} {y - 16 + jitter(amount):.1f} "
            f"{x + 18 + jitter(amount):.1f} {y - 6 + jitter(amount):.1f} "
            f"L{x + 18 + jitter(amount):.1f} {y + jitter(amount):.1f}"
        )
        stroke(d, color, wd, None, op)


# ---------------------------------------------------------------------------
W, H = 980, 560
out.append(
    f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
    f'role="img" aria-label="How it works: your app sends a search and its own key to the bridge. '
    f'The bridge asks Prowlarr using Prowlarr\'s key, which never crosses back. Prowlarr asks your '
    f'indexers and the list comes back the same way.">'
)
out.append("<!-- Drawn by docs/assets/make-how-it-works.py. Text outlined from Patrick Hand, OFL 1.1. -->")
out.append(f'<rect width="{W}" height="{H}" fill="{PAPER}"/>')

text(W / 2, 46, "How it works", 34, INK, "middle")

# ---- your app, on the left -------------------------------------------------
AX = 92
stick_figure(AX, 158)
phone(AX + 42, 168)
text(AX + 12, 268, "your app", 21, INK, "middle")
lines(AX + 12, 293, ["anywhere"], 15, MUTED, "middle")

# ---- the bridge ------------------------------------------------------------
BX, BY, BW, BH = 320, 150, 190, 96
box(BX, BY, BW, BH)
text(BX + BW / 2, BY + 38, "the bridge", 21, INK, "middle")
lines(BX + BW / 2, BY + 62, ["one file, no", "dependencies"], 14, MUTED, "middle")
padlock(BX + BW - 30, BY - 26)

# ---- Prowlarr --------------------------------------------------------------
PX, PY, PW, PH = 620, 150, 170, 96
box(PX, PY, PW, PH)
text(PX + PW / 2, PY + 44, "Prowlarr", 21, INK, "middle")
lines(PX + PW / 2, PY + 68, ["already yours"], 14, MUTED, "middle")

# ---- the indexers ----------------------------------------------------------
IX = 860
for dy in (0, 44, 88):
    box(IX, 132 + dy, 86, 32)
    text(IX + 43, 154 + dy, "indexer", 14, INK, "middle")

# ---- arrows ----------------------------------------------------------------
arrow(196, 178, 312, 178, INK, bend=-4)
key(206, 142, INK, 0.7)
text(236, 147, "your key", 14, INK, "start")
arrow(312, 222, 200, 222, MUTED, width=2.0, dash="7 6", bend=-4)
text(256, 248, "one list back", 14, MUTED, "middle")

arrow(516, 178, 612, 178, INK, bend=-4)
key(520, 142, INK, 0.7)
text(550, 147, "Prowlarr's key", 14, INK, "start")
arrow(612, 222, 520, 222, MUTED, width=2.0, dash="7 6", bend=-4)

for dy in (0, 44, 88):
    arrow(796, 198, IX - 4, 148 + dy, INK, width=1.8)

# ---- the line Prowlarr's key never crosses ---------------------------------
# The boundary that matters is between the app and everything else: the app
# holds its own key and nothing more. Drawn short, and labelled at the top, so
# the bottom of the picture stays free for words.
LINE = 252
stroke(wobbly_line(LINE, 112, LINE, 344, 1.6), ORANGE, 2.6, "10 7")
text(LINE + 12, 104, "Prowlarr's key never crosses this line", 15, INK, "start")

# ---- what each side is -----------------------------------------------------
text(BX + BW / 2, 344, "run it wherever you like", 16, INK, "middle")
lines(BX + BW / 2, 370, [
    "next to Prowlarr, or at Cloudflare",
    "when Prowlarr already has a hostname",
], 14, MUTED, "middle")

text(PX + PW / 2 + 30, 344, "Prowlarr does the searching", 16, INK, "middle")
lines(PX + PW / 2 + 30, 370, ["this only translates the answer"], 14, MUTED, "middle")

# ---- the three nots --------------------------------------------------------
NX = 72
lines(NX + 18, 452, ["no server of ours", "no account with us", "no log of your searches"], 16, INK, "start")
for i in range(3):
    line(NX, 447 + i * 21.1, NX + 8, 447 + i * 21.1, INK, 2.4, double=False)

lines(BX + BW / 2 + 60, 452, [
    "Prowlarr's key opens Prowlarr's whole admin page.",
    "The app gets a read-only search key of its own,",
    "which you can change without touching Prowlarr.",
], 15, INK, "start")

out.append("</svg>")

path = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).with_name("how-it-works.svg")
path.write_text("\n".join(out) + "\n", encoding="utf-8")
print(path, path.stat().st_size, "bytes")
