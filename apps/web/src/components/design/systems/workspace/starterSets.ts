/**
 * Starter sets for a system built from scratch: a palette from one accent,
 * a type scale from one family, a 4 px spacing scale, corner radii and two
 * shadows. Values are neutral defaults, never a sample brand's. The first
 * mode gets light values (dark when it is a dark mode), a later mode of the
 * other kind gets its own, and a later mode of the same kind inherits. Pure.
 */
import type { DesignSystem, DesignTokenEdit, DesignTokenType } from "@specweave-studio/contracts";

import { hexOf, isDarkMode, parseColor, type Rgba } from "./tokenValues";

export type StarterKind = "colors" | "typography" | "spacing" | "radius" | "shadows";

export const STARTER_KINDS: readonly StarterKind[] = [
  "colors",
  "typography",
  "spacing",
  "radius",
  "shadows",
];

/** A calm blue, used until the person picks their own accent. */
export const DEFAULT_ACCENT = "#2f6fed";

export const STARTER_FAMILIES: ReadonlyArray<{ readonly label: string; readonly stack: string }> = [
  {
    label: "System sans",
    stack: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  },
  { label: "Inter", stack: "Inter, ui-sans-serif, system-ui, sans-serif" },
  { label: "Serif", stack: 'ui-serif, Georgia, "Times New Roman", serif' },
  { label: "Rounded", stack: 'ui-rounded, "SF Pro Rounded", system-ui, sans-serif' },
];

export const DEFAULT_FAMILY = STARTER_FAMILIES[0]!.stack;

const MONO_STACK =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

/** What each set is called in the offer, the toast and the button. */
export const STARTER_LABELS: Record<StarterKind, string> = {
  colors: "a starter palette",
  typography: "a starter type scale",
  spacing: "a 4 px spacing scale",
  radius: "starter corner radii",
  shadows: "two starter shadows",
};

const GROUPS: Record<StarterKind, string> = {
  colors: "color",
  typography: "type",
  spacing: "spacing",
  radius: "radius",
  shadows: "shadow",
};

