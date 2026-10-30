/**
 * How Settings > Routines narrows and groups its list: one entry per routine
 * across every machine in scope, filtered by machine, project, provider, state
 * and a search, then grouped. Routines that need nothing from the reader
 * (paused, or a one-time run that already happened) sort into a collapsed tail
 * of each group so the live ones stay on screen.
 */
import type { EnvironmentId, ProjectId, ScheduledTask } from "@specweave-studio/contracts";

import { routineState } from "../../studio/routinePresentation";

/** What a routine needs from the reader, which decides where it sits in a group. */
export type RoutineBucket = "attention" | "active" | "paused" | "finished";

export const ROUTINE_BUCKET_LABELS: Record<RoutineBucket, string> = {
  attention: "Needs attention",
  active: "Active",
  paused: "Paused",
  finished: "Finished",
};

export type RoutineStateFilter = "all" | RoutineBucket;
export type RoutineGroupBy = "machine" | "project" | "provider" | "state";

export const ROUTINE_GROUP_BY_LABELS: Record<RoutineGroupBy, string> = {
  machine: "Machine",
  project: "Project",
  provider: "Provider",
  state: "State",
};

export interface RoutineListEntry {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly task: ScheduledTask;
  readonly projectLabel: string;
  /** The provider instance the routine is pinned to, or its thread starts on. */
  readonly providerKey: string;
  readonly providerLabel: string;
}

export interface RoutineListFilters {
  readonly query: string;
  readonly environmentId: EnvironmentId | "all";
  readonly projectKey: string;
  readonly providerKey: string;
  readonly state: RoutineStateFilter;
}

export const DEFAULT_ROUTINE_FILTERS: RoutineListFilters = {
  query: "",
  environmentId: "all",
  projectKey: "all",
  providerKey: "all",
  state: "all",
};

export interface RoutineGroup {
  readonly key: string;
  readonly label: string;
  /** Running, active, on-request and failed routines, failed first. */
  readonly live: readonly RoutineListEntry[];
  /** Paused and finished routines, shown collapsed. */
  readonly inactive: readonly RoutineListEntry[];
}

type BucketInput = Pick<ScheduledTask, "enabled" | "lastRunStatus" | "lastRunAt"> & {
  readonly schedule: Pick<ScheduledTask["schedule"], "type">;
};

/** Follows the state badge, so a row never sits in a group its badge contradicts. */
export function routineBucket(task: BucketInput): RoutineBucket {
  switch (routineState(task).tone) {
    case "failed":
      return "attention";
    case "paused":
      return "paused";
    case "finished":
      return "finished";
    default:
      return "active";
  }
}

/** A project is named by its machine too: the same id never spans two machines. */
export function routineProjectKey(entry: Pick<RoutineListEntry, "environmentId" | "task">): string {
  return `${entry.environmentId}:${entry.task.projectId as ProjectId}`;
}

export function filterRoutines(
  entries: readonly RoutineListEntry[],
  filters: RoutineListFilters,
): RoutineListEntry[] {
  const words = filters.query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  return entries.filter((entry) => {
    if (filters.environmentId !== "all" && entry.environmentId !== filters.environmentId) {
      return false;
    }
    if (filters.projectKey !== "all" && routineProjectKey(entry) !== filters.projectKey) {
      return false;
    }
    if (filters.providerKey !== "all" && entry.providerKey !== filters.providerKey) return false;
    if (filters.state !== "all" && routineBucket(entry.task) !== filters.state) return false;
    if (words.length === 0) return true;
    const text = [
      entry.task.title,
      entry.task.prompt,
      entry.projectLabel,
      entry.machineLabel,
      entry.providerLabel,
      entry.task.modelSelection.model,
    ]
      .join(" ")
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

const BUCKET_ORDER: readonly RoutineBucket[] = ["attention", "active", "paused", "finished"];

function compareEntries(a: RoutineListEntry, b: RoutineListEntry): number {
  const bucket =
    BUCKET_ORDER.indexOf(routineBucket(a.task)) - BUCKET_ORDER.indexOf(routineBucket(b.task));
  if (bucket !== 0) return bucket;
  return a.task.title.localeCompare(b.task.title, undefined, { sensitivity: "base" });
}

function groupKeyAndLabel(
  entry: RoutineListEntry,
  groupBy: RoutineGroupBy,
): { key: string; label: string } {
  switch (groupBy) {
    case "machine":
      return { key: entry.environmentId, label: entry.machineLabel };
    case "project":
      return { key: routineProjectKey(entry), label: entry.projectLabel };
    case "provider":
      return { key: entry.providerKey, label: entry.providerLabel };
    case "state": {
      const bucket = routineBucket(entry.task);
      return { key: bucket, label: ROUTINE_BUCKET_LABELS[bucket] };
    }
  }
}

/**
 * Groups in a stable order: by state in the order a reader acts on them,
 * otherwise by label. Paused and finished routines fold into each group's
 * tail only when `fold` is set: grouping by state already names them, and a
 * search or state filter asked for them. `keepOpen` (a deep-linked routine)
 * never folds, so the link lands on a visible row. A group with nothing live
 * never folds either: collapsing it would leave only a closed disclosure.
 */
export function groupRoutines(
  entries: readonly RoutineListEntry[],
  groupBy: RoutineGroupBy,
  options: { readonly fold?: boolean; readonly keepOpen?: ScheduledTask["id"] | undefined } = {},
): RoutineGroup[] {
  const fold = (options.fold ?? true) && groupBy !== "state";
  const groups = new Map<string, { label: string; entries: RoutineListEntry[] }>();
  for (const entry of entries) {
    const { key, label } = groupKeyAndLabel(entry, groupBy);
    const group = groups.get(key);
    if (group) group.entries.push(entry);
    else groups.set(key, { label, entries: [entry] });
  }
  const ordered = [...groups.entries()].toSorted(([keyA, a], [keyB, b]) =>
    groupBy === "state"
      ? BUCKET_ORDER.indexOf(keyA as RoutineBucket) - BUCKET_ORDER.indexOf(keyB as RoutineBucket)
      : a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
  return ordered.map(([key, group]) => {
    const sorted = group.entries.toSorted(compareEntries);
    if (!fold) return { key, label: group.label, live: sorted, inactive: [] };
    const isInactive = (entry: RoutineListEntry) => {
      if (entry.task.id === options.keepOpen) return false;
      const bucket = routineBucket(entry.task);
      return bucket === "paused" || bucket === "finished";
    };
    const live = sorted.filter((entry) => !isInactive(entry));
    if (live.length === 0) return { key, label: group.label, live: sorted, inactive: [] };
    return { key, label: group.label, live, inactive: sorted.filter(isInactive) };
  });
}

/** Distinct `{ key, label }` choices for a filter menu, sorted by label. */
export function routineFilterChoices(
  entries: readonly RoutineListEntry[],
  pick: (entry: RoutineListEntry) => { key: string; label: string },
): { key: string; label: string }[] {
  const choices = new Map<string, string>();
  for (const entry of entries) {
    const { key, label } = pick(entry);
    if (!choices.has(key)) choices.set(key, label);
  }
  return [...choices.entries()]
    .map(([key, label]) => ({ key, label }))
    .toSorted((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}
