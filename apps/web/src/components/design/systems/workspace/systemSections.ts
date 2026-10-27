/**
 * The design system page's sections, derived from the system's tokens: a
 * fixed head (Overview, Colors, Typography, Spacing, Corner radius, Shadows),
 * one Name/Value section per extra token family, then Components and Assets.
 * Files is a separate layer reached from the last nav row.
 *
 * Placement reads a token's `type` first (colors, type and shadows), then its
 * free-form `group`, then hints in its name. New tokens store their section in
 * `group`, so older servers keep them where people put them. Pure.
 */
import type { DesignSystem, DesignToken, DesignTokenType } from "@specweave-studio/contracts";

/** Section ids double as the URL hash (`#colors`, `#family-zIndex`). */
export type CoreSectionId =
  | "readme"
  | "colors"
  | "type"
  | "spacing"
  | "corners"
  | "shadows"
  | "components"
  | "assets";
export type SectionId = CoreSectionId | `family-${string}`;

export type SectionKind =
  | "overview"
  | "colors"
  | "typography"
  | "spacing"
  | "radius"
  | "shadows"
  | "family"
  | "components"
  | "assets";

/** Kinds that hold tokens, with the add dialog and the row tables. */
export type TokenSectionKind = Extract<
  SectionKind,
  "colors" | "typography" | "spacing" | "radius" | "shadows" | "family"
>;

export interface SystemSection {
  readonly id: SectionId;
  readonly kind: SectionKind;
  readonly title: string;
  /** Tokens shown here, in the system's order; empty for Overview, Components and Assets. */
  readonly tokens: readonly DesignToken[];
  /** `family` sections only: the camelCase key in the id (`zIndex`). */
  readonly familyKey?: string;
  /** The `group` a token added here gets. */
  readonly group: string;
  /** A core token section with nothing in it yet; editors see its empty state. */
  readonly starter: boolean;
}

const HEAD: ReadonlyArray<{ id: CoreSectionId; kind: SectionKind; title: string; group: string }> =
  [
    { id: "readme", kind: "overview", title: "Overview", group: "" },
    { id: "colors", kind: "colors", title: "Colors", group: "color" },
    { id: "type", kind: "typography", title: "Typography", group: "type" },
    { id: "spacing", kind: "spacing", title: "Spacing", group: "spacing" },
    { id: "corners", kind: "radius", title: "Corner radius", group: "radius" },
    { id: "shadows", kind: "shadows", title: "Shadows", group: "shadow" },
  ];

const TAIL: ReadonlyArray<{ id: CoreSectionId; kind: SectionKind; title: string }> = [
  { id: "components", kind: "components", title: "Components" },
  { id: "assets", kind: "assets", title: "Assets" },
];

/** Families with a known place in the order; any other follows in first-seen order. */
export const KNOWN_FAMILIES = [
  "duration",
  "easing",
  "breakpoint",
  "zIndex",
  "control",
  "opacity",
] as const;

// ---------------------------------------------------------------------------
// Keys and titles
// ---------------------------------------------------------------------------

