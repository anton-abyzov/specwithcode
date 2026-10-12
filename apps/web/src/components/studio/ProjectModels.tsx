import type { EnvironmentId, ModelSelection } from "@specweave-studio/contracts";
import { createModelSelection } from "@specweave-studio/shared/model";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";

/** Choose from this host's actual model catalog; never invent a coordinator default. */
export function ProjectModels({
  environmentId,
  value,
  onChange,
  disabled,
  label,
  recommendedTraits,
}: {
  environmentId: EnvironmentId;
  value: ModelSelection | null;
  onChange: (value: ModelSelection) => void;
  disabled: boolean;
  label: string;
  /** Trait values advised for this role, shown with a Recommended badge. */
  recommendedTraits?: Readonly<Record<string, string>>;
}) {
  const environment = useEnvironment(environmentId);
  const settings = useEnvironmentSettings(environmentId);
  const providers = environment?.serverConfig?.providers ?? [];
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const options = getCustomModelOptionsByInstance(
    settings,
    providers,
    value?.instanceId,
    value?.model,
  );
  const active = entries.find((p) => p.instanceId === value?.instanceId);
  // The searchable list only fills for a ready provider; the plain list below covers the rest.
  const firstAvailable = entries.find(isProviderInstancePickerReady);
  return (
    <fieldset disabled={disabled} className="project-model-field">
      <legend>{label}</legend>
      {value && active ? (
        <div className="project-model-controls">
          <ProviderModelPicker
            activeInstanceId={value.instanceId}
            model={value.model}
            lockedProvider={null}
            instanceEntries={entries}
            modelOptionsByInstance={options}
            getModelDisabledReason={(id, model) => {
              const p = entries.find((e) => e.instanceId === id);
              return p?.enabled &&
                p.isAvailable &&
                options.get(id)?.some((m) => m.slug === model && !m.isUnavailable)
                ? null
                : "Unavailable on this host";
            }}
            onInstanceModelChange={(id, model) => onChange(createModelSelection(id, model))}
          />
          <TraitsPicker
            provider={active.driverKind}
            models={active.models}
            model={value.model}
            prompt=""
            onPromptChange={() => {}}
            modelOptions={value.options ?? []}
            allowPromptInjectedEffort={false}
            planModeEnabled={settings.planModeEnabled}
            recommendedOptionValues={recommendedTraits}
            onModelOptionsChange={(o) =>
              onChange(createModelSelection(value.instanceId, value.model, o))
            }
          />
        </div>
      ) : firstAvailable ? (
        // Nothing chosen yet: the same list as everywhere else, opened on the first usable provider.
        <div className="project-model-controls">
          <ProviderModelPicker
            activeInstanceId={firstAvailable.instanceId}
            model=""
            unset
            lockedProvider={null}
            instanceEntries={entries}
            modelOptionsByInstance={options}
            triggerLabel="Choose model"
            triggerAriaLabel={`${label}: choose model`}
            onInstanceModelChange={(id, model) => onChange(createModelSelection(id, model))}
          />
        </div>
      ) : (
        <select
          aria-label={label}
          value=""
          onChange={(e) => {
            const [id, model] = JSON.parse(e.target.value) as [string, string];
            const entry = entries.find((p) => p.instanceId === id);
            if (entry) onChange(createModelSelection(entry.instanceId, model));
          }}
        >
          <option value="" disabled>
            Select an available model
          </option>
          {entries
            .filter((e) => e.enabled && e.isAvailable)
            .flatMap((e) =>
              (options.get(e.instanceId) ?? [])
                .filter((m) => !m.isUnavailable)
                .map((m) => (
                  <option
                    key={`${e.instanceId}:${m.slug}`}
                    value={JSON.stringify([e.instanceId, m.slug])}
                  >
                    {e.displayName} · {m.name ?? m.slug}
                  </option>
                )),
            )}
        </select>
      )}
      {entries.every((e) => !e.enabled || !e.isAvailable) && (
        <p className="project-muted">Connect a native provider on this host to choose a model.</p>
      )}
    </fieldset>
  );
}
