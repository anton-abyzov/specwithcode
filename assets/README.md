# Brand icons

Every SpecWithCode icon and mark comes from four files in `brand/`. To change the icon, replace them and run one command:

```sh
vp run brand:rollout
```

## Masters

- `brand/specwithcode-mark.svg`: the mark, a white prompt chevron whose cursor is two text lines. It is solid white filled paths (no strokes, no opacity) in a `0 0 1024 1024` box, drawn at the size and place it takes on the tile: about 55 percent of the tile's width.
- `brand/specwithcode-mark-silhouette.svg`: the mark in one colour, for Android's monochrome and notification icons, iOS tinted mode, the widget template image and the tray. It is identical to the mark today because the mark is already one colour.
- `brand/specwithcode-mark-small.svg`: a simplified mark (the chevron and one line) used at 32px and below. At those sizes the two lines of the full mark merge into one shape; the small drawing keeps the chevron and the line separate at 16px on light and dark backgrounds.
- `brand/brand.json`: the tile gradient (`tile.top` to `tile.bottom`, vertically; today `#6E7DFF` to `#4A58E8`), the dark-appearance tile for Icon Composer, and `smallMarkMaxPx`.

Masters must be filled paths. The design was drawn with round-capped strokes (chevron `M288 366L454 512L288 658` at width 92, lines `M544 548H756` and `M544 672H692` at width 84); the committed paths are their outlines, because Android vector drawables, the notification icon and Icon Composer's tinted mode read fills reliably. The export refuses a master that uses strokes.

## What `vp run brand:rollout` writes

It runs `python3 scripts/export-studio-icons.py` (Pillow and `rsvg-convert`), then `node scripts/export-android-icons.ts` (sharp). Running it twice changes nothing.

- `assets/{prod,dev,nightly}`: macOS and Linux icons on the classic macOS grid (an 824px continuous-corner body inset 100px with a soft shadow), full-bleed iOS icons, apple-touch icons, favicons, web and Windows ICOs (the small mark at 16-32px). All three variants share the tile artwork.
- Icon Composer projects `assets/{prod,dev,nightly}/app-icon.icon` and `apps/ios/App/AppIcon.icon`: the mark as the `mark.svg` layer in its own group (no glass, translucency or shadow, so it stays solid white). Production and iOS fill with the gradient, with a dark gradient for the Dark appearance; Tinted is derived by the system. Dev and nightly keep their own fill and background layers.
- `assets/prod/logo.svg`, `apps/web/public/studio-mark.svg`, the widget's `apps/mobile/assets/widget/StudioMark.svg` (the mark alone: the widget uses it as a template image), the web and marketing public icons, `apps/marketing/src/assets/icon*.webp`, and the `?v=` stamps on the pages that link them.
- `apps/chrome-extension/icons/icon-{16,32,48,128}.png` and the gradients in the store promo sources (`store/screenshots/src/promo-*.html`). Render the promo PNGs with `store/screenshots/src/render.mjs` when a listing is updated.
- `apps/ios/SWCKit/.../specwithcode-logo.imageset`.
- `apps/web/src/components/StudioWordmark.tsx` and `apps/mobile/src/components/StudioWordmark.tsx`, the Android notification vector `agent_activity_mark.xml`, the DMG backgrounds, the mobile showcase fixture's project favicon.
- Native Android (`apps/android`): launcher foreground and monochrome PNGs and the gradient `drawable/ic_launcher_background.xml`.
- Tile colours where a gradient cannot go: `ic_launcher_background` in `apps/android/.../values/colors.xml` and Expo's prod `androidAdaptiveBackgroundColor` (the gradient's midpoint), and `--accent` in `apps/chrome-extension/src/popup.css` (the gradient's bottom).
- Android artwork for Expo in `apps/mobile/assets` (see below).
- An avatar pack in `dist/brand/avatars/{square,round}/` (not tracked): GitHub 500, YouTube 800, LinkedIn 400, X 400, Chrome Web Store 128 and App Store 1024 pixels. Uploading one to a store or social profile needs Anton's approval per listing.

Do not edit the outputs by hand. The brand audit and the preservation audit check that the logo, the web wordmark and the DMG backgrounds carry the master's current path data.

## Rendering from Icon Composer

`vp run icons:export` renders the tracked iOS, Linux, Windows and web icons from the Icon Composer projects instead of from `brand/`, so running it replaces the shipped artwork; rerun `vp run brand:rollout` afterwards to restore it. It requires Icon Composer 2 or newer (`ICON_COMPOSER_TOOL` overrides discovery). To preview appearances, call `ictool` directly, for example `ictool assets/prod/app-icon.icon --export-image --output-file out.png --platform iOS --rendition Dark --width 512 --height 512 --scale 1` (renditions `Default`, `Dark`, `TintedLight`, `TintedDark`).

## Android launcher and splash artwork

Android masks the central 72dp of a 108dp adaptive canvas, and the Android 12+ splash screen masks
the central two thirds of a 288dp canvas, so the Icon Composer exports cannot be used directly:
their rounded-square silhouette gets framed again and the mark is cropped. `scripts/export-android-icons.ts`
instead renders from `brand/` and the Icon Composer background layers:

- `apps/mobile/assets/android-icon-foreground.png`: the master's 1024 box over the 72dp visible
  area, so the mark sits on the adaptive tile as it sits on the app icon
- `apps/mobile/assets/android-icon-background-{dev,nightly,prod}.png`: full-bleed variant artwork
  (blueprint grid; night sky and clouds; the brand gradient)
- `apps/mobile/assets/android-splash-icon-*.png`: the two layers composed into one 288dp image, so
  the splash mask reproduces the launcher icon's framing
- `apps/mobile/assets/android-icon-mark.png`: the silhouette, for Android's monochrome themed icon
- `apps/mobile/assets/android-notification-icon.png`: the silhouette cropped to the mark, 20dp in
  the 24dp status bar icon
