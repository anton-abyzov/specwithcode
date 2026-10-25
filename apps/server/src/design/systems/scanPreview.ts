/**
 * A preview of what importing a scan suggestion would give, read in memory.
 *
 * The suggestion's token files go through the same extraction a proposal
 * uses (references resolved, modes merged), with no folder listing and one
 * read budget for all previews. Component barrels and folders are not parsed
 * again: their counts come from the scan. Nothing is written and no proposal
 * is kept.
 */
import {
  DESIGN_SYSTEM_PREVIEW_MAX_SOURCES,
  DESIGN_SYSTEM_PREVIEW_MAX_SWATCHES,
  type DesignSystemCandidate,
  type DesignSystemPreviewSource,
  type DesignSystemPreviewSwatch,
  type DesignSystemScanResult,
  type DesignSystemSuggestion,
  type DesignSystemSuggestionPreview,
  type DesignToken,
} from "@specweave-studio/contracts";

import { compareText } from "./common.ts";
import { extractFromCode } from "./proposal.ts";
import { ReadBudget } from "./scanCandidates.ts";

/** Suggestions a scan previews when asked, strongest first. */
export const PREVIEW_SUGGESTIONS = 3;

const NOT_PAINTABLE =
  /^(?:transparent|currentcolor|inherit|initial|unset|revert|revert-layer|none)$/i;
const CSS_COLOR =
  /^(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(.*\)|[a-z]+)$/is;

/** A resolved value a browser can paint as a swatch, or null. */
export const swatchColor = (value: string | null | undefined): string | null => {
  const text = value?.trim();
  if (!text || text.length > 200 || text.includes("var(") || NOT_PAINTABLE.test(text)) return null;
  return CSS_COLOR.test(text) ? text : null;
};

/** Roles a swatch row should show, one each before any repeats. */
const SWATCH_ROLES = [
  /brand|primary/,
  /accent/,
  /background|\bbg\b|ground|canvas/,
  /surface|card|panel/,
  /ink|text|foreground|\bfg\b/,
  /muted|subtle/,
  /border|line|divider/,
  /success|positive/,
  /warning|caution/,
  /danger|error|destructive|negative/,
];
/** Component-scoped colors (`btn-`, `chip-`) say less about the system than its own. */
const COMPONENT_SCOPED =
  /^(?:btn|button|chip|pill|card|badge|tabs?|nav|input|field|row|cell|tooltip|modal|dialog|menu|table|toast)-/;

const roleOf = (name: string) => {
  const index = SWATCH_ROLES.findIndex((role) => role.test(name));
  return index === -1 ? SWATCH_ROLES.length : index;
};

/**
 * Up to eight color tokens with paintable values: the light (or only) mode
 * as `value`, the dark mode as `darkValue`. One per role first (brand,
 * accent, background, surface, text ...), then the rest, never the same
 * color twice.
 */
export const pickSwatches = (tokens: ReadonlyArray<DesignToken>): DesignSystemPreviewSwatch[] => {
  const swatches: DesignSystemPreviewSwatch[] = [];
  for (const token of tokens) {
    if (token.type !== "color") continue;
    const light =
      token.values["light"] ??
      token.values["default"] ??
      Object.entries(token.values)
        .sort(([left], [right]) => compareText(left, right))
        .find(([mode]) => mode !== "dark")?.[1];
    const value = swatchColor(light?.resolved);
    if (value === null) continue;
    const darkValue = swatchColor(token.values["dark"]?.resolved);
    swatches.push({ name: token.name, value, ...(darkValue ? { darkValue } : {}) });
  }
  // The system's own, shortest names first: `color-ink` before `pitch-ink-muted`.
  const plainFirst = (left: DesignSystemPreviewSwatch, right: DesignSystemPreviewSwatch) =>
    Number(COMPONENT_SCOPED.test(left.name)) - Number(COMPONENT_SCOPED.test(right.name)) ||
    Number(!/colou?r/.test(left.name)) - Number(!/colou?r/.test(right.name)) ||
    left.name.split("-").length - right.name.split("-").length ||
    left.name.length - right.name.length ||
    compareText(left.name, right.name);
  const picked: DesignSystemPreviewSwatch[] = [];
  const colors = new Set<string>();
  const take = (swatch: DesignSystemPreviewSwatch | undefined) => {
    if (!swatch || picked.length >= DESIGN_SYSTEM_PREVIEW_MAX_SWATCHES) return;
    picked.push(swatch);
    colors.add(swatch.value.toLowerCase());
  };
  const fresh = (swatch: DesignSystemPreviewSwatch) =>
    !picked.includes(swatch) && !colors.has(swatch.value.toLowerCase());
  for (const role of SWATCH_ROLES)
    take(swatches.filter((swatch) => role.test(swatch.name) && fresh(swatch)).sort(plainFirst)[0]);
  const rest = swatches.sort(
    (left, right) => roleOf(left.name) - roleOf(right.name) || plainFirst(left, right),
  );
  for (const swatch of rest) if (fresh(swatch)) take(swatch);
  return picked;
};

