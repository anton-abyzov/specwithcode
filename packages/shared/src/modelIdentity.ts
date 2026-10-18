/**
 * The same model served by different providers: Claude Opus 5.5 on a Claude
 * subscription is `claude-opus-5-5`, on GitHub Copilot `claude-opus-5.5`.
 * Both describe one model, so a project's recommended model can run on
 * whichever provider has room.
 *
 * @module modelIdentity
 */
import type { ServerProvider, ServerProviderModel } from "@specweave-studio/contracts";

type ModelNames = Pick<ServerProviderModel, "slug"> &
  Partial<Pick<ServerProviderModel, "name" | "aliases">>;

/**
 * One spelling reduced to a comparable key: lower case, a vendor prefix
 * (`anthropic/`) and a bracketed context suffix (`[1m]`) dropped, and
 * spaces, dots and underscores read as dashes. Keys without a digit are
 * dropped: "auto", "default" or "opus" name different models on different
 * providers, while "claude-opus-5-5" names one.
 */
function identityKey(spelling: string): string | null {
  const key = spelling
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/^.*\//, "")
    .replace(/[\s._]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return key.length > 0 && /\d/.test(key) ? key : null;
}

/** Every key a model answers to: its slug, display name and aliases. */
export function modelIdentityKeys(model: ModelNames): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const spelling of [model.slug, model.name, ...(model.aliases ?? [])]) {
    if (spelling === undefined) continue;
    const key = identityKey(spelling);
    if (key !== null) keys.add(key);
  }
  return keys;
}

/** Whether two provider models are the same model under different names. */
export function isSameModel(a: ModelNames, b: ModelNames): boolean {
  const keys = modelIdentityKeys(a);
  for (const key of modelIdentityKeys(b)) if (keys.has(key)) return true;
  return false;
}

/**
 * The model `slug` as the provider that serves it describes it, for its name
 * and aliases; just the slug when that provider does not list it.
 */
export function describeModel(
  provider: Pick<ServerProvider, "models"> | undefined,
  slug: string,
): ModelNames {
  return provider?.models.find((model) => model.slug === slug) ?? { slug };
}

/**
 * The slug `provider` serves `model` under, or undefined when it does not
 * list it. A custom model counts: a person added it to that provider on
 * purpose, as GitHub Copilot users do for models its catalogue omits.
 */
export function sameModelOn(
  provider: Pick<ServerProvider, "models">,
  model: ModelNames,
): string | undefined {
  return (
    provider.models.find((candidate) => candidate.slug === model.slug && !candidate.isCustom) ??
    provider.models.find((candidate) => isSameModel(candidate, model))
  )?.slug;
}
