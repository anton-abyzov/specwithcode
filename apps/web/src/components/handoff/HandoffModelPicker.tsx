import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection } from "@specweave-studio/contracts";
import { createModelSelection } from "@specweave-studio/shared/model";
import { useMemo } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { modelLabel } from "../../studio/shellModel";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";

/**
 * The providers to pick from: the destination's when this window is connected
 * to it, otherwise the source's; the destination's preflight says whether the
 * model is really there.
 */
function useHandoffProviders(
  sourceEnvironmentId: EnvironmentId,
  destinationEnvironmentId: EnvironmentId | null,
) {
  const destinationProviders = useAtomValue(
    serverEnvironment.providersValueAtom(destinationEnvironmentId ?? sourceEnvironmentId),
  );
  const sourceProviders = useAtomValue(serverEnvironment.providersValueAtom(sourceEnvironmentId));
  const fromDestination = destinationProviders !== null && destinationProviders !== undefined;
  const providers =
    (fromDestination ? destinationProviders : sourceProviders) ?? EMPTY_SERVER_PROVIDERS;
  const settingsEnvironment = fromDestination
    ? (destinationEnvironmentId ?? sourceEnvironmentId)
    : sourceEnvironmentId;
  const settings = useEnvironmentSettings(settingsEnvironment);
  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  return { providers, settings, entries };
}

/** "Claude Code · Opus 5.5" for the summary line, or null when no model is set. */
export function useHandoffModelSummary(
  sourceEnvironmentId: EnvironmentId,
  destinationEnvironmentId: EnvironmentId | null,
  value: ModelSelection | null,
): string | null {
  const { entries } = useHandoffProviders(sourceEnvironmentId, destinationEnvironmentId);
  if (value === null) return null;
  const label = modelLabel(
    entries.find((entry) => entry.instanceId === value.instanceId) ?? null,
    value.instanceId,
    value.model,
  );
  return label.provider ? `${label.provider} · ${label.model}` : label.model;
}

/** Picks the provider and model the thread continues with; `value` null means none is set yet. */
export function HandoffModelPicker(props: {
  sourceEnvironmentId: EnvironmentId;
  destinationEnvironmentId: EnvironmentId | null;
  value: ModelSelection | null;
  disabled?: boolean;
  /** Names the trigger for screen readers, e.g. "Model on Minis". */
  ariaLabel?: string;
  onChange: (selection: ModelSelection) => void;
}) {
  const { providers, settings, entries } = useHandoffProviders(
    props.sourceEnvironmentId,
    props.destinationEnvironmentId,
  );
  // With no model yet, the list opens on the default provider and nothing reads as chosen.
  const shown = props.value ?? resolveDefaultProviderModelSelection(providers, null);
  const modelOptions = useMemo(
    () =>
      getCustomModelOptionsByInstance(
        settings,
        providers,
        shown?.instanceId ?? null,
        shown?.model ?? null,
      ),
    [settings, providers, shown?.instanceId, shown?.model],
  );
  if (shown === null)
    return <p className="text-xs text-muted-foreground">No models are set up there yet.</p>;
  return (
    <ProviderModelPicker
      activeInstanceId={shown.instanceId}
      model={shown.model}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={modelOptions}
      isComposerOwned={false}
      disabled={props.disabled ?? false}
      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
      triggerAriaLabel={props.ariaLabel ?? "Model on the destination"}
      {...(props.value === null ? { unset: true, triggerLabel: "Choose a model" } : {})}
      onInstanceModelChange={(instanceId, model) =>
        props.onChange(createModelSelection(instanceId, model))
      }
    />
  );
}
