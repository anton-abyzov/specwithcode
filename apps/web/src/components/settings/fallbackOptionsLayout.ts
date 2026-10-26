import type { FallbackOption, FallbackOptionGroup } from "@specweave-studio/shared/fallbackOptions";

/**
 * How the fallback options panel lays a family out: one block per provider,
 * with the status and usage most of its models share said once in the block
 * header, and older versions of a model line folded away.
 */
export interface FallbackProviderBlock {
  readonly key: string;
  readonly providerName: string;
  /** What most of the block's models share; rows only repeat what differs. */
  readonly common: Pick<FallbackOption, "status" | "access" | "usedPercent">;
  /** Shown without asking. */
  readonly shown: ReadonlyArray<FallbackOption>;
  /** Superseded versions, behind "Show older models". */
  readonly older: ReadonlyArray<FallbackOption>;
}

export interface FallbackFamilySummary {
  readonly total: number;
  readonly usable: number;
  readonly excluded: number;
}

export const isUsableFallbackOption = (option: FallbackOption) =>
  option.status === "ready" || option.status === "unverified";

const VERSION = /\d+(?:[.-]\d+)*/g;

/** A model's line and version from its name: "Claude Opus 4.8" is line "claude opus #", 4.8. */
export function modelLineAndVersion(
  name: string,
): { readonly line: string; readonly version: ReadonlyArray<number> } | null {
  const key = name.toLowerCase().trim();
  const numbers = key.match(VERSION);
  if (!numbers) return null;
  return {
    line: key.replace(VERSION, "#").replace(/\s+/g, " "),
    version: numbers.flatMap((part) => part.split(/[.-]/).map(Number)),
  };
}

function compareVersions(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Whether a newer version of the same line sits on the same provider: Opus
 * 4.8 next to Opus 5.5 is older, Haiku 5.5 next to Opus 5.5 is not. Names
 * without a version are never older.
 */
export function isSupersededOption(
  option: FallbackOption,
  siblings: ReadonlyArray<FallbackOption>,
): boolean {
  const own = modelLineAndVersion(option.modelName);
  if (!own) return false;
  return siblings.some((sibling) => {
    const other = modelLineAndVersion(sibling.modelName);
    return other?.line === own.line && compareVersions(other.version, own.version) > 0;
  });
}

function mostCommon<T>(values: ReadonlyArray<T>, key: (value: T) => string): T {
  const counts = new Map<string, number>();
  let best = values[0] as T;
  let bestCount = 0;
  for (const value of values) {
    const id = key(value);
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

const accessKey = (option: FallbackOption) =>
  `${option.access}:${option.usedPercent === null ? "" : Math.round(option.usedPercent)}`;

export function layoutFallbackFamily(
  group: FallbackOptionGroup,
): ReadonlyArray<FallbackProviderBlock> {
  const byProvider = new Map<string, FallbackOption[]>();
  for (const option of group.options) {
    const key = option.provider.instanceId;
    byProvider.set(key, [...(byProvider.get(key) ?? []), option]);
  }
  return [...byProvider].map(([key, options]) => {
    const first = options[0]!;
    // An excluded or ordered model stays in sight so its state never hides behind a fold.
    const folded = (option: FallbackOption) =>
      !option.excluded &&
      option.orderIndex === null &&
      option.status !== "current" &&
      isSupersededOption(option, options);
    const live = options.filter((option) => !option.excluded);
    const accessSource = mostCommon(live.length > 0 ? live : options, accessKey);
    return {
      key,
      providerName: first.provider.displayName ?? first.provider.instanceId,
      common: {
        status: mostCommon(live.length > 0 ? live : options, (option) => option.status).status,
        access: accessSource.access,
        usedPercent: accessSource.usedPercent,
      },
      shown: options.filter((option) => !folded(option)),
      older: options.filter(folded),
    };
  });
}

export function summarizeFallbackFamily(group: FallbackOptionGroup): FallbackFamilySummary {
  return {
    total: group.options.length,
    usable: group.options.filter(isUsableFallbackOption).length,
    excluded: group.options.filter((option) => option.excluded).length,
  };
}

export function fallbackFamilySummaryLabel(summary: FallbackFamilySummary): string {
  const parts = [
    `${summary.total} ${summary.total === 1 ? "model" : "models"}`,
    `${summary.usable} ready now`,
  ];
  if (summary.excluded > 0) parts.push(`${summary.excluded} excluded`);
  return parts.join(" · ");
}

export function sameAccess(option: FallbackOption, common: FallbackProviderBlock["common"]) {
  return (
    option.access === common.access &&
    (option.usedPercent === null ? null : Math.round(option.usedPercent)) ===
      (common.usedPercent === null ? null : Math.round(common.usedPercent))
  );
}
