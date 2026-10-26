import { useEffect, useRef } from "react";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type { AtomCommandResult } from "@specweave-studio/client-runtime/state/runtime";
import {
  ProjectId,
  type EnvironmentId,
  type FolderCopySourceSummary,
  type FolderCopyStatus,
} from "@specweave-studio/contracts";
import { useAtomCommand } from "../../state/use-atom-command";
import { machineHandoff } from "../../studio/machineHandoff";
import { cloneableRows, copySettled, DEFAULT_COPY_SELECTION } from "../../studio/folderCopy";
import { toastManager } from "../ui/toast";
import {
  folderCopyStorageKey,
  isFolderCopyNotFound,
  readPendingCopy,
  type PendingCopy,
} from "./handoffFolderCopyPending";
import {
  copyStartInput,
  replaceAllReady,
  replacementText,
  replacesNothing,
  replacingCount,
  secretsLeft,
  secretsLeftText,
  undecidedCloneRows,
} from "./handoffCopyAuto";
import { copyProblem, groupCopyNotices, skippedWorktreeParts } from "./handoffCopyNotices";

const WATCH_MS = 2000;
/** A one-click copy that cannot start after this many tries stops and says so. */
const START_ATTEMPTS = 3;
const REOPEN = "Open Continue on another machine";

function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

/** Destination states after an approval landed. */
const APPROVED: ReadonlySet<FolderCopyStatus["state"]> = new Set([
  "approved",
  "transferring",
  "verifying",
  "applying",
  "applied",
]);

/** What stayed on the source: skipped worktrees with work in them and secret-like files. */
function leftBehind(
  status: FolderCopyStatus,
  summary: FolderCopySourceSummary | null,
  sourceLabel: string,
): string | null {
  if (!summary) return null;
  const worktrees = skippedWorktreeParts(
    groupCopyNotices({ skipped: summary.skipped, warnings: [], rootLabel: "Root" }),
    sourceLabel,
  );
  const secrets = secretsLeftText(secretsLeft(summary.secretFiles, status.secrets), sourceLabel);
  const parts = [worktrees.length > 0 ? `${worktrees.join("; ")}.` : null, secrets].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(" ") : null;
}

function announceCopy(
  status: FolderCopyStatus,
  machine: string,
  summary: FolderCopySourceSummary | null,
  sourceLabel: string,
  openDialog: (() => void) | null,
) {
  if (status.state === "previewed") {
    const count = replacingCount(status);
    const replaced =
      count !== null && count > 0
        ? `${count.toLocaleString()} ${count === 1 ? "file" : "files"}`
        : replacementText(status.rows);
    toastManager.add({
      type: "success",
      title: replaced
        ? `Copy to ${machine} would replace ${replaced}. ${REOPEN} to review.`
        : `Copy to ${machine} is ready to review.`,
    });
  } else if (status.state === "applied" && copyProblem(status, sourceLabel)) {
    // Files changed while copying or a check failed: not a success; copying again fixes it.
    const id = toastManager.add({
      type: "warning",
      title: `Copy to ${machine} finished, but ${copyProblem(status, sourceLabel)}.`,
      description: openDialog
        ? "Open it to see what differs and copy again."
        : `${REOPEN} to see what differs and copy again.`,
      ...(openDialog
        ? {
            actionProps: {
              children: "Open",
              onClick: () => {
                toastManager.close(id);
                openDialog();
              },
            },
          }
        : {}),
    });
  } else if (status.state === "applied") {
    const left = leftBehind(status, summary, sourceLabel);
    toastManager.add({
      type: "success",
      title:
        status.mode === "copy-and-move"
          ? `Files are copied to ${machine}. ${REOPEN} to transfer coordinator context.`
          : `Copy to ${machine} is done. ${REOPEN} to finish setting it up.`,
      ...(left ? { description: left } : {}),
    });
  } else if (status.state === "failed")
    toastManager.add({ type: "error", title: `Copy to ${machine} stopped. ${REOPEN} to retry.` });
}

const writePointer = (key: string, value: PendingCopy) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Only resuming after a reload needs the pointer. */
  }
};

/**
 * Mounted while the handoff dialog is closed after it left a measure or copy running.
 * It watches that one operation and says when it is ready, then stops. A one-click copy
 * keeps going here: once measured it starts comparing, and a plan that replaces nothing
 * and has no secret files to choose is approved, as the dialog would. Reopening the
 * dialog unmounts it; the dialog resumes the operation itself.
 */
