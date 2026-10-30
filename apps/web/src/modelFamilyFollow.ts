import type { ProviderInstanceId } from "@specweave-studio/contracts";
import { modelSearchIdentity } from "./components/chat/modelSearchGroups";

type FollowableModel = {
  readonly slug: string;
  readonly name: string;
  readonly isUnavailable?: boolean | undefined;
};

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
    if (
      currentModel &&
      modelSearchIdentity(currentModel).family === family &&
      compareVersions(
        modelSearchIdentity(newest).version,
        modelSearchIdentity(currentModel).version,
      ) <= 0
    ) {
      continue;
    }
    updates.push({ instanceId, from: current, to: newest.slug });
  }
  return updates;
}
