#!/usr/bin/env python3
"""Generate the Omp Studio app icon.

Lettermark: deep green squircle + accent O-ring + mint π (oh-my-pi / omp).
Colors track the in-app brand (dark rail + `--accent` greens). Outputs the
canonical packaging trio into ../resources:

  - icon.png   (1024px master; electron-builder / Linux)
  - icon.ico   (multi-size; Windows)
  - icon.icns  (multi-size; macOS)

Usage: python scripts/generate-icon.py

Requires: Pillow
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, "..", "resources"))
S = 1024  # master canvas size

# Deep charcoal-green squircle (aligned with dark theme rail).
BG_TOP = (36, 54, 44)
BG_BOT = (24, 35, 30)
# Accent ring (~ dark-theme --accent / send greens).
RING = (95, 192, 135, 255)  # #5fc087
RING_HI = (168, 230, 190, 255)
PI = (236, 247, 238, 255)
SHADOW = (0, 0, 0, 64)


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def background(size: int) -> Image.Image:
    """Soft vertical gradient clipped to a squircle."""
    grad = Image.new("RGBA", (size, size))
    gd = ImageDraw.Draw(grad)
    for y in range(size):
        t = (y / (size - 1)) ** 0.9
        c = tuple(int(BG_TOP[i] * (1.0 - t) + BG_BOT[i] * t) for i in range(3)) + (255,)
        gd.line([(0, y), (size, y)], fill=c)
    mask = rounded_mask(size, radius=round(size * 0.22))
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out


def ring_layer(size: int) -> Image.Image:
    """Accent O with soft drop shadow + upper-left highlight."""
    cx = cy = size / 2
    outer = size * 0.345
    stroke = size * 0.105
    inner = outer - stroke

    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        [cx - outer, cy - outer + 22, cx + outer, cy + outer + 22],
        outline=SHADOW,
        width=int(stroke * 1.1),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(30))

    o = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(o).ellipse([cx - outer, cy - outer, cx + outer, cy + outer], fill=RING)
    hole = Image.new("L", (size, size), 0)
    hd = ImageDraw.Draw(hole)
    hd.ellipse([cx - outer, cy - outer, cx + outer, cy + outer], fill=255)
    hd.ellipse([cx - inner, cy - inner, cx + inner, cy + inner], fill=0)
    o.putalpha(hole)

    hi = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(hi).ellipse(
        [cx - outer, cy - outer, cx + outer, cy + outer],
        outline=RING_HI,
        width=int(stroke * 0.5),
    )
    fade = Image.new("L", (size, size), 0)
    ImageDraw.Draw(fade).ellipse(
        [cx - outer * 1.15, cy - outer * 1.25, cx + outer * 0.15, cy + outer * 0.05],
        fill=210,
    )
    fade = fade.filter(ImageFilter.GaussianBlur(70))
    r, g, b, a = hi.split()
    hi = Image.merge("RGBA", (r, g, b, ImageChops.multiply(a, fade)))

    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    layer = Image.alpha_composite(layer, glow)
    layer = Image.alpha_composite(layer, o)
    layer = Image.alpha_composite(layer, hi)
    return layer


def pi_layer(size: int) -> Image.Image:
    """Geometric π — font-independent, crisp at 16px dock sizes."""
    cx = cy = size / 2
    outer = size * 0.345
    stroke = size * 0.105
    inner = outer - stroke

    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    bar_w = inner * 1.52
    bar_h = stroke * 0.70
    bar_x0 = cx - bar_w / 2
    bar_y0 = cy - inner * 0.40
    bar_x1 = cx + bar_w / 2
    bar_y1 = bar_y0 + bar_h
    d.rounded_rectangle([bar_x0, bar_y0, bar_x1, bar_y1], radius=bar_h / 2, fill=PI)

    serif = bar_h * 0.6
    d.rounded_rectangle(
        [bar_x0 - 2, bar_y0 - serif * 0.4, bar_x0 + serif * 0.65, bar_y1 + serif * 0.2],
        radius=serif / 2,
        fill=PI,
    )
    d.rounded_rectangle(
        [bar_x1 - serif * 0.65, bar_y0 - serif * 0.4, bar_x1 + 2, bar_y1 + serif * 0.2],
        radius=serif / 2,
        fill=PI,
    )

    leg_w = stroke * 0.64
    leg_gap = bar_w * 0.27
    leg_top = bar_y1 - bar_h * 0.2
    leg_bot = cy + inner * 0.50
    d.rounded_rectangle(
        [cx - leg_gap - leg_w / 2, leg_top, cx - leg_gap + leg_w / 2, leg_bot],
        radius=leg_w / 2,
        fill=PI,
    )
    d.rounded_rectangle(
        [cx + leg_gap - leg_w / 2, leg_top, cx + leg_gap + leg_w / 2, leg_bot - stroke * 0.12],
        radius=leg_w / 2,
        fill=PI,
    )
    return layer


def build_master() -> Image.Image:
    base = background(S)
    base = Image.alpha_composite(base, ring_layer(S))
    base = Image.alpha_composite(base, pi_layer(S))
    mask = rounded_mask(S, radius=round(S * 0.22))
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)
    return out


def save_ico(master: Image.Image, path: str) -> None:
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    master.save(path, format="ICO", sizes=sizes)


def save_icns(master: Image.Image, path: str) -> None:
    """Prefer macOS iconutil when available; fall back to Pillow ICNS."""
    iconutil = shutil.which("iconutil")
    if iconutil:
        specs = [
            (16, "icon_16x16.png"),
            (32, "icon_16x16@2x.png"),
            (32, "icon_32x32.png"),
            (64, "icon_32x32@2x.png"),
            (128, "icon_128x128.png"),
            (256, "icon_128x128@2x.png"),
            (256, "icon_256x256.png"),
            (512, "icon_256x256@2x.png"),
            (512, "icon_512x512.png"),
            (1024, "icon_512x512@2x.png"),
        ]
        tmp = tempfile.mkdtemp(prefix="omp-iconset-")
        try:
            iconset = os.path.join(tmp, "OmpStudio.iconset")
            os.makedirs(iconset)
            for px, name in specs:
                master.resize((px, px), Image.Resampling.LANCZOS).save(
                    os.path.join(iconset, name), format="PNG"
                )
            subprocess.check_call([iconutil, "-c", "icns", iconset, "-o", path])
            return
        except Exception as e:
            print(f"warning: iconutil failed ({e}); trying Pillow ICNS", file=sys.stderr)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    try:
        sizes = [(16, 16), (32, 32), (128, 128), (256, 256), (512, 512), (1024, 1024)]
        master.save(path, format="ICNS", sizes=sizes)
    except Exception as e:
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
