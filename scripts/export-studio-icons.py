"""Generate every SpecWithCode icon and mark from the brand masters in assets/brand.

  specwithcode-mark.svg             the mark (prompt chevron and two text lines), solid white
                                    filled paths in a 1024-unit box, sized and placed for the tile
  specwithcode-mark-silhouette.svg  the mark as one colour, for monochrome, tinted and status bar use
  specwithcode-mark-small.svg       a simplified mark (chevron and one line) for 32px and below,
                                    where the two lines of the full mark merge into one shape
  brand.json                        the tile gradient (top to bottom) and the small-mark threshold

Every icon is the mark on a rounded tile with that vertical gradient. Writes the tracked PNG, ICO
and WebP icons, logo.svg and its copies, the Icon Composer projects (prod, dev, nightly and
apps/ios), the Chrome extension icons, the iOS logo image set, both StudioWordmark components, the
Android notification vector and native launcher layers, the DMG backgrounds, the tile colours in
the Android, Chrome and Expo sources, and the avatar pack in dist/brand/avatars. Running it twice
changes nothing. `vp run brand:rollout` runs it together with the Android export; see
assets/README.md. Needs Pillow and rsvg-convert (brew install librsvg).
"""
import hashlib
import json
import math
import re
import subprocess
import tempfile
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / "assets/brand"
SETTINGS = json.loads((BRAND / "brand.json").read_text())
TILE_TOP = SETTINGS["tile"]["top"]
TILE_BOTTOM = SETTINGS["tile"]["bottom"]
DARK_TOP = SETTINGS["darkTile"]["top"]
DARK_BOTTOM = SETTINGS["darkTile"]["bottom"]
SMALL_MARK_MAX_PX = SETTINGS["smallMarkMaxPx"]
BOX = 1024
# variant directory -> (app icon prefix, Windows icon prefix, web icon prefix)
VARIANTS = {
    "prod": ("black", "studio-black", "studio-black-web"),
    "dev": ("blueprint", "blueprint", "blueprint-web"),
    "nightly": ("nightly", "nightly", "nightly-web"),
}
AVATARS = {
    "github": 500,
    "youtube": 800,
    "linkedin": 400,
    "x": 400,
    "chrome-web-store": 128,
    "app-store": 1024,
}


def hex_rgb(value):
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def mid_colour():
    top, bottom = hex_rgb(TILE_TOP), hex_rgb(TILE_BOTTOM)
    return "#" + "".join(f"{(a + b) // 2:02X}" for a, b in zip(top, bottom))


def mark_paths(name="specwithcode-mark"):
    """The path data of a master. Masters must be fills: outline strokes before committing one."""
    source = (BRAND / f"{name}.svg").read_text()
    if re.search(r"\bstroke(?:-width)?=", source):
        raise SystemExit(f"assets/brand/{name}.svg uses strokes; outline them to filled paths first")
    if re.search(r'viewBox="0 0 1024 1024"', source) is None:
        raise SystemExit(f"assets/brand/{name}.svg must use viewBox=\"0 0 1024 1024\"")
    return "".join(re.findall(r'<path[^>]*\sd="([^"]+)"', source))


FULL = mark_paths()
SILHOUETTE = mark_paths("specwithcode-mark-silhouette")
SMALL = mark_paths("specwithcode-mark-small")


def mark_for(px):
    return SMALL if px <= SMALL_MARK_MAX_PX else FULL


def gradient(gid, top=TILE_TOP, bottom=TILE_BOTTOM):
    return (
        f'<linearGradient id="{gid}" x1="0" y1="0" x2="0" y2="1">'
        f'<stop stop-color="{top}"/><stop offset="1" stop-color="{bottom}"/></linearGradient>'
    )


def tile_svg(size=64, mark=FULL, radius=0.225, full_bleed=False, gid="specwithcode-tile", scale=1.0, title=True):
    """The mark on its gradient tile in a size x size box."""
    rx = 0 if full_bleed else BOX * radius
    shift = BOX * (1 - scale) / 2
    transform = f' transform="translate({shift:g} {shift:g}) scale({scale:g})"' if scale != 1 else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {BOX} {BOX}">'
        + ("<title>SpecWithCode</title>" if title else "")
        + f"<defs>{gradient(gid)}</defs>"
        f'<rect width="{BOX}" height="{BOX}" rx="{rx:g}" fill="url(#{gid})"/>'
        f'<path fill="#FFFFFF"{transform} d="{mark}"/></svg>'
    )


