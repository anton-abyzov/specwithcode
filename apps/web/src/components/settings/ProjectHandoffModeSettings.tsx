import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { EnvironmentId, HandoffModeSnapshot, ProjectId } from "@specweave-studio/contracts";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import { useState } from "react";

import { handoffMode, runHandoffMode, useHandoffModeSnapshots } from "../../studio/handoffMode";
import { useLinkMachines } from "../studio/useLinkMachines";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type ProjectMode = "default" | "on" | "off";

export interface ProjectHandoffMember {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  /** Null when the machine has no handoff mode or has not answered yet. */
  readonly snapshot: HandoffModeSnapshot | null;
}

/**
 * The project's mode across its machines: each copy's own override, else that
 * machine's default. "mixed" when the copies disagree.
 */
export function projectHandoffValue(
  members: ReadonlyArray<ProjectHandoffMember>,
): ProjectMode | "mixed" {
  const values = new Set<ProjectMode>(
    members
      .filter((member) => member.snapshot !== null)
      .map((member) => member.snapshot!.projectModes[member.id] ?? "default"),
  );
  if (values.size > 1) return "mixed";
  return values.values().next().value ?? "default";
}

/** What Default means on this project's machines, in words. */
export function projectHandoffDefaultText(
  members: ReadonlyArray<ProjectHandoffMember>,
  label: (environmentId: EnvironmentId) => string,
): string {
  const known = members.filter((member) => member.snapshot !== null);
  const on = known.filter((member) => member.snapshot!.config.defaultMode === "on");
  if (on.length === 0) return "Off";
  if (on.length === known.length) return "On";
  return `On for ${on.map((member) => label(member.environmentId)).join(", ")}`;
}

const MODE_LABEL: Record<ProjectMode | "mixed", string> = {
  default: "Default",
  on: "On",
  off: "Off",
  mixed: "Mixed",
};

export interface ProjectHandoffModeSettingsViewProps {
  readonly members: ReadonlyArray<ProjectHandoffMember>;
  readonly linked: boolean;
  readonly label: (environmentId: EnvironmentId) => string;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onChange: (mode: ProjectMode) => void;
}

export function ProjectHandoffModeSettingsView(props: ProjectHandoffModeSettingsViewProps) {
  const value = projectHandoffValue(props.members);
  const defaultText = projectHandoffDefaultText(props.members, props.label);
  return (
    <SettingsSection title="Moving work">
      <SettingsRow
        title="Keep this project's threads ready to move"
        description={
          props.linked
            ? `Syncs each turn to this project's other machines so any of them can continue. Default follows each machine's own setting (now ${defaultText.toLowerCase()}).`
            : "Link this project on another machine first. Until then there is nowhere to sync to; Move still works."
        }
        control={
          <Select
            value={value}
            disabled={props.pending || !props.linked}
            onValueChange={(next) => {
              if (next === "default" || next === "on" || next === "off") props.onChange(next);
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-36"
              aria-label="Keep this project's threads ready to move"
            >
              <SelectValue>{MODE_LABEL[value]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {value === "mixed" ? (
                <SelectItem value="mixed" disabled>
                  Mixed
                </SelectItem>
              ) : null}
              <SelectItem value="default">Default ({defaultText})</SelectItem>
              <SelectItem value="on">On</SelectItem>
              <SelectItem value="off">Off</SelectItem>
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

/**
 * Settings > Project: whether this project's threads stay ready to move. One
 * choice for the project, written to every machine that has a copy of it.
 */
export function ProjectHandoffModeSettings({
  members,
}: {
  readonly members: ReadonlyArray<EnvironmentProject>;
}) {
  const machines = useLinkMachines();
  const own = members.filter((member) => !isPersonalAssistantProject(member));
  const snapshots = useHandoffModeSnapshots(own.map((member) => member.environmentId));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = own.map((member) => ({
    environmentId: member.environmentId,
    id: member.id,
    snapshot: snapshots.get(member.environmentId) ?? null,
  }));
  // Servers without handoff mode, or a personal assistant: nothing to set.
  if (!rows.some((row) => row.snapshot !== null)) return null;
  // Somewhere to sync to: a copy on another machine.
  const linked =
    new Set([
      ...own.map((member) => member.environmentId),
      ...own.flatMap(
        (member) =>
          member.workspaceSettings?.logicalProject?.members.map((item) => item.environmentId) ?? [],
      ),
    ]).size > 1;
  const change = async (mode: ProjectMode) => {
    setPending(true);
    const failures: string[] = [];
    for (const member of own) {
      if (snapshots.get(member.environmentId) == null) {
        failures.push(
          `${machines.label(member.environmentId)} didn't answer; set it again once it is online.`,
        );
        continue;
      }
      const result = await runHandoffMode(handoffMode.setProjectMode, {
        environmentId: member.environmentId,
        input: { projectId: member.id, mode: mode === "default" ? null : mode },
      });
      if (!result.ok) failures.push(`${machines.label(member.environmentId)}: ${result.error}`);
    }
    setPending(false);
    setError(failures.length > 0 ? failures.join(" ") : null);
  };
  return (
    <ProjectHandoffModeSettingsView
      members={rows}
      linked={linked}
      label={(environmentId) => machines.label(environmentId)}
      pending={pending}
      error={error}
      onChange={(mode) => void change(mode)}
    />
  );
}
