import { useEffect, useRef } from "react";
import type {
  EnvironmentId,
  ProjectId,
  FolderCopyFileClass,
  FolderCopyMode,
  FolderCopyRow,
  FolderCopySourceStatus,
  FolderCopyStatus,
} from "@specweave-studio/contracts";
import {
  copyActivityFromSource,
  copyActivityFromStatus,
  copyActivityKey,
  moveDestination,
  setCopyActivity,
} from "../../studio/folderCopyActivity";
import { copiedProjectFolder } from "../../studio/folderCopy";
import { CLOSABLE_WHILE_WORKING, type CopyStage } from "./handoffCopySteps";
import type { PendingCopy } from "./handoffFolderCopyPending";

/** Opens the applied copy's project on its machine; nothing before it is registered there. */
export function openCopiedProject(
  machine: EnvironmentId | null,
  copy: FolderCopyStatus | null,
  pending: PendingCopy | null,
  onOpen: (input: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly folder: string;
  }) => void,
): void {
  if (!machine || !copy?.projectId) return;
  onOpen({
    environmentId: machine,
    projectId: copy.projectId,
    folder:
      copy.projectFolder ??
      copiedProjectFolder(
        copy.targetFolder,
        copy.projectRelativePath ?? pending?.projectRelativePath,
      ),
  });
}

/** What a copy is started with; Copy again reuses the last copy's. */
export interface CopyChoices {
  readonly machine: EnvironmentId;
  readonly folder: string;
  readonly mode: FolderCopyMode;
  readonly selection: ReadonlyArray<FolderCopyFileClass>;
  readonly auto: boolean;
  readonly method: "copy" | "clone";
  readonly copyRoot: string;
  readonly projectRelativePath: string;
}

export const POLL_MS = 1000;
/** Destination states past which a copy has written files and can no longer be stopped. */
export const APPLYING: ReadonlySet<string> = new Set(["applying", "applied"]);
/** Repository clicks closer together than this re-compare once. */
export const REPOSITORY_SETTLE_MS = 400;

/** True when `path` sits inside a repository row the person left out. */
export function insideSkipped(
  path: string,
  skip: ReadonlyArray<string>,
  rows: ReadonlyArray<FolderCopyRow>,
): boolean {
  return rows.some(
    (row) => skip.includes(row.id) && row.path !== "." && path.startsWith(`${row.path}/`),
  );
}
export const NOT_ABSOLUTE =
  "Enter the full absolute path of the folder on the destination machine.";
export const absolute = (folder: string) =>
  folder.startsWith("/") || /^[A-Za-z]:[\\/]/.test(folder);

/** What a running step is called on the sidebar row before its status first arrives. */
const STAGE_ACTIVITY: Partial<Record<CopyStage, string>> = {
  scanning: "Measuring the folder",
  planning: "Comparing folders",
  copying: "Copying files",
  moving: "Moving the coordinator",
};

/**
 * Reports a running copy outward: busy and close-lock to the dialog (cleared on unmount),
 * the choices to the dialog title, and progress to the sidebar row and project banner.
 * Once the dialog closes on a running copy, the app-wide watcher takes over the row.
 */
export function useCopyReporting({
  environmentId,
  projectId,
  stage,
  working,
  mode,
  machine,
  copy,
  existingDestination = false,
  scanStatus,
  machineName,
  onBusyChange,
  onChoicesChange,
  onCloseLockChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly stage: CopyStage;
  readonly working: boolean;
  readonly mode: FolderCopyMode;
  readonly machine: EnvironmentId | null;
  readonly copy: FolderCopyStatus | null;
  /** The move's folder already held a project: the sidebar keeps listing it. */
  readonly existingDestination?: boolean | undefined;
  readonly scanStatus: FolderCopySourceStatus | null;
  readonly machineName: string;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onChoicesChange?:
    | ((choices: {
        readonly mode: FolderCopyMode;
        readonly machine: EnvironmentId | null;
        readonly done: boolean;
      }) => void)
    | undefined;
  readonly onCloseLockChange?: ((locked: boolean) => void) | undefined;
}): { readonly busy: boolean; readonly closeLocked: boolean } {
  const busy =
    working ||
    stage === "scanning" ||
    stage === "planning" ||
    stage === "copying" ||
    stage === "moving";
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
  const done = stage === "done";
  useEffect(() => onChoicesChange?.({ mode, machine, done }), [mode, machine, done]);
  // Measuring, comparing and copying run on the machines; only the short context
  // transfer and the steps that release a fence keep the dialog open.
  const closeLocked = stage === "moving" || (working && !CLOSABLE_WHILE_WORKING.has(stage));
  useEffect(() => onCloseLockChange?.(closeLocked), [closeLocked, onCloseLockChange]);
  // Unmounting ends this view of the copy; the parent must not keep a stale busy or lock.
  // The parent reads its running flag when the dialog closes, before this runs.
  const reporters = useRef({ onBusyChange, onCloseLockChange });
  reporters.current = { onBusyChange, onCloseLockChange };
  useEffect(
    () => () => {
      reporters.current.onBusyChange(false);
      reporters.current.onCloseLockChange?.(false);
    },
    [],
  );
  const activityKey = copyActivityKey(environmentId, projectId);
  useEffect(() => {
    if (!busy) return setCopyActivity(activityKey, null);
    const fromCopy = copy ? copyActivityFromStatus(copy, machineName) : null;
    const fromSource = scanStatus ? copyActivityFromSource(scanStatus, machineName) : null;
    const label = STAGE_ACTIVITY[stage];
    const activity =
      fromCopy ??
      (fromSource && !fromSource.waiting ? fromSource : null) ??
      (label ? { machine: machineName, label, fraction: null, waiting: false } : null);
    // A move names its destination, so the sidebar shows one row while both copies exist.
    const destination =
      copy && machine && mode === "copy-and-move"
        ? moveDestination(copy, machine, existingDestination)
        : null;
    setCopyActivity(
      activityKey,
      activity && mode === "copy-and-move"
        ? { ...activity, move: true, ...(destination ? { destination } : {}) }
        : activity,
    );
  }, [activityKey, busy, copy, existingDestination, scanStatus, machineName, stage, mode, machine]);
  return { busy, closeLocked };
}
