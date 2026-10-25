import type {
  DesignNode,
  DesignOperation,
  DesignPage,
  DesignPaint,
  DesignSystem,
} from "@specweave-studio/contracts";

import {
  compositeColor,
  contrastRatio,
  cssColorToRgba,
  MIN_TEXT_CONTRAST,
  type Rgba,
  relativeLuminance,
} from "./colorContrast.ts";
import { designId, SLIDE_FRAME } from "./designOps.ts";
import { designTokenValue } from "./designRender.ts";

/**
 * Slide layouts built from a design system. Every color and font is a
 * `{ token }` reference to the system when it has a token for that role, so
 * a layout follows the system's modes (light, dark) and later token edits.
 * Roles the system lacks fall back to another token at reduced opacity, or
 * to a neutral literal when there is no system. Font sizes are literal: UI
 * type scales are far too small for a 1920x1080 slide.
 *
 * Inserted layouts are ordinary nodes (frame, text, rect, ellipse); nothing
 * remembers which layout made them, so every part stays editable.
 */

export type SlideLayoutId =
  | "title"
  | "section"
  | "title-body"
  | "two-columns"
  | "image-caption"
  | "quote";

export const SLIDE_LAYOUTS: readonly {
  readonly id: SlideLayoutId;
  readonly label: string;
  readonly description: string;
}[] = [
  { id: "title", label: "Title", description: "Deck title, summary and presenter" },
  { id: "section", label: "Section", description: "A divider that opens a part of the talk" },
  { id: "title-body", label: "Title and body", description: "A heading, text and a visual" },
  { id: "two-columns", label: "Two columns", description: "Two points side by side" },
  { id: "image-caption", label: "Image and caption", description: "A large image with a caption" },
  { id: "quote", label: "Quote", description: "One quote, large, with who said it" },
];

/** A color for one role: a paint plus the opacity the node needs to read as that role. */
export interface SlideColor {
  readonly paint: DesignPaint;
  readonly opacity?: number;
}

export type SlideFont = string | { readonly token: string };

export interface SlideTokens {
  readonly background: SlideColor;
  readonly surface: SlideColor;
  readonly ink: SlideColor;
  readonly muted: SlideColor;
  readonly accent: SlideColor;
  readonly accentInk: SlideColor;
  /** Absent when the system has no font family tokens; text then uses the renderer's font. */
  readonly display?: SlideFont;
  readonly body?: SlideFont;
}

/** Colors for a deck without a design system. */
const NEUTRAL = {
  background: "#ffffff",
  surface: "#eef1f3",
  ink: "#15181d",
  muted: "#59606c",
  accent: "#1f6f5c",
  accentInk: "#ffffff",
} as const;

/**
 * Words that make a token belong to something other than the plain role it
 * ends with: `primary-foreground` is not the ink, `sidebar-background` is
 * not the slide background.
 */
const QUALIFIERS = new Set([
  "primary",
  "secondary",
  "accent",
  "brand",
  "muted",
  "card",
  "popover",
  "destructive",
  "danger",
  "error",
  "success",
  "warning",
  "info",
  "surface",
  "raised",
  "focus",
  "ring",
  "border",
  "line",
  "input",
  "sidebar",
  "chart",
  "on",
  "hover",
  "active",
  "pressed",
  "disabled",
  "inverse",
  "overlay",
  "scrim",
  "selection",
  "link",
  "code",
  "tooltip",
  // Component tokens: a chip or button color is never the slide's background or text.
  "invert",
  "inverted",
  "chip",
  "btn",
  "button",
  "badge",
  "tag",
  "ghost",
  "toast",
  "alert",
  "menu",
  "nav",
  "tab",
]);

function normalize(name: string) {
  return name.replace(/^-+/, "").toLowerCase();
}

/** `name` is `key`, or a namespace (`wv-`, `color-`) followed by `key`. */
function nameMatches(name: string, key: string) {
  if (name === key) return true;
  if (!name.endsWith(`-${key}`)) return false;
  const prefix = name.slice(0, -key.length - 1).split(/[-_.]/);
  return !prefix.some((word) => QUALIFIERS.has(word));
}

