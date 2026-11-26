"""Build every icon the site and the extension serve from the brand master.

There was no script for this. The first set was made by hand in September
and the only record of how was a comment in index.html, so the second
rebrand started by working out what the first one had done. This exists so
the third one does not.

One master, 512x512 with transparent corners, in brand/:

  mark-black.png   the black lighthouse: a white lighthouse with a black
                   lantern on a near-black disc, inside an off-white ring.
                   The same file the /login page serves as
                   frontend/img/mark-black.png. Every favicon, the .ico,
                   the extension icons and logo-square.png come from it.

The off-white ring is what keeps the mark readable on a dark tab, a dark
toolbar or the site's dark theme, and the near-black disc does the same on
a light one, so no size needs a tile or an inverted variant. The ring is
about 1px at 16px, which is still enough to outline the disc on Chrome's
dark tab strip.

The earlier masters were mark-light.png (the same lighthouse with a green
lantern) and mark-dark.png (a paper ring on a dark green square). Both
were replaced by this one in November 2026.

Every size is resized once from the 512 master rather than stepped down
through the larger ones, since a chain of resamples softens a 1px ring
long before it reaches 16px.

favicon.svg wraps the 512 PNG as a base64 <image> rather than redrawing
the mark as two <circle> elements. A redraw would be smaller and sharper,
and it is deliberately not what happens here: commit 4de4326 ("Use the
actual provided logo/favicon assets, not a redraw") replaced exactly that
kind of approximation with the designer's own file. An SVG master would
change this; a hand-traced one would not.

Usage:
    python scripts/make_icons.py
    python scripts/make_icons.py --check    # verify without writing
"""

import argparse
import base64
import io
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / "brand"
OUT = ROOT / "frontend"
EXT = ROOT / "extension" / "icons"

# 180 is apple-touch-icon, which iOS demands as PNG and will not take as
# SVG. 512 is the largest anything asks for and doubles as the master the
# SVG wraps. 32 and 16 are the two a browser tab actually picks between.
PNG_SIZES = (512, 180, 32, 16)

# The old favicon.ico held one 16x16 image, so anything wanting a crisper
# icon (a Windows shortcut, a browser that prefers .ico over SVG) had
# nothing better to choose. These are the four sizes .ico is normally
# asked for.
ICO_SIZES = [(16, 16), (32, 32), (48, 48), (64, 64)]

# The four sizes extension/manifest.json names. detect.js draws the
# in-page card button from icon-48.png.
EXT_SIZES = (16, 32, 48, 128)


def build(check: bool = False) -> int:
    master = BRAND / "mark-black.png"
    if not master.exists():
        print(f"missing master: {master}", file=sys.stderr)
        return 1

    src = Image.open(master).convert("RGBA")
    if src.size != (512, 512):
        print(f"expected a 512x512 master, got {src.size}", file=sys.stderr)
        return 1

    written = []
    for size in PNG_SIZES:
        im = src.resize((size, size), Image.LANCZOS)
        target = OUT / f"favicon-{size}.png"
        if not check:
            im.save(target)
        written.append(target)

    # Pillow builds every entry in ICO_SIZES from the image it is handed,
    # so hand it one comfortably larger than the biggest entry.
    ico = OUT / "favicon.ico"
    if not check:
        src.resize((256, 256), Image.LANCZOS).save(ico, sizes=ICO_SIZES)
    written.append(ico)

    buf = io.BytesIO()
    src.save(buf, format="PNG")
    data = base64.b64encode(buf.getvalue()).decode("ascii")
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\n'
        f'  <image href="data:image/png;base64,{data}" width="512" height="512"/>\n'
        "</svg>\n"
    )
    svg_path = OUT / "favicon.svg"
    if not check:
        svg_path.write_text(svg, encoding="utf-8")
    written.append(svg_path)

    for size in EXT_SIZES:
        target = EXT / f"icon-{size}.png"
        if not check:
            src.resize((size, size), Image.LANCZOS).save(target)
        written.append(target)

    # Square avatars (LinkedIn, GitHub) get the mark on an opaque square in
    # the disc's own colour, so a circle mask or a rounded-rect mask over
    # it still shows the whole ring. 512 because every platform that takes
    # one wants at least 400px and scales down itself.
    square = OUT / "logo-square.png"
    if not check:
        tile = Image.new("RGBA", src.size, src.getpixel((256, 60)))
        tile.alpha_composite(src)
        tile.convert("RGB").save(square)
    written.append(square)

    for p in written:
        rel = p.relative_to(ROOT).as_posix()
        if check:
            # No byte count on this path, deliberately. The file sitting
            # there is still the previous build, and printing its size
            # beside "would write" reads as a prediction of the new one.
            print(f"  would write {rel}")
        else:
            print(f"  wrote {rel:<28} {p.stat().st_size:>7} bytes")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true",
                    help="report what would be written without writing it")
    args = ap.parse_args()
    return build(check=args.check)


if __name__ == "__main__":
    raise SystemExit(main())
