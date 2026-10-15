# Brand icons

The SpecWithCode icons come from two vector masters in `brand/`:

- `brand/specwithcode-mark.svg`: the page-and-prompt mark, a white spec page with a folded corner and a `>_` prompt. Every icon puts it on an indigo `#5B6CFF` tile; the prompt is ink `#0B1020` and the fold `#AAACB2`.
- `brand/specwithcode-mark-silhouette.svg`: the same page as one white shape with the prompt cut out, for Android's monochrome and notification icons.

`python3 scripts/export-studio-icons.py` (Pillow and `rsvg-convert`) writes every tracked PNG, ICO and WebP icon from them, rendering the vectors at each target size: the macOS and Linux icons on the classic macOS grid (an 824px continuous-corner body inset 100px with a soft shadow), the full-bleed iOS icons and apple-touch icons, Windows ICOs (the mark on its tile at 16-32px), the favicons, `prod/logo.svg` with its copies, and the `text.svg` layer of the three Icon Composer projects. Change a master and rerun the script; do not edit the outputs by hand. All three variants share the same artwork.

## Icon Composer projects

`dev/app-icon.icon`, `nightly/app-icon.icon` and `prod/app-icon.icon` carry the mark as their `text.svg` layer (the mark alone in a 64-unit box at scale 16, written by the script) for native Liquid Glass experiments. `vp run icons:export` renders the tracked iOS, Linux, Windows and web icons from these projects instead of from `brand/`, so running it replaces the shipped artwork; rerun `python3 scripts/export-studio-icons.py` afterwards to restore it. It requires Icon Composer 2 or newer (`ICON_COMPOSER_TOOL` overrides discovery).

## Android launcher and splash artwork

Android masks the central 72dp of a 108dp adaptive canvas, and the Android 12+ splash screen masks
the central two thirds of a 288dp canvas, so the Icon Composer exports cannot be used directly:
their rounded-square silhouette gets framed again and the mark is cropped. The Android artwork
is instead rendered by `vp run icons:export:android` from `brand/specwithcode-mark.svg` and
`brand/specwithcode-mark-silhouette.svg`, without a tile, and from the Icon Composer background layers:

- `apps/mobile/assets/android-icon-foreground.png`: the shared transparent mark at 40% of the
  108dp canvas, so that it stays inside the safe zone
- `apps/mobile/assets/android-icon-background-dev.png` and `-nightly.png`: full-bleed variant
  artwork (blueprint grid; night sky and clouds). Production uses the solid indigo `#5B6CFF`.
- `apps/mobile/assets/android-splash-icon-*.png`: the two layers composed into one 288dp image, so
  the splash mask reproduces the launcher icon's framing.
- `apps/mobile/assets/android-icon-mark.png`: the mark as a white silhouette at 44% of the canvas,
  for Android's monochrome themed icon
- `apps/mobile/assets/android-notification-icon.png`: the same silhouette on a 24dp canvas with
  4dp of padding, for the status bar

Rerun the export after changing the mark or a background layer SVG.
