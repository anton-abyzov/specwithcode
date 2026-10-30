import type {
  EnvironmentId,
  ModelSelection,
  ProviderLimitMachineTarget,
  ProviderLimitTargetOrder,
  ServerProvider,
} from "@specweave-studio/contracts";
import type { UnifiedSettings } from "@specweave-studio/contracts/settings";
import type { StudioFleetMachine } from "@specweave-studio/contracts/studioFleet";
import { createModelSelection } from "@specweave-studio/shared/model";
import {
  orderFallbackCandidates,
  sameMachineTarget,
} from "@specweave-studio/shared/machineFallback";
import { fallbackModelOrder } from "@specweave-studio/shared/providerFallback";
import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useNamedEnvironments } from "./useNamedEnvironments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useStudioFleet } from "../../studio/fleet";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { fallbackEntryLabel, MAX_FALLBACK_MODELS } from "./FallbackOrderList";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
} from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

// The fleet atom needs an id; one that matches no environment reads as no fleet.
const NO_ENVIRONMENT = "" as EnvironmentId;

const ORDER_LABELS: Record<ProviderLimitTargetOrder, string> = {
  "other-machine-first": "Other machines first",
  "same-machine-first": "This machine's models first",
};

/** "Minis · Claude · Opus 5.5": the machine, then the model as the fallback order names it. */
export function machineTargetLabel(
  target: ProviderLimitMachineTarget,
  machines: ReadonlyArray<Pick<StudioFleetMachine, "environmentId" | "label">>,
  providers: ReadonlyArray<ServerProvider>,
): string {
  const machine =
    machines.find((entry) => entry.environmentId === target.environmentId)?.label ??
    target.label ??
    "Unknown machine";
  const known = providers.some((entry) => entry.instanceId === target.modelSelection.instanceId);
  const model =
    !known && target.modelLabel
      ? target.modelLabel
      : fallbackEntryLabel(providers, target.modelSelection);
  return `${machine} · ${model}`;
}

