/**
 * Reading, checking and writing token values on the design system page:
 * colors with alpha, aliases, lengths, shadows, typography shorthand and the
 * names people type. Messages are the sentences the page shows. Pure.
 */
import type { DesignSystem, DesignToken, DesignTokenType } from "@specweave-studio/contracts";
import {
  designTokenAlias,
  designTokensCss,
  safeCssValue,
} from "@specweave-studio/shared/designRender";

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const TOKEN_NAME = /^[A-Za-z0-9._-]+$/;

/** Why a name cannot be used, or null. `current` is the token being renamed. */
export function tokenNameProblem(
  name: string,
  existing: readonly string[],
  current: string | null = null,
): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "A token needs a name.";
  if (!TOKEN_NAME.test(trimmed) || trimmed.length > 200)
    return `“${trimmed}” is not a token name — letters, digits, . _ and - only.`;
  if (trimmed !== current && existing.includes(trimmed)) return `“${trimmed}” already exists.`;
  return null;
}

// ---------------------------------------------------------------------------
// Values per mode
// ---------------------------------------------------------------------------

/** The raw value a token holds in a mode, and whether it is inherited from the first mode. */
export function modeValue(
  token: DesignToken,
  modes: DesignSystem["modes"],
  modeId: string,
): { readonly raw: string; readonly resolved: string | null; readonly inherited: boolean } | null {
  const own = token.values[modeId];
  if (own !== undefined) return { raw: own.raw, resolved: own.resolved, inherited: false };
  const base = baseValue(token, modes);
  if (base === null) return null;
  return { ...base, inherited: modes[0]?.id !== modeId };
}

/** The first mode's value, falling back to `default` or the only value a token has. */
export function baseValue(
  token: DesignToken,
  modes: DesignSystem["modes"],
): { readonly raw: string; readonly resolved: string | null } | null {
  const first = modes[0]?.id;
  const value =
    (first === undefined ? undefined : token.values[first]) ??
    token.values.default ??
    Object.values(token.values)[0];
  return value === undefined ? null : { raw: value.raw, resolved: value.resolved };
}

/** The value to paint or measure: resolved when the server could, else as written. */
export const shownValue = (value: { raw: string; resolved: string | null }) =>
  value.resolved ?? value.raw;

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

/** `{brand-500}` or `var(--brand-500)` names another token. */
export const aliasTarget = designTokenAlias;

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0 to 1. */
  readonly a: number;
}

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
const clampUnit = (value: number) => Math.max(0, Math.min(1, value));

/** Hex and `rgb()`/`rgba()` colors; other color spaces are kept as written. */
export function parseColor(value: string): Rgba | null {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex) {
    let digits = hex[1]!;
    if (digits.length <= 4) digits = [...digits].map((digit) => digit + digit).join("");
    const byte = (index: number) => Number.parseInt(digits.slice(index, index + 2), 16);
    return {
      r: byte(0),
      g: byte(2),
      b: byte(4),
      a: digits.length === 8 ? Math.round((byte(6) / 255) * 100) / 100 : 1,
    };
  }
  const fn = /^rgba?\(\s*([^)]*)\)$/.exec(text);
  if (fn === null) return null;
  const parts = fn[1]!
    .replace(/\s*\/\s*/, " / ")
    .split(/[\s,]+/)
    .filter((part) => part !== "" && part !== "/");
  if (parts.length < 3 || parts.length > 4) return null;
  const channel = (part: string) =>
    part.endsWith("%") ? (Number(part.slice(0, -1)) / 100) * 255 : Number(part);
  const [r, g, b] = parts.slice(0, 3).map(channel);
  const alphaPart = parts[3];
  const a =
    alphaPart === undefined
      ? 1
      : alphaPart.endsWith("%")
        ? Number(alphaPart.slice(0, -1)) / 100
        : Number(alphaPart);
  if (![r, g, b, a].every((number) => Number.isFinite(number))) return null;
  return { r: clampByte(r!), g: clampByte(g!), b: clampByte(b!), a: clampUnit(a) };
}

const hexByte = (value: number) => clampByte(value).toString(16).padStart(2, "0");