def mark_only_svg(mark=FULL, size=BOX, colour="#FFFFFF", box=(0, 0, BOX, BOX)):
    x, y, w, h = box
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="{x:g} {y:g} {w:g} {h:g}">'
        f'<title>SpecWithCode</title><path fill="{colour}" d="{mark}"/></svg>\n'
    )


def rasterize(svg, size):
    with tempfile.NamedTemporaryFile("w", suffix=".svg") as source:
        source.write(svg)
        source.flush()
        png = subprocess.run(
            ["rsvg-convert", "-w", str(size), "-h", str(size), source.name], check=True, capture_output=True
        ).stdout
    return Image.open(BytesIO(png)).convert("RGBA")


def mark_bounds(mark=SILHOUETTE):
    """A square box around the drawn mark, in master units, for tightly cropped one-colour uses."""
    alpha = rasterize(mark_only_svg(mark), BOX).getchannel("A")
    left, top, right, bottom = alpha.getbbox()
    side = max(right - left, bottom - top)
    cx, cy = (left + right) / 2, (top + bottom) / 2
    return (round(cx - side / 2), round(cy - side / 2), side, side)


def favicon(size):
    """A small rounded tile. At 32px and below the simplified mark keeps chevron and line apart."""
    small = size <= SMALL_MARK_MAX_PX
    return rasterize(tile_svg(mark=mark_for(size), radius=0.2, scale=1.0 if small else 1.2), size)


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
    shadow_mask = Image.new("L", (canvas, canvas), 0)
    shadow_mask.paste(mask.point(lambda v: int(v * 0.45)), (offset, offset + 10))
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    out.putalpha(shadow_mask.filter(ImageFilter.GaussianBlur(14)))
    out.alpha_composite(body, (offset, offset))
    return out


def save_png(image, relative):
    path = ROOT / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=True)


def save_ico(path, sizes, render):
    images = [render(size) for size in sizes]
    images[-1].save(path, format="ICO", sizes=[(s, s) for s in sizes], append_images=images[:-1])


def write_text(relative, text):
    path = ROOT / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or path.read_text() != text:
        path.write_text(text)


def substitute(relative, pattern, replacement, flags=0):
    """Rewrite exactly one marked spot in a source file; fail loudly if the anchor moved."""
    path = ROOT / relative
    text = path.read_text()
    updated, count = re.subn(pattern, replacement, text, flags=flags)
    if count != 1:
        raise SystemExit(f"{relative}: expected one match for {pattern!r}, found {count}")
    if updated != text:
        path.write_text(updated)


# Icon Composer ------------------------------------------------------------------------------


def p3(hex_value):
    r, g, b = (c / 255 for c in hex_rgb(hex_value))
    return f"srgb:{r:.5f},{g:.5f},{b:.5f},1.00000"


def gradient_fill(top, bottom):
    return {
        "linear-gradient": [p3(top), p3(bottom)],
        "orientation": {"start": {"x": 0.5, "y": 0}, "stop": {"x": 0.5, "y": 1}},
    }


MARK_LAYER = {
    "glass": False,
    "image-name": "mark.svg",
    "name": "Mark",
    "position": {"scale": 1, "translation-in-points": [0, 0]},
}
# The mark is solid white in every appearance: no glass, no translucency, no shadow.
MARK_GROUP = {"layers": [MARK_LAYER], "shadow": {"kind": "none", "opacity": 0}, "translucency": {"enabled": False, "value": 0}}


def composer_json(document):
    """JSON laid out like the formatter does: short scalar arrays stay on one line."""

    def emit(value, indent):
        pad = "  " * indent
        if isinstance(value, dict):
            if not value:
                return "{}"
            items = [f'{pad}  {json.dumps(k)}: {emit(v, indent + 1)}' for k, v in value.items()]
            return "{\n" + ",\n".join(items) + f"\n{pad}}}"
        if isinstance(value, list):
            if all(not isinstance(v, (dict, list)) for v in value):
                inline = "[" + ", ".join(json.dumps(v) for v in value) + "]"
                if len(pad) + len(inline) < 80:
                    return inline
            if not value:
                return "[]"
            return "[\n" + ",\n".join(f"{pad}  {emit(v, indent + 1)}" for v in value) + f"\n{pad}]"
        return json.dumps(value)

    return emit(document, 0) + "\n"


