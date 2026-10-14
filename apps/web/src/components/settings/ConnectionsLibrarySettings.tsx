import { useState } from "react";
import { NativeConnectionsPanel } from "../connections/NativeConnectionsPanel";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

export function ConnectionsLibrarySettings() {
  const { scope, environments, search } = useSettingsScope();
  const scopeKey = JSON.stringify([search.project, search.machine, search.checkout]);
  const [choiceState, setChoiceState] = useState<{ scopeKey: string; key: string } | null>(null);
  const selection = choiceState?.scopeKey === scopeKey ? choiceState.key : null;
  const choices =
    scope.kind === "project" || scope.kind === "checkout"
      ? scope.members.map((member) => ({
          key: `${member.environmentId}:${member.id}`,
          environmentId: member.environmentId,
          projectId: member.id,
          label: `${environments.find((e) => e.environmentId === member.environmentId)?.label ?? "Machine"} · ${member.workspaceRoot}`,
        }))
      : environments.map((environment) => ({
          key: environment.environmentId,
          environmentId: environment.environmentId,
          projectId: undefined,
          label: environment.label,
        }));
  const selected =
    choices.find((c) => c.key === selection) ?? (selection === null ? choices[0] : undefined);
  return (
    <SettingsPageContainer width="wide">
      <SettingsSection title="MCP connections">
        {scope.kind === "unavailable" ? (
          <p role="status">{scope.message}</p>
        ) : (
          <>
            {(choices.length > 1 || (!selected && choices.length > 0)) && (
              <label className="flex flex-wrap items-center gap-3 text-sm">
                Execution machine
                <select
                  aria-label="Connections execution machine"
                  className="max-w-full rounded-md border border-input bg-background px-3 py-2 text-foreground"
                  value={selected?.key ?? ""}
                  onChange={(e) => setChoiceState({ scopeKey, key: e.target.value })}
                >
                  {!selected && (
                    <option value="" disabled>
                      Select a machine
                    </option>
                  )}
                  {choices.map((choice) => (
                    <option key={choice.key} value={choice.key}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {selected && choices.length === 1 && (
              <p className="break-words text-sm text-muted-foreground">
                Execution machine: {selected.label}
              </p>
            )}
            {selected ? (
              <NativeConnectionsPanel
                key={selected.key}
                environmentId={selected.environmentId}
                projectId={selected.projectId}
              />
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                {selection
                  ? "The selected machine or project is no longer in this scope."
                  : "Connect a machine to discover its native connections."}
              </p>
            )}
          </>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
