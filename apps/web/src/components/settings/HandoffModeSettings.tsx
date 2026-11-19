import { useTx } from "../../i18n";
import {
  type AwayBringBack,
  type EnvironmentId,
  type HandoffConfig,
  type HandoffConfigPatch,
  type HandoffModeSnapshot,
  type ProjectId,
  awayConfigOf,
} from "@specweave-studio/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { useProjects } from "../../state/entities";
import { isArchivedMember } from "../../studio/projectListVisibility";
import { handoffMode, runHandoffMode, useHandoffModeSnapshot } from "../../studio/handoffMode";
import { requestHandOffMachine } from "../handoff/HandOffMachineDialog";
import { HandoffDestinationName, type HandoffDestination } from "../handoff/HandoffResults";
import { useHandoffDestinations } from "../handoff/useHandoffDestinations";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const NOTE_LABELS: Record<HandoffConfig["noteModel"], string> = {
  off: "Off",
  cheap: "Smaller model",
  thread: "Thread's model",
};
const BRING_BACK_LABELS: Record<AwayBringBack, string> = {
  prompt: "Ask",
  "auto-on-power": "Bring back automatically on power",
  manual: "Do nothing",
};
const isBringBack = (value: unknown): value is AwayBringBack =>
  value === "prompt" || value === "auto-on-power" || value === "manual";

/** A project on this machine whose own setting differs from the machine default. */
export interface HandoffModeOverride {
  readonly id: ProjectId;
  /** Null when the project is gone from this machine. */
  readonly title: string | null;
  readonly workspaceRoot?: string | undefined;
  readonly archived?: boolean;
  readonly mode: "on" | "off";
}

export interface HandoffModeSettingsViewProps {
  snapshot: HandoffModeSnapshot;
  destinations: readonly HandoffDestination[];
  /** Projects set On or Off on their own page; empty for almost everyone. */
  overrides?: ReadonlyArray<HandoffModeOverride>;
  pending: boolean;
  error: string | null;
  onConfig: (patch: HandoffConfigPatch) => void;
  onProjectMode: (projectId: ProjectId, mode: "on" | "off" | null) => void;
  onHandOffMachine: () => void;
}

/**
 * Settings > Machines > Moving work between machines, without data wiring so
 * fixtures can render it. One machine-wide default; a project is set on its own
 * page and a thread from its menu. Rare choices sit under More options.
 */