def write_composer_project(directory, document):
    assets = directory / "Assets"
    assets.mkdir(parents=True, exist_ok=True)
    stale = assets / "text.svg"
    if stale.exists():
        stale.unlink()
    write_text((assets / "mark.svg").relative_to(ROOT), mark_only_svg(SILHOUETTE))
    write_text((directory / "icon.json").relative_to(ROOT), composer_json(document))


def production_composer_document():
    return {
        "fill-specializations": [
            {"value": gradient_fill(TILE_TOP, TILE_BOTTOM)},
            {"appearance": "dark", "value": gradient_fill(DARK_TOP, DARK_BOTTOM)},
        ],
        "groups": [MARK_GROUP],
        "supported-platforms": {"circles": ["watchOS"], "squares": "shared"},
    }


def variant_composer_document(directory):
    """Dev and nightly keep their background layers and fill; only the mark changes."""
    document = json.loads((directory / "icon.json").read_text())
    groups = []
    for group in document["groups"]:
        layers = [layer for layer in group.get("layers", []) if layer.get("image-name") not in ("text.svg", "mark.svg")]
        if layers or not groups:
            groups.append({**group, "layers": layers})
    groups = [group for group in groups if group["layers"]]
    document["groups"] = [MARK_GROUP, *groups]
    return document


def write_composer_projects():
    production = production_composer_document()
    write_composer_project(ROOT / "assets/prod/app-icon.icon", production)
    write_composer_project(ROOT / "apps/ios/App/AppIcon.icon", production)
    for variant in ("dev", "nightly"):
        directory = ROOT / "assets" / variant / "app-icon.icon"
        write_composer_project(directory, variant_composer_document(directory))


# Code that draws the mark -------------------------------------------------------------------

GENERATED = "Generated by scripts/export-studio-icons.py from assets/brand; do not edit by hand."


def web_wordmark():
    return f"""import {{ useId, type SVGProps }} from "react";

// The SpecWithCode mark on its gradient tile. {GENERATED}
const TILE_TOP = "{TILE_TOP}";
const TILE_BOTTOM = "{TILE_BOTTOM}";
const MARK_FILL = "#FFFFFF";
const MARK =
  "{FULL}";

export function StudioWordmark(props: SVGProps<SVGSVGElement>) {{
  const tile = `specwithcode-tile-${{useId()}}`;
  return (
    <svg
      {{...props}}
      viewBox="0 0 1024 1024"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="SpecWithCode"
    >
      <defs>
        <linearGradient id={{tile}} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor={{TILE_TOP}} />
          <stop offset="1" stopColor={{TILE_BOTTOM}} />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="230.4" fill={{`url(#${{tile}})`}} />
      <path fill={{MARK_FILL}} d={{MARK}} />
    </svg>
  );
}}
"""


def mobile_wordmark():
    return f"""import type {{ ColorValue }} from "react-native";
import Svg, {{ Defs, LinearGradient, Path, Rect, Stop }} from "react-native-svg";

// The SpecWithCode mark on its gradient tile. {GENERATED}
const TILE_TOP = "{TILE_TOP}";
const TILE_BOTTOM = "{TILE_BOTTOM}";
const MARK_FILL = "#FFFFFF";
const MARK =
  "{FULL}";

// Always the brand colors; color and colorClassName are kept for existing callers.
export function StudioWordmark(props: {{
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}}) {{
  return (
    <Svg
      accessibilityLabel="SpecWithCode"
      height={{props.height}}
      width={{props.height}}
      viewBox="0 0 1024 1024"
    >
      <Defs>
        <LinearGradient id="specwithcode-tile" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={{TILE_TOP}} />
          <Stop offset="1" stopColor={{TILE_BOTTOM}} />
        </LinearGradient>
      </Defs>
      <Rect width="1024" height="1024" rx="230.4" fill="url(#specwithcode-tile)" />
      <Path fill={{MARK_FILL}} d={{MARK}} />
    </Svg>
  );
}}
"""