export const previewSuggestion = async (
  realRoot: string,
  suggestion: Pick<DesignSystemSuggestion, "paths">,
  candidates: ReadonlyMap<string, DesignSystemCandidate>,
  budget: ReadBudget = new ReadBudget(),
): Promise<DesignSystemSuggestionPreview> => {
  const own = suggestion.paths.flatMap((path) => candidates.get(path) ?? []);
  const tokenFiles = own.filter((candidate) => candidate.kind !== "components");
  const extraction =
    tokenFiles.length > 0
      ? (
          await extractFromCode(
            realRoot,
            tokenFiles.map((candidate) => candidate.path),
            { folders: new Map(), budget },
          )
        ).extraction
      : null;
  const classes = extraction?.components ?? [];
  const componentsIn = (candidate: DesignSystemCandidate) =>
    candidate.kind === "components"
      ? candidate.componentCount
      : classes.filter((component) => component.provenance.location === candidate.path).length;
  const modeIds = extraction
    ? extraction.modes.map((mode) => mode.id)
    : [...new Set(own.flatMap((candidate) => candidate.modes))].sort(compareText);
  const sources: DesignSystemPreviewSource[] = own
    .map((candidate) => ({
      path: candidate.path,
      kind: candidate.kind,
      tokens: candidate.tokenCount,
      components: componentsIn(candidate),
    }))
    .sort(
      (left, right) =>
        right.tokens + right.components - (left.tokens + left.components) ||
        compareText(left.path, right.path),
    );
  return {
    tokens: extraction?.tokens.length ?? 0,
    components:
      own
        .filter((candidate) => candidate.kind === "components")
        .reduce((sum, candidate) => sum + candidate.componentCount, 0) + classes.length,
    // `default` holds base values; next to light and dark it is not a mode to show.
    modes: modeIds.length > 1 ? modeIds.filter((id) => id !== "default") : modeIds,
    swatches: pickSwatches(extraction?.tokens ?? []),
    sources: sources.slice(0, DESIGN_SYSTEM_PREVIEW_MAX_SOURCES),
  };
};

/** Previews of the strongest suggestions with paths, by key. One that cannot be read is left out. */
export const previewScan = async (
  realRoot: string,
  scan: DesignSystemScanResult,
  count = PREVIEW_SUGGESTIONS,
): Promise<Map<string, DesignSystemSuggestionPreview>> => {
  const candidates = new Map(scan.candidates.map((candidate) => [candidate.path, candidate]));
  const budget = new ReadBudget();
  const previews = new Map<string, DesignSystemSuggestionPreview>();
  for (const suggestion of scan.suggestions
    .filter((suggestion) => suggestion.paths.length > 0)
    .slice(0, count)) {
    try {
      previews.set(
        suggestion.key,
        await previewSuggestion(realRoot, suggestion, candidates, budget),
      );
    } catch {
      // The suggestion stays without a preview.
    }
  }
  return previews;
};
