/**
 * The project's models in one place, opened from the coordinator's model chip:
 * the coordinator's model, the model new threads start on and their effort,
 * and the machines the project runs on. It reads and writes the same project
 * settings as Project settings > General, so the two always agree; a thread's
 * own model stays in that thread's composer.
 */
import type {
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  ServerProvider,
} from "@specweave-studio/contracts";
import {
  COORDINATOR_EFFORT_CAP_LABEL,
  coordinatorEffortIsCapped,
} from "@specweave-studio/shared/coordinatorDefault";
import { modelSelectionEffortValue } from "@specweave-studio/shared/effortLevel";
import { createModelSelection } from "@specweave-studio/shared/model";
import { ChevronRightIcon, Code2Icon, ZapIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { ProviderInstanceEntry } from "../../../providerInstances";
import { useMachineIdentities } from "../../../studio/machineIdentity";
import { modelLabel } from "../../../studio/shellModel";
import { effortLevelLabel } from "../../chat/EffortGlyph";
import { ProviderInstanceIcon } from "../../chat/ProviderInstanceIcon";
import { ProviderModelPicker } from "../../chat/ProviderModelPicker";
import type { ModelEsque } from "../../chat/providerIconUtils";
import { useTraitsEffortControl } from "../../chat/TraitsPicker";
import { MachineChip } from "../../MachineChip";

/** The model new threads start on, as the project saves it. */
export interface ProjectThreadModel {
  /** The project's own choice; null follows the app default. */
  readonly value: ModelSelection | null;
  /** What threads start on while the project has no choice of its own. */
  readonly inherited: ModelSelection | null;
  readonly saving: boolean;
  /** Saves the project's choice; null goes back to the app default. */
  readonly onChange: (value: ModelSelection | null) => void;
}

const hasBoolean = (
  entry: ProviderInstanceEntry | null,
  model: string | undefined,
  id: string,
): boolean =>
  entry?.models
    .find((candidate) => candidate.slug === model)
    ?.capabilities?.optionDescriptors?.some(
      (descriptor) => descriptor.id === id && descriptor.type === "boolean",
    ) === true;

function Row(props: {
  readonly title: string;
  readonly note: ReactNode;
  readonly children: ReactNode;
  readonly row: string;
}) {
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/70 px-3 py-2.5 first:border-t-0"
      data-project-models-row={props.row}
    >
      <div className="min-w-0 flex-1 basis-32">
        <div className="text-sm font-semibold text-foreground">{props.title}</div>
        <div className="text-xs leading-snug text-muted-foreground">{props.note}</div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
        {props.children}
      </div>
    </div>
  );
}

const TOGGLE =
  "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-(--disabled-opacity)";

