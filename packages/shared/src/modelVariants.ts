/**
 * The strongest variant of a model line goes first. A provider can list a
 * line's base model before its stronger variant and mark the base as its
 * default: Muse Code lists `muse-wonder-1.0` (default) above
 * `muse-wonder-full-1.0`. Lists and pickers then read the strongest model as
 * the second choice. This puts each variant just above its base and, when the
 * base was the default, makes the variant the default instead.
 *
 * A variant is named by a word, never guessed from tiers: `muse-wonder-full-1.0`
 * is the Full variant of `muse-wonder-1.0` because removing `full` gives that
 * listed slug. Different lines (GPT Sol and Astra, Claude Opus and Fable) are
 * never reordered here.
 *
 * @module modelVariants
 */

/** Slug words that name the strongest variant of a line. */
export const STRONG_VARIANT_WORDS: ReadonlyArray<string> = ["full", "max", "pro"];

/**
 * The slugs `slug` is the strong variant of: `slug` with one variant word
 * taken out. `muse-wonder-full-1.0` gives `muse-wonder-1.0`;
 * `gpt-5.1-codex-max` gives `gpt-5.1-codex`. Empty when it names no variant.
 */
export function strongVariantBases(slug: string): ReadonlyArray<string> {
  const parts = slug.split("-");
  return parts.flatMap((part, index) =>
    index > 0 && STRONG_VARIANT_WORDS.includes(part.toLowerCase())
      ? [[...parts.slice(0, index), ...parts.slice(index + 1)].join("-")]
      : [],
  );
}

interface RankableModel {
  readonly slug: string;
  readonly isCustom: boolean;
  readonly isDefault?: boolean | undefined;
  readonly isLegacy?: boolean | undefined;
  readonly billing?: string | undefined;
}

/**
 * `models` with each listed strong variant just above its base. When the base
 * was the provider's default, the first such variant becomes the default,
 * unless it is legacy or billed differently (a paid "pro" never takes over
 * from a plan-billed default). Custom models are left where they are. Returns
 * `models` itself when nothing moves, so an unchanged snapshot stays equal.
 */
export function strongestVariantsFirst<M extends RankableModel>(
  models: ReadonlyArray<M>,
): ReadonlyArray<M> {
  const builtIn = new Set(models.filter((model) => !model.isCustom).map((model) => model.slug));
  const variantsOf = new Map<string, M[]>();
  for (const model of models) {
    if (model.isCustom) continue;
    const base = strongVariantBases(model.slug).find(
      (slug) => slug !== model.slug && builtIn.has(slug),
    );
    if (base === undefined) continue;
    variantsOf.set(base, [...(variantsOf.get(base) ?? []), model]);
  }
  if (variantsOf.size === 0) return models;

  const defaultTo = new Map<string, string>();
  for (const base of models) {
    const variant = variantsOf
      .get(base.slug)
      ?.find((model) => model.isLegacy !== true && model.billing === base.billing);
    if (base.isDefault === true && variant !== undefined && variant.isDefault !== true) {
      defaultTo.set(base.slug, variant.slug);
    }
  }

  const placed = new Set<string>();
  const ordered: M[] = [];
  for (const model of models) {
    if (placed.has(model.slug)) continue;
    for (const variant of variantsOf.get(model.slug) ?? []) {
      if (placed.has(variant.slug)) continue;
      placed.add(variant.slug);
      ordered.push(variant);
    }
    placed.add(model.slug);
    ordered.push(model);
  }
  const moved = ordered.some((model, index) => model !== models[index]);
  if (!moved && defaultTo.size === 0) return models;

  const takesDefault = new Set(defaultTo.values());
  return ordered.map((model) => {
    if (defaultTo.has(model.slug)) {
      const { isDefault: _isDefault, ...rest } = model;
      return rest as M;
    }
    return takesDefault.has(model.slug) ? { ...model, isDefault: true } : model;
  });
}
