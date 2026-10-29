import { useSyncExternalStore } from "react";
import type { FolderCopySourceStatus, FolderCopyStatus } from "@specweave-studio/contracts";
import { copiedProjectFolder, copyDestinationKey } from "./folderCopy";

/**
 * Folder copies running in the background, app wide: what each one is doing, for the
 * sidebar row and the project's banner, and which ones are watched while their dialog
 * is closed. A copy keeps running on the machines whatever this app shows; this only
 * lets the person see it from any project and keep working elsewhere.
 */

export interface CopyActivity {
  /** The machine the folder is copied to. */
  readonly machine: string;
  /** "Copying files", "Measuring the folder", …: what is happening now. */
  readonly label: string;
  /** 0 to 1 when the step can say how far it is, otherwise null. */
  readonly fraction: number | null;
  /** True while nothing runs and the copy waits for the person (a preview to review). */
  readonly waiting: boolean;
  /** "Move and continue there": the project itself is moving, not only its files. */
  readonly move?: boolean;
  /** Where a move lands, once known: that project is the same one, mid-move. */
  readonly destination?: MoveDestination;
}

/** The project a move registers on the destination, by id once known and by folder. */
export interface MoveDestination {
  readonly environmentId: string;
  readonly projectId: string | null;
  readonly folder: string;
  /** The folder held a project before the move: it stays listed, with its own threads. */
  readonly existing?: boolean;
}

/** Where a copy-and-move lands on `environmentId`; null for a copy of files only. */
export function moveDestination(
  status: Pick<
    FolderCopyStatus,
    "mode" | "projectId" | "projectFolder" | "targetFolder" | "projectRelativePath"
  >,
  environmentId: string,
  existing = false,
): MoveDestination | null {
  if (status.mode !== "copy-and-move") return null;
  return {
    environmentId,
    projectId: status.projectId ?? null,
    folder:
      status.projectFolder ?? copiedProjectFolder(status.targetFolder, status.projectRelativePath),
    ...(existing ? { existing: true } : {}),
  };
}

/**
 * True when `project` is where a running move lands. The sidebar leaves it out, so the
 * project shows once, on its source row with the move's progress, until the move finishes.
 * A move waiting for review hides nothing, and neither does one into a folder that already
 * held a project before the move: that project and its threads stay listed.
 */
export function isMovingDestination(
  project: { readonly environmentId: string; readonly id: string; readonly workspaceRoot: string },
  activities: ReadonlyMap<string, CopyActivity>,
): boolean {
  for (const [source, activity] of activities) {
    const destination = activity.destination;
    if (
      !activity.move ||
      activity.waiting ||
      !destination ||
      destination.existing ||
      destination.environmentId !== project.environmentId
    )
      continue;
    if (source === copyActivityKey(project.environmentId, project.id)) continue;
    if (destination.projectId !== null && destination.projectId === project.id) return true;
    if (
      copyDestinationKey(project.environmentId, project.workspaceRoot) ===
      copyDestinationKey(destination.environmentId, destination.folder)
    )
      return true;
  }
  return false;
}

/** A copy watched while its dialog is closed: the props its watcher needs. */
export interface CopyWatch {
  readonly environmentId: string;
  readonly projectId: string;
  readonly machineLabel: (environmentId: string) => string;
  readonly sourceLabel: string;
  /** The project's name, for "Open Move {project}" in the toasts. */
  readonly projectName?: string;
  /** Restored after a reload: a copy already finished is not announced again. */
  readonly restored?: boolean;
}

export const copyActivityKey = (environmentId: string, projectId: string) =>
  `${environmentId}:${projectId}`;

type Listener = () => void;
const listeners = new Set<Listener>();
let activities: ReadonlyMap<string, CopyActivity> = new Map();
let watches: ReadonlyMap<string, CopyWatch> = new Map();
/** Dialogs mounted per project, which open on a toast's Open. */
const openers = new Map<string, () => void>();

const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: Listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const sameActivity = (a: CopyActivity | undefined, b: CopyActivity | null) =>
  a === undefined
    ? b === null
    : b !== null &&
      a.machine === b.machine &&
      a.label === b.label &&
      a.fraction === b.fraction &&
      a.waiting === b.waiting &&
      a.move === b.move &&
      a.destination?.environmentId === b.destination?.environmentId &&
      a.destination?.projectId === b.destination?.projectId &&
      a.destination?.folder === b.destination?.folder &&
      a.destination?.existing === b.destination?.existing;

export function setCopyActivity(key: string, activity: CopyActivity | null): void {
  if (sameActivity(activities.get(key), activity)) return;
  const next = new Map(activities);
  if (activity) next.set(key, activity);
  else next.delete(key);
  activities = next;
  emit();
}

export function watchCopy(watch: CopyWatch): void {
  const key = copyActivityKey(watch.environmentId, watch.projectId);
  const next = new Map(watches);
  next.set(key, watch);
  watches = next;
  emit();
}

/** Stops watching in the background: the dialog follows the copy itself. */
export function unwatchCopy(key: string): void {
  if (!watches.has(key)) return;
  const next = new Map(watches);
  next.delete(key);
  watches = next;
  emit();
}

/** The copies watched in the background right now, outside React. */
export function currentCopyWatches(): ReadonlyMap<string, CopyWatch> {
  return watches;
}

export function useCopyWatches(): ReadonlyMap<string, CopyWatch> {
  return useSyncExternalStore(subscribe, () => watches);
}

/** The running copies right now, outside React. */
export function currentCopyActivities(): ReadonlyMap<string, CopyActivity> {
  return activities;
}

