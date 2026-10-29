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
import { useEffect, useMemo, useRef, useState } from "react";
import { useEnvironmentSettings } from "../../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerSelectable,
  sortProviderInstanceEntries,
} from "../../../providerInstances";
import { useEnvironment } from "../../../state/environments";
import { serverEnvironment } from "../../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useMachineNickname } from "../../../studio/machineNickname";
import { COORDINATOR_RECOMMENDED_TRAITS, modelLabel } from "../../../studio/shellModel";
import { fallbackModelState, modelStateText, type ModelState } from "../../chat/ModelStateTag";
import { ProviderModelPicker } from "../../chat/ProviderModelPicker";
import { MachineLimitsButton, MachineLimitsPanel } from "./ProjectUsageIndicator";
import { TraitsPicker } from "../../chat/TraitsPicker";
import { ModelBadge } from "./ModelBadge";
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
  /**
   * The coordinator runs on this instead of `value`, which remains the saved preference.
   * A return hint is present only while the saved provider is actually limited.
   */
  running?: {
    value: ModelSelection;
    returnsTo: string | null;
    /** The coordinator is off its saved pick (not just running before one is saved). */
    offPick?: boolean;
    reason?: string | null;
    onSwitchBack?: (() => void) | null;
    switching?: boolean;
  } | null;
  /** The model the host moves the next turn to while the shown one is out of room. */
  nextOnLimit?: string | null;
  /** The project's fallback models, best first, for the limits view. */
  fallbackOrder?: ReadonlyArray<{ readonly instanceId: string; readonly label: string }>;
  disabled: boolean;
  saving: boolean;
  requiresFolderGrants?: boolean;
  folderPolicy?: CoordinatorFolderPolicy;
  onChange: (value: ModelSelection) => void;
  /** Legacy project-settings callback; provider setup opens its machine-scoped route. */
  onOpenSettings: () => void;
  /** Opens the project's Usage tab from the menu's limits view. */
  onOpenProjectUsage?: () => void;
}) {
  const navigate = useNavigate();
  const environment = useEnvironment(props.environmentId);
  const settings = useEnvironmentSettings(props.environmentId);
  const providers = environment?.serverConfig?.providers ?? [];
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const value = props.value;
  // Display follows the admitted turn; choices still compare against the saved model.
  const running = props.running ?? null;
  const shown = running?.value ?? value;
  const options = getCustomModelOptionsByInstance(
    settings,
    providers,
    shown?.instanceId,
    shown?.model,
  );
  const active = value
    ? (entries.find((entry) => entry.instanceId === value.instanceId) ?? null)
    : null;
  const shownEntry = shown
    ? (entries.find((entry) => entry.instanceId === shown.instanceId) ?? null)
    : null;
  const savedLabel = value ? modelLabel(active, value.instanceId, value.model) : null;
  const fallbackState: Extract<ModelState, { kind: "fallback" }> | null =
    running?.offPick && savedLabel
      ? fallbackModelState({
          pick: { ...savedLabel, instance: active?.displayName ?? value!.instanceId },
          running: shown
            ? {
                ...modelLabel(shownEntry, shown.instanceId, shown.model),
                instance: shownEntry?.displayName ?? shown.instanceId,
              }
            : null,
          reason: running.returnsTo ? "usage limit" : null,
          detail: running.reason ?? null,
        })
      : null;
  // The header names the pick the way the chip's state does, so a twin of the
  // running model is told apart by its provider or account, never named twice.
  const fallbackDetail = fallbackState
    ? [
        running?.reason,
        running?.returnsTo
          ? `The next turn after it has room goes back to ${fallbackState.pickModel} on its own.`
          : null,
      ]
        .filter(Boolean)
        .join(" ") || undefined
    : undefined;
  const stateHeader = fallbackState
    ? {
        title: "Running on a fallback",
        detail:
          fallbackDetail ?? "The coordinator is running on a different model from your saved pick.",
        now: shown ? modelLabel(shownEntry, shown.instanceId, shown.model).full : null,
        pick: {
          label: fallbackState.pick,
          why: running?.reason
            ? `${running.reason.charAt(0).toUpperCase()}${running.reason.slice(1).replace(/\.?$/, ".")}`
            : "Not running on your saved pick.",
        },
        returns: running?.returnsTo
          ? {
              mode: "auto" as const,
              text: `Goes back to ${fallbackState.pickModel} on its own once it has room.`,
            }
          : {
              mode: "manual" as const,
              text: "It does not switch back on its own.",
            },
        back: running?.onSwitchBack
          ? {
              label: `Return to ${fallbackState.pickModel}`,
              onClick: running.onSwitchBack,
              disabledReason: props.saving || running.switching ? "Switching models…" : null,
            }
          : null,
      }
    : null;
  const available = entries.filter((entry) => entry.enabled && entry.isAvailable);
  const modelsLoading = useCoordinatorModelsLoading(environment?.serverConfig);
  const machineLabel = useMachineNickname(props.environmentId, environment?.label);
  // A host still connecting has no fresh read: its rows say so instead of guessing.
  const hostPhase = environment?.connection?.phase;
  const hostConnected = hostPhase !== "offline" && hostPhase !== "error";
  const nextOnLimit = props.nextOnLimit ?? null;
  const usage = useMemo(
    () => ({
      connected: hostConnected,
      environmentId: props.environmentId,
      machineLabel: machineLabel || null,
      running: null,
      nextOnLimit,
      surface: "coordinator" as const,
    }),
    [hostConnected, machineLabel, nextOnLimit, props.environmentId],
  );
  const openProviderSetup = (instanceId?: ProviderInstanceId) => {
    if (props.disabled || props.saving) return;
    void navigate({
      to: "/settings/providers",
      search: { environmentId: props.environmentId, ...(instanceId ? { instanceId } : {}) },
    });
  };
  const isSaved = (id: ProviderInstanceId, model: string) =>
    value !== null && id === value.instanceId && model === value.model;
  const hostDisabledReason = (id: ProviderInstanceId, model: string) => {
    const entry = entries.find((candidate) => candidate.instanceId === id);
    const compatibility = coordinatorFolderCompatibility(
      props.requiresFolderGrants === true,
      entry?.driverKind,
      props.folderPolicy,
      entry?.snapshot?.supportedRuntimeModes,
    );
    if (compatibility) return compatibility;
    return entry &&
      isProviderInstancePickerSelectable(entry) &&
      options.get(id)?.some((option) => option.slug === model && !option.isUnavailable)
      ? null
      : "Unavailable on this host";
  };
  const getModelDisabledReason = (id: ProviderInstanceId, model: string) => {
    const reason = hostDisabledReason(id, model);
    if (reason || !running?.offPick || !isSaved(id, model)) return reason;
    // On a fallback the saved row is the way back; say why it cannot be used yet.
    if (!running.onSwitchBack) return "Switching back isn't available here";
    return running.switching ? "Switching models…" : null;
  };
  const changeModel = (id: ProviderInstanceId, model: string) => {
    if (props.disabled || props.saving || getModelDisabledReason(id, model)) return;
    if (isSaved(id, model)) {
      // Picking the saved model while a fallback runs is the same explicit switch back as
      // the header's button; usage is advisory and the host keeps its own limit checks.
      if (running?.offPick) running.onSwitchBack?.();
      return;
    }
    // Effort and other traits belong to the model they were chosen for.
    props.onChange(createModelSelection(id, model));
  };

  const content = () => {
    if (!shown) {
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
          isProviderInstancePickerSelectable(entry) &&
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
    const current = shown;
    const label = modelLabel(shownEntry, current.instanceId, current.model);
    const recovery =
      !props.disabled &&
      value &&
      hostDisabledReason(value.instanceId, value.model) &&
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
          <span
            role="img"
            aria-label={`Coordinator model: ${label.full}${fallbackState ? modelStateText(fallbackState).aria : ""}`}
          >
            <ModelBadge
              entry={shownEntry}
              instanceId={current.instanceId}
              model={current.model}
              variant="chip"
              state={fallbackState}
              tooltip
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
          {!props.disabled ? (
            <MachineLimitsButton
              className="sws-model-trigger"
              projectEnvironmentId={props.environmentId}
              coordinatorInstanceId={current.instanceId}
              fallbackOrder={props.fallbackOrder ?? []}
              onOpenProjectUsage={props.onOpenProjectUsage}
            />
          ) : null}
          {recovery}
        </span>
      );
    return (
      <span className="sws-model-pick" data-saving={props.saving ? "true" : undefined}>
        <ProviderModelPicker
          key="model"
          activeInstanceId={current.instanceId}
          model={current.model}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={options}
          size="sm"
          triggerClassName="sws-model-trigger"
          triggerParts={{ provider: label.provider, model: label.model }}
          triggerState={fallbackState}
          triggerStateDetail={fallbackDetail}
          stateHeader={stateHeader}
          triggerAriaLabel={
            running
              ? `Coordinator model: running on ${label.full}${fallbackState ? modelStateText(fallbackState).aria : ""}${running.returnsTo ? `, back to ${running.returnsTo} after reset` : ""}. Change model`
              : `Coordinator model: ${label.full}. Change model`
          }
          disabled={props.saving}
          getModelDisabledReason={getModelDisabledReason}
          usage={usage}
          secondaryView={{
            label: "Limits by account",
            render: ({ back, close }) => (
              <MachineLimitsPanel
                projectEnvironmentId={props.environmentId}
                coordinatorInstanceId={current.instanceId}
                fallbackOrder={props.fallbackOrder ?? []}
                onBack={back}
                onClose={close}
                onOpenProjectUsage={
                  props.onOpenProjectUsage
                    ? () => {
                        close();
                        props.onOpenProjectUsage?.();
                      }
                    : undefined
                }
              />
            ),
          }}
          onOpenProviderSetup={openProviderSetup}
          onManageProviders={() => openProviderSetup()}
          onInstanceModelChange={changeModel}
        />
        {recovery}
        {/* Effort belongs to the saved model, which is not the one running now. */}
        {value && active && !running ? (
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
    <span
      className="inline-flex min-w-0 flex-col items-start gap-1"
      data-coordinator-model-controls=""
    >
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
              : "Additional folders are available with Codex, Claude and Muse Code.")}
        </span>
      ) : null}
    </span>
  );
}
