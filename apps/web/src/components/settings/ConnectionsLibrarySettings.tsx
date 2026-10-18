import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { useState } from "react";

import { machineStatus } from "../../lib/machineStatus";
import { useEnvironments } from "../../state/environments";
import { NativeConnectionsPanel } from "../connections/NativeConnectionsPanel";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsSection } from "./settingsLayout";

interface Choice {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | undefined;
  /** The machine's name; a project scope groups its checkouts under it. */
  readonly machine: string;
  /** The checkout's folder in a project scope, absent when the choice is the machine itself. */
  readonly folder: string | undefined;
}

const choiceLabel = (choice: Choice) =>
  choice.folder ? `${choice.machine} · ${choice.folder}` : choice.machine;

/**
 * The MCP servers a machine, or a project's checkout on it, declares. One
 * section of Settings > Connections: it renders inside that page's container,
 * so it is only as tall as its content.
 */
export function ConnectionsLibrarySettings() {
  const { scope, environments, search } = useSettingsScope();
  const { environments: presentations } = useEnvironments();
  const scopeKey = JSON.stringify([search.project, search.machine, search.checkout]);
  const [choiceState, setChoiceState] = useState<{ scopeKey: string; key: string } | null>(null);
  const selection = choiceState?.scopeKey === scopeKey ? choiceState.key : null;
  const machineLabel = (environmentId: EnvironmentId) =>
    environments.find((e) => e.environmentId === environmentId)?.label ?? "Machine";
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const choices: Choice[] = projectScope
    ? scope.members.map((member) => ({
        key: `${member.environmentId}:${member.id}`,
        environmentId: member.environmentId,
        projectId: member.id,
        machine: machineLabel(member.environmentId),
        folder: member.workspaceRoot,
      }))
    : environments.map((environment) => ({
        key: environment.environmentId,
        environmentId: environment.environmentId,
        projectId: undefined,
        machine: environment.label,
        folder: undefined,
      }));
  const selected =
    choices.find((c) => c.key === selection) ?? (selection === null ? choices[0] : undefined);
  // The same status text the machine picker, sidebar and chats show.
  const statusText = (environmentId: EnvironmentId) => {
    const connection = presentations.find((e) => e.environmentId === environmentId)?.connection;
    return connection ? machineStatus(connection).text : null;
  };
  const groups = projectScope
    ? [...new Set(choices.map((choice) => choice.environmentId))].map((environmentId) => {
        const status = statusText(environmentId);
        const machine = machineLabel(environmentId);
        return {
          key: environmentId,
          label: status ? `${machine} · ${status}` : machine,
          choices: choices.filter((choice) => choice.environmentId === environmentId),
        };
      })
    : [{ key: "machines", label: "Machines", choices }];
  const showPicker =
    scope.kind !== "unavailable" && (choices.length > 1 || (!selected && choices.length > 0));
  const picker = showPicker ? (
    <Select
      value={selected?.key ?? null}
      onValueChange={(key) => {
        if (typeof key === "string") setChoiceState({ scopeKey, key });
      }}
    >
      <SelectTrigger
        size="xs"
        className="w-auto max-w-72 min-w-0"
        aria-label="Connections execution machine"
      >
        <SelectValue placeholder="Select a machine">
          {selected ? choiceLabel(selected) : null}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {groups.map((group) => (
          <SelectGroup key={group.key}>
            <SelectGroupLabel>{group.label}</SelectGroupLabel>
            {group.choices.map((choice) => {
              const status = choice.folder ? null : statusText(choice.environmentId);
              return (
                <SelectItem key={choice.key} value={choice.key}>
                  <span className="flex min-w-0 items-center justify-between gap-4">
                    <span className="max-w-80 truncate">{choice.folder ?? choice.machine}</span>
                    {status ? (
                      <span className="shrink-0 text-xs text-muted-foreground">{status}</span>
                    ) : null}
                  </span>
                </SelectItem>
              );
            })}
          </SelectGroup>
        ))}
      </SelectPopup>
    </Select>
  ) : selected && scope.kind !== "unavailable" ? (
    <span className="max-w-72 truncate text-xs text-muted-foreground">{choiceLabel(selected)}</span>
  ) : null;
  return (
    <SettingsSection id="mcp-connections" title="MCP connections" headerAction={picker}>
      <div className="px-3 py-2.5 sm:px-4">
        {scope.kind === "unavailable" ? (
          <p role="status" className="text-sm text-muted-foreground">
            {scope.message}
          </p>
        ) : selected ? (
          <NativeConnectionsPanel
            key={selected.key}
            environmentId={selected.environmentId}
            projectId={selected.projectId}
          />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {selection
              ? "The selected machine or project is no longer in this scope."
              : "Connect a machine to see its MCP servers."}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
