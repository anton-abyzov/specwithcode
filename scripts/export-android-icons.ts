#!/usr/bin/env node

// Renders the Android launcher, splash and notification artwork from the Studio mark and
// the Icon Composer background layers.
//
// Icon Composer exports already contain a rounded-square silhouette, and Android masks
// the central 72dp of a 108dp adaptive canvas, so exporting them as a foreground produces
// a double-framed icon with the mark cropped by the mask. Instead, each variant gets a
// full-bleed background layer (the artwork behind the mark) and a shared transparent
// foreground that keeps the mark inside the safe zone.
//
// The Android 12+ splash screen masks its icon to a circle covering the central two thirds
// of a 288dp canvas, which is the same proportion the launcher crops. Composing the two
// adaptive layers into one 288dp image therefore makes the splash frame the mark
// exactly like the launcher icon does.
//
// The themed (monochrome) launcher layer and the status bar notification icon are the
// same mark as a white silhouette: Android reads only their alpha channel.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

type IconVariant = "dev" | "nightly" | "prod";

// 108dp at xxxhdpi. Expo's prebuild derives every launcher density bucket from this.
const ADAPTIVE_CANVAS = 432;
// 288dp at xxxhdpi: the full Android 12+ splash canvas, so the icon needs no upscaling.
const SPLASH_CANVAS = 1152;
// 24dp at xxxhdpi, the largest density bucket of a status bar icon.
const NOTIFICATION_CANVAS = 96;
// The page-and-prompt mark's own coordinates: a square box around the page, as tall as the page.
const MARK = { x: 10, y: 10, width: 80, height: 80 };
const MARK_SOURCE = "assets/brand/specwithcode-mark.svg";
// The same page as one shape with the prompt cut out, for the alpha-only layers.
const SILHOUETTE_SOURCE = "assets/brand/specwithcode-mark-silhouette.svg";
// Mark width as a fraction of the 108dp canvas. The visible area is 72dp (66dp
// guaranteed), so 0.4 leaves the mark at 60% of the mask, with its whole box inside
// the 66dp circle and room for the launcher's own zoom effects.
const MARK_FRACTION = 0.4;
// The themed layer's silhouette is 47.5dp tall. Its box reaches past the 66dp circle
// only at the corners, where the narrower page stays inside it.
const MONOCHROME_MARK_FRACTION = 0.44;
// A 16dp mark with 4dp of padding on each side of the 24dp status bar icon.
const NOTIFICATION_MARK_FRACTION = 2 / 3;
const SILHOUETTE_COLOR = "#fff";
// Icon Composer positions layers on a 1024pt canvas, with translation relative to center.
const COMPOSER_CANVAS_PT = 1024;
const SVG_DENSITY = 300;
const OUTPUT_DIRECTORY = "apps/mobile/assets";
// Production has no background artwork, so its splash composes onto the adaptive color.
const PRODUCTION_BACKGROUND_COLOR = "#5B6CFF";

export class AndroidIconRenderError extends Schema.TaggedError<AndroidIconRenderError>()(
  "AndroidIconRenderError",
  { layer: Schema.String, cause: Schema.Defect() },
) {}

const markTransform = (size: number, fraction: number) => {
  const scale = (size * fraction) / MARK.width;
  const tx = (size - MARK.width * scale) / 2 - MARK.x * scale;
  const ty = (size - MARK.height * scale) / 2 - MARK.y * scale;
  return `translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${scale.toFixed(4)})`;
};