/** The first token, by key priority, whose name matches one of `keys`. */
function pick(names: readonly string[], keys: readonly string[], taken: ReadonlySet<string>) {
  for (const key of keys)
    for (const name of names)
      if (!taken.has(name) && nameMatches(normalize(name), key)) return name;
  return null;
}

// Real surface and text names first; the `bg`/`fg` shorthands that component tokens use come last.
const BACKGROUND_KEYS = ["background", "canvas", "paper", "page", "surface", "base", "bg"];
const INK_KEYS = ["foreground", "text", "ink", "on-background", "body", "content", "fg"];
const MUTED_INK_KEYS = [
  "muted-foreground",
  "ink-muted",
  "muted-ink",
  "text-muted",
  "muted-text",
  "fg-muted",
  "ink-soft",
  "text-secondary",
  "subtle-foreground",
];
const SURFACE_KEYS = [
  "surface-raised",
  "raised",
  "card",
  "panel",
  "elevated",
  "surface-2",
  "subtle",
  "surface",
];
const ACCENT_KEYS = ["primary", "accent", "brand"];
const ACCENT_INK_KEYS = [
  "primary-foreground",
  "on-primary",
  "accent-foreground",
  "on-accent",
  "brand-foreground",
  "on-brand",
];
const DISPLAY_FONT_KEYS = [
  "font-display",
  "display",
  "font-heading",
  "heading",
  "font-headline",
  "headline",
  "font-title",
  "title",
  "font-serif",
  "serif",
];
const BODY_FONT_KEYS = [
  "font-body",
  "body",
  "font-sans",
  "sans",
  "font-text",
  "text",
  "font-base",
  "base",
  "font-ui",
  "ui",
  "font",
];

/** Plain colors for when no token pairing can be read. */
const PLAIN = {
  lightInk: NEUTRAL.ink,
  darkInk: "#ffffff",
  lightSurface: NEUTRAL.surface,
  darkSurface: "#262a31",
} as const;

const WHITE: Rgba = { r: 1, g: 1, b: 1, a: 1 };

/** The mode a deck renders in: the system's first mode. */
export function slideDeckMode(system: DesignSystem | null): string {
  return system?.modes[0]?.id ?? "light";
}

