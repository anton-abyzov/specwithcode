import type { ProviderInstanceId } from "@specweave-studio/contracts";
import { normalizeSearchQuery, scoreQueryMatch } from "@specweave-studio/shared/searchRanking";
import { providerModelKey } from "../../modelOrdering";

type ModelPickerSearchableModel = {
  /** Driver kind — indexed so "codex" still matches a Codex Personal instance. */
  driverKind: string;
  /**
   * Instance display name (e.g. "Codex Personal"). Indexed as a search
   * field so typing the custom instance's user-authored name matches its
   * models directly instead of just the driver kind.
   */
  providerDisplayName: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  isFavorite?: boolean;
};

const MODEL_PICKER_FAVORITE_SCORE_BOOST = 24;

function getModelPickerSearchFields(model: ModelPickerSearchableModel): string[] {
  return [
    normalizeSearchQuery(model.name),
    ...(model.shortName ? [normalizeSearchQuery(model.shortName)] : []),
    ...(model.subProvider ? [normalizeSearchQuery(model.subProvider)] : []),
    normalizeSearchQuery(model.driverKind),
    normalizeSearchQuery(model.providerDisplayName),
    buildModelPickerSearchText(model),
  ];
}

function scoreModelPickerSearchToken(
  field: string,
  token: string,
  fieldBase: number,
): number | null {
  return scoreQueryMatch({
    value: field,
    query: token,
    exactBase: fieldBase,
    prefixBase: fieldBase + 2,
    boundaryBase: fieldBase + 4,
    includesBase: fieldBase + 6,
    ...(token.length >= 3 ? { fuzzyBase: fieldBase + 100 } : {}),
  });
}

export function buildModelPickerSearchText(model: ModelPickerSearchableModel): string {
  return normalizeSearchQuery(
    [model.name, model.shortName, model.subProvider, model.driverKind, model.providerDisplayName]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" "),
  );
}

export function scoreModelPickerSearch(
  model: ModelPickerSearchableModel,
  query: string,
): number | null {
  const tokens = normalizeSearchQuery(query)
    .split(/\s+/u)
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return 0;
  }

  const fields = getModelPickerSearchFields(model);
  let score = 0;

  for (const token of tokens) {
    const tokenScores: Array<number> = [];
    for (let index = 0; index < fields.length; index += 1) {
      const fieldScore = scoreModelPickerSearchToken(fields[index]!, token, index * 10);
      if (fieldScore !== null) {
        tokenScores.push(fieldScore);
      }
    }

    if (tokenScores.length === 0) {
      return null;
    }

    score += Math.min(...tokenScores);
  }

  return model.isFavorite ? score - MODEL_PICKER_FAVORITE_SCORE_BOOST : score;
}

type RankableModel = {
  readonly name: string;
  readonly shortName?: string | undefined;
  readonly subProvider?: string | undefined;
  readonly driverKind: string;
  readonly instanceDisplayName: string;
};

/** The models matching `query`, best first; favorites win ties, then the search text. */
export function rankModelPickerSearch<T extends RankableModel>(
  models: ReadonlyArray<T>,
  query: string,
  isFavorite: (model: T) => boolean,
): T[] {
  const ranked: Array<{ model: T; score: number; isFavorite: boolean; tieBreaker: string }> = [];
  for (const model of models) {
    const searchable = {
      name: model.name,
      ...(model.shortName ? { shortName: model.shortName } : {}),
      ...(model.subProvider ? { subProvider: model.subProvider } : {}),
      driverKind: model.driverKind,
      providerDisplayName: model.instanceDisplayName,
    };
    const favorite = isFavorite(model);
    const score = scoreModelPickerSearch({ ...searchable, isFavorite: favorite }, query);
    if (score === null) continue;
    ranked.push({
      model,
      score,
      isFavorite: favorite,
      tieBreaker: buildModelPickerSearchText(searchable),
    });
  }
  return ranked
    .toSorted(
      (a, b) =>
        a.score - b.score ||
        (a.isFavorite === b.isFavorite ? 0 : a.isFavorite ? -1 : 1) ||
        a.tieBreaker.localeCompare(b.tieBreaker),
    )
    .map((entry) => entry.model);
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