const canvasSvg = (size: number, inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none">${inner}</svg>`;

// The layer sources clip to a 10pt rounded rectangle for the iOS silhouette. Android
// applies its own mask, so the layer must bleed to the canvas edge.
const fullBleed = (svg: string) =>
  svg.replace(/<rect width="128" height="128" rx="10"\/>/, '<rect width="128" height="128"/>');

const rasterize = (layer: string, svg: string, width: number, height = width) =>
  Effect.tryPromise({
    try: () =>
      sharp(Buffer.from(svg), { density: SVG_DENSITY }).resize(width, height).png().toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const composite = (
  layer: string,
  base: Buffer,
  overlays: ReadonlyArray<{ input: Buffer; left?: number; top?: number }>,
) =>
  Effect.tryPromise({
    try: () =>
      sharp(base)
        .composite([...overlays])
        .png()
        .toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const solidCanvas = (layer: string, size: number, background: string) =>
  Effect.tryPromise({
    try: () =>
      sharp({ create: { width: size, height: size, channels: 4, background } })
        .png()
        .toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const readLayerSource = Effect.fn("androidIcons.readLayerSource")(function* (
  repositoryRoot: string,
  variant: IconVariant,
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(
    path.join(repositoryRoot, "assets", variant, "app-icon.icon", "Assets", file),
  );
});

// The brand mark without a tile, because the adaptive background layer takes the
// tile's place.
const readMarkPaths = Effect.fn("androidIcons.readMarkPaths")(function* (
  repositoryRoot: string,
  source: string = MARK_SOURCE,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const logo = yield* fs.readFileString(path.join(repositoryRoot, source));
  return [...(logo.match(/<defs>.*?<\/defs>/s) ?? []), ...(logo.match(/<path[^>]*\/>/g) ?? [])];
});

const renderMark = Effect.fn("androidIcons.renderMark")(function* (
  layer: string,
  paths: ReadonlyArray<string>,
  size: number,
  fraction: number,
) {
  return yield* rasterize(
    layer,
    canvasSvg(size, `<g transform="${markTransform(size, fraction)}">${paths.join("")}</g>`),
    size,
  );
});

const renderForeground = Effect.fn("androidIcons.renderForeground")(function* (
  repositoryRoot: string,
  size: number,
) {
  const paths = yield* readMarkPaths(repositoryRoot);
  return yield* renderMark("foreground", paths, size, MARK_FRACTION);
});

const renderSilhouette = Effect.fn("androidIcons.renderSilhouette")(function* (
  layer: string,
  repositoryRoot: string,
  size: number,
  fraction: number,
) {
  const paths = yield* readMarkPaths(repositoryRoot, SILHOUETTE_SOURCE);
  return yield* renderMark(
    layer,
    paths.map((markPath) =>
      markPath.replace(/="(?:#[0-9a-fA-F]{3,8}|url\(#[^)]+\))"/g, `="${SILHOUETTE_COLOR}"`),
    ),
    size,
    fraction,
  );
});

const renderDevelopmentBackground = Effect.fn("androidIcons.renderDevelopmentBackground")(
  function* (repositoryRoot: string, size: number) {
    const paper = yield* readLayerSource(repositoryRoot, "dev", "background.svg");
    return yield* rasterize("dev-background", fullBleed(paper), size);
  },
);

const renderNightlyBackground = Effect.fn("androidIcons.renderNightlyBackground")(function* (
  repositoryRoot: string,
  size: number,
) {
  // Positions mirror assets/nightly/app-icon.icon/icon.json. The SVG blur filter is
  // dropped because Icon Composer ignores it and it smears at this raster size.
  const clouds = [
    { file: "cloud-lower-left.svg", scale: 25, translation: [-309.6375, 268.66077693836917] },
    {
      file: "cloud-upper-right.svg",
      scale: 15,
      translation: [387.9605131881942, -134.30064713259117],
    },
  ] as const;
  const k = size / COMPOSER_CANVAS_PT;
  const overlays = yield* Effect.forEach(clouds, (cloud) =>
    Effect.gen(function* () {
      const width = Math.round(64 * cloud.scale * k);
      const height = Math.round(32 * cloud.scale * k);
      const left = Math.round((COMPOSER_CANVAS_PT / 2 + cloud.translation[0]) * k - width / 2);
      const top = Math.round((COMPOSER_CANVAS_PT / 2 + cloud.translation[1]) * k - height / 2);
      const source = yield* readLayerSource(repositoryRoot, "nightly", cloud.file);
      const png = yield* rasterize(
        cloud.file,
        source.replace(/ filter="url\(#soft\)"/, ""),
        width,
        height,
      );
      const x0 = Math.max(0, left);
      const y0 = Math.max(0, top);
      const x1 = Math.min(size, left + width);
      const y1 = Math.min(size, top + height);
      const clipped = yield* Effect.tryPromise({
        try: () =>
          sharp(png)
            .extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 })
            .png()
            .toBuffer(),
        catch: (cause) => new AndroidIconRenderError({ layer: cloud.file, cause }),
      });
      return { input: clipped, left: x0, top: y0 };
    }),
  );
  const sky = yield* readLayerSource(repositoryRoot, "nightly", "background.svg");
  const background = yield* rasterize("nightly-background", fullBleed(sky), size);
  return yield* composite("nightly-background", background, overlays);
});

const renderBackground = Effect.fn("androidIcons.renderBackground")(function* (
  repositoryRoot: string,
  variant: IconVariant,
  size: number,
) {
  switch (variant) {
    case "dev":
      return yield* renderDevelopmentBackground(repositoryRoot, size);
    case "nightly":
      return yield* renderNightlyBackground(repositoryRoot, size);
    case "prod":
      return yield* solidCanvas("prod-background", size, PRODUCTION_BACKGROUND_COLOR);
  }
});

const renderSplashIcon = Effect.fn("androidIcons.renderSplashIcon")(function* (
  repositoryRoot: string,
  variant: IconVariant,
) {
  const background = yield* renderBackground(repositoryRoot, variant, SPLASH_CANVAS);
  const foreground = yield* renderForeground(repositoryRoot, SPLASH_CANVAS);
  return yield* composite(`${variant}-splash`, background, [{ input: foreground }]);
});

const exportAndroidIcons = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const outputs = [
    ["android-icon-foreground.png", yield* renderForeground(repositoryRoot, ADAPTIVE_CANVAS)],
    [
      "android-icon-mark.png",
      yield* renderSilhouette(
        "monochrome",
        repositoryRoot,
        ADAPTIVE_CANVAS,
        MONOCHROME_MARK_FRACTION,
      ),
    ],
    [
      "android-notification-icon.png",
      yield* renderSilhouette(
        "notification",
        repositoryRoot,
        NOTIFICATION_CANVAS,
        NOTIFICATION_MARK_FRACTION,
      ),
    ],
    [
      "android-icon-background-dev.png",
      yield* renderDevelopmentBackground(repositoryRoot, ADAPTIVE_CANVAS),
    ],
    [
      "android-icon-background-nightly.png",
      yield* renderNightlyBackground(repositoryRoot, ADAPTIVE_CANVAS),
    ],
    ["android-splash-icon-dev.png", yield* renderSplashIcon(repositoryRoot, "dev")],
    ["android-splash-icon-nightly.png", yield* renderSplashIcon(repositoryRoot, "nightly")],
    ["android-splash-icon-prod.png", yield* renderSplashIcon(repositoryRoot, "prod")],
  ] as const;
  for (const [name, contents] of outputs) {
    yield* fs.writeFile(path.join(repositoryRoot, OUTPUT_DIRECTORY, name), contents);
    yield* Console.log(`wrote ${OUTPUT_DIRECTORY}/${name}`);
  }
});

if (import.meta.main) {
  exportAndroidIcons.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