/** `#0F141E` for display. */
export function hexOf(color: Pick<Rgba, "r" | "g" | "b">): string {
  return `#${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}`.toUpperCase();
}

/** What a color field stores: `#rrggbb`, or `rgba(r, g, b, a)` when not opaque. */
export function formatColor(color: Rgba): string {
  if (color.a >= 1) return `#${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}`;
  const alpha = Math.round(clampUnit(color.a) * 100) / 100;
  return `rgba(${clampByte(color.r)}, ${clampByte(color.g)}, ${clampByte(color.b)}, ${alpha})`;
}

/** A cell's text: the hex value with its alpha as a percentage, or the value as written. */
export function colorLabel(value: string): {
  readonly text: string;
  readonly alpha: string | null;
} {
  const color = parseColor(value);
  if (color === null) return { text: value.trim(), alpha: null };
  return { text: hexOf(color), alpha: color.a < 1 ? `${Math.round(color.a * 100)}%` : null };
}

const COLOR_FUNCTION =
  /^(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color|color-mix|light-dark)\([-+0-9.%a-z\s,/#()]*\)$/i;
const NAMED_COLORS = new Set(["transparent", "currentcolor", "black", "white"]);

/** A paintable CSS color, never anything that loads (`url(`). */
export function isCssColor(value: string): boolean {
  const text = value.trim();
  if (text.length === 0 || text.length > 300 || safeCssValue(text) === undefined) return false;
  return (
    /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text) ||
    COLOR_FUNCTION.test(text) ||
    NAMED_COLORS.has(text.toLowerCase())
  );
}

/** Why a color value is not accepted, or null. */
export function colorProblem(
  raw: string,
  self: string,
  colorNames: readonly string[],
): string | null {
  const text = raw.trim();
  if (text === "") return "A color is needed.";
  const target = aliasTarget(text);
  if (target !== null) {
    if (target === self) return "A token cannot alias itself.";
    return colorNames.includes(target) ? null : `${target} names no color token.`;
  }
  return isCssColor(text) ? null : "Not a color — try #rrggbb, rgb(), oklch() or {token}.";
}

// ---------------------------------------------------------------------------
// Lengths, shadows and plain values
// ---------------------------------------------------------------------------

const LENGTH = /^(?:0|(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%))$/i;

/** Spacing and corner radius: a non-negative length or an alias. */
export function lengthProblem(raw: string): string | null {
  const text = raw.trim();
  if (text === "" || (!LENGTH.test(text) && aliasTarget(text) === null))
    return "Not a length — try 8px or 0.5rem.";
  return null;
}

const SHADOW_LENGTH = String.raw`-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em)?`;
const SHADOW_LAYER = new RegExp(
  String.raw`^(?:inset\s+)?(?:(?:\S+\([^)]*\)|#[0-9a-f]{3,8}|[a-z]+)\s+)?${SHADOW_LENGTH}\s+${SHADOW_LENGTH}(?:\s+${SHADOW_LENGTH}){0,2}(?:\s+(?:inset\s+)?(?:\S+\(.*\)|#[0-9a-f]{3,8}|[a-z]+))?(?:\s+inset)?$`,
  "i",
);

/** Splits on commas outside parentheses. */
function topLevelParts(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim());
}

export function shadowProblem(raw: string): string | null {
  const text = raw.trim();
  if (text === "") return "A box-shadow is needed.";
  const valid =
    safeCssValue(text) !== undefined &&
    (text.toLowerCase() === "none" ||
      aliasTarget(text) !== null ||
      topLevelParts(text).every((layer) => SHADOW_LAYER.test(layer)));
  return valid ? null : "Not a box-shadow — try 0 1px 2px rgba(0,0,0,.2).";
}

/** Extra families accept any plain CSS value. */
export function plainValueProblem(raw: string): string | null {
  const text = raw.trim();
  if (text === "" || text.length > 2_000 || safeCssValue(text) === undefined)
    return "Not a plain CSS value.";
  return null;
}

