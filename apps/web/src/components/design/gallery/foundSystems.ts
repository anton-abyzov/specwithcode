/**
 * Design systems a project's repository already has, as the creation dialogs
 * offer them before anyone imports one: what a read-only scan found, best
 * first, with counts, modes, a few swatches and the files they came from.
 */
import type {
  DesignSystemCandidate,
  DesignSystemScanResult,
  DesignSystemSuggestion,
} from "@specweave-studio/contracts";

export interface FoundSystemSource {
  readonly path: string;
  readonly tokens: number;
  readonly components: number;
}

export interface FoundSwatch {
  readonly name: string;
  readonly value: string;
  readonly darkValue?: string;
}

export interface FoundSystem {
  /** The scan's suggestion key; stable for one repository. */
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  /** The files a proposal reads (the scan's preselected candidates). */
  readonly paths: readonly string[];
  readonly sources: readonly FoundSystemSource[];
  readonly tokens: number;
  readonly components: number;
  readonly modes: readonly string[];
  readonly swatches: readonly FoundSwatch[];
  /** Copies of these files elsewhere in the repository, for the record. */
  readonly copies: readonly string[];
}

/** What servers from 1.0.76 add to a suggestion when the scan asks for a preview. */
interface SuggestionPreview {
  readonly tokens: number;
  readonly components: number;
  readonly modes: readonly string[];
  readonly swatches: readonly FoundSwatch[];
  readonly sources: readonly FoundSystemSource[];
}

const previewOf = (suggestion: DesignSystemSuggestion): SuggestionPreview | null =>
  (suggestion as DesignSystemSuggestion & { readonly preview?: SuggestionPreview }).preview ?? null;

const MAX_FOUND = 4;

/**
 * The scan's suggestions that hold something, in the scan's order (best
 * first). Without a preview the counts are the candidates' own, which a
 * proposal may refine.
 */
export function foundSystemsFromScan(result: DesignSystemScanResult): FoundSystem[] {
  const byKey = new Map<string, DesignSystemCandidate[]>();
  for (const candidate of result.candidates) {
    const list = byKey.get(candidate.suggestion) ?? [];
    list.push(candidate);
    byKey.set(candidate.suggestion, list);
  }
  const found: FoundSystem[] = [];
  for (const suggestion of result.suggestions) {
    if (suggestion.paths.length === 0) continue;
    const preview = previewOf(suggestion);
    const chosen = (byKey.get(suggestion.key) ?? []).filter((candidate) =>
      suggestion.paths.includes(candidate.path),
    );
    const sources =
      preview?.sources ??
      chosen.map((candidate) => ({
        path: candidate.path,
        tokens: candidate.tokenCount,
        components: candidate.componentCount,
      }));
    const tokens = preview?.tokens ?? sum(chosen, (candidate) => candidate.tokenCount);
    const components = preview?.components ?? sum(chosen, (candidate) => candidate.componentCount);
    if (tokens === 0 && components === 0) continue;
    found.push({
      key: suggestion.key,
      name: suggestion.name,
      description: suggestion.description ?? null,
      paths: suggestion.paths,
      sources,
      tokens,
      components,
      modes: preview?.modes ?? [...new Set(chosen.flatMap((candidate) => candidate.modes))],
      swatches: preview?.swatches ?? [],
      copies: suggestion.copies,
    });
    if (found.length >= MAX_FOUND) break;
  }
  return found;
}

const sum = <A>(items: readonly A[], of: (item: A) => number) =>
  items.reduce((total, item) => total + of(item), 0);

/** "317 tokens · 321 components · light, dark" */
export function foundSystemSummary(found: Pick<FoundSystem, "tokens" | "components" | "modes">) {
  return [
    found.tokens > 0 ? plural(found.tokens, "token") : null,
    found.components > 0 ? plural(found.components, "component") : null,
    found.modes.length > 0 ? found.modes.slice(0, 3).join(", ") : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** The folder the system lives in: the longest folder its sources share. */
export function foundSystemFolder(found: Pick<FoundSystem, "sources" | "paths">): string {
  const paths = found.sources.length > 0 ? found.sources.map((source) => source.path) : found.paths;
  if (paths.length === 0) return "";
  const split = paths.map((path) => path.split("/").slice(0, -1));
  const shared: string[] = [];
  for (let index = 0; index < split[0]!.length; index += 1) {
    const segment = split[0]![index]!;
    if (!split.every((parts) => parts[index] === segment)) break;
    shared.push(segment);
  }
  // A package's `src/...` reads better as the package folder.
  const src = shared.lastIndexOf("src");
  return (src > 0 ? shared.slice(0, src) : shared).join("/") || paths[0]!;
}

const plural = (count: number, noun: string) =>
  `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;

/** "283 tokens, 321 components, light and dark modes" for the dialogs. */
export function foundSystemFacts(found: Pick<FoundSystem, "tokens" | "components" | "modes">) {
  const modes = found.modes.slice(0, 3);
  return [
    found.tokens > 0 ? plural(found.tokens, "token") : null,
    found.components > 0 ? plural(found.components, "component") : null,
    modes.length === 0
      ? null
      : modes.length === 1
        ? `${modes[0]} mode`
        : `${modes.slice(0, -1).join(", ")} and ${modes.at(-1)} modes`,
  ]
    .filter((part) => part !== null)
    .join(", ");
}

// A repository's color value is shown, never interpreted: plain color syntax only, so
// nothing like `url(...)` reaches a style.
const COLOR =
  /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([\d\s.,%/+\-a-z]*\)|[a-z]{3,20})$/i;

/** The swatches a dialog can paint. */
export function paintableSwatches(found: Pick<FoundSystem, "swatches">): FoundSwatch[] {
  return found.swatches.flatMap((swatch) => {
    if (!COLOR.test(swatch.value.trim())) return [];
    const dark = swatch.darkValue?.trim();
    return [
      {
        name: swatch.name,
        value: swatch.value.trim(),
        ...(dark !== undefined && COLOR.test(dark) ? { darkValue: dark } : {}),
      },
    ];
  });
}
