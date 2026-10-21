import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection } from "@specweave-studio/contracts";
import { createModelSelection } from "@specweave-studio/shared/model";
import { useMemo } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";

/**
 * Picks the provider and model the destination continues with. The list comes
 * from the destination when this window is connected to it, otherwise from the
 * source; the destination's preflight says whether the model is really there.
 */
export function HandoffModelPicker(props: {
  sourceEnvironmentId: EnvironmentId;
  destinationEnvironmentId: EnvironmentId | null;
  value: ModelSelection;
  disabled?: boolean;
  onChange: (selection: ModelSelection) => void;
}) {
  const destinationProviders = useAtomValue(
    serverEnvironment.providersValueAtom(
      props.destinationEnvironmentId ?? props.sourceEnvironmentId,
    ),
  );
  const sourceProviders = useAtomValue(
    serverEnvironment.providersValueAtom(props.sourceEnvironmentId),
  );
  const fromDestination = destinationProviders !== null && destinationProviders !== undefined;
  const providers =
    (fromDestination ? destinationProviders : sourceProviders) ?? EMPTY_SERVER_PROVIDERS;
  const settingsEnvironment = fromDestination
    ? (props.destinationEnvironmentId ?? props.sourceEnvironmentId)
    : props.sourceEnvironmentId;
  const settings = useEnvironmentSettings(settingsEnvironment);
  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const modelOptions = useMemo(
    () =>
      getCustomModelOptionsByInstance(
        settings,
        providers,
        props.value.instanceId,
        props.value.model,
      ),
    [settings, providers, props.value.instanceId, props.value.model],
  );
  return (
    <ProviderModelPicker
      activeInstanceId={props.value.instanceId}
      model={props.value.model}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={modelOptions}
      isComposerOwned={false}
      disabled={props.disabled ?? false}
      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
      triggerAriaLabel="Model on the destination"
      onInstanceModelChange={(instanceId, model) =>
        props.onChange(createModelSelection(instanceId, model))
      }
    />
  );
}
