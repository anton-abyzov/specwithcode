/**
 * The list in Settings > Routines: every routine across the machines in scope,
 * with search, filters for machine, project, provider and state, and a choice
 * of grouping. Paused and finished routines fold into a collapsed tail.
 */
import { useAtomValue } from "@effect/atom-react";
import { SearchIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScheduledTask,
  type ScheduledTaskId,
  resolveEnvironmentMachineKind,
} from "@specweave-studio/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import type { EnvironmentPresentation } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { readEnvironmentScope } from "../../state/session";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { isArchivedMember } from "../../studio/projectListVisibility";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ArchivedDisclosure } from "./ArchivedDisclosure";
import { ScheduledTaskRow, confirmRoutineDelete } from "./ScheduledTaskRow";
import { SettingsRow, SettingsSection, useRelativeTimeTick } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { matchesScheduledTaskScope } from "./scheduledTasksSettings.logic";
import {
  DEFAULT_ROUTINE_FILTERS,
  ROUTINE_BUCKET_LABELS,
  ROUTINE_GROUP_BY_LABELS,
  filterRoutines,
  groupRoutines,
  routineBucket,
  routineFilterChoices,
  routineProjectKey,
  type RoutineGroupBy,
  type RoutineListEntry,
  type RoutineListFilters,
  type RoutineStateFilter,
} from "./routineList.logic";

/** One machine's routines as the list sees them. */
interface EnvironmentRoutines {
  readonly status: "disconnected" | "loading" | "error" | "ready";
  readonly error: string | null;
  readonly tasks: readonly ScheduledTask[];
  /** Provider instance id to its display name on that machine. */
  readonly providerLabels: ReadonlyMap<string, string>;
}

/** Same tasks and labels: a re-read that changed nothing must not re-render the list. */
function sameRoutines(a: EnvironmentRoutines | undefined, b: EnvironmentRoutines): boolean {
  if (a === undefined) return false;
  if (a.status !== b.status || a.error !== b.error) return false;
  if (a.tasks.length !== b.tasks.length || a.tasks.some((task, i) => task !== b.tasks[i])) {
    return false;
  }
  if (a.providerLabels.size !== b.providerLabels.size) return false;
  for (const [key, label] of a.providerLabels) {
    if (b.providerLabels.get(key) !== label) return false;
  }
  return true;
}

const FILTER_TRIGGER_CLASSNAME = "w-auto min-w-0 max-w-48 shrink-0";

/** Loads one machine's routines and reports them up; renders nothing. */
function EnvironmentRoutinesSource({
  environment,
  taskId,
  onEdit,
  onChange,
}: {
  readonly environment: EnvironmentPresentation;
  readonly taskId: ScheduledTaskId | undefined;
  readonly onEdit: (environmentId: EnvironmentId, task: ScheduledTask) => void;
  readonly onChange: (environmentId: EnvironmentId, routines: EnvironmentRoutines) => void;
}) {
  const { scope } = useSettingsScope();
  const environmentId = environment.environmentId;
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const tasksQuery = useEnvironmentQuery(
    connected ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
  );
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const providerLabels = useMemo(
    () =>
      new Map(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings).map(
          (entry) => [entry.instanceId as string, entry.displayName] as const,
        ),
      ),
    [providers, settings],
  );
  const data = tasksQuery.data;
  const error = tasksQuery.error;
  const routines = useMemo<EnvironmentRoutines>(() => {
    if (!connected) return { status: "disconnected", error: null, tasks: [], providerLabels };
    if (error) return { status: "error", error, tasks: [], providerLabels };
    if (!data) return { status: "loading", error: null, tasks: [], providerLabels };
    return {
      status: "ready",
      error: null,
      tasks: data.tasks.filter((task) =>
        matchesScheduledTaskScope(scope, environmentId, task.projectId),
      ),
      providerLabels,
    };
  }, [connected, data, environmentId, error, providerLabels, scope]);
  useEffect(() => onChange(environmentId, routines), [environmentId, onChange, routines]);
  const linkedTask = taskId ? routines.tasks.find((task) => task.id === taskId) : undefined;
  const openedLink = useRef(false);
  useEffect(() => {
    if (!openedLink.current && linkedTask) {
      openedLink.current = true;
      onEdit(environmentId, linkedTask);
    }
  }, [environmentId, linkedTask, onEdit]);
  return null;
}

