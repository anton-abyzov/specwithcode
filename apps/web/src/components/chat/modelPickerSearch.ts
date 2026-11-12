import type {
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ServerProviderModel,
} from "@specweave-studio/contracts";
import {
  closestNameWordDistance,
  modelHasCapability,
  modelNameWords,
  modelVendorAliases,
  parseModelSearch,
  providerVendorAliases,
  smartRank,
  type ModelSearchCapability,
  type ModelSearchFacts,
} from "@specweave-studio/shared/modelSearchIntents";
import { normalizeSearchQuery } from "@specweave-studio/shared/searchRanking";
import { providerModelKey } from "../../modelOrdering";

type ModelPickerSearchableModel = {
  /** Driver kind — indexed so "codex" still matches a Codex Personal instance. */
  driverKind: string;
  /**
   * Instance display name (e.g. "Codex Personal"). Indexed as a provider
   * field so typing the custom instance's user-authored name matches its
   * models, ranked after any match in a model's own name.
   */
  providerDisplayName: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  /** Catalog aliases ("opus-5.5"); they rank with the name. */
  aliases?: ReadonlyArray<string> | undefined;
  /** The account behind the provider ("Enterprise", "Claude Max"). */
  accountLabel?: string | undefined;
  isFavorite?: boolean;
};

/** Match tiers, best first. Name matches always beat provider matches. */
const NAME_EXACT = 0;
const NAME_PREFIX = 1;
const NAME_WORD_START = 2;
const NAME_COMPACT = 3;
const NAME_VENDOR = 4;
const NAME_INSIDE = 5;
const PROVIDER_EXACT = 10;
const PROVIDER_PREFIX = 11;
const PROVIDER_WORD_START = 12;

const WORD_BREAK = /[\s\-_/.:()[\],]/u;
const LEADING_VENDOR = /^(?:[a-z-]+:\s*|claude\s+(?=\S)|anthropic\s+|openai\s+|google\s+)/u;

/** Where `token` begins a word of `value`; -1 when it begins none. Both lowercased. */
function wordStartIndex(value: string, token: string): number {
  let from = 0;
  while (from <= value.length - token.length) {
    const index = value.indexOf(token, from);
    if (index === -1) return -1;
    if (index === 0 || WORD_BREAK.test(value[index - 1]!)) return index;
    // A version glued to its name starts a word too: "3" in "qwen3", "3.2" in "llama3.2".
    if (/\d/u.test(token[0]!) && /[a-z]/u.test(value[index - 1]!)) return index;
    from = index + 1;
  }
  return -1;
}

const compact = (value: string) => value.replace(/[\s\-_.]/gu, "");

function scoreNameField(field: string, token: string): number | null {
  if (!field) return null;
  if (field === token) return NAME_EXACT;
  if (field.startsWith(token)) return NAME_PREFIX;
  if (wordStartIndex(field, token) !== -1) return NAME_WORD_START;
  // "gpt5" finds "GPT-5": the same letters with the separators left out.
  const tight = compact(token);
  if (tight.length >= 3 && compact(field).startsWith(tight)) return NAME_COMPACT;
  // A whole word inside a run-together name ("seek" in "DeepSeek"); ranked last among names.
  if (token.length >= 4 && field.includes(token)) return NAME_INSIDE;
  return null;
}

function scoreProviderField(field: string, token: string): number | null {
  if (!field) return null;
  if (field === token) return PROVIDER_EXACT;
  if (field.startsWith(token)) return PROVIDER_PREFIX;
  return wordStartIndex(field, token) !== -1 ? PROVIDER_WORD_START : null;
}

function nameFields(model: ModelPickerSearchableModel): string[] {
  const names = [model.name, model.shortName, ...(model.aliases ?? [])]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => normalizeSearchQuery(value));
  // "Claude Opus 5.5" and "Opus 5.5" are one model: a vendor word in front never costs rank.
  const bare = names.map((value) => value.replace(LEADING_VENDOR, "")).filter(Boolean);
  return [...new Set([...names, ...bare])];
}

function providerFields(model: ModelPickerSearchableModel): string[] {
  return [model.subProvider, model.driverKind, model.providerDisplayName, model.accountLabel]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => normalizeSearchQuery(value));
}