def notification_vector():
    x, y, w, h = mark_bounds()
    return f"""<!-- The SpecWithCode mark (assets/brand/specwithcode-mark-silhouette.svg) as a white silhouette cropped to the mark, so it renders as large as other apps' status bar icons. {GENERATED} -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp"
    android:viewportWidth="{w}" android:viewportHeight="{h}">
    <group android:translateX="{-x}" android:translateY="{-y}">
        <path android:fillColor="#FFFFFFFF"
            android:pathData="{SILHOUETTE}" />
    </group>
</vector>
"""


def native_android_background():
    return f"""<?xml version="1.0" encoding="utf-8"?>
<!-- The launcher tile: the brand gradient, top to bottom. {GENERATED} -->
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <gradient android:angle="270" android:startColor="{TILE_TOP}" android:endColor="{TILE_BOTTOM}" />
</shape>
"""


def android_layer(mark, size=432):
    """The mark's 1024 box over the 72dp visible part of the 108dp adaptive canvas."""
    inner = size * 72 / 108
    offset = (size - inner) / 2
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(rasterize(mark_only_svg(mark), round(inner)), (round(offset), round(offset)))
    return canvas


def write_code_consumers():
    write_text("apps/web/src/components/StudioWordmark.tsx", web_wordmark())
    write_text("apps/mobile/src/components/StudioWordmark.tsx", mobile_wordmark())
    write_text(
        "apps/mobile/modules/studio-agent-notifications/android/src/main/res/drawable/agent_activity_mark.xml",
        notification_vector(),
    )
    # Native Android launcher: gradient tile, mark foreground, one-colour themed layer.
    write_text("apps/android/app/src/main/res/drawable/ic_launcher_background.xml", native_android_background())
    for relative in (
        "apps/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml",
        "apps/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml",
    ):
        substitute(relative, r'android:drawable="@(?:color|drawable)/ic_launcher_background"', 'android:drawable="@drawable/ic_launcher_background"')
    substitute(
        "apps/android/app/src/main/res/values/colors.xml",
        r'(<color name="ic_launcher_background">)#[0-9A-Fa-f]{6}(</color>)',
        rf"\g<1>{mid_colour()}\g<2>",
    )
    save_png(android_layer(FULL), "apps/android/app/src/main/res/drawable-xxxhdpi/ic_launcher_foreground.png")
    save_png(android_layer(SILHOUETTE), "apps/android/app/src/main/res/drawable-xxxhdpi/ic_launcher_monochrome.png")
    # Tile colours in sources that cannot read a gradient.
    substitute("apps/chrome-extension/src/popup.css", r"(--accent: )#[0-9A-Fa-f]{6}(;)", rf"\g<1>{TILE_BOTTOM.lower()}\g<2>")
    substitute(
        "apps/mobile/app.config.ts",
        r'(androidAdaptiveBackgroundColor: )"#[0-9A-Fa-f]{6}"(,\s+androidAdaptiveBackgroundImage: "\./assets/android-icon-background-prod\.png")',
        rf'\g<1>"{mid_colour()}"\g<2>',
    )
    for promo in ("promo-small.html", "promo-marquee.html"):
        substitute(
            f"apps/chrome-extension/store/screenshots/src/{promo}",
            r"(\n\s+background: )linear-gradient\([^;]*\);(\s*/\* brand tile \*/)?",
            rf"\g<1>linear-gradient(180deg, {TILE_TOP.lower()} 0%, {TILE_BOTTOM.lower()} 100%); /* brand tile */",
        )
    # DMG backgrounds: the tiled mark above the install hint, and the arrow in the tile colour.
    for name in ("latest", "nightly"):
        relative = f"apps/desktop/resources/dmg/dmg-background-{name}.svg"
        tile = tile_svg(gid="specwithcode-tile", title=False).replace(
            '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"', '<svg x="300" y="24" width="40" height="40"'
        )
        substitute(relative, r'<svg x="300" y="24"[^>]*>.*?</svg>', lambda _: tile, re.S)
        substitute(relative, r'(<path d="M270 204[^"]*" stroke=")#[0-9A-Fa-f]{6}(")', rf"\g<1>{TILE_TOP}\g<2>")
    # The SpecWithCode project favicon in the mobile showcase fixture.
    substitute(
        "scripts/mobile-showcase-environment.ts",
        r"(\n  studio: `)<svg[^`]*(`,)",
        lambda m: m.group(1) + tile_svg(gid="specwithcode-tile") + m.group(2),
    )