export interface StarterOptions {
  /** The palette's accent, any hex or rgb() color. */
  readonly accent?: string;
  /** The type scale's family stack. */
  readonly family?: string;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

type Pair = { readonly light: string; readonly dark: string };

/** Values per mode id: the first mode and every later mode unlike it get their own; the rest inherit. */
export function modeValues(modes: DesignSystem["modes"], pair: Pair): Record<string, string> {
  const [first, ...rest] = modes;
  if (first === undefined) return { default: pair.light };
  const pick = (mode: (typeof modes)[number]) => (isDarkMode(mode) ? pair.dark : pair.light);
  const values: Record<string, string> = { [first.id]: pick(first) };
  for (const mode of rest) if (isDarkMode(mode) !== isDarkMode(first)) values[mode.id] = pick(mode);
  return values;
}

const firstOnly = (modes: DesignSystem["modes"], raw: string): Record<string, string> => ({
  [modes[0]?.id ?? "default"]: raw,
});

// ---------------------------------------------------------------------------
// Color math
// ---------------------------------------------------------------------------

interface Hsl {
  readonly h: number;
  readonly s: number;
  readonly l: number;
}

function toHsl({ r, g, b }: Rgba): Hsl {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === rn
      ? (gn - bn) / d + (gn < bn ? 6 : 0)
      : max === gn
        ? (bn - rn) / d + 2
        : (rn - gn) / d + 4;
  return { h: h * 60, s: s * 100, l: l * 100 };
}

function hex(h: number, s: number, l: number): string {
  const sn = Math.max(0, Math.min(100, s)) / 100;
  const ln = Math.max(0, Math.min(100, l)) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return hexOf({ r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 });
}

function luminance({ r, g, b }: Pick<Rgba, "r" | "g" | "b">): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** White or near-black, whichever reads better on the fill. */
function textOn(fill: string): string {
  const color = parseColor(fill);
  if (color === null) return "#FFFFFF";
  const l = luminance(color);
  const ink = luminance({ r: 11, g: 13, b: 18 });
  return 1.05 / (l + 0.05) >= (l + 0.05) / (ink + 0.05) ? "#FFFFFF" : "#0B0D12";
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

function token(
  kind: StarterKind,
  name: string,
  type: DesignTokenType,
  values: Record<string, string>,
  description?: string,
): DesignTokenEdit {
  return {
    name,
    type,
    group: GROUPS[kind],
    values,
    ...(description === undefined ? {} : { description }),
  };
}

function palette(modes: DesignSystem["modes"], accentInput: string): DesignTokenEdit[] {
  const parsed = parseColor(accentInput) ?? parseColor(DEFAULT_ACCENT)!;
  const { h, s, l } = toHsl(parsed);
  // Neutrals lean slightly toward the accent's hue, so grays belong to the brand.
  const tint = Math.min(s, 40) / 40;
  const n = (sat: number) => sat * tint;
  const accentLight = hexOf(parsed);
  const accentDark = hex(h, Math.min(s, 90), Math.max(Math.min(l + 12, 72), 60));
  const color = (name: string, pair: Pair, description?: string) =>
    token("colors", `color-${name}`, "color", modeValues(modes, pair), description);
  return [
    color(
      "surface-ground",
      { light: hex(h, n(14), 98), dark: hex(h, n(16), 8) },
      "The page ground.",
    ),
    color(
      "surface-panel",
      { light: "#FFFFFF", dark: hex(h, n(14), 12) },
      "Cards, menus and windows that sit on the ground.",
    ),
    color(
      "surface-sunken",
      { light: hex(h, n(16), 95), dark: hex(h, n(16), 5) },
      "Wells, code and inputs.",
    ),
    color("line-default", { light: hex(h, n(14), 89), dark: hex(h, n(12), 20) }, "Hairlines."),
    color(
      "line-strong",
      { light: hex(h, n(12), 72), dark: hex(h, n(10), 34) },
      "Borders on controls that must be seen.",
    ),
    color("text-ink", { light: hex(h, n(20), 11), dark: hex(h, n(24), 95) }, "Body text."),
    color("text-muted", { light: hex(h, n(10), 38), dark: hex(h, n(10), 68) }, "Secondary text."),
    color("accent", { light: accentLight, dark: accentDark }, "Primary buttons, links and focus."),
    color(
      "accent-strong",
      {
        light: hex(h, s, Math.max(l - 10, 18)),
        dark: hex(h, Math.min(s, 90), Math.min(l + 20, 82)),
      },
      "The accent on hover and press.",
    ),
    color(
      "text-on-accent",
      { light: textOn(accentLight), dark: textOn(accentDark) },
      "Text on an accent fill.",
    ),
    color("status-success", { light: hex(145, 63, 32), dark: hex(145, 55, 55) }),
    color("status-warning", { light: hex(35, 92, 36), dark: hex(40, 92, 58) }),
    color("status-danger", { light: hex(0, 72, 45), dark: hex(0, 85, 67) }),
  ];
}

/**
 * The chosen family is the body face whatever its stack, so it is named by
 * that role (not font-sans for a serif); slides read font-body as body text.
 */
const BODY_FAMILY = "font-body";

function typeScale(modes: DesignSystem["modes"], family: string): DesignTokenEdit[] {
  const name = BODY_FAMILY;
  const style = (step: string, raw: string) =>
    token("typography", `type-${step}`, "typography", firstOnly(modes, raw));
  return [
    token("typography", name, "fontFamily", firstOnly(modes, family)),
    token("typography", "font-mono", "fontFamily", firstOnly(modes, MONO_STACK)),
    style("display", `700 48px/1.1 var(--${name})`),
    style("h1", `700 32px/1.2 var(--${name})`),
    style("h2", `600 24px/1.25 var(--${name})`),
    style("h3", `600 20px/1.3 var(--${name})`),
    style("body", `400 16px/1.5 var(--${name})`),
    style("small", `400 14px/1.45 var(--${name})`),
    style("caption", `500 12px/1.4 var(--${name})`),
    style("code", "400 14px/1.5 var(--font-mono)"),
  ];
}

const SPACING = [
  [1, 4],
  [2, 8],
  [3, 12],
  [4, 16],
  [6, 24],
  [8, 32],
  [12, 48],
  [16, 64],
] as const;

const RADII = [
  ["sm", "4px", "Chips and inline code."],
  ["md", "8px", "Buttons and inputs."],
  ["lg", "12px", "Cards and menus."],
  ["xl", "20px", "Dialogs and sheets."],
  ["full", "9999px", "Pills and avatars."],
] as const;

/** The tokens of one starter set for this system's modes. */
export function starterTokens(
  kind: StarterKind,
  modes: DesignSystem["modes"],
  options: StarterOptions = {},
): DesignTokenEdit[] {
  switch (kind) {
    case "colors":
      return palette(modes, options.accent ?? DEFAULT_ACCENT);
    case "typography":
      return typeScale(modes, options.family?.trim() || DEFAULT_FAMILY);
    case "spacing":
      return SPACING.map(([step, px]) =>
        token("spacing", `space-${step}`, "dimension", firstOnly(modes, `${px}px`)),
      );
    case "radius":
      return RADII.map(([size, raw, description]) =>
        token("radius", `radius-${size}`, "dimension", firstOnly(modes, raw), description),
      );
    case "shadows":
      return [
        token(
          "shadows",
          "shadow-raised",
          "shadow",
          modeValues(modes, {
            light: "0 1px 3px rgba(15, 23, 42, 0.1), 0 2px 8px rgba(15, 23, 42, 0.06)",
            dark: "0 1px 3px rgba(0, 0, 0, 0.45), 0 2px 8px rgba(0, 0, 0, 0.35)",
          }),
          "Cards that lift off the ground.",
        ),
        token(
          "shadows",
          "shadow-overlay",
          "shadow",
          modeValues(modes, {
            light: "0 4px 6px rgba(15, 23, 42, 0.06), 0 10px 24px rgba(15, 23, 42, 0.14)",
            dark: "0 4px 6px rgba(0, 0, 0, 0.4), 0 10px 24px rgba(0, 0, 0, 0.6)",
          }),
          "Layers that float above the page: menus, popovers and dialogs.",
        ),
      ];
  }
}

/** Every starter set at once, for the welcome sheet. */
export function starterKit(
  modes: DesignSystem["modes"],
  options: StarterOptions = {},
): DesignTokenEdit[] {
  return STARTER_KINDS.flatMap((kind) => starterTokens(kind, modes, options));
}
