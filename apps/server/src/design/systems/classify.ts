/**
 * Token type and group from a token's name and value. Name hints win over the
 * value (`--font-mono` is a family even though its value is a plain list), and
 * the value decides the rest. Pure and deterministic.
 */
import type { DesignTokenType } from "@specweave-studio/contracts";

const NAMED_COLORS = new Set([
  "transparent",
  "currentcolor",
  "black",
  "white",
  "red",
  "green",
  "blue",
  "gray",
  "grey",
  "orange",
  "yellow",
  "purple",
  "pink",
  "teal",
  "navy",
  "silver",
  "maroon",
  "olive",
  "lime",
  "aqua",
  "fuchsia",
  "canvas",
  "canvastext",
]);

const COLOR_FUNCTION = /^(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color|color-mix|light-dark)\(/i;
const DIMENSION =
  /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|ch|ex|vh|vw|vmin|vmax|dvh|svh|lvh|%|pt|cqi|cqw)$/i;
const DURATION = /^-?(?:\d+\.?\d*|\.\d+)(?:ms|s)$/i;
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/;
const EASING =
  /^(?:ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|(?:cubic-bezier|steps|linear)\(.*\))$/i;
const SHADOW =
  /(?:^|,)\s*(?:inset\s+)?-?\d[\w.]*\s+-?\d[\w.]*(?:\s+-?\d[\w.]*){0,2}\s+(?:#|rgba?\(|hsla?\(|oklch\(|color-mix\(|var\()/i;

export const isColorValue = (value: string): boolean => {
  const trimmed = value.trim();
  return (
    /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(trimmed) ||
    COLOR_FUNCTION.test(trimmed) ||
    NAMED_COLORS.has(trimmed.toLowerCase())
  );
};

const segments = (name: string): string[] =>
  name
    .toLowerCase()
    .split(/[-_.\/]+/)
    .filter(Boolean);

export const inferTokenType = (name: string, value: string): DesignTokenType => {
  const parts = segments(name);
  const has = (...words: string[]) => parts.some((part) => words.includes(part));
  const trimmed = value.trim();
  if (has("shadow", "elevation", "elev")) return "shadow";
  if (has("duration", "delay", "stagger") && DURATION.test(trimmed)) return "duration";
  if (has("ease", "easing", "timing")) return "easing";
  if (has("weight") && NUMBER.test(trimmed)) return "fontWeight";
  if (
    has("font", "family", "typeface") &&
    !has("size", "weight") &&
    !DIMENSION.test(trimmed) &&
    !NUMBER.test(trimmed)
  ) {
    return "fontFamily";
  }
  if (isColorValue(trimmed)) return "color";
  if (DURATION.test(trimmed)) return "duration";
  if (EASING.test(trimmed)) return "easing";
  if (DIMENSION.test(trimmed)) return "dimension";
  if (NUMBER.test(trimmed))
    return trimmed === "0" && has("radius", "space", "gap") ? "dimension" : "number";
  if (SHADOW.test(trimmed)) return "shadow";
  if (has("color", "bg", "background", "foreground", "fg", "border", "fill", "stroke", "ink")) {
    return "color";
  }
  return "other";
};

const CATEGORY_BY_SEGMENT: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["color", ["color", "colour", "palette"]],
  ["type", ["font", "text", "weight", "tracking", "leading", "line-height", "type", "letter"]],
  ["spacing", ["space", "spacing", "gap", "inset", "gutter"]],
  ["radius", ["radius", "rounded", "corner"]],
  ["shadow", ["shadow", "elevation", "elev"]],
  ["motion", ["duration", "ease", "easing", "stagger", "motion", "transition", "animate", "delay"]],
  ["z-index", ["z", "layer", "zindex"]],
  ["layout", ["breakpoint", "bp", "screen", "measure", "page", "container", "layout"]],
];

const GROUP_BY_TYPE: Record<DesignTokenType, string> = {
  color: "color",
  dimension: "size",
  fontFamily: "type",
  fontWeight: "type",
  typography: "type",
  shadow: "shadow",
  duration: "motion",
  easing: "motion",
  number: "other",
  other: "other",
};

/** The prefix most names share (`wv-`), stripped before grouping. */
export const commonPrefix = (names: ReadonlyArray<string>): string => {
  if (names.length < 4) return "";
  const counts = new Map<string, number>();
  for (const name of names) {
    const match = /^([a-z0-9]+-)/i.exec(name);
    if (match) counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [prefix, count] of [...counts].sort(([left], [right]) => (left < right ? -1 : 1))) {
    if (count > bestCount) {
      best = prefix;
      bestCount = count;
    }
  }
  const isCategory = CATEGORY_BY_SEGMENT.some(([, words]) => words.includes(best.slice(0, -1)));
  return bestCount / names.length >= 0.8 && !isCategory ? best : "";
};

/**
 * Groups tokens by their first name segment after the shared prefix: known
 * categories (`color-`, `space-`, `radius-`), component families shared by at
 * least four tokens of mixed types (`chip-bg`, `chip-padding`), else by type.
 */
export const groupTokens = (
  tokens: ReadonlyArray<{ readonly name: string; readonly type: DesignTokenType }>,
): Map<string, string> => {
  const prefix = commonPrefix(tokens.map((token) => token.name));
  const firstSegment = (name: string) => {
    const rest = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
    return rest.toLowerCase().split(/[-_.]/)[0] ?? "";
  };
  const families = new Map<string, Set<DesignTokenType>>();
  const familySizes = new Map<string, number>();
  for (const token of tokens) {
    const segment = firstSegment(token.name);
    familySizes.set(segment, (familySizes.get(segment) ?? 0) + 1);
    const types = families.get(segment) ?? new Set();
    types.add(token.type);
    families.set(segment, types);
  }
  const groups = new Map<string, string>();
  for (const token of tokens) {
    const segment = firstSegment(token.name);
    const category = CATEGORY_BY_SEGMENT.find(([, words]) => words.includes(segment))?.[0];
    if (category) {
      groups.set(token.name, category);
    } else if ((familySizes.get(segment) ?? 0) >= 4 && (families.get(segment)?.size ?? 0) > 1) {
      groups.set(token.name, `component/${segment}`);
    } else {
      groups.set(token.name, GROUP_BY_TYPE[token.type]);
    }
  }
  return groups;
};