/** Which of the system's tokens a slide uses for each role. */
export function slideTokens(system: DesignSystem | null): SlideTokens {
  const colors = (system?.tokens ?? []).filter((token) => token.type === "color");
  const names = colors.map((token) => token.name);
  const mode = slideDeckMode(system);
  const taken = new Set<string>();
  const take = (keys: readonly string[]) => {
    const name = pick(names, keys, taken);
    if (name !== null) taken.add(name);
    return name;
  };
  /** Every untaken name for `keys`, in key priority. */
  const candidates = (keys: readonly string[]) => {
    const found: string[] = [];
    for (const key of keys)
      for (const name of names)
        if (!taken.has(name) && !found.includes(name) && nameMatches(normalize(name), key))
          found.push(name);
    return found;
  };
  const rgbOf = (name: string) => cssColorToRgba(designTokenValue(system, name, mode));
  const colorOf = (color: SlideColor, under: Rgba): Rgba | null => {
    const top =
      typeof color.paint === "string" ? cssColorToRgba(color.paint) : rgbOf(color.paint.token);
    return top === null ? null : compositeColor(top, under, color.opacity ?? 1);
  };
  const readable = (text: SlideColor, under: Rgba) => {
    const ink = colorOf(text, under);
    return ink === null || contrastRatio(ink, under) >= MIN_TEXT_CONTRAST;
  };
  const tokenColor = (name: string): SlideColor => ({ paint: { token: name } });

  // Most specific roles first, so `primary-foreground` never ends up as the accent.
  const accentInkName = take(ACCENT_INK_KEYS);
  const mutedName = take(MUTED_INK_KEYS);
  const accentName = take(ACCENT_KEYS);

  // Background and ink as a pair that reads in the deck's mode.
  const backgrounds = candidates(BACKGROUND_KEYS);
  const inks = candidates(INK_KEYS);
  const opaque = (name: string) => {
    const rgb = rgbOf(name);
    return rgb !== null && rgb.a === 1 ? rgb : null;
  };
  let background: SlideColor | null = null;
  let backgroundRgb: Rgba | null = null;
  let ink: SlideColor | null = null;
  const knownBackgrounds = backgrounds.filter((name) => opaque(name) !== null);
  const knownInks = inks.filter((name) => rgbOf(name) !== null);
  if (knownBackgrounds.length === 0 && knownInks.length === 0) {
    // Nothing can be checked (unresolved references): trust the names.
    const backgroundName = backgrounds[0] ?? null;
    if (backgroundName !== null) {
      taken.add(backgroundName);
      background = tokenColor(backgroundName);
    }
    const inkName = inks.find((name) => name !== backgroundName) ?? null;
    if (inkName !== null) {
      taken.add(inkName);
      ink = tokenColor(inkName);
    }
  } else {
    for (const backgroundName of knownBackgrounds) {
      const under = opaque(backgroundName)!;
      const inkName = knownInks.find(
        (name) => name !== backgroundName && readable(tokenColor(name), under),
      );
      if (inkName === undefined) continue;
      background = tokenColor(backgroundName);
      backgroundRgb = under;
      ink = tokenColor(inkName);
      taken.add(backgroundName);
      taken.add(inkName);
      break;
    }
    if (background === null) {
      const backgroundName = knownBackgrounds[0];
      if (backgroundName !== undefined) {
        // A background token with no readable ink token: plain light or dark text on it.
        backgroundRgb = opaque(backgroundName)!;
        background = tokenColor(backgroundName);
        taken.add(backgroundName);
        const dark: SlideColor = { paint: PLAIN.lightInk };
        ink = readable(dark, backgroundRgb) ? dark : { paint: PLAIN.darkInk };
      } else {
        backgroundRgb = WHITE;
        const inkName = knownInks.find((name) => readable(tokenColor(name), WHITE));
        if (inkName !== undefined) {
          taken.add(inkName);
          ink = tokenColor(inkName);
        }
      }
    }
  }
  const backgroundColor = background ?? { paint: NEUTRAL.background };
  const inkColor = ink ?? { paint: NEUTRAL.ink };
  const base = backgroundRgb ?? colorOf(backgroundColor, WHITE) ?? WHITE;
  const lightBase = relativeLuminance(base) > 0.18;
  const accentColor = accentName === null ? { paint: NEUTRAL.accent } : tokenColor(accentName);

  // A bare `muted` is a surface beside `muted-foreground` (shadcn), and the muted ink otherwise.
  const bareMuted = mutedName === null ? take(["muted"]) : null;
  const mutedToken = mutedName ?? bareMuted;

  // Cards: the first surface the ink reads on.
  const surfaces = candidates(mutedName === null ? SURFACE_KEYS : [...SURFACE_KEYS, "muted"]);
  const surfaceOptions: SlideColor[] = [
    ...surfaces.map(tokenColor),
    ...(accentName !== null ? [{ paint: accentColor.paint, opacity: 0.1 }] : []),
    { paint: lightBase ? PLAIN.lightSurface : PLAIN.darkSurface },
  ];
  const surfaceColor =
    surfaceOptions.find((option) => {
      const fill = colorOf(option, base);
      // An unreadable value is only trusted when nothing else could be checked either.
      return fill === null ? backgroundRgb === null : readable(inkColor, fill);
    }) ?? backgroundColor;
  const surfaceRgb = colorOf(surfaceColor, base) ?? base;

  const readsOnBoth = (text: SlideColor) => readable(text, base) && readable(text, surfaceRgb);
  const mutedOptions: SlideColor[] = [
    ...(mutedToken !== null ? [tokenColor(mutedToken)] : []),
    ...(ink !== null ? [{ paint: inkColor.paint, opacity: 0.68 }] : [{ paint: NEUTRAL.muted }]),
  ];
  const muted = mutedOptions.find(readsOnBoth) ?? inkColor;

  const accentRgb = colorOf(accentColor, base);
  const accentInkOptions: SlideColor[] = [
    ...(accentInkName !== null ? [tokenColor(accentInkName)] : []),
    ...(background !== null ? [backgroundColor] : []),
    { paint: NEUTRAL.accentInk },
    { paint: PLAIN.lightInk },
  ];
  const accentInk =
    accentRgb === null
      ? accentInkOptions[0]!
      : (accentInkOptions.find((option) => readable(option, accentRgb)) ??
        accentInkOptions.reduce((best, option) =>
          contrastRatio(colorOf(option, accentRgb) ?? accentRgb, accentRgb) >
          contrastRatio(colorOf(best, accentRgb) ?? accentRgb, accentRgb)
            ? option
            : best,
        ));

  const fonts = (system?.tokens ?? []).filter((item) => item.type === "fontFamily");
  const fontNames = fonts.map((item) => item.name);
  const bodyName = pick(fontNames, BODY_FONT_KEYS, new Set());
  const displayName = pick(
    fontNames,
    DISPLAY_FONT_KEYS,
    new Set(bodyName === null ? [] : [bodyName]),
  );
  const onlyFont = fontNames.length === 1 ? fontNames[0]! : null;
  const body = bodyName ?? onlyFont;
  const display = displayName ?? body;

  return {
    background: backgroundColor,
    ink: inkColor,
    accent: accentColor,
    muted,
    surface: surfaceColor,
    accentInk,
    ...(display === null ? {} : { display: { token: display } }),
    ...(body === null ? {} : { body: { token: body } }),
  };
}

