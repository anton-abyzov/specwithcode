import type { ModelSelection, ProviderInstanceId } from "@specweave-studio/contracts";
import { describeModel, sameModelOn } from "@specweave-studio/shared/modelIdentity";
import { isPerTokenProvider } from "@specweave-studio/shared/providerFallback";
import { ArrowUpIcon } from "lucide-react";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { Button } from "../ui/button";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export interface ModelProviderChoice {
  readonly entry: ProviderInstanceEntry;
  /** The slug this provider serves the recommended model under. */
  readonly slug: string;
}

/**
 * The providers that serve `model` besides its own, in the order threads try
 * them when the recommended provider has no room: the saved order first, then
 * the same driver, then the picker's order. Providers billed per token are
 * left out, since nothing switches to them on its own.
 */
export function recommendedModelProviderOrder(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  model: ModelSelection,
  saved: ReadonlyArray<ProviderInstanceId>,
): { readonly own: ProviderInstanceEntry | undefined; readonly others: ModelProviderChoice[] } {
  const own = entries.find((entry) => entry.instanceId === model.instanceId);
  const identity = describeModel(own?.snapshot, model.model);
  const rank = (entry: ProviderInstanceEntry) => {
    const index = saved.indexOf(entry.instanceId);
    return index === -1 ? saved.length : index;
  };
  const others = entries.flatMap((entry, position) => {
    if (entry.instanceId === model.instanceId || !entry.enabled) return [];
    if (isPerTokenProvider(entry.snapshot)) return [];
    const slug = sameModelOn(entry.snapshot, identity);
    return slug === undefined ? [] : [{ entry, slug, position }];
  });
  others.sort(
    (a, b) =>
      rank(a.entry) - rank(b.entry) ||
      Number(b.entry.driverKind === own?.driverKind) -
        Number(a.entry.driverKind === own?.driverKind) ||
      a.position - b.position,
  );
  return { own, others: others.map(({ entry, slug }) => ({ entry, slug })) };
}

/**
 * Where a project's recommended model runs once its own provider is full:
 * Claude Opus 5.5 on a Claude subscription, then the same model on GitHub
 * Copilot. Shown only when another provider serves the model.
 */
export function RecommendedModelProviders({ model }: { readonly model: ModelSelection | null }) {
  const { target } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environments } = useEnvironments();
  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
  const providers = representative?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  if (model === null) return null;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const saved = settings.defaultModelProviders;
  const { own, others } = recommendedModelProviderOrder(entries, model, saved);
  if (others.length === 0) return null;
  const moveUp = (index: number) => {
    const order = others.map((choice) => choice.entry.instanceId);
    [order[index - 1], order[index]] = [order[index]!, order[index - 1]!];
    updateSettings({ defaultModelProviders: order });
  };
  const ownName = own?.displayName ?? model.instanceId;
  return (
    <SettingsRow
      serverScoped
      settingKeys={["defaultModelProviders"]}
      id="project-recommended-model-providers"
      title="Also served by"
      description={`When ${ownName} has no room, threads run the same model on the first provider below that has room. Providers billed per token are never picked on their own. When none has room, the rules below pick another model.`}
      status={saved.length === 0 ? "Automatic order" : undefined}
      resetAction={
        saved.length > 0 ? (
          <SettingResetButton
            label="provider order"
            onClick={() => updateSettings({ defaultModelProviders: [] })}
          />
        ) : null
      }
    >
      <ol className="mb-2 space-y-1 text-sm" aria-label="Providers for the recommended model">
        {others.map((choice, index) => (
          <li key={choice.entry.instanceId} className="flex min-w-0 items-center gap-2">
            <span className="w-5 shrink-0 text-right text-xs text-muted-foreground">
              {index + 1}.
            </span>
            <span className="min-w-0 flex-1 truncate">
              {choice.entry.displayName}
              <span className="ml-2 text-xs text-muted-foreground">{choice.slug}</span>
            </span>
            {index > 0 ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Try ${choice.entry.displayName} earlier`}
                onClick={() => moveUp(index)}
              >
                <ArrowUpIcon />
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
    </SettingsRow>
  );
}
