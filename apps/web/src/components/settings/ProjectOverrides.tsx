import { useTx } from "../../i18n";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  ProviderLimitAction,
  PullRequestMergeMethod,
  ResponseStreamingMode,
  RuntimeMode,
  ThreadEnvMode,
  ThreadFinishAction,
  type ProjectId,
  type ProjectScopedServerSettingKey,
  type ProjectSettingsOverrides,
} from "@specweave-studio/contracts";
import { useMemo, useState } from "react";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useEnvironmentsWithScope } from "../../state/session";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import {
  groupProjectSettingOverrides,
  type ProjectOverrideGroup,
  type ProjectOverrideLine,
  type ProjectOverrideMachine,
} from "./projectOverrideRows";
import {
  planProjectOverrideEdits,
  planProjectOverridesClear,
  undoProjectOverrideEdits,
} from "./scopedSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { formatSettingValueFor } from "./settingValueLabels";
import { useNamedEnvironments } from "./useNamedEnvironments";
import { useRunScopedPlan, type ScopedPlanFeedback } from "./useScopedSettings";

/** The Select value for a stored null, such as "Last selected" for the merge method. */
const NULL_OPTION = "__null";

/** Keys edited in place with a Select; every other key opens its own row. */
const ENUM_OPTIONS: Partial<Record<ProjectScopedServerSettingKey, readonly string[]>> = {
  threadFinishAction: ThreadFinishAction.literals,
  defaultRuntimeMode: RuntimeMode.literals,
  providerLimitAction: ProviderLimitAction.literals,
  defaultThreadEnvMode: ThreadEnvMode.literals,
  pullRequestMergeMethod: [NULL_OPTION, ...PullRequestMergeMethod.literals],
  responseStreamingMode: ResponseStreamingMode.literals,
};

const optionValue = (value: unknown) => (value === null ? NULL_OPTION : String(value));

function decodeOption(line: ProjectOverrideLine, option: string | null): unknown {
  if (typeof line.rawValue === "boolean") return option === "true";
  return option === NULL_OPTION ? null : option;
}

function editOptions(key: ProjectScopedServerSettingKey, line: ProjectOverrideLine) {
  const listed = ENUM_OPTIONS[key];
  if (listed) return listed;
  return typeof line.rawValue === "boolean" ? ["true", "false"] : null;
}

const machineNames = (machines: readonly ProjectOverrideMachine[]) =>
  machines.map((machine) => machine.environmentLabel).join(", ");

/** Scroll to the setting's own row on this page and draw the eye to it. */
function revealSettingRow(key: ProjectScopedServerSettingKey, label: string, page: string) {
  const row = document.querySelector<HTMLElement>(`[data-setting-keys~="${key}"]`);
  if (!row) {
    toastManager.add({
      type: "info",
      title: `${label} is edited in App settings`,
      description: `Open App settings > ${page} with this project selected.`,
    });
    return;
  }
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  row.focus({ preventScroll: true });
  row.classList.add("ring-2", "ring-primary");
  window.setTimeout(() => row.classList.remove("ring-2", "ring-primary"), 1600);
}

interface SessionChange {
  readonly text: string;
  readonly undo: () => void;
}

/**
 * The values this project sets for itself instead of the app settings: one
 * row per setting, machines with the same value on one line, the app value
 * beside it, an edit control and Use app setting. Every change says what it
 * did and can be undone. Renders nothing when the project follows the app
 * settings everywhere and nothing was changed here.
 */