function scoreToken(model: ModelPickerSearchableModel, token: string): number | null {
  let best: number | null = null;
  const take = (score: number | null) => {
    if (score !== null && (best === null || score < best)) best = score;
  };
  for (const field of nameFields(model)) take(scoreNameField(field, token));
  if (modelVendorAliases(model).includes(token)) take(NAME_VENDOR);
  for (const field of providerFields(model)) take(scoreProviderField(field, token));
  if (
    providerVendorAliases({
      driverKind: model.driverKind,
      displayName: `${model.providerDisplayName} ${model.subProvider ?? ""}`,
    }).includes(token)
  ) {
    take(PROVIDER_EXACT);
  }
  return best;
}

export function buildModelPickerSearchText(model: ModelPickerSearchableModel): string {
  return normalizeSearchQuery(
    [model.name, model.shortName, model.subProvider, model.driverKind, model.providerDisplayName]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" "),
  );
}

/**
 * How well a model matches the text words of a query; lower is better, null is
 * no match. Each word must begin the model's name, an alias or a word of
 * either, or else the provider's or account's name. Nothing is matched loosely:
 * near-misses are `searchModelPicker`'s fallback. Capability words are not
 * text and are ignored here.
 */
export function scoreModelPickerSearch(
  model: ModelPickerSearchableModel,
  query: string,
): number | null {
  const tokens = parseModelSearch(query).text;
  let score = 0;
  for (const token of tokens) {
    const tokenScore = scoreToken(model, token);
    if (tokenScore === null) return null;
    score += tokenScore;
  }
  return score;
}

type RankableModel = {
  readonly name: string;
  readonly slug: string;
  readonly shortName?: string | undefined;
  readonly subProvider?: string | undefined;
  readonly aliases?: ReadonlyArray<string> | undefined;
  readonly accountLabel?: string | undefined;
  readonly driverKind: string;
  readonly instanceDisplayName: string;
};

const searchableOf = (model: RankableModel): ModelPickerSearchableModel => ({
  name: model.name,
  ...(model.shortName ? { shortName: model.shortName } : {}),
  ...(model.subProvider ? { subProvider: model.subProvider } : {}),
  ...(model.aliases ? { aliases: model.aliases } : {}),
  ...(model.accountLabel ? { accountLabel: model.accountLabel } : {}),
  driverKind: model.driverKind,
  providerDisplayName: model.instanceDisplayName,
});

const defaultFacts = (model: RankableModel): ModelSearchFacts => ({
  name: model.name,
  slug: model.slug,
});

/** Whether the model's own name carries the capability word ("Grok Code Fast"). */
function namesWord(model: RankableModel, word: string): boolean {
  return modelNameWords(`${model.name} ${model.shortName ?? ""}`).includes(word);
}

export interface ModelPickerSearchResult<T> {
  /** The models to list, best first. */
  readonly matches: T[];
  /** True when nothing matched directly and `matches` are near-misses. */
  readonly closest: boolean;
  /** The capability filters the query asked for, for their removable chips. */
  readonly capabilities: ReadonlyArray<ModelSearchCapability>;
}

/**
 * The models a query lists: direct matches ranked exact, prefix, word start in
 * the name or an alias, then provider or account name, favorites winning ties.
 * Capability words filter; a model whose own name is the word always stays.
 * Only when nothing matches directly are models within a typo of a name word
 * returned, flagged `closest`.
 */
