/**
 * The coordinator's model and effort, chosen under the composer. Both are
 * project settings, so a choice saves at once and every window follows it.
 */
import type { EnvironmentId, ModelSelection } from "@specweave-studio/contracts";
import { createModelSelection } from "@specweave-studio/shared/model";
import { useEnvironmentSettings } from "../../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  sortProviderInstanceEntries,
} from "../../../providerInstances";
import { useEnvironment } from "../../../state/environments";
import { COORDINATOR_RECOMMENDED_TRAITS, modelLabel } from "../../../studio/shellModel";
import { ProviderModelPicker } from "../../chat/ProviderModelPicker";
import { TraitsPicker } from "../../chat/TraitsPicker";
import { ModelBadge, ModelBadgeMark } from "./ModelBadge";
import { useCoordinatorModelsLoading } from "./useCoordinatorModelsLoading";

export function CoordinatorModelPicker(props: {
  environmentId: EnvironmentId;
  value: ModelSelection | null;
  disabled: boolean;
  saving: boolean;
  onChange: (value: ModelSelection) => void;
  /** No model can be listed here, so the full settings are the way to one. */
  onOpenSettings: () => void;
}) {
  const environment = useEnvironment(props.environmentId);
  const settings = useEnvironmentSettings(props.environmentId);
  const providers = environment?.serverConfig?.providers ?? [];
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const options = getCustomModelOptionsByInstance(
    settings,
    providers,
    props.value?.instanceId,
    props.value?.model,
  );
  const value = props.value;
  const active = value
    ? (entries.find((entry) => entry.instanceId === value.instanceId) ?? null)
    : null;
  const available = entries.filter((entry) => entry.enabled && entry.isAvailable);
  const modelsLoading = useCoordinatorModelsLoading(environment?.serverConfig);

  if (!value) {
    // Providers have not arrived from the host or are still being checked: nothing is
    // missing yet, so ask for nothing.
    if (modelsLoading)
      return (
        <span className="sws-model-pick sws-model-pick-loading" role="status">
          Loading models
          <span className="sr-only"> for the coordinator</span>
        </span>
      );
    // The list only fills for a provider that is ready; without one, settings explain why.
    const first = available.find(isProviderInstancePickerReady);
    if (!first || props.disabled)
      return (
        <button
          type="button"
          className="sws-model-pick sws-model-pick-empty"
          onClick={props.onOpenSettings}
        >
          Choose model
          <span className="sr-only"> for the coordinator</span>
        </button>
      );
    return (
      // Nothing saved yet: pick here, and the first choice becomes the project's setting.
      <span
        className="sws-model-pick sws-model-pick-unset"
        data-saving={props.saving ? "true" : undefined}
      >
        <ProviderModelPicker
          // The same instance once a model is saved, so focus stays on the trigger.
          key="model"
          activeInstanceId={first.instanceId}
          model=""
          unset
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={options}
          size="sm"
          triggerClassName="sws-model-trigger"
          triggerLabel="Choose model"
          triggerAriaLabel="Choose model for the coordinator"
          onInstanceModelChange={(id, model) => {
            if (!props.saving) props.onChange(createModelSelection(id, model));
          }}
        />
      </span>
    );
  }
  const label = modelLabel(active, value.instanceId, value.model);
  // A saved instance that is gone from this host can still be replaced by one that is here.
  if (available.length === 0 || props.disabled)
    return (
      // Nothing to pick from on this host right now; still say what the coordinator runs on.
      <span
        className="sws-model-pick sws-model-pick-static"
        role="img"
        aria-label={`Coordinator model: ${label.full}`}
      >
        <ModelBadge
          entry={active}
          instanceId={value.instanceId}
          model={value.model}
          variant="chip"
        />
      </span>
    );
  return (
    <span className="sws-model-pick" data-saving={props.saving ? "true" : undefined}>
      <ModelBadgeMark entry={active} instanceId={value.instanceId} provider={label.provider} />
      <ProviderModelPicker
        key="model"
        activeInstanceId={value.instanceId}
        model={value.model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        size="sm"
        triggerClassName="sws-model-trigger"
        triggerLabel={`${label.provider} · ${label.model}`}
        triggerAriaLabel={`Coordinator model: ${label.full}. Change model`}
        disabled={props.saving}
        getModelDisabledReason={(id, model) => {
          const entry = entries.find((candidate) => candidate.instanceId === id);
          return entry?.enabled &&
            entry.isAvailable &&
            options.get(id)?.some((option) => option.slug === model && !option.isUnavailable)
            ? null
            : "Unavailable on this host";
        }}
        onInstanceModelChange={(id, model) => {
          if (id === value.instanceId && model === value.model) return;
          // Effort and other traits belong to the model they were chosen for.
          props.onChange(createModelSelection(id, model));
        }}
      />
      {active ? (
        <TraitsPicker
          provider={active.driverKind}
          instanceId={value.instanceId}
          models={active.models}
          model={value.model}
          prompt=""
          onPromptChange={() => {}}
          modelOptions={value.options ?? []}
          allowPromptInjectedEffort={false}
          planModeEnabled={settings.planModeEnabled}
          triggerClassName="sws-model-trigger sws-effort-trigger"
          triggerAriaLabelPrefix="Coordinator effort"
          recommendedOptionValues={COORDINATOR_RECOMMENDED_TRAITS}
          disabled={props.saving}
          onModelOptionsChange={(traits) =>
            props.onChange(createModelSelection(value.instanceId, value.model, traits))
          }
        />
      ) : null}
    </span>
  );
}