# Raster sets --------------------------------------------------------------------------------


def write_avatars():
    """Square (full bleed) and round (transparent outside the circle) profile pictures."""
    out = ROOT / "dist/brand/avatars"
    for shape in ("square", "round"):
        (out / shape).mkdir(parents=True, exist_ok=True)
    for platform, size in AVATARS.items():
        square = rasterize(tile_svg(mark=mark_for(size), full_bleed=True), size)
        square.save(out / "square" / f"specwithcode-{platform}-{size}.png", format="PNG", optimize=True)
        scale = 4
        mask = Image.new("L", (size * scale, size * scale), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, size * scale - 1, size * scale - 1), fill=255)
        round_image = square.copy()
        round_image.putalpha(mask.resize((size, size), Image.Resampling.LANCZOS))
        round_image.save(out / "round" / f"specwithcode-{platform}-{size}.png", format="PNG", optimize=True)


def main():
    art = rasterize(tile_svg(size=1024, full_bleed=True), 1024)
    mac = macos_icon(rasterize(tile_svg(size=824, full_bleed=True), 824))
    full = art.convert("RGB")

    def app_ico(size):
        return favicon(size) if size <= 48 else mac.resize((size, size), Image.Resampling.LANCZOS)

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
    write_composer_projects()

    tiled = tile_svg() + "\n"
    for path in ("assets/prod/logo.svg", "apps/web/public/studio-mark.svg"):
        write_text(path, tiled)
    # The widget ships this as a template image, which keeps only the alpha channel: the mark alone.
    write_text("apps/mobile/assets/widget/StudioMark.svg", mark_only_svg(SILHOUETTE, size=64, box=mark_bounds()))

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

    # Chrome extension: small tiles at 16-48px; the 128px icon keeps 8px of transparent margin.
    for size in (16, 32, 48):
        save_png(favicon(size), f"apps/chrome-extension/icons/icon-{size}.png")
    chrome = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    chrome.alpha_composite(rasterize(tile_svg(radius=0.2), 112), (8, 8))
    save_png(chrome, "apps/chrome-extension/icons/icon-128.png")

    # The native iOS app's 32pt logo.
    imageset = "apps/ios/SWCKit/Sources/Weave/Resources/Brand.xcassets/specwithcode-logo.imageset"
    for scale in (1, 2, 3):
        save_png(favicon(32 * scale), f"{imageset}/logo@{scale}x.png")

    write_code_consumers()
    write_avatars()
    stamp_icon_links()
    print("SpecWithCode icons generated from assets/brand")


# Pages that link the generated icons. Each link carries ?v=<brand hash>, so a new mark gets new
# URLs and browsers stop showing a favicon or touch icon cached from the old one.
ICON_LINKERS = (
    "apps/web/index.html",
    "apps/web/public/manifest.webmanifest",
    "apps/marketing/src/layouts/Layout.astro",
    "apps/marketing/src/pages/95.astro",
)
ICON_LINK = re.compile(
    r"/(favicon\.ico|favicon-\d+x\d+\.png|apple-touch-icon\.png|manifest\.webmanifest|studio-mark\.svg)(\?v=[0-9a-f]+)?"
)


def stamp_icon_links():
    digest = hashlib.sha256()
    for name in ("specwithcode-mark.svg", "specwithcode-mark-small.svg", "brand.json"):
        digest.update((BRAND / name).read_bytes())
    version = digest.hexdigest()[:8]
    for relative in ICON_LINKERS:
        path = ROOT / relative
        text = path.read_text()
        updated = ICON_LINK.sub(lambda match: f"/{match.group(1)}?v={version}", text)
        if updated != text:
            path.write_text(updated)


if __name__ == "__main__":
    main()
