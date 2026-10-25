/**
 * Orders a scan's suggestions strongest first and folds what repeats.
 *
 * A suggestion's score is what its preselected files hold (tokens plus
 * components), with a bonus for light and dark (or several) modes and one
 * when its package says it is a design system, UI kit or tokens package.
 * Before ordering, duplicate checkouts of one package collapse into the
 * strongest, and a stylesheet that shares most of its custom properties with
 * a stronger suggestion's stylesheet becomes that suggestion's copy, so a
 * system copied into other apps is offered once, from its source.
 */
import type {
  DesignSystemCandidateKind,
  DesignSystemSuggestion,
} from "@specweave-studio/contracts";

import { compareText } from "./common.ts";

/** Modes beyond one (`light` and `dark`, or several named themes). */
export const MODES_BONUS = 50;
/** A package that calls itself a design system, UI kit or tokens package. */
export const DESIGN_SYSTEM_BONUS = 100;
/** Share of custom-property names two stylesheets have in common to count as copies. */
export const COPY_SHARE = 0.8;
/** Stylesheets with fewer names are too small to call one a copy of another. */
export const COPY_MIN_NAMES = 10;

const DESIGN_SYSTEM_WORDS = /design[\s_-]?system|ui[\s_-]?kit|\btokens?\b/i;

/** True when a package name or description says it is a design system. */
export const looksLikeDesignSystem = (...texts: ReadonlyArray<string | undefined>): boolean =>
  texts.some((text) => text !== undefined && DESIGN_SYSTEM_WORDS.test(text));

export interface RankedCandidate {
  readonly path: string;
  readonly kind: DesignSystemCandidateKind;
  readonly tokenCount: number;
  readonly componentCount: number;
  readonly modes: ReadonlyArray<string>;
  /** A stylesheet's custom-property names, for copy detection. */
  readonly propertyNames?: ReadonlySet<string>;
}

export interface PackageInfo {
  /** The label shown for the package: manifest name without its scope, or the folder name. */
  readonly label: string;
  /** The manifest's `name` as written, when there is one. */
  readonly manifestName?: string;
  readonly description?: string;
}

export type MutableSuggestion = DesignSystemSuggestion & { paths: string[]; copies: string[] };

/** True when the modes are light and dark, or two or more named modes. */
const hasSeveralModes = (modes: ReadonlySet<string>) =>
  (modes.has("light") && modes.has("dark")) ||
  [...modes].filter((mode) => mode !== "default").length >= 2;

export const suggestionScore = (
  suggestion: Pick<DesignSystemSuggestion, "paths">,
  candidates: ReadonlyMap<string, RankedCandidate>,
  info: PackageInfo | undefined,
): number => {
  let score = 0;
  const modes = new Set<string>();
  for (const path of suggestion.paths) {
    const candidate = candidates.get(path);
    if (!candidate) continue;
    score += candidate.tokenCount + candidate.componentCount;
    for (const mode of candidate.modes) modes.add(mode);
  }
  if (hasSeveralModes(modes)) score += MODES_BONUS;
  if (info && looksLikeDesignSystem(info.manifestName, info.description))
    score += DESIGN_SYSTEM_BONUS;
  return score;
};

/** Share of names two stylesheets have in common, of the larger one. */
export const sharedShare = (left: ReadonlySet<string>, right: ReadonlySet<string>): number => {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  if (large.size === 0) return 0;
  let shared = 0;
  for (const name of small) if (large.has(name)) shared += 1;
  return shared / large.size;
};

/**
 * Ranks the suggestions in place and returns them in order: with paths first,
 * by score, then by key. `suggestionOf` maps each candidate path to its
 * suggestion key and is updated when a candidate moves to another suggestion.
 */
export const rankSuggestions = (
  suggestions: Map<string, MutableSuggestion>,
  suggestionOf: Map<string, string>,
  candidates: ReadonlyMap<string, RankedCandidate>,
  packageOf: (key: string) => PackageInfo | undefined,
): MutableSuggestion[] => {
  const scores = new Map<string, number>();
  const rescore = () => {
    for (const [key, suggestion] of suggestions)
      scores.set(key, suggestionScore(suggestion, candidates, packageOf(key)));
  };
  const ordered = () =>
    [...suggestions.values()].sort(
      (left, right) =>
        Number(right.paths.length > 0) - Number(left.paths.length > 0) ||
        scores.get(right.key)! - scores.get(left.key)! ||
        compareText(left.key, right.key),
    );
  const moveAll = (from: MutableSuggestion, to: MutableSuggestion) => {
    for (const [path, key] of suggestionOf) if (key === from.key) suggestionOf.set(path, to.key);
  };
  rescore();

  // Duplicate checkouts of one package: the strongest stays, the others are its copies.
  const byManifest = new Map<string, MutableSuggestion[]>();
  for (const suggestion of ordered()) {
    const name = packageOf(suggestion.key)?.manifestName;
    if (name === undefined || !suggestion.key.startsWith("pkg:")) continue;
    byManifest.set(name, [...(byManifest.get(name) ?? []), suggestion]);
  }
  for (const [winner, ...others] of byManifest.values()) {
    for (const other of others) {
      winner!.copies.push(...other.paths, ...other.copies);
      moveAll(other, winner!);
      suggestions.delete(other.key);
    }
  }

  // A stylesheet that repeats a stronger suggestion's stylesheet is its copy.
  const namesOf = (path: string) => {
    const names = candidates.get(path)?.propertyNames;
    return names && names.size >= COPY_MIN_NAMES ? names : undefined;
  };
  const sheetsBy = new Map<string, string[]>();
  for (const [path, key] of suggestionOf)
    if (namesOf(path)) sheetsBy.set(key, [...(sheetsBy.get(key) ?? []), path]);
  const ranked = ordered();
  for (const [index, stronger] of ranked.entries()) {
    const own = stronger.paths.flatMap((path) => namesOf(path) ?? []);
    if (own.length === 0) continue;
    for (const weaker of ranked.slice(index + 1)) {
      const kept: string[] = [];
      for (const path of sheetsBy.get(weaker.key) ?? []) {
        const names = namesOf(path)!;
        if (!own.some((sheet) => sharedShare(sheet, names) >= COPY_SHARE)) {
          kept.push(path);
          continue;
        }
        stronger.copies.push(path);
        suggestionOf.set(path, stronger.key);
        const at = weaker.paths.indexOf(path);
        if (at >= 0) weaker.paths.splice(at, 1);
      }
      sheetsBy.set(weaker.key, kept);
    }
  }

  // A suggestion left with no files at all is gone; one with files but no paths sinks.
  const used = new Set(suggestionOf.values());
  for (const key of suggestions.keys()) if (!used.has(key)) suggestions.delete(key);
  rescore();
  return ordered();
};
