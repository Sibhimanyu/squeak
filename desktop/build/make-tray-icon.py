#!/usr/bin/env python3
"""
Make the menu-bar icon from the duck's own artwork, so the two always match.

    python3 desktop/build/make-tray-icon.py      # writes desktop/assets/duckTemplate{,@2x}.png

The source is the approved logo (brand/logo, full colour, facing right), so
the mark follows the brand duck rather than the older mood sprite.

A menu-bar icon must be a template image: black plus transparency, which
macOS tints for light and dark menu bars. So this takes the duck's
silhouette (renderer/duck.png) and cuts its inner lines — eye, wing, beak
edge — out of it, which is what makes it read as *this* duck at 18pt.
"""
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter

here = Path(__file__).resolve().parent.parent
src = Image.open(here.parent / "brand" / "logo" / "png" / "squeak-duck-full-color-1024.png").convert("RGBA")
src = src.crop(src.getbbox())
width, height = src.size
r, g, b, a = src.split()

silhouette = a.point(lambda v: 255 if v > 128 else 0)
lines = ImageChops.multiply(Image.merge("RGB", (r, g, b)).convert("L").point(lambda v: 255 if v < 90 else 0), silhouette)
# Only the lines well inside the outline: shrink the silhouette, keep lines within.
interior = silhouette
kernel = max(3, int(min(width, height) * 0.035)) | 1
for _ in range(3):
    interior = interior.filter(ImageFilter.MinFilter(kernel))
cut = ImageChops.multiply(lines, interior).filter(ImageFilter.MaxFilter(5))  # survive downsampling
mask = ImageChops.subtract(silhouette, cut)


def render(px: int, name: str) -> None:
    supersample = px * 8
    side = int(supersample * 0.94)
    scale = side / max(width, height)
    fitted = mask.resize((int(width * scale), int(height * scale)), Image.LANCZOS)
    canvas = Image.new("L", (supersample, supersample), 0)
    canvas.paste(fitted, ((supersample - fitted.width) // 2, (supersample - fitted.height) // 2))
    out = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    out.putalpha(canvas.resize((px, px), Image.LANCZOS))
    out.save(here / "assets" / name)


render(18, "duckTemplate.png")
render(36, "duckTemplate@2x.png")
print("wrote assets/duckTemplate.png and @2x")
