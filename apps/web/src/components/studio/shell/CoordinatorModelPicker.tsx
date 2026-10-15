/**
 * The coordinator's model and effort, chosen under the composer. Both are
 * project settings, so a choice saves at once and every window follows it.
 */
import {
  type CoordinatorFolderPolicy,
  coordinatorFolderCompatibility,
} from "../coordinatorRecovery";
import { useNavigate } from "@tanstack/react-router";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInstanceId,
} from "@specweave-studio/contracts";
import { createModelSelection } from "@specweave-studio/shared/model";
import { useEffect, useRef, useState } from "react";
import { useEnvironmentSettings } from "../../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  sortProviderInstanceEntries,
} from "../../../providerInstances";
import { useEnvironment } from "../../../state/environments";
import { serverEnvironment } from "../../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { COORDINATOR_RECOMMENDED_TRAITS, modelLabel } from "../../../studio/shellModel";
import { ProviderModelPicker } from "../../chat/ProviderModelPicker";
import { TraitsPicker } from "../../chat/TraitsPicker";
import { ModelBadge, ModelBadgeMark } from "./ModelBadge";
import { useCoordinatorModelsLoading } from "./useCoordinatorModelsLoading";

function CoordinatorProviderRecovery(props: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  saving: boolean;
}) {
  const canRefresh = useEnvironmentScope(props.environmentId, AuthOrchestrationReadScope);
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const checkAgain = async () => {
    if (
      props.saving ||
      inFlight.current ||
      !readEnvironmentScope(props.environmentId, AuthOrchestrationReadScope)
    )
      return;
    inFlight.current = true;
    setPending(true);
    setFailed(false);
    try {
      const result = await refresh({
        environmentId: props.environmentId,
        input: { instanceId: props.instanceId, refreshModels: true },
      });
      if (mounted.current) setFailed(result._tag === "Failure");
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  };

  if (!canRefresh) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <button
        type="button"
        className="sws-model-trigger"
        disabled={props.saving || pending}
        aria-busy={pending}
        onClick={() => void checkAgain()}
      >
        {pending ? "Checking…" : "Check again"}
      </button>
      {failed ? (
        <span
          role="alert"
          className="text-destructive-foreground text-xs"
          title="Provider status could not be checked. Try again."
        >
          Check failed
        </span>
      ) : null}
    </span>
  );
}

export function CoordinatorModelPicker(props: {
  environmentId: EnvironmentId;
  value: ModelSelection | null;
  disabled: boolean;
  saving: boolean;
  requiresFolderGrants?: boolean;
  folderPolicy?: CoordinatorFolderPolicy;
  onChange: (value: ModelSelection) => void;
  /** Legacy project-settings callback; provider setup opens its machine-scoped route. */
  onOpenSettings: () => void;
}) {
  const navigate = useNavigate();
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
  const openProviderSetup = (instanceId?: ProviderInstanceId) => {
    if (props.disabled || props.saving) return;
    void navigate({
      to: "/settings/providers",
      search: { environmentId: props.environmentId, ...(instanceId ? { instanceId } : {}) },
    });
  };
  const getModelDisabledReason = (id: ProviderInstanceId, model: string) => {
    const entry = entries.find((candidate) => candidate.instanceId === id);
    const compatibility = coordinatorFolderCompatibility(
      props.requiresFolderGrants === true,
      entry?.driverKind,
      props.folderPolicy,
      entry?.snapshot?.supportedRuntimeModes,
    );
    if (compatibility) return compatibility;
    return entry &&
      isProviderInstancePickerReady(entry) &&
      options.get(id)?.some((option) => option.slug === model && !option.isUnavailable)
      ? null
      : "Unavailable on this host";
  };
  const changeModel = (id: ProviderInstanceId, model: string) => {
    if (props.disabled || props.saving || getModelDisabledReason(id, model)) return;
    if (value && id === value.instanceId && model === value.model) return;
    // Effort and other traits belong to the model they were chosen for.
    props.onChange(createModelSelection(id, model));
  };

  const content = () => {
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
      const first = available.find(
        (entry) =>
          isProviderInstancePickerReady(entry) &&
          !coordinatorFolderCompatibility(
            props.requiresFolderGrants === true,
            entry.driverKind,
            props.folderPolicy,
            entry.snapshot?.supportedRuntimeModes,
          ),
      );
      if (!first || props.disabled)
        return (
          <button
            type="button"
            className="sws-model-pick sws-model-pick-empty"
            disabled={props.disabled || props.saving}
            onClick={() => openProviderSetup()}
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
            disabled={props.saving}
            getModelDisabledReason={getModelDisabledReason}
            onOpenProviderSetup={openProviderSetup}
            onManageProviders={() => openProviderSetup()}
            onInstanceModelChange={changeModel}
          />
        </span>
      );
    }
    const label = modelLabel(active, value.instanceId, value.model);
    const recovery =
      !props.disabled &&
      getModelDisabledReason(value.instanceId, value.model) &&
      !coordinatorFolderCompatibility(
        props.requiresFolderGrants === true,
        active?.driverKind,
        props.folderPolicy,
        active?.snapshot?.supportedRuntimeModes,
      ) ? (
        <CoordinatorProviderRecovery
          key={`${props.environmentId}:${value.instanceId}`}
          environmentId={props.environmentId}
          instanceId={value.instanceId}
          saving={props.saving}
        />
      ) : null;
    // A saved instance that is gone from this host can still be replaced by one that is here.
    if (available.length === 0 || props.disabled)
      return (
        // Nothing to pick from on this host right now; still say what the coordinator runs on.
        <span className="sws-model-pick sws-model-pick-static">
          <span role="img" aria-label={`Coordinator model: ${label.full}`}>
            <ModelBadge
              entry={active}
              instanceId={value.instanceId}
              model={value.model}
              variant="chip"
            />
          </span>
          {!props.disabled ? (
            <button
              type="button"
              className="sws-model-trigger"
              disabled={props.saving}
              onClick={() => openProviderSetup(active?.instanceId)}
            >
              Add or manage providers
            </button>
          ) : null}
          {recovery}
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
          getModelDisabledReason={getModelDisabledReason}
          onOpenProviderSetup={openProviderSetup}
          onManageProviders={() => openProviderSetup()}
          onInstanceModelChange={changeModel}
        />
        {recovery}
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
  };
  return (
    <span className="inline-flex min-w-0 flex-col items-start gap-1">
      {content()}
      {props.requiresFolderGrants ? (
        <span
          className="max-w-xl text-xs leading-relaxed text-muted-foreground"
          role="status"
          data-coordinator-folder-guidance=""
        >
          {coordinatorFolderCompatibility(
            true,
            active?.driverKind,
            props.folderPolicy,
            active?.snapshot?.supportedRuntimeModes,
          ) ??
            (active?.driverKind === "acpRegistry"
              ? "Project folders use this coordinator’s existing full-access permissions."
              : "Additional folders are available with Codex and Claude.")}
        </span>
      ) : null}
    </span>
  );
}
