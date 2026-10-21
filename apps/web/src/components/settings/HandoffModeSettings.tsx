import type {
  EnvironmentId,
  HandoffConfig,
  HandoffConfigPatch,
  HandoffModeSnapshot,
  ProjectId,
} from "@specweave-studio/contracts";
import { useState } from "react";

import { useProjects } from "../../state/entities";
import { handoffMode, runHandoffMode, useHandoffModeSnapshot } from "../../studio/handoffMode";
import { requestHandOffMachine } from "../handoff/HandOffMachineDialog";
import type { HandoffDestination } from "../handoff/HandoffResults";
import { useHandoffDestinations } from "../handoff/useHandoffDestinations";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const NOTE_LABELS: Record<HandoffConfig["noteModel"], string> = {
  off: "Off",
  cheap: "Cheap model",
  thread: "Thread model",
};
const TAKEOVER_MINUTES = [0, 5, 15, 30, 60] as const;
const takeoverLabel = (minutes: number) => (minutes === 0 ? "Off" : `After ${minutes} min`);

export interface HandoffModeSettingsViewProps {
  snapshot: HandoffModeSnapshot;
  destinations: readonly HandoffDestination[];
  projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  pending: boolean;
  error: string | null;
  onConfig: (patch: HandoffConfigPatch) => void;
  onProjectMode: (projectId: ProjectId, mode: "on" | "off" | null) => void;
  onHandOffMachine: () => void;
}

/** Settings > Machines > Handoff mode, without data wiring so fixtures can render it. */
export function HandoffModeSettingsView(props: HandoffModeSettingsViewProps) {
  const { config } = props.snapshot;
  const sleepTarget = props.destinations.find((item) => item.environmentId === config.sleepTarget);
  return (
    <SettingsSection
      {...searchableSetting("handoff-mode")}
      headerAction={
        <Button size="xs" variant="ghost-muted" onClick={props.onHandOffMachine}>
          Hand off this machine…
        </Button>
      }
    >
      <SettingsRow
        title="Default handoff mode"
        description="New threads keep a checkpoint on your other machines after each turn, so any of them can continue the work. It costs a few more tokens."
        control={
          <Select
            value={config.defaultMode}
            disabled={props.pending}
            onValueChange={(value) => {
              if (value === "on" || value === "off") props.onConfig({ defaultMode: value });
            }}
          >
            <SelectTrigger size="sm" aria-label="Default handoff mode">
              <SelectValue>{config.defaultMode === "on" ? "On" : "Off"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="on">On</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      {props.projects.length > 0 ? (
        <SettingsRow
          title="Projects"
          description="A project setting wins over the default; a thread's own setting wins over both."
        >
          <ul className="mt-2 flex flex-col gap-1.5">
            {props.projects.map((project) => {
              const mode = props.snapshot.projectModes[project.id] ?? null;
              return (
                <li key={project.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">{project.title}</span>
                  <Select
                    value={mode ?? "default"}
                    disabled={props.pending}
                    onValueChange={(value) =>
                      props.onProjectMode(
                        project.id,
                        value === "on" || value === "off" ? value : null,
                      )
                    }
                  >
                    <SelectTrigger size="sm" aria-label={`Handoff mode for ${project.title}`}>
                      <SelectValue>
                        {mode === null ? "Default" : mode === "on" ? "On" : "Off"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem value="default">Default</SelectItem>
                      <SelectItem value="on">On</SelectItem>
                      <SelectItem value="off">Off</SelectItem>
                    </SelectPopup>
                  </Select>
                </li>
              );
            })}
          </ul>
        </SettingsRow>
      ) : null}
      <SettingsRow
        title="Handoff note"
        description="A short Done, Next, Open questions note written at each turn end."
        control={
          <Select
            value={config.noteModel}
            disabled={props.pending}
            onValueChange={(value) => {
              if (value === "off" || value === "cheap" || value === "thread")
                props.onConfig({ noteModel: value });
            }}
          >
            <SelectTrigger size="sm" aria-label="Handoff note">
              <SelectValue>{NOTE_LABELS[config.noteModel]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="cheap">Cheap model</SelectItem>
              <SelectItem value="thread">Thread model</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Push checkpoints to origin"
        description="Also push each thread's hidden checkpoint ref to the repository's origin. Branches are never pushed."
        control={
          <Switch
            aria-label="Push checkpoints to origin"
            checked={config.pushToOrigin}
            disabled={props.pending}
            onCheckedChange={(pushToOrigin) => props.onConfig({ pushToOrigin })}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("handoff-sleep-target")}
        title={`When this Mac sleeps, hand off running threads to ${sleepTarget?.label ?? "…"}`}
        description="Best effort, on sleep only; locking the screen is not leaving."
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
            <SelectTrigger size="sm" aria-label="Machine to hand off to when this Mac sleeps">
              <SelectValue>{sleepTarget ? sleepTarget.label : "Off"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="off">Off</SelectItem>
              {props.destinations.map((destination) => (
                <SelectItem key={destination.environmentId} value={destination.environmentId}>
                  {destination.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Continue automatically when a machine stops answering"
        description="Otherwise a thread whose machine went silent waits for your one click on Continue here."
        control={
          <Select
            value={String(config.autoTakeoverMinutes)}
            disabled={props.pending}
            onValueChange={(value) => props.onConfig({ autoTakeoverMinutes: Number(value) })}
          >
            <SelectTrigger size="sm" aria-label="Automatic takeover">
              <SelectValue>{takeoverLabel(config.autoTakeoverMinutes)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {[...new Set<number>([...TAKEOVER_MINUTES, config.autoTakeoverMinutes])].map(
                (minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {takeoverLabel(minutes)}
                  </SelectItem>
                ),
              )}
            </SelectPopup>
          </Select>
        }
      />
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
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A server without handoff mode shows nothing rather than a broken section.
  if (!snapshot) return null;
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
      projects={projects.map((project) => ({ id: project.id, title: project.title }))}
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