export function moveMachineTarget(
  targets: ReadonlyArray<ProviderLimitMachineTarget>,
  index: number,
  by: -1 | 1,
): ReadonlyArray<ProviderLimitMachineTarget> {
  const to = index + by;
  if (index < 0 || index >= targets.length || to < 0 || to >= targets.length) return targets;
  const next = [...targets];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

/** Adds a target at the end; one already listed stays where it is. */
export function addMachineTarget(
  targets: ReadonlyArray<ProviderLimitMachineTarget>,
  target: ProviderLimitMachineTarget,
): ReadonlyArray<ProviderLimitMachineTarget> {
  if (targets.length >= MAX_FALLBACK_MODELS) return targets;
  if (targets.some((entry) => sameMachineTarget(entry, target))) return targets;
  return [...targets, target];
}

/**
 * Other paired machines a limited thread may move to, and which list goes
 * first. A machine counts only when its account differs from the one that ran
 * out, its usage is below the threshold, it is online, signed in, and its
 * work grant covers the project.
 */
export function MachineFallbackSettings() {
  const { target } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environments } = useNamedEnvironments();
  const environmentId = target?.environmentId ?? NO_ENVIRONMENT;
  const fleet = useStudioFleet(environmentId);
  const machines = (fleet.snapshot?.machines ?? []).filter(
    (machine) => machine.environmentId !== environmentId,
  );
  // Until the paired list arrives, no target is called unpaired or offline.
  const machinesKnown = fleet.snapshot !== null;
  const providersOn = (machineEnvironmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === machineEnvironmentId)
      ?.serverConfig?.providers ??
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.providers ??
    EMPTY_SERVER_PROVIDERS;
  const targets = settings.providerLimitMachineTargets;
  const order = settings.providerLimitTargetOrder;
  const saveTargets = (next: ReadonlyArray<ProviderLimitMachineTarget>) =>
    updateSettings({ providerLimitMachineTargets: [...next] });
  const mixedTargets = useScopedSettingsMixed(["providerLimitMachineTargets"]);
  const mixedOrder = useScopedSettingsMixed(["providerLimitTargetOrder"]);
  const mixedUnknown = useScopedSettingsMixed(["providerLimitUnknownUsageEligible"]);
  const addMachine = (machineEnvironmentId: string) => {
    const machine = machines.find((entry) => entry.environmentId === machineEnvironmentId);
    if (!machine) return;
    const providers = providersOn(machine.environmentId);
    const selection = resolveDefaultProviderModelSelection(providers, null);
    if (!selection) return;
    saveTargets(
      addMachineTarget(targets, {
        environmentId: machine.environmentId,
        label: machine.label,
        modelSelection: selection,
        modelLabel: fallbackEntryLabel(providers, selection),
      }),
    );
  };
  const preview = orderFallbackCandidates(order, fallbackModelOrder(settings), targets);

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["providerLimitMachineTargets"]}
        mixed={mixedTargets}
        id="provider-limit-machine-targets"
        title="Other machines"
        description="Paired machines a limited thread can move to, best first. The thread resumes there from its last checkpoint. A machine counts only when its account differs from the one that ran out, its usage is below the switch threshold, it is online, signed in to the provider, and its work grant covers this project."
        status={targets.length === 0 && !mixedTargets ? "This machine only" : undefined}
        resetAction={
          targets.length > 0 ? (
            <SettingResetButton label="other machines" onClick={() => saveTargets([])} />
          ) : null
        }
        control={
          machines.length > 0 ? (
            <Select
              value={null}
              onValueChange={(value) => {
                if (typeof value === "string") addMachine(value);
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label="Add a machine"
                disabled={targets.length >= MAX_FALLBACK_MODELS}
              >
                <SelectValue>{() => (mixedTargets ? "Mixed" : "Add machine")}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {machines.map((machine) => (
                  <SelectItem key={machine.environmentId} value={machine.environmentId}>
                    {machine.status === "reachable" ? machine.label : `${machine.label} (offline)`}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : (
            <span className="text-sm text-muted-foreground">
              {machinesKnown
                ? "No paired machines"
                : fleet.failed
                  ? "Couldn't read paired machines"
                  : "Checking paired machines"}
            </span>
          )
        }
      >
        {targets.length > 0 ? (
          <ol className="flex flex-col gap-1" aria-label="Machine targets">
            {targets.map((entry, index) => (
              <MachineTargetRow
                key={`${entry.environmentId}:${entry.modelSelection.instanceId}:${entry.modelSelection.model}`}
                index={index}
                count={targets.length}
                entry={entry}
                machines={machines}
                machinesKnown={machinesKnown}
                providers={providersOn(entry.environmentId)}
                settings={settings}
                onModel={(modelSelection, modelLabel) =>
                  saveTargets(
                    targets.map((existing, at) =>
                      at === index ? { ...existing, modelSelection, modelLabel } : existing,
                    ),
                  )
                }
                onMove={(by) => saveTargets(moveMachineTarget(targets, index, by))}
                onRemove={() => saveTargets(targets.filter((_, at) => at !== index))}
              />
            ))}
          </ol>
        ) : null}
        {targets.length > 0 && preview.length > 0 ? (
          <p className="text-xs text-muted-foreground" aria-label="Order tried">
            {`Tried in this order: ${preview
              .map((candidate) =>
                candidate.kind === "machine"
                  ? machineTargetLabel(
                      candidate.target,
                      machines,
                      providersOn(candidate.target.environmentId),
                    )
                  : `This machine · ${fallbackEntryLabel(providersOn(environmentId), candidate.modelSelection)}`,
              )
              .join(", then ")}.`}
          </p>
        ) : null}
      </SettingsRow>
      <SettingsRow
        serverScoped
        settingKeys={["providerLimitTargetOrder"]}
        mixed={mixedOrder}
        id="provider-limit-target-order"
        title="Try first"
        description="Which list a limited thread tries first: other machines, or this machine's fallback order. When nothing qualifies, the thread waits and the limit banner names the reason for each machine."
        resetAction={
          order !== "other-machine-first" ? (
            <SettingResetButton
              label="try first"
              onClick={() => updateSettings({ providerLimitTargetOrder: "other-machine-first" })}
            />
          ) : null
        }
        control={
          <Select
            value={mixedOrder ? null : order}
            onValueChange={(value) => {
              if (value === "other-machine-first" || value === "same-machine-first")
                updateSettings({ providerLimitTargetOrder: value });
            }}
          >
            <SelectTrigger size="sm" aria-label="Try first">
              <SelectValue>
                {(value: string | null) =>
                  value === "other-machine-first" || value === "same-machine-first"
                    ? ORDER_LABELS[value]
                    : "Mixed"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(ORDER_LABELS) as ProviderLimitTargetOrder[]).map((option) => (
                <SelectItem key={option} value={option}>
                  {ORDER_LABELS[option]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["providerLimitUnknownUsageEligible"]}
        mixed={mixedUnknown}
        id="provider-limit-unknown-usage"
        title="Use machines with unknown usage"
        description="Count a machine whose provider reports no usage as having room. Off by default: a machine that may be on the same account, or near its limit, is skipped."
        resetAction={
          settings.providerLimitUnknownUsageEligible ? (
            <SettingResetButton
              label="unknown usage"
              onClick={() => updateSettings({ providerLimitUnknownUsageEligible: false })}
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.providerLimitUnknownUsageEligible}
            onCheckedChange={(checked) =>
              updateSettings({ providerLimitUnknownUsageEligible: Boolean(checked) })
            }
            aria-label="Use machines with unknown usage"
          />
        }
      />
    </>
  );
}

function MachineTargetRow(props: {
  readonly index: number;
  readonly count: number;
  readonly entry: ProviderLimitMachineTarget;
  readonly machines: ReadonlyArray<StudioFleetMachine>;
  readonly machinesKnown: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  readonly onModel: (selection: ModelSelection, label: string) => void;
  readonly onMove: (by: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const { index, count, entry, machines, machinesKnown, providers, settings } = props;
  const label = machineTargetLabel(entry, machines, providers);
  const machine = machines.find((candidate) => candidate.environmentId === entry.environmentId);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    entry.modelSelection.instanceId,
    entry.modelSelection.model,
  );
  return (
    <li className="flex items-center gap-2 rounded-md border border-border/70 px-2 py-1 text-sm">
      <span className="w-4 text-right text-xs text-muted-foreground tabular-nums">{index + 1}</span>
      <span className="min-w-0 flex-1 break-words">
        {label}
        {!machinesKnown ? null : machine === undefined ? (
          <span className="ml-2 text-xs text-muted-foreground">not paired</span>
        ) : machine.status !== "reachable" ? (
          <span className="ml-2 text-xs text-muted-foreground">offline</span>
        ) : null}
      </span>
      {entries.length > 0 ? (
        <ProviderModelPicker
          activeInstanceId={entry.modelSelection.instanceId}
          model={entry.modelSelection.model}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={modelOptions}
          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
          triggerLabel="Model"
          triggerAriaLabel={`Change the model for ${label}`}
          onInstanceModelChange={(instanceId, model) => {
            const selection = createModelSelection(instanceId, model);
            props.onModel(selection, fallbackEntryLabel(providers, selection));
          }}
        />
      ) : null}
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Move ${label} up`}
        disabled={index === 0}
        onClick={() => props.onMove(-1)}
      >
        <ArrowUpIcon className="size-3" />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Move ${label} down`}
        disabled={index === count - 1}
        onClick={() => props.onMove(1)}
      >
        <ArrowDownIcon className="size-3" />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Remove ${label}`}
        onClick={props.onRemove}
      >
        <XIcon className="size-3" />
      </Button>
    </li>
  );
}