export function searchModelPicker<T extends RankableModel>(
  models: ReadonlyArray<T>,
  query: string,
  isFavorite: (model: T) => boolean,
  factsOf: (model: T) => ModelSearchFacts = defaultFacts,
): ModelPickerSearchResult<T> {
  const { text, capabilities } = parseModelSearch(query);
  const textQuery = text.join(" ");
  const passes = (model: T) => {
    if (capabilities.length === 0) return true;
    const facts = factsOf(model);
    return capabilities.every(
      (capability) => modelHasCapability(capability.id, facts) || namesWord(model, capability.word),
    );
  };
  const smart = capabilities.some((capability) => capability.id === "smart");
  type Ranked = { model: T; score: number; isFavorite: boolean; tieBreaker: string; order: number };
  const sorted = (ranked: Ranked[]) =>
    ranked
      .toSorted(
        (a, b) =>
          a.score - b.score ||
          (a.isFavorite === b.isFavorite ? 0 : a.isFavorite ? -1 : 1) ||
          (text.length === 0 ? a.order - b.order : a.tieBreaker.localeCompare(b.tieBreaker)),
      )
      .map((entry) => entry.model);

  const direct: Ranked[] = [];
  models.forEach((model, order) => {
    if (!passes(model)) return;
    const searchable = searchableOf(model);
    const score = scoreModelPickerSearch(searchable, textQuery);
    if (score === null) return;
    direct.push({
      model,
      score: score + (smart ? smartRank(factsOf(model)) : 0),
      isFavorite: isFavorite(model),
      tieBreaker: buildModelPickerSearchText(searchable),
      order,
    });
  });
  if (direct.length > 0 || text.length === 0) {
    return { matches: sorted(direct), closest: false, capabilities };
  }

  const near: Ranked[] = [];
  models.forEach((model, order) => {
    if (!passes(model)) return;
    const searchable = searchableOf(model);
    const words = modelNameWords([model.name, model.shortName, ...(model.aliases ?? [])].join(" "));
    let distance = 0;
    for (const token of text) {
      if (scoreToken(searchable, token) !== null) continue;
      const tokenDistance = closestNameWordDistance(token, words);
      if (tokenDistance === null) return;
      distance += tokenDistance;
    }
    near.push({
      model,
      score: distance,
      isFavorite: isFavorite(model),
      tieBreaker: buildModelPickerSearchText(searchable),
      order,
    });
  });
  return { matches: sorted(near), closest: near.length > 0, capabilities };
}

/** The models matching `query` directly, best first; favorites win ties, then the search text. */
export function rankModelPickerSearch<T extends RankableModel>(
  models: ReadonlyArray<T>,
  query: string,
  isFavorite: (model: T) => boolean,
  factsOf?: (model: T) => ModelSearchFacts,
): T[] {
  const result = searchModelPicker(models, query, isFavorite, factsOf);
  return result.closest ? [] : result.matches;
}

/**
 * The parts of `label` the query's text words match, as [start, end) pairs in
 * order, for highlighting. A word marks the first place it begins a word.
 */
export function modelSearchHighlightRanges(
  label: string,
  query: string,
): ReadonlyArray<readonly [number, number]> {
  const lower = label.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const token of parseModelSearch(query).text) {
    const index = wordStartIndex(lower, token);
    if (index !== -1) ranges.push([index, index + token.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/** The alias a query matched when the model's shown name does not carry the match. */
export function modelSearchMatchedAlias(
  model: { readonly aliases?: ReadonlyArray<string> | undefined },
  label: string,
  query: string,
): string | null {
  const text = parseModelSearch(query).text;
  if (text.length === 0 || modelSearchHighlightRanges(label, query).length > 0) return null;
  return (
    model.aliases?.find((alias) =>
      text.some((token) => scoreNameField(normalizeSearchQuery(alias), token) !== null),
    ) ?? null
  );
}

const isFastDescriptor = (descriptor: ProviderOptionDescriptor) =>
  (descriptor.id === "fastMode" && descriptor.type === "boolean") ||
  (descriptor.id === "serviceTier" &&
    descriptor.type === "select" &&
    descriptor.options.some((option) => /^(?:ultra)?fast$/iu.test(option.label)));

/** What the capability filters read about one listed model. */
export function modelSearchFacts(
  model: { readonly name: string; readonly slug: string; readonly badge?: "new" | undefined },
  runtime: ServerProviderModel | undefined,
  extra: {
    readonly isLatest?: boolean;
    readonly inHardestTier?: boolean;
    readonly subscription?: boolean;
  } = {},
): ModelSearchFacts {
  return {
    name: model.name,
    slug: model.slug,
    billing: runtime?.billing,
    contextWindow: runtime?.contextWindow,
    imageInput: runtime?.imageInput,
    isNew: model.badge === "new" || runtime?.badge === "new",
    hasFast: runtime?.capabilities?.optionDescriptors?.some(isFastDescriptor) === true,
    ...extra,
  };
}

/** How many search matches each provider offers, plus All and Favorites. */
export function countModelSearchMatches(
  matches: ReadonlyArray<{ readonly instanceId: ProviderInstanceId; readonly slug: string }>,
  favorites: ReadonlySet<string>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>([
    ["all", matches.length],
    ["favorites", 0],
  ]);
  for (const model of matches) {
    counts.set(model.instanceId, (counts.get(model.instanceId) ?? 0) + 1);
    if (favorites.has(providerModelKey(model.instanceId, model.slug))) {
      counts.set("favorites", counts.get("favorites")! + 1);
    }
  }
  return counts;
}
