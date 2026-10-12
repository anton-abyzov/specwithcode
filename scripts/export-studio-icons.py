"""Generate the SpecWithCode icons from the two brand masters in assets/brand.

  specwithcode-icon.png  1024px full-bleed app icon artwork (macOS, iOS, Linux, Windows)
  specweave-mark.svg     the flat woven-S mark (favicons, in-app marks, Icon Composer layer)

Writes the tracked PNG, ICO and WebP icons, logo.svg and its copies, and the text.svg
layer of the three Icon Composer projects. See assets/README.md.
Needs Pillow and rsvg-convert (brew install librsvg).
"""
import math
import re
import subprocess
import tempfile
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / "assets/brand"
TILE = "#0B1020"
# variant directory -> (app icon prefix, Windows icon prefix, web icon prefix)
VARIANTS = {
    "prod": ("black", "studio-black", "studio-black-web"),
    "dev": ("blueprint", "blueprint", "blueprint-web"),
    "nightly": ("nightly", "nightly", "nightly-web"),
}


def mark_svg(size=64, inset=0.12, tile=True, radius=0.225):
    """The woven-S mark centred in a size x size box, on a rounded navy tile unless tile=False."""
    source = (BRAND / "specweave-mark.svg").read_text()
    view_box = re.search(r'viewBox="([^"]+)"', source).group(1)
    inner = re.sub(r"<title>.*?</title>", "", re.search(r"<svg[^>]*>(.*)</svg>", source, re.S).group(1))
    pad, box = size * inset, size * (1 - 2 * inset)
    background = f'<rect width="{size}" height="{size}" rx="{size * radius:g}" fill="{TILE}"/>' if tile else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">'
        f"<title>SpecWithCode</title>{background}"
        f'<svg x="{pad:g}" y="{pad:g}" width="{box:g}" height="{box:g}" viewBox="{view_box}">{inner}</svg></svg>\n'
    )


def rasterize(svg, size):
    with tempfile.NamedTemporaryFile("w", suffix=".svg") as source:
        source.write(svg)
        source.flush()
        png = subprocess.run(
            ["rsvg-convert", "-w", str(size), "-h", str(size), source.name], check=True, capture_output=True
        ).stdout
    return Image.open(BytesIO(png)).convert("RGBA")


def favicon(size):
    # Small sizes give the mark more of the tile so the weave still reads at 16px.
    inset = 0.06 if size <= 16 else 0.1 if size <= 48 else 0.14
    return rasterize(mark_svg(inset=inset, radius=0.2), size)


def squircle_mask(size, exponent=5.0):
    scale = 4
    half = size * scale / 2
    points = []
    for i in range(1440):
        t = 2 * math.pi * i / 1440
        c, s = math.cos(t), math.sin(t)
        points.append(
            (half + half * math.copysign(abs(c) ** (2 / exponent), c), half + half * math.copysign(abs(s) ** (2 / exponent), s))
        )
    mask = Image.new("L", (size * scale, size * scale), 0)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    return mask.resize((size, size), Image.Resampling.LANCZOS)


def macos_icon(art):
    """The classic macOS grid: an 824px continuous-corner body inset 100px in a 1024px canvas, with a soft shadow."""
    canvas, tile = 1024, 824
    offset = (canvas - tile) // 2
    mask = squircle_mask(tile)
    body = art.resize((tile, tile), Image.Resampling.LANCZOS).convert("RGBA")
    body.putalpha(mask)
    # A faint highlight along the upper rim, fading towards the bottom.
    rim = ImageChops.subtract(mask, mask.filter(ImageFilter.MinFilter(5)))
    fade = Image.linear_gradient("L").resize((tile, tile)).point(lambda v: int((255 - v) * 0.35))
    highlight = Image.new("RGBA", (tile, tile), (255, 255, 255, 0))
    highlight.putalpha(ImageChops.multiply(rim, fade))
    body = Image.alpha_composite(body, highlight)
    shadow_mask = Image.new("L", (canvas, canvas), 0)
    shadow_mask.paste(mask.point(lambda v: int(v * 0.45)), (offset, offset + 10))
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    out.putalpha(shadow_mask.filter(ImageFilter.GaussianBlur(14)))
    out.alpha_composite(body, (offset, offset))
    return out


def save_ico(path, sizes, render):
    images = [render(size) for size in sizes]
    images[-1].save(path, format="ICO", sizes=[(s, s) for s in sizes], append_images=images[:-1])


def main():
    art = Image.open(BRAND / "specwithcode-icon.png").convert("RGBA")
    mac = macos_icon(art)
    full = art.resize((1024, 1024), Image.Resampling.LANCZOS).convert("RGB")

    def app_ico(size):
        return favicon(size) if size <= 32 else mac.resize((size, size), Image.Resampling.LANCZOS)

    # Icon Composer layer: the mark alone at scale 16, so the 64-unit box covers the 1024pt canvas.
    layer = mark_svg(tile=False, inset=0.2)
    for variant, (app, windows, web) in VARIANTS.items():
        directory = ROOT / "assets" / variant
        mac.save(directory / f"{app}-macos-1024.png", optimize=True)
        mac.save(directory / f"{app}-universal-1024.png", optimize=True)
        full.save(directory / f"{app}-ios-1024.png", optimize=True)
        save_ico(directory / f"{windows}-windows.ico", [16, 24, 32, 48, 64, 128, 256], app_ico)
        full.resize((180, 180), Image.Resampling.LANCZOS).save(directory / f"{web}-apple-touch-180.png", optimize=True)
        favicon(16).save(directory / f"{web}-favicon-16x16.png", optimize=True)
        favicon(32).save(directory / f"{web}-favicon-32x32.png", optimize=True)
        save_ico(directory / f"{web}-favicon.ico", [16, 32, 48], favicon)
        (directory / "app-icon.icon/Assets/text.svg").write_text(layer)

    tiled = mark_svg()
    for path in ("assets/prod/logo.svg", "apps/web/public/studio-mark.svg", "apps/mobile/assets/widget/StudioMark.svg"):
        (ROOT / path).write_text(tiled)

    # The browser app's public icons mirror the development set; the marketing site uses production.
    for public, prefix in (("apps/web/public", "assets/dev/blueprint-web"), ("apps/marketing/public", "assets/prod/studio-black-web")):
        for target, source in (
            ("favicon.ico", "favicon.ico"),
            ("favicon-16x16.png", "favicon-16x16.png"),
            ("favicon-32x32.png", "favicon-32x32.png"),
            ("apple-touch-icon.png", "apple-touch-180.png"),
        ):
            (ROOT / public / target).write_bytes((ROOT / f"{prefix}-{source}").read_bytes())
    for name in ("icon.webp", "icon-nightly.webp"):
        mac.save(ROOT / "apps/marketing/src/assets" / name, format="WEBP", quality=92, method=6)
    print("SpecWithCode icons generated from assets/brand")


if __name__ == "__main__":
    main()