export function HandoffFolderCopyWatcher({
  environmentId,
  projectId,
  machineLabel,
  sourceLabel = "this machine",
  onOpenDialog,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly machineLabel: (environmentId: string) => string;
  /** This machine's name, for what stayed here after the copy. */
  readonly sourceLabel?: string;
  /** Opens the handoff dialog, which resumes this copy; a warning toast's action calls it. */
  readonly onOpenDialog?: () => void;
}) {
  const status = useAtomCommand(machineHandoff.copyStatus, { reportFailure: false });
  const sourceStatus = useAtomCommand(machineHandoff.copySourceStatus, { reportFailure: false });
  const offerCopy = useAtomCommand(machineHandoff.copyOffer, { reportFailure: false });
  const start = useAtomCommand(machineHandoff.copyStart, { reportFailure: false });
  const decide = useAtomCommand(machineHandoff.copyDecide, { reportFailure: false });
  const approve = useAtomCommand(machineHandoff.copyApprove, { reportFailure: false });
  const commands = { status, sourceStatus, offerCopy, start, decide, approve };
  const latest = useRef({ commands, machineLabel, sourceLabel, onOpenDialog });
  latest.current = { commands, machineLabel, sourceLabel, onOpenDialog };

  useEffect(() => {
    const key = folderCopyStorageKey(environmentId, projectId);
    if (!readPendingCopy(key)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let startFailures = 0;
    const operationId = readPendingCopy(key)!.operationId;

    /** Starts comparing a one-click copy the source has measured. */
    const startPlan = async (saved: PendingCopy) => {
      const { offerCopy, start } = latest.current.commands;
      const destination = saved.environmentId as EnvironmentId;
      // Offering the same operation again returns its record with a fresh token.
      const offer = unwrap(
        await offerCopy({
          environmentId,
          input: {
            projectId: ProjectId.make(projectId),
            operationId: saved.operationId,
            mode: saved.mode,
            destinationEnvironmentId: destination,
            ...(saved.copyRoot && saved.projectRelativePath && saved.projectRelativePath !== "."
              ? { copyRoot: saved.copyRoot }
              : {}),
          },
        }),
      );
      unwrap(
        await start({
          environmentId: destination,
          input: copyStartInput(offer, saved, saved.selection ?? DEFAULT_COPY_SELECTION),
        }),
      );
    };

    /** The source's measured summary, or null when it cannot be read. */
    const readSummary = async (): Promise<FolderCopySourceSummary | null> => {
      try {
        const read = await latest.current.commands.sourceStatus({
          environmentId,
          input: { operationId },
        });
        return read._tag === "Success" ? read.value.summary : null;
      } catch {
        return null;
      }
    };

    /**
     * A preview to carry on: the clone choice once, then approve a one-click plan that
     * replaces nothing, or a plan answered with Replace all once nothing is left open.
     * Secret-like files never stop it; they stay on the source.
     */
    const settle = async (saved: PendingCopy, previewed: FolderCopyStatus) => {
      const { decide, approve, status } = latest.current.commands;
      const destination = saved.environmentId as EnvironmentId;
      if (saved.auto && saved.method === "clone" && !saved.cloneDecided) {
        if (undecidedCloneRows(previewed.rows).length > 0)
          unwrap(
            await decide({
              environmentId: destination,
              input: { operationId, clone: cloneableRows(previewed.rows) },
            }),
          );
        writePointer(key, { ...saved, cloneDecided: true });
        return "again" as const;
      }
      const approvable = saved.replaceAll
        ? replaceAllReady(previewed)
        : saved.auto === true && replacesNothing(previewed);
      if (!approvable) {
        if (saved.replaceAll) {
          // The re-compared plan needs the person: the old click no longer approves it.
          const { replaceAll: _dropped, ...rest } = saved;
          writePointer(key, rest);
        }
        return "ask" as const;
      }
      const approved = await approve({ environmentId: destination, input: { operationId } });
      if (approved._tag === "Success") return "again" as const;
      // The approval may have landed although its answer was lost.
      const current = await status({ environmentId: destination, input: { operationId } });
      return current._tag === "Success" && APPROVED.has(current.value.state)
        ? ("again" as const)
        : ("ask" as const);
    };

    /** Returns whether to keep watching. */
    const check = async (saved: PendingCopy): Promise<boolean> => {
      // A cancelled copy only waits for the dialog to retell the source; never announce it.
      if (saved.cancelled) return false;
      const { commands, machineLabel, sourceLabel } = latest.current;
      const machine = machineLabel(saved.environmentId);
      const destination = await commands.status({
        environmentId: saved.environmentId as EnvironmentId,
        input: { operationId },
      });
      if (stopped) return false;
      if (destination._tag === "Success") {
        if (!copySettled(destination.value)) return true;
        if ((saved.auto || saved.replaceAll) && destination.value.state === "previewed") {
          // A refused choice or approval waits for the person instead of retrying.
          const outcome = await settle(saved, destination.value).catch(() => "ask" as const);
          if (stopped) return false;
          if (outcome === "again") return true;
        }
        const summary = destination.value.state === "applied" ? await readSummary() : null;
        if (stopped) return false;
        const open = latest.current.onOpenDialog;
        announceCopy(destination.value, machine, summary, sourceLabel, open ? () => open() : null);
        return false;
      }
      // An unreachable destination may come back; keep watching.
      if (!isFolderCopyNotFound(squashAtomCommandFailure(destination))) return true;
      const source = await commands.sourceStatus({ environmentId, input: { operationId } });
      if (stopped) return false;
      if (source._tag === "Failure") return !isFolderCopyNotFound(squashAtomCommandFailure(source));
      if (source.value.state === "scanning") return true;
      if (source.value.summary && source.value.state !== "failed") {
        if (saved.auto) {
          try {
            await startPlan(saved);
            return true;
          } catch {
            startFailures += 1;
            if (startFailures < START_ATTEMPTS) return true;
            toastManager.add({
              type: "error",
              title: `Copy to ${machine} could not start. ${REOPEN} to see why.`,
            });
            return false;
          }
        }
        toastManager.add({
          type: "success",
          title: `Folder measured. ${REOPEN} to choose what to copy.`,
        });
      } else if (source.value.state === "failed")
        toastManager.add({
          type: "error",
          title: `Measuring the folder stopped. ${REOPEN} to see why.`,
        });
      return false;
    };

    const tick = () => {
      timer = setTimeout(async () => {
        // Another dialog session finished or replaced this operation.
        const saved = readPendingCopy(key);
        if (stopped || saved?.operationId !== operationId) return;
        let again = true;
        try {
          again = await check(saved);
        } catch {
          again = true;
        }
        if (again && !stopped) tick();
      }, WATCH_MS);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [environmentId, projectId]);

  return null;
}
