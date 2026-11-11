/**
 * The coordinator's model chip under its composer. Clicking it opens the
 * project's Models popover (coordinator model, model and effort for new
 * threads, the machines it runs on); each is a project setting, so a choice
 * saves at once and every window follows it. The coordinator's effort is not
 * set here: it runs at Medium, capped at High, from Project settings.
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
import { modelLabel } from "../../../studio/shellModel";
import { fallbackModelState, modelStateText, type ModelState } from "../../chat/ModelStateTag";
import { ProviderModelPicker } from "../../chat/ProviderModelPicker";
import { MachineLimitsButton, MachineLimitsPanel } from "./ProjectUsageIndicator";
import { ProjectModelsPopover, type ProjectThreadModel } from "./ProjectModelsPopover";
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
    /** The saved pick cannot run at all (not prepared, off, signed out), rather than limited. */
    setup?: boolean;
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
  /**
   * The model new threads start on. With it, the chip opens the Models popover;
   * without it (a host that cannot save it), the chip opens the model list.
   */
  threads?: ProjectThreadModel | null;
  /** The machines the project runs on, its coordinator's first. */
  machines?: ReadonlyArray<{ readonly environmentId: string; readonly label?: string }>;
  /** The project's name, beside the choice a picker names. */
  projectTitle?: string;
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
          reason: running.returnsTo ? (running.setup ? "not set up" : "usage limit") : null,
          detail: running.reason ?? null,
        })
      : null;
  // The header names the pick the way the chip's state does, so a twin of the
  // running model is told apart by its provider or account, never named twice.
  const fallbackDetail = fallbackState
    ? [
        running?.reason,
        running?.returnsTo
          ? `The next turn after it ${running.setup ? "can run" : "has room"} goes back to ${fallbackState.pickModel} on its own.`
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
              text: `Goes back to ${fallbackState.pickModel} on its own once it ${running?.setup ? "can run" : "has room"}.`,
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
          title="Coordinator model"
          {...(props.projectTitle ? { titleContext: props.projectTitle } : {})}
          {...(props.threads
            ? {
                frontView: {
                  render: ({ openPicker, close }) => (
                    <ProjectModelsPopover
                      environmentId={props.environmentId}
                      entries={entries}
                      providers={providers}
                      modelOptionsByInstance={options}
                      coordinator={value ?? current}
                      onChooseCoordinator={openPicker}
                      threads={props.threads!}
                      machines={props.machines ?? []}
                      planModeEnabled={settings.planModeEnabled}
                      disabled={props.saving}
                      onOpenSettings={props.onOpenSettings}
                      onClose={close}
                    />
                  ),
                },
              }
            : {})}
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
      </span>
    );
  };
  const folderProblem = props.requiresFolderGrants
    ? coordinatorFolderCompatibility(
        true,
        active?.driverKind,
        props.folderPolicy,
        active?.snapshot?.supportedRuntimeModes,
      )
    : null;
  return (
    <span
      className="inline-flex min-w-0 flex-col items-start gap-1"
      data-coordinator-model-controls=""
    >
      {content()}
      {/* Only a problem is said here. That additional folders need Codex, Claude or Muse
          Code is said where folders are added, in Project settings > Environment. */}
      {folderProblem ? (
        <span
          className="max-w-xl text-xs leading-relaxed text-muted-foreground"
          role="status"
          data-coordinator-folder-guidance=""
        >
          {folderProblem}
        </span>
      ) : null}
    </span>
  );
}