function FilterSelect({
  label,
  value,
  allLabel,
  choices,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly allLabel: string;
  readonly choices: readonly { key: string; label: string }[];
  readonly onChange: (value: string) => void;
}) {
  const current = choices.find((choice) => choice.key === value)?.label ?? allLabel;
  return (
    <Select value={value} onValueChange={(next) => onChange(next ?? "all")}>
      <SelectTrigger size="sm" aria-label={label} className={FILTER_TRIGGER_CLASSNAME}>
        <SelectValue>
          <span className="truncate">{current}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="all">{allLabel}</SelectItem>
        {choices.map((choice) => (
          <SelectItem key={choice.key} value={choice.key}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** Deletes every finished one-time routine in view, after one confirmation. */
function DeleteFinishedButton({ entries }: { readonly entries: readonly RoutineListEntry[] }) {
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "routine delete finished",
  });
  const [busy, setBusy] = useState(false);
  const permitted = entries.filter((entry) =>
    readEnvironmentScope(entry.environmentId, AuthOrchestrationOperateScope),
  );
  if (entries.length === 0) return null;
  const run = async () => {
    const count = permitted.length;
    if (
      busy ||
      count === 0 ||
      !(await confirmRoutineDelete(
        `Delete ${count} finished routine${count === 1 ? "" : "s"}?\nThey already ran and cannot be restored.`,
      ))
    ) {
      return;
    }
    setBusy(true);
    const failures: string[] = [];
    for (const entry of permitted) {
      const result = await remove({
        environmentId: entry.environmentId,
        input: { id: entry.task.id },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        failures.push(`${entry.task.title}: ${String(squashAtomCommandFailure(result))}`);
      }
    }
    setBusy(false);
    if (failures.length > 0) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not delete ${failures.length} routine${failures.length === 1 ? "" : "s"}`,
          description: failures.join("\n"),
        }),
      );
    }
  };
  return (
    <Button
      size="xs"
      variant="ghost-muted"
      disabled={busy || permitted.length === 0}
      onClick={() => void run()}
      data-routine-delete-finished
    >
      <Trash2Icon className="size-3" />
      Delete finished ({entries.length})
    </Button>
  );
}

export function RoutineList({
  environments,
  linkedEnvironmentId,
  taskId,
  onEdit,
}: {
  readonly environments: readonly EnvironmentPresentation[];
  /** The machine a deep-linked routine belongs to. */
  readonly linkedEnvironmentId: EnvironmentId | undefined;
  readonly taskId: ScheduledTaskId | undefined;
  readonly onEdit: (environmentId: EnvironmentId, task: ScheduledTask) => void;
}) {
  const { scope } = useSettingsScope();
  const projects = useProjects();
  const [sources, setSources] = useState<ReadonlyMap<EnvironmentId, EnvironmentRoutines>>(
    () => new Map(),
  );
  const reportSource = useCallback(
    (environmentId: EnvironmentId, routines: EnvironmentRoutines) => {
      setSources((current) => {
        if (sameRoutines(current.get(environmentId), routines)) return current;
        const next = new Map(current);
        next.set(environmentId, routines);
        return next;
      });
    },
    [],
  );
  const [filters, setFilters] = useState<RoutineListFilters>(DEFAULT_ROUTINE_FILTERS);
  const [groupBy, setGroupBy] = useState<RoutineGroupBy>("machine");
  // A new deep link must land on its row, whatever was filtered before.
  const [filteredFor, setFilteredFor] = useState(taskId);
  if (filteredFor !== taskId) {
    setFilteredFor(taskId);
    if (taskId !== undefined) setFilters(DEFAULT_ROUTINE_FILTERS);
  }
  useRelativeTimeTick(60_000);

  const projectScoped = scope.kind === "project" || scope.kind === "checkout";
  const multipleMachines = environments.length > 1;
  const { entries, archived } = useMemo(() => {
    const projectsById = new Map(
      projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
    );
    const live: RoutineListEntry[] = [];
    const archivedEntries: RoutineListEntry[] = [];
    for (const environment of environments) {
      const source = sources.get(environment.environmentId);
      if (source?.status !== "ready") continue;
      for (const task of source.tasks) {
        const project = projectsById.get(`${environment.environmentId}:${task.projectId}`);
        const instanceId = task.modelSelection.instanceId as string;
        const entry: RoutineListEntry = {
          environmentId: environment.environmentId,
          machineLabel: environment.label,
          task,
          projectLabel: project?.title ?? "Unknown project",
          providerKey: instanceId,
          providerLabel: source.providerLabels.get(instanceId) ?? instanceId,
        };
        // A linked routine stays in the main list so the deep link still lands on a visible row.
        if (project && isArchivedMember(project) && task.id !== taskId) archivedEntries.push(entry);
        else live.push(entry);
      }
    }
    return { entries: live, archived: archivedEntries };
  }, [environments, projects, sources, taskId]);

  const machineChoices = routineFilterChoices(entries, (entry) => ({
    key: entry.environmentId,
    label: entry.machineLabel,
  }));
  const projectChoices = routineFilterChoices(entries, (entry) => ({
    key: routineProjectKey(entry),
    label: multipleMachines ? `${entry.projectLabel} · ${entry.machineLabel}` : entry.projectLabel,
  }));
  const providerChoices = routineFilterChoices(entries, (entry) => ({
    key: entry.providerKey,
    label: entry.providerLabel,
  }));
  // A choice that is gone (its machine went offline, the scope narrowed to one project) stops
  // filtering instead of hiding everything behind a control that is no longer shown.
  const has = (choices: readonly { key: string }[], key: string) =>
    choices.some((choice) => choice.key === key);
  const effective: RoutineListFilters = {
    ...filters,
    environmentId: has(machineChoices, filters.environmentId) ? filters.environmentId : "all",
    projectKey:
      !projectScoped && has(projectChoices, filters.projectKey) ? filters.projectKey : "all",
    providerKey: has(providerChoices, filters.providerKey) ? filters.providerKey : "all",
  };
  const filtered = filterRoutines(entries, effective);
  const filteredArchived = filterRoutines(archived, effective);
  // Searching, or asking for a state, shows every match open.
  const fold = effective.state === "all" && effective.query.trim() === "";
  const groups = groupRoutines(filtered, groupBy, { fold, keepOpen: taskId });
  const finished = filtered.filter((entry) => routineBucket(entry.task) === "finished");
  const filtersActive =
    effective.query.trim() !== "" ||
    effective.environmentId !== "all" ||
    effective.projectKey !== "all" ||
    effective.providerKey !== "all" ||
    effective.state !== "all";
  const setFilter = <K extends keyof RoutineListFilters>(key: K, value: RoutineListFilters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const linkedSource = sources.get(linkedEnvironmentId ?? ("" as EnvironmentId));
  const linkedMissing =
    taskId !== undefined &&
    linkedSource?.status === "ready" &&
    !linkedSource.tasks.some((task) => task.id === taskId);
  const pending = environments.filter(
    (environment) => sources.get(environment.environmentId)?.status !== "ready",
  );
  const anyReady = pending.length < environments.length;
  const showMachine = multipleMachines && groupBy !== "machine";
  const showProject = !projectScoped && groupBy !== "project";
  const showProvider = groupBy !== "provider";

  const renderRow = (
    entry: RoutineListEntry,
    compact: boolean,
    machineLabel = showMachine ? entry.machineLabel : null,
  ) => (
    <ScheduledTaskRow
      key={`${entry.environmentId}:${entry.task.id}`}
      environmentId={entry.environmentId}
      task={entry.task}
      projectLabel={showProject ? entry.projectLabel : null}
      machineLabel={machineLabel}
      providerLabel={showProvider ? entry.providerLabel : null}
      compact={compact}
      onEdit={() => onEdit(entry.environmentId, entry.task)}
    />
  );

  return (
    <div className="space-y-6" data-routine-list>
      {environments.map((environment) => (
        <EnvironmentRoutinesSource
          key={`${environment.environmentId}:${taskId ?? ""}`}
          environment={environment}
          taskId={linkedEnvironmentId === environment.environmentId ? taskId : undefined}
          onEdit={onEdit}
          onChange={reportSource}
        />
      ))}
      {entries.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 px-3 sm:px-4" data-routine-toolbar>
          <InputGroup className="min-w-40 flex-1">
            <InputGroupAddon>
              <SearchIcon aria-hidden className="size-3" />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              aria-label="Search routines"
              placeholder="Search routines"
              value={filters.query}
              onChange={(event) => setFilter("query", event.currentTarget.value)}
            />
          </InputGroup>
          {machineChoices.length > 1 ? (
            <FilterSelect
              label="Machine"
              value={effective.environmentId}
              allLabel="All machines"
              choices={machineChoices}
              onChange={(value) => setFilter("environmentId", value as EnvironmentId | "all")}
            />
          ) : null}
          {!projectScoped && projectChoices.length > 1 ? (
            <FilterSelect
              label="Project"
              value={effective.projectKey}
              allLabel="All projects"
              choices={projectChoices}
              onChange={(value) => setFilter("projectKey", value)}
            />
          ) : null}
          {providerChoices.length > 1 ? (
            <FilterSelect
              label="Provider"
              value={effective.providerKey}
              allLabel="All providers"
              choices={providerChoices}
              onChange={(value) => setFilter("providerKey", value)}
            />
          ) : null}
          <FilterSelect
            label="State"
            value={filters.state}
            allLabel="Any state"
            choices={(["attention", "active", "paused", "finished"] as const).map((key) => ({
              key,
              label: ROUTINE_BUCKET_LABELS[key],
            }))}
            onChange={(value) => setFilter("state", value as RoutineStateFilter)}
          />
          <Select
            value={groupBy}
            onValueChange={(value) => value && setGroupBy(value as RoutineGroupBy)}
          >
            <SelectTrigger size="sm" aria-label="Group by" className={FILTER_TRIGGER_CLASSNAME}>
              <SelectValue>
                <span className="truncate">
                  Group by {ROUTINE_GROUP_BY_LABELS[groupBy].toLowerCase()}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {(Object.keys(ROUTINE_GROUP_BY_LABELS) as RoutineGroupBy[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {ROUTINE_GROUP_BY_LABELS[key]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {filtersActive ? (
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => setFilters(DEFAULT_ROUTINE_FILTERS)}
            >
              Clear filters
            </Button>
          ) : null}
          <DeleteFinishedButton entries={finished} />
        </div>
      ) : null}
      {pending.length > 0 ? (
        <SettingsSection title="Machines" hideTitle>
          {pending.map((environment) => {
            const source = sources.get(environment.environmentId);
            const prefix = multipleMachines ? `${environment.label}: ` : "";
            return source?.status === "disconnected" ? (
              <SettingsRow
                key={environment.environmentId}
                title={`${prefix}Environment disconnected`}
                description={`Reconnect ${environment.label} to view its routines.`}
              />
            ) : source?.status === "error" ? (
              <SettingsRow
                key={environment.environmentId}
                title={`${prefix}Could not load routines`}
                description={source.error}
              />
            ) : (
              <SettingsRow
                key={environment.environmentId}
                title={`${prefix}Loading routines…`}
                role="status"
              />
            );
          })}
        </SettingsSection>
      ) : null}
      {linkedMissing ? (
        <SettingsSection title="Linked routine" hideTitle>
          <SettingsRow
            title="Routine unavailable"
            description="This routine no longer exists or is outside the selected project scope."
            role="status"
          />
        </SettingsSection>
      ) : null}
      {anyReady && entries.length === 0 && archived.length === 0 ? (
        <SettingsSection title="No routines" hideTitle>
          <SettingsRow
            title="No routines"
            description="No routines match this machine and project selection."
          />
        </SettingsSection>
      ) : null}
      {anyReady && entries.length === 0 && archived.length > 0 ? (
        <SettingsSection title="No routines for active projects" hideTitle>
          <SettingsRow
            title="No routines for active projects"
            description="Every routine here belongs to an archived project."
          />
        </SettingsSection>
      ) : null}
      {entries.length > 0 && filtered.length === 0 ? (
        <SettingsSection title="No matching routines" hideTitle>
          <SettingsRow
            title="No routines match these filters"
            control={
              <Button
                size="xs"
                variant="outline"
                onClick={() => setFilters(DEFAULT_ROUTINE_FILTERS)}
              >
                Clear filters
              </Button>
            }
          />
        </SettingsSection>
      ) : null}
      {groups.map((group) => {
        const environment =
          groupBy === "machine"
            ? environments.find((entry) => entry.environmentId === group.key)
            : undefined;
        return (
          <SettingsSection
            key={group.key}
            data-routine-group={group.key}
            title={`${group.label} (${group.live.length + group.inactive.length})`}
            // One machine and no filters reads as a plain list, as it always has.
            hideTitle={groupBy === "machine" && !multipleMachines}
            icon={
              environment ? (
                <EnvironmentMachineIcon
                  kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                  className="size-3.5"
                />
              ) : undefined
            }
          >
            {group.live.map((entry) => {
              // Paused and finished routines are one line a row, folded or not.
              const bucket = routineBucket(entry.task);
              return renderRow(entry, bucket === "paused" || bucket === "finished");
            })}
            <ArchivedDisclosure count={group.inactive.length} label="paused and finished">
              {group.inactive.map((entry) => renderRow(entry, true))}
            </ArchivedDisclosure>
          </SettingsSection>
        );
      })}
      {filteredArchived.length > 0 ? (
        <ArchivedDisclosure count={filteredArchived.length}>
          {filteredArchived.map((entry) =>
            renderRow(entry, true, multipleMachines ? entry.machineLabel : null),
          )}
        </ArchivedDisclosure>
      ) : null}
    </div>
  );
}
