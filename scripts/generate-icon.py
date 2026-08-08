#!/usr/bin/env python3
"""Generate the Omp Studio app icon.

Renders a green gradient squircle with a bold white pi glyph, matching the
in-app brand mark (`.set-brand-mark`: linear-gradient(135deg, #2e7d52, #6fbf8c)
with a white "pi"). Outputs a 1024px master PNG plus multi-size ICO (Windows)
and ICNS (macOS) into ../resources.

Usage: python scripts/generate-icon.py
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, "..", "resources"))
S = 1024  # master canvas size

# Brand colors (CSS: linear-gradient(135deg, var(--accent), #6fbf8c)).
C_DARK = np.array([46, 125, 82], dtype=np.float64)    # #2e7d52 top-left
C_LIGHT = np.array([111, 191, 140], dtype=np.float64)  # #6fbf8c bottom-right

FONT_CANDIDATES = [
    "C:/Windows/Fonts/seguibl.ttf",   # Segoe UI Black
    "C:/Windows/Fonts/seguisb.ttf",   # Segoe UI Semibold
    "C:/Windows/Fonts/segoeuib.ttf",  # Segoe UI Bold
    "C:/Windows/Fonts/arialbd.ttf",   # Arial Bold
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
]


def pick_font(target_px: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if not os.path.exists(path):
            continue
        try:
            font = ImageFont.truetype(path, target_px)
        except OSError:
            continue
        # Ensure the font actually has a pi glyph.
        if font.getbbox("\u03c0"):
            return font
    raise SystemExit("No font with a pi glyph was found.")


def rounded_mask(size: int, inset: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([inset, inset, size - inset - 1, size - inset - 1], radius=radius, fill=255)
    return mask


def gradient_tile(size: int) -> Image.Image:
    """135deg diagonal gradient: dark green (top-left) -> light green (bottom-right)."""
    ys, xs = np.mgrid[0:size, 0:size].astype(np.float64)
    t = (xs + ys) / (2.0 * (size - 1))  # 0 at top-left, 1 at bottom-right
    rgb = C_DARK * (1.0 - t)[..., None] + C_LIGHT * t[..., None]
    return Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB")


def add_sheen(tile: Image.Image, mask: Image.Image) -> Image.Image:
    """Subtle top light for a modern, slightly dimensional flat look."""
    size = tile.width
    ys = np.arange(size, dtype=np.float64)
    # 0.14 alpha at the very top, fading to 0 by 46% height.
    alpha = np.clip(0.14 * (1.0 - ys / (size * 0.46)), 0.0, 1.0)
    band = np.zeros((size, size), dtype=np.float64)
    band[:] = alpha[:, None]
    white = Image.new("RGB", (size, size), (255, 255, 255))
    overlay_alpha = Image.fromarray((band * 255).astype(np.uint8), "L")
    tile = tile.copy()
    tile.paste(white, (0, 0), overlay_alpha)
    # Re-apply the rounded mask so the sheen never leaks past the corners.
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(tile, (0, 0), mask)
    return out


def draw_pi(base: Image.Image, mask: Image.Image) -> Image.Image:
    size = base.width
    inset = round(size * 0.035)
    tile = size - 2 * inset
    target_h = tile * 0.50  # pi cap height relative to the tile

    font = pick_font(round(target_h * 1.4))
    # Scale the font so the rendered pi matches the target height.
    bbox = font.getbbox("\u03c0")
    cur_h = bbox[3] - bbox[1]
    font = pick_font(round(font.size * (target_h / cur_h)))

    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    bbox = font.getbbox("\u03c0")
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    x = (size - w) / 2 - bbox[0]
    y = (size - h) / 2 - bbox[1]
    # Optical lift: the pi reads better sitting a touch above true center.
    y -= size * 0.008

    # Soft drop shadow for legibility against the lighter lower-right.
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.text((x, y + size * 0.006), "\u03c0", font=font, fill=(15, 40, 26, 90))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=size * 0.006))

    d.text((x, y), "\u03c0", font=font, fill=(255, 255, 255, 255))

    out = base.copy()
    out = Image.alpha_composite(out, shadow)
    out = Image.alpha_composite(out, layer)
    # Clip everything back to the rounded tile.
    clipped = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    clipped.paste(out, (0, 0), mask)
    return clipped


def build_master() -> Image.Image:
    inset = round(S * 0.035)
    radius = round((S - 2 * inset) * 0.225)
    mask = rounded_mask(S, inset, radius)
    tile = gradient_tile(S).convert("RGBA")
    tile = add_sheen(tile, mask)
    return draw_pi(tile, mask)


def save_ico(master: Image.Image, path: str) -> None:
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    master.save(path, format="ICO", sizes=sizes)


def save_icns(master: Image.Image, path: str) -> None:
    try:
        sizes = [(16, 16), (32, 32), (128, 128), (256, 256), (512, 512), (1024, 1024)]
        master.save(path, format="ICNS", sizes=sizes)
    except Exception as e:  # macOS icon is a nice-to-have; don't fail the build.
        print(f"warning: ICNS generation skipped ({e})", file=sys.stderr)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    master = build_master()

    png_path = os.path.join(OUT_DIR, "icon.png")
    master.save(png_path, format="PNG")

    save_ico(master, os.path.join(OUT_DIR, "icon.ico"))
    save_icns(master, os.path.join(OUT_DIR, "icon.icns"))

    print(f"wrote: {png_path}")
    print(f"wrote: {os.path.join(OUT_DIR, 'icon.ico')}")
    print(f"wrote: {os.path.join(OUT_DIR, 'icon.icns')}")


if __name__ == "__main__":
    main()