// ---------------------------------------------------------------------------
// Geometry (on the 1920x1080 grid, scaled to other frame sizes)
// ---------------------------------------------------------------------------

const MARGIN = 128;

interface TextSpec {
  readonly kind: "text";
  readonly name: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly size: number;
  readonly weight?: number;
  readonly lineHeight?: number;
  readonly tracking?: number;
  readonly color: SlideColor;
  readonly font?: SlideFont | undefined;
  readonly align?: "left" | "center" | "right";
}

interface ShapeSpec {
  readonly kind: "rect" | "ellipse";
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color: SlideColor;
  readonly radius?: number;
}

type Spec = TextSpec | ShapeSpec;

interface LayoutSpec {
  readonly fill: SlideColor;
  readonly parts: readonly Spec[];
}

function titleOf(tokens: SlideTokens, text: string): TextSpec {
  return {
    kind: "text",
    name: "Title",
    text,
    x: MARGIN,
    y: 112,
    width: 1920 - MARGIN * 2,
    height: 96,
    size: 64,
    weight: 700,
    lineHeight: 1.15,
    tracking: -1,
    color: tokens.ink,
    font: tokens.display,
  };
}

function layoutSpec(layout: SlideLayoutId, tokens: SlideTokens): LayoutSpec {
  switch (layout) {
    case "title":
      return {
        fill: tokens.background,
        parts: [
          {
            kind: "ellipse",
            name: "Accent circle",
            x: 1352,
            y: 400,
            width: 900,
            height: 900,
            color: tokens.accent,
          },
          {
            kind: "text",
            name: "Title",
            text: "Presentation title",
            x: MARGIN,
            y: 340,
            width: 1120,
            height: 280,
            size: 112,
            weight: 700,
            lineHeight: 1.05,
            tracking: -2,
            color: tokens.ink,
            font: tokens.display,
          },
          {
            kind: "text",
            name: "Subtitle",
            text: "One line on what this deck is for",
            x: MARGIN,
            y: 650,
            width: 1040,
            height: 120,
            size: 40,
            lineHeight: 1.3,
            color: tokens.muted,
            font: tokens.body,
          },
          {
            kind: "text",
            name: "Presenter",
            text: "Presenter name, date",
            x: MARGIN,
            y: 912,
            width: 900,
            height: 48,
            size: 28,
            lineHeight: 1.3,
            color: tokens.muted,
            font: tokens.body,
          },
        ],
      };
    case "section":
      return {
        fill: tokens.accent,
        parts: [
          {
            kind: "text",
            name: "Section number",
            text: "01",
            x: MARGIN,
            y: 300,
            width: 480,
            height: 140,
            size: 120,
            weight: 700,
            lineHeight: 1,
            color: { paint: tokens.accentInk.paint, opacity: 0.5 },
            font: tokens.display,
          },
          {
            kind: "text",
            name: "Section title",
            text: "Section title",
            x: MARGIN,
            y: 460,
            width: 1500,
            height: 240,
            size: 104,
            weight: 700,
            lineHeight: 1.05,
            tracking: -2,
            color: tokens.accentInk,
            font: tokens.display,
          },
          {
            kind: "text",
            name: "Section summary",
            text: "What this part of the talk covers",
            x: MARGIN,
            y: 724,
            width: 1200,
            height: 80,
            size: 40,
            lineHeight: 1.3,
            color: { paint: tokens.accentInk.paint, opacity: 0.78 },
            font: tokens.body,
          },
        ],
      };
    case "title-body":
      return {
        fill: tokens.background,
        parts: [
          titleOf(tokens, "Slide title"),
          {
            kind: "text",
            name: "Body",
            text: "Make one point per slide.\nKeep each line short enough to read at a glance.\nSay the details out loud and put them in the notes.",
            x: MARGIN,
            y: 272,
            width: 960,
            height: 600,
            size: 36,
            lineHeight: 1.6,
            color: tokens.ink,
            font: tokens.body,
          },
          {
            kind: "rect",
            name: "Visual",
            x: 1216,
            y: 272,
            width: 576,
            height: 680,
            radius: 32,
            color: tokens.surface,
          },
        ],
      };
    case "two-columns": {
      const width = (1920 - MARGIN * 2 - 48) / 2;
      const column = (x: number, side: string, heading: string, body: string): Spec[] => [
        {
          kind: "rect",
          name: `${side} column`,
          x,
          y: 272,
          width,
          height: 680,
          radius: 32,
          color: tokens.surface,
        },
        {
          kind: "text",
          name: `${side} heading`,
          text: heading,
          x: x + 56,
          y: 328,
          width: width - 112,
          height: 64,
          size: 44,
          weight: 600,
          lineHeight: 1.2,
          color: tokens.ink,
          font: tokens.display,
        },
        {
          kind: "text",
          name: `${side} body`,
          text: body,
          x: x + 56,
          y: 420,
          width: width - 112,
          height: 476,
          size: 32,
          lineHeight: 1.55,
          color: tokens.muted,
          font: tokens.body,
        },
      ];
      return {
        fill: tokens.background,
        parts: [
          titleOf(tokens, "Two ways to look at it"),
          ...column(MARGIN, "Left", "Before", "Where things stand today, and what that costs."),
          ...column(
            MARGIN + width + 48,
            "Right",
            "After",
            "What changes, and what people will notice first.",
          ),
        ],
      };
    }
    case "image-caption":
      return {
        fill: tokens.background,
        parts: [
          {
            kind: "rect",
            name: "Image",
            x: 0,
            y: 0,
            width: 1152,
            height: 1080,
            color: tokens.surface,
          },
          {
            kind: "text",
            name: "Caption title",
            text: "What the image shows",
            x: 1248,
            y: 360,
            width: 544,
            height: 200,
            size: 56,
            weight: 700,
            lineHeight: 1.1,
            tracking: -1,
            color: tokens.ink,
            font: tokens.display,
          },
          {
            kind: "text",
            name: "Caption",
            text: "Drop an image on the left panel, then say why it matters here.",
            x: 1248,
            y: 600,
            width: 544,
            height: 300,
            size: 30,
            lineHeight: 1.5,
            color: tokens.muted,
            font: tokens.body,
          },
        ],
      };
    case "quote":
      return {
        fill: tokens.background,
        parts: [
          {
            kind: "text",
            name: "Quote mark",
            text: "“",
            x: MARGIN - 12,
            y: 96,
            width: 240,
            height: 240,
            size: 280,
            weight: 700,
            lineHeight: 1,
            color: tokens.accent,
            font: tokens.display,
          },
          {
            kind: "text",
            name: "Quote",
            text: "A sentence worth remembering, set large enough to read from the back of the room.",
            x: MARGIN,
            y: 360,
            width: 1520,
            height: 380,
            size: 72,
            weight: 500,
            lineHeight: 1.2,
            tracking: -1,
            color: tokens.ink,
            font: tokens.display,
          },
          {
            kind: "text",
            name: "Attribution",
            text: "Name, role",
            x: MARGIN,
            y: 800,
            width: 1200,
            height: 60,
            size: 32,
            lineHeight: 1.3,
            color: tokens.muted,
            font: tokens.body,
          },
        ],
      };
  }
}

