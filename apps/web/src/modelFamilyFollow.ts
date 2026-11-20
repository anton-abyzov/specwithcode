import type { ProviderInstanceId, ServerProviderModel } from "@specweave-studio/contracts";
import { newerOfFamily } from "@specweave-studio/shared/modelTiers";
import { modelSearchIdentity } from "./components/chat/modelSearchGroups";

type FollowableModel = {
  readonly slug: string;
  readonly name: string;
  readonly isUnavailable?: boolean | undefined;
  readonly isCustom?: boolean | undefined;
  readonly succeeds?: string | undefined;
  readonly billing?: ServerProviderModel["billing"] | undefined;
};

/**
 * The release that replaces `slug` on this provider's list: the same successor a
 * track row follows (`newerOfFamily`). Same billing only. A custom model and an
 * unavailable release are not successors. Undefined when the slug is already newest.
 */
export function sameBillingSuccessor<T extends FollowableModel>(
  models: ReadonlyArray<T>,
  slug: string,
): string | undefined {
  const current = models.find((model) => model.slug === slug);
  if (!current || current.isCustom) return undefined;
  const catalog = models.flatMap((model) =>
    model.isUnavailable
      ? []
      : [
          {
            slug: model.slug,
            name: model.name,
            isCustom: model.isCustom === true,
            capabilities: null,
            ...(model.succeeds ? { succeeds: model.succeeds } : {}),
            ...(model.billing ? { billing: model.billing } : {}),
          },
        ],
  );
  return newerOfFamily({ models: catalog }, slug);
}

/** One device-local star moves from `from` to `to`. A star already on `to` drops the old one. */
export function replaceFavoriteModel(
  favorites: ReadonlyArray<{ readonly provider: ProviderInstanceId; readonly model: string }>,
  instanceId: ProviderInstanceId,
  from: string,
  to: string,
): Array<{ provider: ProviderInstanceId; model: string }> {
  const already = favorites.some(
    (favorite) => favorite.provider === instanceId && favorite.model === to,
  );
  return favorites.flatMap((favorite) => {
    if (favorite.provider !== instanceId || favorite.model !== from) return [favorite];
    return already ? [] : [{ provider: instanceId, model: to }];
  });
}

function compareVersions(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** The newest version of a family a provider offers ("opus" → Claude Opus 6), or null. */
export function newestModelInFamily<T extends FollowableModel>(
  models: ReadonlyArray<T>,
  family: string,
): T | null {
  let best: { model: T; version: ReadonlyArray<number> } | null = null;
  for (const model of models) {
    const identity = modelSearchIdentity(model);
    if (identity.family !== family || model.isUnavailable) continue;
    if (!best || compareVersions(identity.version, best.version) > 0) {
      best = { model, version: identity.version };
    }
  }
  return best?.model ?? null;
}

/**
 * The sticky picks that move to a newer version, for new chats only: each provider whose
 * family the user follows, where the provider now lists a newer version than the sticky one.
 * Open chats keep their model; this only feeds the selection a new draft starts from.
 */
export function followedModelUpdates(input: {
  readonly follow: Readonly<Partial<Record<ProviderInstanceId, string>>>;
  readonly sticky: Readonly<Partial<Record<ProviderInstanceId, { readonly model: string }>>>;
  readonly modelsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<FollowableModel>>;
}): ReadonlyArray<{
  readonly instanceId: ProviderInstanceId;
  readonly from: string | null;
  readonly to: string;
}> {
  const updates: Array<{ instanceId: ProviderInstanceId; from: string | null; to: string }> = [];
  for (const [instanceId, family] of Object.entries(input.follow) as Array<
    [ProviderInstanceId, string | undefined]
  >) {
    if (!family) continue;
    const models = input.modelsByInstance.get(instanceId) ?? [];
    const newest = newestModelInFamily(models, family);
    const current = input.sticky[instanceId]?.model ?? null;
    if (!newest || newest.slug === current) continue;
    // Move only up. A sticky model this machine doesn't list (another machine's catalog,
    // a brief fallback list) can't be compared, so it stays.
    const currentModel = models.find((model) => model.slug === current);
    if (current !== null && !currentModel) continue;
    // A sticky model already in the followed family moves only to the successor
    // a track row would follow. That keeps the saved effort's model line and
    // refuses a release that costs money or whose billing is unknown.
    if (
      currentModel &&
      current !== null &&
      modelSearchIdentity(currentModel).family === family
    ) {
      const successor = sameBillingSuccessor(models, current);
      if (successor && successor !== current)
        updates.push({ instanceId, from: current, to: successor });
      continue;
    }
    updates.push({ instanceId, from: current, to: newest.slug });
  }
  return updates;
}