export function HandoffModeSettingsView(props: HandoffModeSettingsViewProps) {
  const tx = useTx();
  const { config } = props.snapshot;
  const sleepTarget = props.destinations.find((item) => item.environmentId === config.sleepTarget);
  const away = awayConfigOf(config);
  const awayOff = props.pending || config.sleepTarget === null;
  const overrides = props.overrides ?? [];
  return (
    <SettingsSection
      {...searchableSetting("handoff-mode")}
      headerAction={
        <Button size="xs" variant="outline" onClick={props.onHandOffMachine}>
          {tx("Move running threads…")}
        </Button>
      }
    >
      <SettingsRow
        title={tx("Keep threads ready to move")}
        description="After each turn, copies this machine's threads, existing ones too, to your other machines with the same project, so any of them can pick up. Uses a few more tokens."
        control={
          <Switch
            aria-label={tx("Keep threads ready to move")}
            checked={config.defaultMode === "on"}
            disabled={props.pending}
            onCheckedChange={(on) => props.onConfig({ defaultMode: on ? "on" : "off" })}
          />
        }
      >
        {overrides.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1.5" aria-label={tx("Projects set differently")}>
            {overrides.map((override) => (
              <li key={override.id} className="flex items-center justify-between gap-3 text-sm">
                <span
                  className="min-w-0 truncate text-muted-foreground"
                  title={override.workspaceRoot ?? undefined}
                >
                  {override.title ?? tx("A removed project")}
                  {override.archived ? " (archived)" : ""}:{" "}
                  {override.mode === "on" ? "On" : tx("Off")}
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={props.pending}
                  onClick={() => props.onProjectMode(override.id, null)}
                  aria-label={`Use the default for ${override.title ?? "the removed project"}`}
                >
                  {tx("Use default")}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </SettingsRow>
      <SettingsRow
        {...searchableSetting("handoff-sleep-target")}
        title="Away target"
        description="Where Away sends your threads, routines and coordinators when you leave this machine. Closing the lid moves nothing."
        control={
          <Select
            value={config.sleepTarget ?? "off"}
            disabled={props.pending}
            onValueChange={(value) =>
              props.onConfig({
                sleepTarget: value === "off" || value === null ? null : (value as EnvironmentId),
              })
            }
          >
            <SelectTrigger size="sm" aria-label={tx("Away target")}>
              <SelectValue>
                {sleepTarget ? (
                  <HandoffDestinationName destination={sleepTarget} />
                ) : config.sleepTarget ? (
                  tx("A removed machine")
                ) : (
                  tx("Off")
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="off">{tx("Off")}</SelectItem>
              {props.destinations.map((destination) => (
                <SelectItem key={destination.environmentId} value={destination.environmentId}>
                  <HandoffDestinationName destination={destination} />
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("away-bring-back")}
        title="When this machine wakes"
        description="After you left with Away. Ask shows one button to bring it back."
        control={
          <Select
            value={away.bringBack}
            disabled={awayOff}
            onValueChange={(value) => {
              if (isBringBack(value)) props.onConfig({ bringBack: value });
            }}
          >
            <SelectTrigger size="sm" aria-label={tx("When this machine wakes")}>
              <SelectValue>{BRING_BACK_LABELS[away.bringBack]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="prompt">{BRING_BACK_LABELS.prompt}</SelectItem>
              <SelectItem value="auto-on-power">{BRING_BACK_LABELS["auto-on-power"]}</SelectItem>
              <SelectItem value="manual">{BRING_BACK_LABELS.manual}</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <Collapsible data-slot="handoff-more-options">
        <CollapsibleTrigger className="group flex items-center gap-1 px-3 py-2 text-muted-foreground text-xs hover:text-foreground sm:px-4">
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 transition-transform group-data-panel-open:rotate-90"
          />
          {tx("More options")}
        </CollapsibleTrigger>
        <CollapsiblePanel keepMounted>
          <SettingsRow
            title={tx("Turn summary")}
            description="A short note at each turn end: what's done, what's next, open questions. It helps the next machine pick up."
            control={
              <Select
                value={config.noteModel}
                disabled={props.pending}
                onValueChange={(value) => {
                  if (value === "off" || value === "cheap" || value === "thread")
                    props.onConfig({ noteModel: value });
                }}
              >
                <SelectTrigger size="sm" aria-label={tx("Turn summary")}>
                  <SelectValue>{NOTE_LABELS[config.noteModel]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="off">{NOTE_LABELS.off}</SelectItem>
                  <SelectItem value="cheap">{NOTE_LABELS.cheap}</SelectItem>
                  <SelectItem value="thread">{NOTE_LABELS.thread}</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            title={tx("Also back up syncs to the repository's remote")}
            description="Pushes each sync to origin under refs/specwithcode/handoff, including uncommitted and untracked files. Moves don't need it. Your branches are never pushed."
            control={
              <Switch
                aria-label={tx("Also back up syncs to the repository's remote")}
                checked={config.pushToOrigin}
                disabled={props.pending}
                onCheckedChange={(pushToOrigin) => props.onConfig({ pushToOrigin })}
              />
            }
          />
        </CollapsiblePanel>
      </Collapsible>
      {(props.snapshot.pendingDisarm ?? []).map((machine) => (
        <p
          key={machine.environmentId}
          role="status"
          className="px-3 py-2 text-muted-foreground text-sm sm:px-4"
        >
          {tx(
            "Waiting for {machine} to confirm that silence no longer moves threads. Until it answers, a thread it could continue pauses here when it goes quiet.",
            { machine: machine.machineLabel },
          )}
        </p>
      ))}
      {props.error ? (
        <p role="alert" className="px-3 py-2 text-sm text-destructive-foreground sm:px-4">
          {props.error}
        </p>
      ) : null}
    </SettingsSection>
  );
}

export function HandoffModeSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const { snapshot } = useHandoffModeSnapshot(environmentId);
  const destinations = useHandoffDestinations(environmentId, false);
  const projects = useProjects();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A server without handoff mode shows nothing rather than a broken section.
  if (!snapshot) return null;
  const overrides = Object.entries(snapshot.projectModes).map(([id, mode]): HandoffModeOverride => {
    const project = projects.find((item) => item.environmentId === environmentId && item.id === id);
    return {
      id: id as ProjectId,
      title: project?.title ?? null,
      workspaceRoot: project?.workspaceRoot,
      archived: project ? isArchivedMember(project) : false,
      mode,
    };
  });
  const run = async (work: () => Promise<{ ok: boolean; error?: string }>) => {
    setPending(true);
    const result = await work();
    setPending(false);
    setError(result.ok ? null : (result.error ?? null));
  };
  return (
    <HandoffModeSettingsView
      snapshot={snapshot}
      destinations={destinations}
      overrides={overrides}
      pending={pending}
      error={error}
      onConfig={(patch) =>
        void run(() => runHandoffMode(handoffMode.updateConfig, { environmentId, input: patch }))
      }
      onProjectMode={(projectId, mode) =>
        void run(() =>
          runHandoffMode(handoffMode.setProjectMode, {
            environmentId,
            input: { projectId, mode },
          }),
        )
      }
      onHandOffMachine={() => requestHandOffMachine(environmentId)}
    />
  );
}