function withOpacity(color: SlideColor) {
  return color.opacity === undefined ? {} : { opacity: color.opacity };
}

function toNode(
  spec: Spec,
  parentId: string,
  scale: { x: number; y: number },
  random: () => number,
): DesignNode {
  const box = {
    id: designId("n", random),
    parentId,
    name: spec.name,
    x: Math.round(spec.x * scale.x),
    y: Math.round(spec.y * scale.y),
    width: Math.round(spec.width * scale.x),
    height: Math.round(spec.height * scale.y),
    ...withOpacity(spec.color),
  };
  if (spec.kind === "text") {
    const type = Math.min(scale.x, scale.y);
    return {
      ...box,
      type: "text",
      text: spec.text,
      color: spec.color.paint,
      fontSize: Math.round(spec.size * type),
      ...(spec.font === undefined ? {} : { fontFamily: spec.font }),
      ...(spec.weight === undefined ? {} : { fontWeight: spec.weight }),
      lineHeight: spec.lineHeight ?? 1.3,
      ...(spec.tracking === undefined ? {} : { letterSpacing: spec.tracking }),
      align: spec.align ?? "left",
    };
  }
  return {
    ...box,
    type: spec.kind,
    fill: spec.color.paint,
    ...(spec.radius === undefined || spec.kind === "ellipse"
      ? {}
      : { radius: Math.round(spec.radius * Math.min(scale.x, scale.y)) }),
  };
}