export function ProjectOverrides({
  checkouts,
}: {
  checkouts: readonly { readonly environmentId: EnvironmentId; readonly id: ProjectId }[];
}) {
  const tx = useTx();
  const { environments } = useNamedEnvironments();
  const groups = useMemo(() => {
    const names = new Map(
      environments.map((environment) => [
        environment.environmentId,
        new Map(
          deriveProviderInstanceEntries(environment.serverConfig?.providers ?? []).map((entry) => [
            entry.instanceId as string,
            entry.displayName,
          ]),
        ),
      ]),
    );
    return groupProjectSettingOverrides(checkouts, environments, (environmentId, item) =>
      names.get(environmentId)?.get(item),
    );
  }, [checkouts, environments]);
  const environmentKey = [
    ...new Set(
      groups.flatMap((group) =>
        group.lines.flatMap((line) => line.machines.map((machine) => machine.environmentId)),
      ),
    ),
  ].join("\n");
  const rowEnvironments = useMemo(
    () =>
      environmentKey === ""
        ? []
        : environmentKey.split("\n").map((id) => ({ environmentId: id as EnvironmentId })),
    [environmentKey],
  );
  const writable = useEnvironmentsWithScope(rowEnvironments, AuthSettingsWriteScope);
  const connected = new Set(
    environments
      .filter((environment) => environment.connection.phase === "connected")
      .map((environment) => environment.environmentId),
  );
  // Why these machines cannot be changed now, or undefined when they all can.
  const blockedReason = (machines: readonly ProjectOverrideMachine[]) => {
    const offline = machines.filter((machine) => !connected.has(machine.environmentId));
    if (offline.length > 0)
      return `${machineNames(offline)} ${offline.length === 1 ? "is" : "are"} offline. Connect to change this setting there.`;
    return machines.every((machine) => writable.has(machine.environmentId))
      ? undefined
      : tx("This connection cannot change settings on this machine.");
  };
  const run = useRunScopedPlan();
  // What was changed here this session, by setting, so a cleared row stays
  // visible with its result and Undo instead of vanishing.
  const [changes, setChanges] = useState<ReadonlyMap<string, SessionChange>>(new Map());
  const [labels, setLabels] = useState<
    ReadonlyMap<string, { readonly label: string; readonly page: string }>
  >(new Map());

  const shownKeys = new Set(groups.map((group) => group.key as string));
  const goneGroups = [...changes.keys()].filter((key) => !shownKeys.has(key));
  if (groups.length === 0 && goneGroups.length === 0) return null;
  const machineCount = environmentKey === "" ? 0 : environmentKey.split("\n").length;

  const apply = async (
    group: ProjectOverrideGroup,
    machines: readonly ProjectOverrideMachine[],
    change: { readonly set: unknown } | { readonly clear: true },
    describe: (shown: string) => string,
  ) => {
    const plan =
      "clear" in change
        ? planProjectOverridesClear(environments, machines, [group.key])
        : planProjectOverrideEdits(
            environments,
            machines.map((machine) => ({
              environmentId: machine.environmentId,
              projectId: machine.projectId,
              set: { [group.key]: change.set } as ProjectSettingsOverrides,
            })),
          );
    const undo = planProjectOverrideEdits(
      environments,
      undoProjectOverrideEdits(group.key, machines),
    );
    const was = [
      ...new Set(machines.map((machine) => formatSettingValueFor(group.key, machine.rawValue))),
    ].join(" / ");
    const where = machineNames(machines);
    const clearMarker = () =>
      setChanges((latest) => {
        const next = new Map(latest);
        next.delete(group.key);
        return next;
      });
    const feedback: ScopedPlanFeedback = {
      title: describe(where),
      description: `Was: ${was}.`,
      undo,
      onUndone: clearMarker,
    };
    const result = await run(plan, feedback);
    if (result.savedEnvironmentIds.size === 0) return;
    const saved = machines.filter((machine) =>
      result.savedEnvironmentIds.has(machine.environmentId),
    );
    const savedUndo = planProjectOverrideEdits(
      environments,
      undoProjectOverrideEdits(group.key, saved),
    );
    setLabels((current) =>
      new Map(current).set(group.key, { label: group.label, page: group.page }),
    );
    setChanges((current) =>
      new Map(current).set(group.key, {
        text: `${describe(machineNames(saved))}. Was: ${was}.`,
        undo: () => {
          clearMarker();
          void run(savedUndo, { title: "Change undone" });
        },
      }),
    );
  };

  const marker = (key: string) => {
    const change = changes.get(key);
    if (!change) return null;
    return (
      <div
        role="status"
        className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-accent px-3 py-2 text-xs text-accent-foreground"
      >
        <span>{change.text}</span>
        <Button size="xs" variant="ghost" onClick={change.undo}>
          {tx("Undo")}
        </Button>
      </div>
    );
  };

  return (
    <SettingsSection id="project-overrides" title="Overrides">
      <p className="px-3 pt-1 pb-2 text-xs text-muted-foreground sm:px-4">
        {groups.length === 0
          ? tx("This project follows the app settings everywhere.")
          : `${groups.length} ${groups.length === 1 ? "setting differs" : "settings differ"} from the app settings${machineCount > 1 ? ` on ${machineCount} machines` : ""}.`}
      </p>
      {groups.map((group) => {
        const allMachines = group.lines.flatMap((line) => line.machines);
        const allReason = blockedReason(allMachines);
        return (
          <SettingsRow
            key={group.key}
            data-override-key={group.key}
            literal
            title={group.label}
            description={`${group.page} page`}
            control={
              group.lines.length > 1 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={allReason !== undefined}
                  title={allReason}
                  onClick={() =>
                    void apply(
                      group,
                      allMachines,
                      { clear: true },
                      (where) => `${group.label} follows the app setting on ${where}`,
                    )
                  }
                >
                  {tx("Use app setting everywhere")}
                </Button>
              ) : undefined
            }
          >
            <ul role="list" className="mb-2 space-y-2">
              {group.lines.map((line) => {
                const reason = blockedReason(line.machines);
                const lineWritable = reason === undefined;
                const options = editOptions(group.key, line);
                const where = machineNames(line.machines);
                return (
                  <li
                    key={line.machines.map((machine) => machine.environmentId).join(",")}
                    className="grid grid-cols-1 items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_auto]"
                  >
                    <div className="min-w-0 text-sm">
                      <div className="flex flex-wrap gap-1">
                        {line.machines.map((machine) => (
                          <span
                            key={machine.environmentId}
                            className="rounded-full border border-border px-2 text-xs text-muted-foreground"
                          >
                            {machine.environmentLabel}
                          </span>
                        ))}
                      </div>
                      <div className="mt-1">
                        <span className="font-medium text-foreground">{line.value}</span>
                        <span className="text-muted-foreground">
                          {line.sameAsApp
                            ? ` · ${tx("Same as the app setting")}`
                            : ` · App: ${line.appValue}`}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2" title={reason}>
                      {options ? (
                        <Select
                          value={optionValue(line.rawValue)}
                          disabled={!lineWritable}
                          onValueChange={(value) => {
                            if (value === null || value === optionValue(line.rawValue)) return;
                            const next = decodeOption(line, value);
                            const shown = formatSettingValueFor(group.key, next);
                            void apply(
                              group,
                              line.machines,
                              { set: next },
                              (machines) => `${group.label} changed to ${shown} on ${machines}`,
                            );
                          }}
                        >
                          <SelectTrigger size="sm" aria-label={`${group.label} on ${where}`}>
                            <SelectValue>
                              {(value: string | null) =>
                                formatSettingValueFor(group.key, decodeOption(line, value))
                              }
                            </SelectValue>
                          </SelectTrigger>
                          <SelectPopup align="end" alignItemWithTrigger={false}>
                            {options.map((option) => (
                              <SelectItem key={option} value={option}>
                                {formatSettingValueFor(group.key, decodeOption(line, option))}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Edit ${group.label}`}
                          onClick={() => revealSettingRow(group.key, group.label, group.page)}
                        >
                          {tx("Edit")}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!lineWritable}
                        aria-label={`Use the app setting for ${group.label} on ${where}`}
                        onClick={() =>
                          void apply(
                            group,
                            line.machines,
                            { clear: true },
                            (machines) =>
                              `${group.label} follows the app setting (${line.appValue}) on ${machines}`,
                          )
                        }
                      >
                        {tx("Use app setting")}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
            {marker(group.key)}
          </SettingsRow>
        );
      })}
      {goneGroups.map((key) => {
        const shown = labels.get(key);
        return (
          <SettingsRow
            key={key}
            data-override-key={key}
            literal
            title={shown?.label ?? key}
            description={shown ? `${shown.page} page` : undefined}
          >
            {marker(key)}
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );
}
