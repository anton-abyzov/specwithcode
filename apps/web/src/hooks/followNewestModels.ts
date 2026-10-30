import type { ProviderInstanceId, ServerProvider } from "@specweave-studio/contracts";
import { createModelSelection } from "@specweave-studio/shared/model";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import { followedModelUpdates } from "../modelFamilyFollow";

/**
 * Before a new chat takes the sticky model: each provider that follows a favorite family
 * moves to that family's newest version (Claude Opus 5.5 → 6). Only new chats start from
 * the sticky model, so open chats keep theirs.
 */
export function followNewestModels(
  providers: ReadonlyArray<ServerProvider>,
  follow: Readonly<Partial<Record<ProviderInstanceId, string>>> | undefined,
  // Models hidden in a provider's settings are never followed to.
  preferences?: Readonly<
    Partial<Record<ProviderInstanceId, { readonly hiddenModels: ReadonlyArray<string> }>>
  >,
): void {
  if (!follow || Object.keys(follow).length === 0) return;
  const store = useComposerDraftStore.getState();
  const modelsByInstance = new Map(
    providers.map((p) => {
      const hidden = new Set(preferences?.[p.instanceId]?.hiddenModels ?? []);
      return [p.instanceId, p.models.filter((model) => !hidden.has(model.slug))] as const;
    }),
  );
  const updates = followedModelUpdates({
    follow,
    sticky: store.stickyModelSelectionByProvider,
    modelsByInstance,
  });
  if (updates.length === 0) return;
  const active = store.stickyActiveProvider;
  for (const update of updates) {
    store.setStickyModelSelection(createModelSelection(update.instanceId, update.to));
  }
  // Each update marks its provider active; keep the provider the user last chose.
  const activeSelection = active
    ? useComposerDraftStore.getState().stickyModelSelectionByProvider[active]
    : undefined;
  if (activeSelection) store.setStickyModelSelection(activeSelection);
  for (const update of updates) {
    if (update.from === null) continue;
    const models = modelsByInstance.get(update.instanceId) ?? [];
    const name = (slug: string) => models.find((model) => model.slug === slug)?.name ?? slug;
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: `New chats now use ${name(update.to)}`,
        description: `It's the newest in a family you starred. Open chats stay on ${name(update.from)}.`,
      }),
    );
  }
}
