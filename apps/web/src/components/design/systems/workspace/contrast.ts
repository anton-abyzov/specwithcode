/**
 * Contrast for text colors, as WCAG 2 measures it: relative luminance of
 * each color, see-through text composited over what it sits on. A text color
 * is one named ink, text, foreground or fg; on-X and X-foreground sit on X,
 * the rest on the mode's page ground. A see-through fill is laid over the
 * ground first. No opaque ground color, no check. Pure.
 */
import type { DesignSystem, DesignToken } from "@specweave-studio/contracts";

import { groundOf, isCssColor, modeValue, parseColor, shownValue, type Rgba } from "./tokenValues";

/** Body text needs 4.5:1; large text and controls 3:1. */
export const TEXT_RATIO = 4.5;
export const LARGE_RATIO = 3;

const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export function relativeLuminance({ r, g, b }: Pick<Rgba, "r" | "g" | "b">): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** `top` laid over an opaque `bottom`. */
function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/**
 * The ratio of a text color on a background, 1 to 21; null when either is not
 * hex or rgb(). A see-through background is laid over `backdrop` (white when
 * it is not given or not opaque).
 */
export function contrastRatio(text: string, background: string, backdrop?: string): number | null {
  const fg = parseColor(text);
  const bg = parseColor(background);
  if (fg === null || bg === null) return null;
  const under = backdrop === undefined ? null : parseColor(backdrop);
  const ground = bg.a >= 1 ? bg : over(bg, under !== null && under.a >= 1 ? under : WHITE);
  const lighter = relativeLuminance(over(fg, ground));
  const darker = relativeLuminance(ground);
  const [high, low] = lighter > darker ? [lighter, darker] : [darker, lighter];
  return (high + 0.05) / (low + 0.05);
}

/** "14.2:1"; whole numbers drop the decimal ("13:1"). */
export function ratioLabel(ratio: number): string {
  const rounded = Math.floor(ratio * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}:1`;
}

const TEXT_WORDS = new Set(["ink", "text", "foreground", "fg"]);
const FOREGROUND = new Set(["foreground", "fg"]);
/** Words before -foreground that say nothing about the fill (color-foreground sits on the ground). */
const GENERIC = new Set(["color", "colour", "colors", "text", "ink", "default", "base", "sys"]);

const words = (name: string) =>
  name
    .toLowerCase()
    .split(/[-_./]+/)
    .filter(Boolean);

export interface TextRole {
  /** `ground`, or the fill the text sits on. */
  readonly on: string;
  /** X-foreground with no X color falls back to the page ground. */
  readonly orGround?: boolean;
}

/** What a text color sits on: `ground`, the X of on-X or X-foreground, or null for a color that is not text. */
export function textRole(name: string): TextRole | null {
  const parts = words(name);
  const at = parts.lastIndexOf("on");
  if (at >= 0 && at < parts.length - 1) return { on: parts.slice(at + 1).join("-") };
  if (parts.length > 1 && FOREGROUND.has(parts.at(-1)!)) {
    const fill = parts.slice(0, -1).filter((part) => !GENERIC.has(part));
    if (fill.length > 0) return { on: fill.join("-"), orGround: true };
  }
  return parts.some((part) => TEXT_WORDS.has(part)) ? { on: "ground" } : null;
}

/**
 * The color token a text sits on: the same name without `on-` or `-foreground`,
 * else X itself or one ending in X. Text colors are never fills, so
 * `text-on-primary` sits on `primary`, not on `text-primary`.
 */
function fillFor(token: DesignToken, target: string, tokens: readonly DesignToken[]) {
  const colors = tokens.filter(
    (candidate) =>
      candidate.type === "color" && candidate !== token && textRole(candidate.name) === null,
  );
  const lower = token.name.toLowerCase();
  const direct = lower.replace(/(^|[-_./])on[-_./]/, "$1").replace(/[-_./](?:foreground|fg)$/, "");
  return (
    colors.find((candidate) => candidate.name.toLowerCase() === direct) ??
    colors.find((candidate) => candidate.name.toLowerCase() === target) ??
    colors.find((candidate) => candidate.name.toLowerCase().endsWith(`-${target}`))
  );
}

function paintIn(token: DesignToken, system: Pick<DesignSystem, "modes">, modeId: string) {
  const value = modeValue(token, system.modes, modeId);
  if (value === null) return null;
  const shown = shownValue(value);
  return isCssColor(shown) ? shown : null;
}

export interface ContrastCheck {
  readonly ratio: number;
  /** What it was measured against: "the ground" or a token name. */
  readonly against: string;
}

/** A text color's contrast in one mode, or null when it is not text or a color is unknown. */
export function tokenContrast(
  token: DesignToken,
  system: Pick<DesignSystem, "tokens" | "modes">,
  mode: { readonly id: string; readonly name: string },
): ContrastCheck | null {
  if (token.type !== "color") return null;
  const role = textRole(token.name);
  if (role === null) return null;
  const text = paintIn(token, system, mode.id);
  if (text === null) return null;
  // Only an opaque ground counts: a see-through one has no known color under it.
  const groundColor = groundOf(system, mode.id);
  const groundRgba = groundColor === null ? null : parseColor(groundColor);
  const ground = groundRgba !== null && groundRgba.a >= 1 ? groundColor : null;
  if (role.on !== "ground") {
    const fill = fillFor(token, role.on, system.tokens);
    // Only X-foreground with no X at all falls back to the ground; an unreadable X is no check.
    if (fill === undefined && role.orGround !== true) return null;
    if (fill !== undefined) {
      const background = paintIn(fill, system, mode.id);
      if (background === null) return null;
      // A see-through fill needs an opaque ground under it; without one there is no check.
      if ((parseColor(background)?.a ?? 1) < 1 && ground === null) return null;
      const ratio = contrastRatio(text, background, ground ?? undefined);
      return ratio === null ? null : { ratio, against: fill.name };
    }
  }
  const ratio = ground === null ? null : contrastRatio(text, ground);
  return ratio === null ? null : { ratio, against: "the page ground" };
}
