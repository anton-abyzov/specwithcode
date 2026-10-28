import { useSyncExternalStore } from "react";
import type { FolderCopySourceStatus, FolderCopyStatus } from "@specweave-studio/contracts";

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
      a.waiting === b.waiting;

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
): CopyActivity | null {
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

/** "Copy to ministorm: copying files, 42%". */
export function copyActivityText(activity: CopyActivity): string {
  const percent = activity.fraction === null ? "" : `, ${Math.floor(activity.fraction * 100)}%`;
  const label = activity.label.charAt(0).toLowerCase() + activity.label.slice(1);
  return `Copy to ${activity.machine}: ${label}${percent}`;
}

/** Test helper: forgets every activity, watch and opener. */
export function resetCopyActivityForTests(): void {
  activities = new Map();
  watches = new Map();
  openers.clear();
  emit();
}