/** A type for a value typed into an extra family; the section's group keeps it in place. */
export function inferValueType(raw: string): DesignTokenType {
  const text = raw.trim();
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:ms|s)$/i.test(text)) return "duration";
  if (/^(?:ease|ease-in|ease-out|ease-in-out|linear|cubic-bezier\(.*\)|steps\(.*\))$/i.test(text))
    return "easing";
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|ch|vh|vw|%)$/i.test(text)) return "dimension";
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) return "number";
  if (isCssColor(text)) return "color";
  return "other";
}

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

export const WEIGHT_NAMES: ReadonlyArray<readonly [number, string]> = [
  [100, "Thin"],
  [200, "Extra light"],
  [300, "Light"],
  [400, "Regular"],
  [500, "Medium"],
  [600, "Semibold"],
  [700, "Bold"],
  [800, "Heavy"],
  [900, "Black"],
];

export function weightName(weight: number): string {
  return WEIGHT_NAMES.find(([value]) => value === weight)?.[1] ?? String(weight);
}

export interface TypeStyle {
  readonly italic: boolean;
  readonly weight: number;
  /** As written (`15px`, `1rem`). */
  readonly size: string;
  /** As written (`1.5`, `24px`), or null when the shorthand has none. */
  readonly lineHeight: string | null;
  /** The family list as written, possibly `var(--font-sans)`. */
  readonly family: string;
}

const TYPE_SHORTHAND =
  /^(?:(italic|oblique|normal)\s+)?(?:(normal|bold|lighter|bolder|\d{3})\s+)?((?:\d+\.?\d*|\.\d+)(?:px|rem|em|%|pt)?)(?:\s*\/\s*((?:\d+\.?\d*|\.\d+)(?:px|rem|em|%)?|normal))?\s+(.+)$/i;

/** `600 24px/1.25 var(--font-sans)`, the CSS `font` shorthand typography tokens hold. */
export function parseTypeStyle(raw: string): TypeStyle | null {
  const match = TYPE_SHORTHAND.exec(raw.trim());
  if (match === null) return null;
  const weightText = (match[2] ?? "400").toLowerCase();
  const weight =
    weightText === "bold" ? 700 : weightText === "normal" ? 400 : Number(weightText) || 400;
  return {
    italic: (match[1] ?? "").toLowerCase() === "italic" || (match[1] ?? "") === "oblique",
    weight,
    size: match[3]!,
    lineHeight: match[4] === undefined || match[4] === "normal" ? null : match[4],
    family: match[5]!.trim(),
  };
}

export function formatTypeStyle(style: TypeStyle): string {
  const size = style.lineHeight === null ? style.size : `${style.size}/${style.lineHeight}`;
  return [style.italic ? "italic" : null, String(style.weight), size, style.family]
    .filter((part) => part !== null)
    .join(" ");
}

/** A font size in px: plain numbers and px as is, rem and em at 16 px. */
export function sizeInPx(size: string): number | null {
  const match = /^((?:\d+\.?\d*|\.\d+))(px|rem|em|pt)?$/i.exec(size.trim());
  if (match === null) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "px").toLowerCase();
  return unit === "rem" || unit === "em" ? amount * 16 : unit === "pt" ? (amount * 4) / 3 : amount;
}

/** "16" becomes "16px"; anything else is kept for the size check. */
export function normalizeSize(input: string): string {
  const text = input.trim();
  return /^(?:\d+\.?\d*|\.\d+)$/.test(text) ? `${text}px` : text;
}

export function sizeProblem(input: string): string | null {
  return sizeInPx(normalizeSize(input)) === null ? "Not a size — try 16 or 1rem." : null;
}

export function lineHeightProblem(input: string): string | null {
  const text = input.trim();
  return text === "" || /^(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%)?$/i.test(text)
    ? null
    : "Not a line height — try 1.5 or 24px.";
}

export function trackingProblem(input: string): string | null {
  const text = input.trim();
  return text === "" || /^(?:0|-?(?:\d+\.?\d*|\.\d+)(?:px|em|rem))$/i.test(text)
    ? null
    : "Not a length — try 0.2px or -0.01em.";
}

/**
 * Letter spacing is not part of the `font` shorthand; imports write it into the
 * usage note as "Letter spacing 0.06em.", so the page reads and writes it there.
 */
const TRACKING_NOTE = /\s*Letter spacing (-?[0-9.]+(?:px|em|rem)?)\.\s*/;

