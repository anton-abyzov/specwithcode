/**
 * Size limits for MCP tool results. Claude Code saves a result over about
 * 25,000 tokens to a file and hands the agent a notice instead, so the
 * caller loses the reply. JSON of ids and short words runs about 2 to 4 bytes
 * per token; 40,000 bytes stays under 20,000 tokens even at 2 bytes per token.
 */
export const MCP_RESULT_MAX_BYTES = 40_000;

export const serializedBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");

/**
 * How many items from the end of `items` fit in `maxBytes` next to a result
 * whose other fields take `fixedBytes` (with the item array empty). Each item
 * costs its own size plus a separating comma.
 */
export function newestItemsThatFit<T>(
  items: ReadonlyArray<T>,
  fixedBytes: number,
  maxBytes: number,
  sizeOf: (item: T) => number = serializedBytes,
): number {
  let used = fixedBytes;
  let kept = 0;
  for (let index = items.length - 1; index >= 0; index--) {
    used += sizeOf(items[index]!) + 1;
    if (used > maxBytes) break;
    kept++;
  }
  return kept;
}

/** The largest n in [0, max] with fits(n), for a fits that holds up to some point. 0 when none does. */
export function largestThatFits(max: number, fits: (n: number) => boolean): number {
  let low = 0;
  let high = Math.max(0, Math.floor(max));
  if (fits(high)) return high;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}

interface CatalogModel {
  readonly id: string;
  readonly label: string | null;
  readonly options?: ReadonlyArray<unknown> | undefined;
  readonly paid?: boolean | undefined;
}
interface CatalogProvider<M extends CatalogModel> {
  readonly providerInstanceId: string;
  readonly models: ReadonlyArray<M>;
  readonly modelCount?: number | undefined;
}
interface Catalog<M extends CatalogModel, P extends CatalogProvider<M>> {
  readonly providers: ReadonlyArray<P>;
}
export interface CatalogDetail {
  readonly view: "compact" | "instance";
  readonly note?: string;
  readonly nextModelOffset?: number | null;
}

const COMPACT_NOTE = "Model options are omitted. Pass providerInstanceId for one instance in full.";
const CUT_NOTE =
  "Model labels and some model ids are omitted (see modelCount). Pass providerInstanceId for one instance in full.";

/**
 * The no-argument capabilities view. A catalog that fits is returned whole;
 * a larger one lists every instance with its model ids and labels but no
 * model options. A catalog too large even for that drops labels, then the
 * last model ids of the longest lists, reporting each cut instance's
 * modelCount.
 */
export function compactCatalog<
  M extends CatalogModel,
  P extends CatalogProvider<M>,
  C extends Catalog<M, P>,
>(catalog: C, maxBytes: number): C & { readonly detail?: CatalogDetail } {
  if (serializedBytes(catalog) <= maxBytes) return catalog;
  const withProviders = (providers: ReadonlyArray<P>, note: string) => ({
    ...catalog,
    providers,
    detail: { view: "compact" as const, note },
  });
  const withoutOptions = catalog.providers.map((provider) => ({
    ...provider,
    models: provider.models.map(({ options: _options, ...model }) => model as M),
  }));
  const compact = withProviders(withoutOptions, COMPACT_NOTE);
  if (serializedBytes(compact) <= maxBytes) return compact;

  const idsOnly = withoutOptions.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => ({ ...model, label: null })),
  }));
  const cutTo = (target: number) => {
    let size = serializedBytes(withProviders(idsOnly, CUT_NOTE));
    const kept = idsOnly.map((provider) => provider.models.length);
    while (size > target) {
      let longest = -1;
      for (let index = 0; index < kept.length; index++)
        if (kept[index]! > 0 && (longest === -1 || kept[index]! > kept[longest]!)) longest = index;
      if (longest === -1) break;
      const provider = idsOnly[longest]!;
      kept[longest] = kept[longest]! - 1;
      size -= serializedBytes(provider.models[kept[longest]!]) + 1;
      // The first cut of an instance adds its modelCount.
      if (kept[longest] === provider.models.length - 1)
        size += `,"modelCount":${provider.models.length}`.length;
    }
    return withProviders(
      idsOnly.map((provider, index) =>
        kept[index] === provider.models.length
          ? provider
          : {
              ...provider,
              models: provider.models.slice(0, kept[index]),
              modelCount: provider.models.length,
            },
      ),
      CUT_NOTE,
    );
  };
  // The running size is an estimate (commas, ids that need escaping); measure and tighten.
  let target = maxBytes;
  let cut = cutTo(target);
  for (let over = serializedBytes(cut) - maxBytes; over > 0 && target > 0;) {
    target -= over;
    cut = cutTo(target);
    over = serializedBytes(cut) - maxBytes;
  }
  return cut;
}

/**
 * One instance in full, models from `modelOffset` while they fit, and the
 * offset of the next page. At least one model is returned so paging moves on.
 */
export function instanceCatalog<
  M extends CatalogModel,
  P extends CatalogProvider<M>,
  C extends Catalog<M, P>,
>(
  catalog: C,
  providerInstanceId: string,
  modelOffset: number,
  maxBytes: number,
): (C & { readonly detail: CatalogDetail }) | undefined {
  const provider = catalog.providers.find(
    (candidate) => candidate.providerInstanceId === providerInstanceId,
  );
  if (provider === undefined) return undefined;
  const rest = provider.models.slice(modelOffset);
  const shell = {
    ...catalog,
    providers: [{ ...provider, models: [], modelCount: provider.models.length }],
    detail: { view: "instance" as const, nextModelOffset: provider.models.length },
  };
  let used = serializedBytes(shell);
  let kept = 0;
  for (const model of rest) {
    used += serializedBytes(model) + 1;
    if (kept > 0 && used > maxBytes) break;
    kept++;
  }
  const next = modelOffset + kept < provider.models.length ? modelOffset + kept : null;
  return {
    ...catalog,
    providers: [
      {
        ...provider,
        models: rest.slice(0, kept),
        ...(next === null && modelOffset === 0 ? {} : { modelCount: provider.models.length }),
      },
    ],
    detail: { view: "instance", nextModelOffset: next },
  };
}