/** `z-index` → `zIndex`, `font_size` → `fontSize`; only letters and digits stay. */
export function familyKeyOf(group: string): string {
  const words = group
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return "other";
  return words
    .map((word, index) =>
      index === 0
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join("");
}

/** `zIndex` → "Z index", `breakpoint` → "Breakpoint", `font-size` → "Font size". */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return spaced === "" ? "Other" : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ---------------------------------------------------------------------------
// Classifying one token
// ---------------------------------------------------------------------------

export type Placement =
  | { readonly kind: Exclude<TokenSectionKind, "family"> }
  | { readonly kind: "family"; readonly key: string };

const words = (name: string) =>
  name
    .toLowerCase()
    .split(/[-_.\/]+/)
    .filter(Boolean);

const GROUP_SECTIONS: Record<string, Exclude<TokenSectionKind, "family">> = {
  color: "colors",
  colors: "colors",
  colour: "colors",
  type: "typography",
  typography: "typography",
  font: "typography",
  spacing: "spacing",
  space: "spacing",
  radius: "radius",
  radii: "radius",
  corner: "radius",
  corners: "radius",
  shadow: "shadows",
  shadows: "shadows",
  elevation: "shadows",
};

const TYPE_SECTIONS: Partial<Record<DesignTokenType, Exclude<TokenSectionKind, "family">>> = {
  color: "colors",
  typography: "typography",
  fontFamily: "typography",
  fontWeight: "typography",
  shadow: "shadows",
};

/** Families read from a token's type and name when its group says nothing specific. */
function familyByType(token: Pick<DesignToken, "name" | "type">): Placement {
  const parts = words(token.name);
  const has = (...candidates: string[]) => parts.some((part) => candidates.includes(part));
  if (token.type === "duration") return { kind: "family", key: "duration" };
  if (token.type === "easing") return { kind: "family", key: "easing" };
  if (has("radius", "rounded", "corner", "corners")) return { kind: "radius" };
  if (has("space", "spacing", "gap", "gutter", "inset")) return { kind: "spacing" };
  if (has("breakpoint", "bp", "screen")) return { kind: "family", key: "breakpoint" };
  if (has("opacity", "alpha")) return { kind: "family", key: "opacity" };
  if (has("z", "zindex", "layer")) return { kind: "family", key: "zIndex" };
  if (token.type === "dimension") return { kind: "family", key: "size" };
  return { kind: "family", key: "other" };
}

/** Where a token is shown. */
export function placeToken(token: Pick<DesignToken, "name" | "type" | "group">): Placement {
  const byType = TYPE_SECTIONS[token.type];
  if (byType !== undefined) return { kind: byType };
  const group = (token.group ?? "").trim();
  const lower = group.toLowerCase();
  const section = GROUP_SECTIONS[lower];
  // A color group holding a non-color, or a shadow group holding a number, keeps its own family.
  if (section !== undefined && section !== "colors" && section !== "shadows")
    return { kind: section };
  if (lower === "" || lower === "other" || lower === "size" || section !== undefined)
    return familyByType(token);
  if (lower === "motion")
    return token.type === "duration" || token.type === "easing"
      ? familyByType(token)
      : { kind: "family", key: "motion" };
  if (lower === "layout") {
    const placed = familyByType(token);
    return placed.kind === "family" && placed.key === "breakpoint"
      ? placed
      : { kind: "family", key: "layout" };
  }
  if (lower.startsWith("component/") || lower === "component" || lower === "components")
    return { kind: "family", key: "control" };
  return { kind: "family", key: familyKeyOf(group) };
}

// ---------------------------------------------------------------------------
// Sections of a system
// ---------------------------------------------------------------------------

export function buildSections(system: Pick<DesignSystem, "tokens">): SystemSection[] {
  const byKind = new Map<string, DesignToken[]>();
  const families = new Map<string, DesignToken[]>();
  for (const token of system.tokens) {
    const placed = placeToken(token);
    if (placed.kind === "family") {
      const list = families.get(placed.key) ?? [];
      list.push(token);
      families.set(placed.key, list);
    } else {
      const list = byKind.get(placed.kind) ?? [];
      list.push(token);
      byKind.set(placed.kind, list);
    }
  }
  const head: SystemSection[] = HEAD.map(({ id, kind, title, group }) => {
    const tokens = byKind.get(kind) ?? [];
    return { id, kind, title, group, tokens, starter: kind !== "overview" && tokens.length === 0 };
  });
  const known = KNOWN_FAMILIES.filter((key) => families.has(key));
  const others = [...families.keys()].filter(
    (key) => !(KNOWN_FAMILIES as readonly string[]).includes(key),
  );
  const extra: SystemSection[] = [...known, ...others].map((key) => {
    const tokens = families.get(key) ?? [];
    const groups = new Set(tokens.map((token) => token.group ?? ""));
    const shared = groups.size === 1 ? [...groups][0]! : "";
    // New tokens join the group their neighbours share when it keeps them here; else the key.
    const placed = shared === "" ? null : placeToken({ ...tokens[0]!, group: shared });
    const keeps = placed !== null && placed.kind === "family" && placed.key === key;
    return {
      id: `family-${key}`,
      kind: "family",
      title: humanizeKey(key),
      familyKey: key,
      group: keeps ? shared : key,
      tokens,
      starter: false,
    };
  });
  const tail: SystemSection[] = TAIL.map(({ id, kind, title }) => ({
    id,
    kind,
    title,
    group: "",
    tokens: [],
    starter: false,
  }));
  return [...head, ...extra, ...tail];
}

/** Sections a viewer sees: empty core token sections only show their empty state to editors. */
export function visibleSections(
  sections: readonly SystemSection[],
  options: { readonly canEdit: boolean; readonly componentCount: number },
): SystemSection[] {
  return sections.filter((section) => {
    if (section.kind === "components") return options.canEdit || options.componentCount > 0;
    return options.canEdit || !section.starter;
  });
}

/** The id of a section's heading: its title, or the cover's name on Overview. */
export const sectionHeadingId = (id: SectionId) => `section-${id}-title`;

export function isSectionId(value: string): value is SectionId {
  return (
    HEAD.some((entry) => entry.id === value) ||
    TAIL.some((entry) => entry.id === value) ||
    /^family-[A-Za-z0-9]+$/.test(value)
  );
}

// ---------------------------------------------------------------------------
// Groups inside a section, derived from names
// ---------------------------------------------------------------------------

export interface TokenGroup {
  /** The name prefix without its trailing hyphen; "" for Palette. */
  readonly key: string;
  readonly label: string;
  readonly tokens: readonly DesignToken[];
}

export const PALETTE_LABEL = "Palette";

/** The longest `<segments>-` prefix every name shares, leaving something after it. */
export function sharedPrefix(names: readonly string[]): string {
  if (names.length < 2) return "";
  const first = names[0]!.split("-");
  for (let count = first.length - 1; count > 0; count -= 1) {
    const prefix = `${first.slice(0, count).join("-")}-`;
    if (names.every((name) => name.startsWith(prefix) && name.length > prefix.length))
      return prefix;
  }
  return "";
}

/**
 * Groups by name, as the reference page does for colors: strip the prefix every
 * name shares, group by the first hyphen segment, keep a numbered scale
 * (`blue-gray-100`, `blue-gray-200`) under its stem, and put names without a
 * hyphen under Palette unless they name a group of their own.
 */
export function groupTokensByName(tokens: readonly DesignToken[]): TokenGroup[] {
  const prefix = sharedPrefix(tokens.map((token) => token.name));
  const rest = (name: string) => name.slice(prefix.length);
  const stems = new Map<string, number>();
  for (const token of tokens) {
    const match = /^(.+)-\d+$/.exec(rest(token.name));
    if (match) stems.set(match[1]!, (stems.get(match[1]!) ?? 0) + 1);
  }
  const keyOf = (name: string): string => {
    const tail = rest(name);
    const match = /^(.+)-\d+$/.exec(tail);
    if (match && (stems.get(match[1]!) ?? 0) >= 2) return match[1]!;
    const dash = tail.indexOf("-");
    return dash > 0 ? tail.slice(0, dash) : "";
  };
  const keys = tokens.map((token) => keyOf(token.name));
  const named = new Set(keys.filter((key) => key !== ""));
  const groups = new Map<string, DesignToken[]>();
  tokens.forEach((token, index) => {
    let key = keys[index]!;
    // `surface` sits with `surface-2` rather than alone under Palette.
    if (key === "" && named.has(rest(token.name))) key = rest(token.name);
    const list = groups.get(key) ?? [];
    list.push(token);
    groups.set(key, list);
  });
  return [...groups].map(([key, list]) => ({
    key,
    label: key === "" ? PALETTE_LABEL : key,
    tokens: list,
  }));
}

/** The prefix `groupTokensByName` stripped, so a new name can be built the same way. */
export function groupNamePrefix(tokens: readonly DesignToken[]): string {
  return sharedPrefix(tokens.map((token) => token.name));
}

// ---------------------------------------------------------------------------
// Typography parts
// ---------------------------------------------------------------------------

export interface TypographyParts {
  /** Composite styles, in sets by name. */
  readonly sets: readonly TokenGroup[];
  readonly families: readonly DesignToken[];
  readonly weights: readonly DesignToken[];
  /** Sizes, line heights and anything else filed under type. */
  readonly other: readonly DesignToken[];
}

export function typographyParts(tokens: readonly DesignToken[]): TypographyParts {
  const styles = tokens.filter((token) => token.type === "typography");
  const groups = groupTokensByName(styles);
  return {
    sets:
      groups.length === 1
        ? [{ ...groups[0]!, label: "Styles" }]
        : groups.map((group) => ({ ...group, label: humanizeKey(group.label) })),
    families: tokens.filter((token) => token.type === "fontFamily"),
    weights: tokens.filter((token) => token.type === "fontWeight"),
    other: tokens.filter(
      (token) =>
        token.type !== "typography" && token.type !== "fontFamily" && token.type !== "fontWeight",
    ),
  };
}

// ---------------------------------------------------------------------------
// Nav search
// ---------------------------------------------------------------------------

export interface SectionMatch {
  readonly section: SystemSection;
  /** Token or component names under the section that contain the query. */
  readonly items: readonly string[];
}

export interface SectionSearch {
  readonly matches: readonly SectionMatch[];
  /** Items found before the per-section cap. */
  readonly total: number;
  /** Items listed. */
  readonly shown: number;
}

const ITEMS_PER_SECTION = 6;

/** Sections whose title or items contain the query; items are capped per section. */
export function searchSections(
  sections: readonly SystemSection[],
  query: string,
  componentNames: readonly string[] = [],
): SectionSearch {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "")
    return { matches: sections.map((section) => ({ section, items: [] })), total: 0, shown: 0 };
  let total = 0;
  let shown = 0;
  const matches: SectionMatch[] = [];
  for (const section of sections) {
    const names =
      section.kind === "components" ? componentNames : section.tokens.map((token) => token.name);
    const found = names.filter((name) => name.toLocaleLowerCase().includes(needle));
    const titleMatch = section.title.toLocaleLowerCase().includes(needle);
    if (!titleMatch && found.length === 0) continue;
    const items = found.slice(0, ITEMS_PER_SECTION);
    total += found.length;
    shown += items.length;
    matches.push({ section, items });
  }
  return { matches, total, shown };
}