export function ProjectModelsPopover(props: {
  readonly environmentId: EnvironmentId;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  /** The saved coordinator model, or the one it runs on while none is saved. */
  readonly coordinator: ModelSelection;
  /** Opens the picker titled "Coordinator model". */
  readonly onChooseCoordinator: () => void;
  readonly threads: ProjectThreadModel;
  /** The machines the project runs on, its coordinator's first. */
  readonly machines: ReadonlyArray<{ readonly environmentId: string; readonly label?: string }>;
  readonly planModeEnabled: boolean;
  readonly disabled: boolean;
  readonly onOpenSettings: () => void;
  readonly onClose: () => void;
}) {
  const { threads } = props;
  const entryOf = (selection: ModelSelection | null) =>
    selection
      ? (props.entries.find((entry) => entry.instanceId === selection.instanceId) ?? null)
      : null;
  const coordinatorEntry = entryOf(props.coordinator);
  const coordinatorName = modelLabel(
    coordinatorEntry,
    props.coordinator.instanceId,
    props.coordinator.model,
  );
  const capped = coordinatorEffortIsCapped(props.coordinator, props.providers);
  const savedEffort = modelSelectionEffortValue(props.coordinator);
  const coordinatorEffort = capped
    ? COORDINATOR_EFFORT_CAP_LABEL
    : savedEffort
      ? effortLevelLabel(savedEffort, savedEffort)
      : null;

  const thread = threads.value ?? threads.inherited;
  const threadEntry = entryOf(thread);
  const locked = props.disabled || threads.saving;
  const saveThread = (next: ModelSelection | null) => {
    if (!locked) threads.onChange(next);
  };
  const effort = useTraitsEffortControl(
    thread && threadEntry
      ? {
          provider: threadEntry.driverKind,
          instanceId: thread.instanceId,
          models: threadEntry.models,
          model: thread.model,
          prompt: "",
          onPromptChange: () => {},
          modelOptions: thread.options ?? [],
          allowPromptInjectedEffort: false,
          planModeEnabled: props.planModeEnabled,
          onModelOptionsChange: (traits) =>
            saveThread(createModelSelection(thread.instanceId, thread.model, traits)),
        }
      : null,
  );
  const offersUltracode = hasBoolean(threadEntry, thread?.model, "ultracode");
  const ultracodeOn =
    thread?.options?.some((option) => option.id === "ultracode" && option.value === true) === true;
  const identityOf = useMachineIdentities();
  const firstReady = props.entries.find((entry) => entry.enabled && entry.isAvailable);

  return (
    <div
      className="w-screen max-w-[min(27rem,calc(100vw-1.5rem))] text-sm"
      role="group"
      aria-label="Models for this project"
      data-project-models-popover=""
      data-sws-picker=""
    >
      <Row
        row="coordinator"
        title="Coordinator"
        note={
          <>
            Plans, routes and replies to you.
            {coordinatorEffort ? (
              <span className="block" data-coordinator-effort-note="">
                {capped
                  ? `Coordinator effort is capped at ${COORDINATOR_EFFORT_CAP_LABEL}.`
                  : `${coordinatorEffort} effort. Change it in Project settings › General › Advanced.`}
              </span>
            ) : null}
          </>
        }
      >
        <button
          type="button"
          className="inline-flex h-8 max-w-56 min-w-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-(--disabled-opacity)"
          aria-label={`Coordinator model: ${coordinatorName.full}. Change`}
          disabled={props.disabled}
          onClick={props.onChooseCoordinator}
          data-project-models-choose="coordinator"
        >
          {coordinatorEntry ? (
            <ProviderInstanceIcon
              driverKind={coordinatorEntry.driverKind}
              displayName={coordinatorEntry.displayName}
              accentColor={coordinatorEntry.accentColor}
              acpRegistryAgentId={coordinatorEntry.acpRegistryAgentId}
              acpRegistryIconUrl={coordinatorEntry.acpRegistryIconUrl}
              showBadge={false}
              className="size-4 shrink-0"
              iconClassName="size-4"
            />
          ) : null}
          <span className="min-w-0 truncate">{coordinatorName.model}</span>
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </Row>

      <Row
        row="threads"
        title="New threads"
        note={
          threads.value
            ? "Workers the coordinator starts. Set for this project."
            : "Workers the coordinator starts. Follows the app default."
        }
      >
        {thread && threadEntry ? (
          <ProviderModelPicker
            activeInstanceId={thread.instanceId}
            model={thread.model}
            lockedProvider={null}
            instanceEntries={props.entries}
            modelOptionsByInstance={props.modelOptionsByInstance}
            title="Model for new threads"
            triggerAriaLabel={`Model for new threads: ${modelLabel(threadEntry, thread.instanceId, thread.model).full}. Change model`}
            disabled={locked}
            onInstanceModelChange={(id, model) => saveThread(createModelSelection(id, model))}
          />
        ) : firstReady ? (
          <ProviderModelPicker
            activeInstanceId={firstReady.instanceId}
            model=""
            unset
            lockedProvider={null}
            instanceEntries={props.entries}
            modelOptionsByInstance={props.modelOptionsByInstance}
            title="Model for new threads"
            triggerLabel="Choose model"
            triggerAriaLabel="Model for new threads: choose model"
            disabled={locked}
            onInstanceModelChange={(id, model) => saveThread(createModelSelection(id, model))}
          />
        ) : (
          <span className="text-xs text-muted-foreground">No provider is ready here.</span>
        )}
        {threads.value ? (
          <button
            type="button"
            className="rounded px-1 text-xs font-medium text-muted-foreground underline decoration-border underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            disabled={locked}
            onClick={() => saveThread(null)}
            data-project-models-use-default=""
          >
            Use default
          </button>
        ) : null}
      </Row>

      {effort && (effort.options.length > 0 || effort.fast || offersUltracode) ? (
        <Row
          row="effort"
          title="Effort for new threads"
          note="Each thread can still change its own."
        >
          {effort.options.length > 0 ? (
            <div
              role="radiogroup"
              aria-label="Effort for new threads"
              className="inline-flex flex-wrap rounded-full border border-border p-0.5"
              data-project-models-effort=""
            >
              {effort.options.map((option) => {
                const on = option.id === effort.value;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={locked || effort.locked !== null}
                    className={cn(
                      "h-6 rounded-full px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      on
                        ? "bg-primary/15 font-semibold text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => effort.select(option.id)}
                    data-effort-option={option.id}
                  >
                    {effortLevelLabel(option.id, option.label)}
                  </button>
                );
              })}
            </div>
          ) : null}
          {effort.fast ? (
            <button
              type="button"
              aria-pressed={effort.fast.on}
              disabled={locked}
              className={cn(
                TOGGLE,
                effort.fast.on
                  ? "border-primary/45 bg-primary/12 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
              onClick={effort.fast.toggle}
              data-project-models-fast=""
            >
              <ZapIcon className="size-3" aria-hidden />
              Fast
            </button>
          ) : null}
          {offersUltracode && thread ? (
            <button
              type="button"
              aria-pressed={ultracodeOn}
              disabled={locked}
              className={cn(
                TOGGLE,
                ultracodeOn
                  ? "border-primary/45 bg-primary/12 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
              onClick={() =>
                saveThread(
                  createModelSelection(thread.instanceId, thread.model, [
                    ...(thread.options ?? []).filter((option) => option.id !== "ultracode"),
                    { id: "ultracode", value: !ultracodeOn },
                  ]),
                )
              }
              data-project-models-ultracode=""
            >
              <Code2Icon className="size-3" aria-hidden />
              Ultracode
            </button>
          ) : null}
        </Row>
      ) : null}

      {props.machines.length > 0 ? (
        <Row row="machines" title="Runs on" note="The coordinator's machine first.">
          {props.machines.map((machine) => (
            <MachineChip
              key={machine.environmentId}
              identity={identityOf(machine.environmentId, machine.label)}
            />
          ))}
        </Row>
      ) : null}

      <div className="flex items-center justify-between gap-2 border-t border-border/70 px-3 py-2 text-xs text-muted-foreground">
        <span>Applies to this project.</span>
        <button
          type="button"
          className="rounded px-1 font-semibold text-foreground underline decoration-primary/60 underline-offset-2 outline-none hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            props.onClose();
            props.onOpenSettings();
          }}
          data-project-models-settings=""
        >
          Project settings
        </button>
      </div>
    </div>
  );
}