export function useCopyActivities(): ReadonlyMap<string, CopyActivity> {
  return useSyncExternalStore(subscribe, () => activities);
}

/** The running copy of any of these projects (a sidebar row groups a project's checkouts). */
export function useCopyActivity(
  projects: ReadonlyArray<{ readonly environmentId: string; readonly id: string }>,
): CopyActivity | null {
  const all = useCopyActivities();
  for (const project of projects) {
    const activity = all.get(copyActivityKey(project.environmentId, project.id));
    if (activity) return activity;
  }
  return null;
}

/** Registers the dialog that opens for a project's copy; returns the unregister. */
export function registerCopyOpener(key: string, open: () => void): () => void {
  openers.set(key, open);
  return () => {
    if (openers.get(key) === open) openers.delete(key);
  };
}

/** Opens the project's copy dialog when its project is on screen; null otherwise. */
export function copyOpener(key: string): (() => void) | null {
  const open = openers.get(key);
  return open ? () => openers.get(key)?.() : null;
}

const ratio = (done: number, total: number) =>
  total > 0 ? Math.min(1, Math.max(0, done / total)) : null;

/** What a destination's status says about a running copy; null once nothing runs. */
export function copyActivityFromStatus(
  status: FolderCopyStatus,
  machine: string,
  /** The destination's environment: given, a move's activity names where it lands. */
  environmentId?: string,
  /** The move's folder already held a project before it started. */
  existing = false,
): CopyActivity | null {
  const activity = statusActivity(status, machine);
  const destination = environmentId ? moveDestination(status, environmentId, existing) : null;
  return activity && status.mode === "copy-and-move"
    ? { ...activity, move: true, ...(destination ? { destination } : {}) }
    : activity;
}

function statusActivity(status: FolderCopyStatus, machine: string): CopyActivity | null {
  const progress = status.progress;
  const bytes = progress ? ratio(progress.bytesDone, progress.bytesTotal) : null;
  const files = progress ? ratio(progress.filesDone, progress.filesTotal) : null;
  switch (status.state) {
    case "planned":
    case "scanning":
      return { machine, label: "Comparing folders", fraction: null, waiting: false };
    case "previewed":
      return { machine, label: "Ready to review", fraction: null, waiting: true };
    case "approved":
    case "transferring":
      return { machine, label: "Copying files", fraction: bytes ?? files, waiting: false };
    case "verifying":
      return { machine, label: "Checking files", fraction: files ?? bytes, waiting: false };
    case "applying":
      return { machine, label: "Applying files", fraction: files, waiting: false };
    case "applied":
      // Applied but not yet committed or registered: still finishing.
      return status.committed && status.projectId !== null
        ? null
        : { machine, label: "Finishing", fraction: 1, waiting: false };
    default:
      return null;
  }
}

/** What the source's status says while it measures or builds the copy. */
export function copyActivityFromSource(
  status: FolderCopySourceStatus,
  machine: string,
): CopyActivity | null {
  const progress = status.progress ?? null;
  if (status.state === "scanning")
    return { machine, label: "Measuring the folder", fraction: null, waiting: false };
  if (status.state === "building")
    return {
      machine,
      label: "Preparing files",
      fraction:
        progress && progress.totalBytes !== undefined
          ? ratio(progress.bytes, progress.totalBytes)
          : null,
      waiting: false,
    };
  if (status.state === "scanned")
    return { machine, label: "Folder measured", fraction: null, waiting: true };
  return null;
}

/** "Copy to ministorm: copying files, 42%", or "Move to ministorm: …" for a move. */
export function copyActivityText(activity: CopyActivity): string {
  const percent = activity.fraction === null ? "" : `, ${Math.floor(activity.fraction * 100)}%`;
  const label = activity.label.charAt(0).toLowerCase() + activity.label.slice(1);
  return `${activity.move ? "Hand off" : "Copy"} to ${activity.machine}: ${label}${percent}`;
}

/** Test helper: forgets every activity, watch and opener. */
export function resetCopyActivityForTests(): void {
  activities = new Map();
  watches = new Map();
  openers.clear();
  emit();
}

interface ArrangedGroups<G> {
  readonly pinned: G[];
  readonly unpinned: G[];
}

/**
 * The sidebar's groups without the ones that only hold where a running move lands, and the
 * listed keys to match: during a move the project shows once, on its source row.
 */
export function withoutMovingDestinations<
  G extends {
    readonly projectKey: string;
    readonly memberProjects: ReadonlyArray<{
      readonly environmentId: string;
      readonly id: string;
      readonly workspaceRoot: string;
    }>;
  },
>(
  visible: ArrangedGroups<G>,
  listedKeys: ArrangedGroups<string>,
  activities: ReadonlyMap<string, CopyActivity>,
): { readonly visible: ArrangedGroups<G>; readonly listedKeys: ArrangedGroups<string> } {
  if (activities.size === 0) return { visible, listedKeys };
  const hidden = new Set(
    [...visible.pinned, ...visible.unpinned]
      .filter(
        (group) =>
          group.memberProjects.length > 0 &&
          group.memberProjects.every((member) => isMovingDestination(member, activities)),
      )
      .map((group) => group.projectKey),
  );
  if (hidden.size === 0) return { visible, listedKeys };
  const keep = (key: string) => !hidden.has(key);
  return {
    visible: {
      pinned: visible.pinned.filter((group) => keep(group.projectKey)),
      unpinned: visible.unpinned.filter((group) => keep(group.projectKey)),
    },
    listedKeys: {
      pinned: listedKeys.pinned.filter(keep),
      unpinned: listedKeys.unpinned.filter(keep),
    },
  };
}
