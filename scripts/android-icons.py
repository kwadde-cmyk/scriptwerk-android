#!/usr/bin/env python3
"""Rasterize Scriptwerk launcher icons from android/icon-1024.png (web favicon)."""
from __future__ import annotations

import os
import sys
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "android", "icon-1024.png")
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")
BG = (11, 12, 14, 255)
LAUNCHER = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
FG = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}


def circular(im: Image.Image) -> Image.Image:
    size = im.size[0]
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    out = im.copy()
    out.putalpha(mask)
    return out


def main() -> int:
    if not os.path.isfile(SRC):
        print(f"[icons] missing {SRC}", file=sys.stderr)
        return 1
    src = Image.open(SRC).convert("RGBA")
    for dens, size in LAUNCHER.items():
        icon = src.resize((size, size), Image.Resampling.LANCZOS)
        d = os.path.join(RES, f"mipmap-{dens}")
        os.makedirs(d, exist_ok=True)
        icon.save(os.path.join(d, "ic_launcher.png"), "PNG", optimize=True)
        circular(icon).save(os.path.join(d, "ic_launcher_round.png"), "PNG", optimize=True)
    for dens, size in FG.items():
        fg = Image.new("RGBA", (size, size), BG)
        content = src.resize((size, size), Image.Resampling.LANCZOS)
        fg.paste(content, (0, 0), content)
        d = os.path.join(RES, f"mipmap-{dens}")
        os.makedirs(d, exist_ok=True)
        fg.save(os.path.join(d, "ic_launcher_foreground.png"), "PNG", optimize=True)
    print("[icons] wrote launcher mipmaps from web S")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