export function trackingOf(description: string | undefined): string | null {
  return TRACKING_NOTE.exec(description ?? "")?.[1] ?? null;
}

export function withTracking(description: string | undefined, tracking: string | null): string {
  const rest = (description ?? "").replace(TRACKING_NOTE, " ").trim();
  if (tracking === null || tracking.trim() === "" || /^0(?:px|em|rem)?$/.test(tracking.trim()))
    return rest;
  return [rest, `Letter spacing ${tracking.trim()}.`].filter(Boolean).join(" ");
}

/** The usage note without the letter spacing sentence, for the notes popover. */
export function noteWithoutTracking(description: string | undefined): string {
  return withTracking(description, null);
}

/** Resolves `var(--font-sans)` through the system's tokens, one level deep at a time. */
export function resolveFamily(family: string, tokens: readonly DesignToken[], depth = 0): string {
  const target = aliasTarget(family);
  if (target === null || depth > 4) return family;
  const token = tokens.find((candidate) => candidate.name === target);
  const value = token === undefined ? undefined : Object.values(token.values)[0];
  if (value === undefined) return family;
  return resolveFamily(value.resolved ?? value.raw, tokens, depth + 1);
}

/** "Inter Variable" from `"Inter Variable", system-ui, sans-serif`. */
export function familyLabel(stack: string): string {
  const first = topLevelParts(stack)[0] ?? stack;
  return first.replace(/^["']|["']$/g, "").trim() || stack;
}

/** A family list that is safe in a style attribute, or null. */
export function safeFamily(stack: string): string | null {
  const value = safeCssValue(stack);
  return value === undefined || value === "" || /var\(/i.test(value) ? null : value;
}

/** "11" for 11px, "1rem" otherwise; the chip under each preview. */
export function sizeLabel(size: string): string {
  return /^(?:\d+\.?\d*|\.\d+)px$/i.test(size) ? size.slice(0, -2) : size;
}

// ---------------------------------------------------------------------------
// Shadow stages
// ---------------------------------------------------------------------------

const GROUND_NAMES = [
  /(?:^|-)ground$/,
  /(?:^|-)bg-100$/,
  /(?:^|-)background$/,
  /(?:^|-)page$/,
  /(?:^|-)canvas$/,
  /(?:^|-)surface-1$/,
];
const SURFACE_NAMES = [
  /(?:^|-)bg-0$/,
  /(?:^|-)surface$/,
  /(?:^|-)card$/,
  /(?:^|-)panel$/,
  /(?:^|-)raised$/,
];

const isDarkMode = (mode: { id: string; name: string }) =>
  /dark|night/i.test(mode.id) || /dark|night/i.test(mode.name);

function colorByNames(
  tokens: readonly DesignToken[],
  patterns: readonly RegExp[],
  modes: DesignSystem["modes"],
  modeId: string,
): string | null {
  const colors = tokens.filter((token) => token.type === "color");
  for (const pattern of patterns) {
    for (const token of colors) {
      if (!pattern.test(token.name.toLowerCase())) continue;
      const value = modeValue(token, modes, modeId);
      if (value === null) continue;
      const shown = shownValue(value);
      if (isCssColor(shown)) return shown;
    }
  }
  return null;
}

/** The page ground and the card color a shadow is shown on, per mode, with neutral fallbacks. */
export function shadowStage(
  system: Pick<DesignSystem, "tokens" | "modes">,
  mode: { id: string; name: string },
): { readonly ground: string; readonly surface: string } {
  const dark = isDarkMode(mode);
  return {
    ground:
      colorByNames(system.tokens, GROUND_NAMES, system.modes, mode.id) ??
      (dark ? "#1f1e1d" : "#f0eee6"),
    surface:
      colorByNames(system.tokens, SURFACE_NAMES, system.modes, mode.id) ??
      (dark ? "#30302e" : "#ffffff"),
  };
}

// ---------------------------------------------------------------------------
// Token CSS for component previews
// ---------------------------------------------------------------------------

/** `:root{--name:value}` for one mode; shared with the canvas and exports. */
export const tokensCss = designTokensCss;