export interface SlideLayoutInput {
  readonly system: DesignSystem | null;
  /** The slide frame's size; defaults to 1920x1080. */
  readonly size?: { readonly width: number; readonly height: number };
  readonly random?: () => number;
}

/** The frame fill and the nodes (children of `frameId`) of one layout. */
export function slideLayoutNodes(
  layout: SlideLayoutId,
  frameId: string,
  input: SlideLayoutInput,
): { fill: DesignPaint; nodes: DesignNode[] } {
  const size = input.size ?? SLIDE_FRAME;
  const scale = { x: size.width / SLIDE_FRAME.width, y: size.height / SLIDE_FRAME.height };
  const spec = layoutSpec(layout, slideTokens(input.system));
  const random = input.random ?? Math.random;
  return {
    fill: spec.fill.paint,
    nodes: spec.parts.map((part) => toNode(part, frameId, scale, random)),
  };
}

/** A new slide page: one 16:9 frame holding the layout. */
export function slideLayoutPage(
  layout: SlideLayoutId,
  input: SlideLayoutInput & { readonly name: string },
): DesignPage {
  const random = input.random ?? Math.random;
  const size = input.size ?? SLIDE_FRAME;
  const frameId = designId("n", random);
  const { fill, nodes } = slideLayoutNodes(layout, frameId, { ...input, random });
  return {
    id: designId("p", random),
    name: input.name,
    nodes: [
      {
        id: frameId,
        parentId: null,
        type: "frame",
        name: input.name,
        x: 0,
        y: 0,
        width: size.width,
        height: size.height,
        fill,
        clip: true,
      },
      ...nodes,
    ],
  };
}

/**
 * Operations that lay `layout` out inside the slide's frame: the frame takes
 * the layout's fill and the layout's nodes are added on top of whatever the
 * frame already holds. Null when the page has no slide frame.
 */
export function applySlideLayout(
  page: DesignPage,
  layout: SlideLayoutId,
  input: Omit<SlideLayoutInput, "size">,
): DesignOperation[] | null {
  const frame = page.nodes.find((node) => node.type === "frame" && node.parentId === null);
  if (frame === undefined) return null;
  const { fill, nodes } = slideLayoutNodes(layout, frame.id, {
    ...input,
    size: { width: frame.width, height: frame.height },
  });
  return [
    { op: "update_node", pageId: page.id, id: frame.id, patch: { fill } },
    ...nodes.map((node) => ({ op: "add_node" as const, pageId: page.id, node })),
  ];
}
