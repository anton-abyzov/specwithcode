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
import { refreshSealedRoute, secretsSealed } from "../../studio/copySecretsRoute";
import { machineHandoff } from "../../studio/machineHandoff";
import { recordLinkFailure, recordLinkOutcome } from "../../studio/linkRefusals";
import { linkCopyAsWorkers, projectLink } from "../../studio/projectLink";
import { randomUUID } from "../../lib/utils";
import { cloneableRows, copySettled, DEFAULT_COPY_SELECTION } from "../../studio/folderCopy";
import {
  copyActivityFromSource,
  copyActivityFromStatus,
  copyActivityKey,
  copyDetailsOpener,
  copyActivityText,
  openCopyReview,
  setCopyActivity,
  type CopyActivity,
} from "../../studio/folderCopyActivity";
import { toastManager } from "../ui/toast";
import { notifyCopyReview } from "../../notificationConnection";
import {
  folderCopyStorageKey,
  isFolderCopyNotFound,
  readPendingCopy,
  pendingSecrets,
  secretsPromised,
  type PendingCopy,
} from "./handoffFolderCopyPending";
import { stageForStatus } from "./handoffCopySteps";
import {
  approveInput,
  secretsBlockedNow,
  secretsSenderNow,
  withdrawStagedSecrets,
  withoutSecrets,
} from "./useSecretsGate";
import { isHomeSecretRow, sendableSecrets } from "./handoffCopySecrets";
import type { CopyMachine } from "./HandoffCopySetup";
import {
  copyStartInput,
  replaceAllReady,
  replacementText,
  replacesNothing,
  replacingCount,
  secretsLeft,
  secretsLeftText,
  type SecretsSender,
  undecidedCloneRows,
} from "./handoffCopyAuto";
import { useSyncOffer } from "./useSyncOffer";
import { copyProblem, groupCopyNotices, skippedWorktreeParts } from "./handoffCopyNotices";

const WATCH_MS = 2000;
/** A one-click copy that cannot start after this many tries stops and says so. */
const START_ATTEMPTS = 3;
/** Checks a restored copy still to be linked waits for its machine to connect: one minute. */
const RESTORED_LINK_WAITS = 30;
/** Without a machines list (a test, an early mount) nothing is known about `~/` files. */
const homeSecretsUnknown = (): boolean | null => null;
/** The toast's way back: the project's Move dialog resumes the copy. */
const reopenText = (projectName: string | undefined) =>
  `Open Move ${projectName?.trim() || "project"}`;

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
  sender: SecretsSender,
): string | null {
  if (!summary) return null;
  const worktrees = skippedWorktreeParts(
    groupCopyNotices({
      skipped: summary.skipped,
      warnings: [],
      rootLabel: "Root",
    }),
    sourceLabel,
  );
  const secrets = secretsLeftText(
    secretsLeft(summary.secretFiles, status.secrets),
    sourceLabel,
    sender,
  );
  const parts = [worktrees.length > 0 ? `${worktrees.join("; ")}.` : null, secrets].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(" ") : null;
}

/** The failure's own words, short enough for a toast; the dialog shows the rest. */
export function failureReason(message: string | null | undefined): string | null {
  const text = message?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const sentence = text.length > 180 ? `${text.slice(0, 177).trimEnd()}...` : text;
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/** Adds a toast with an Open button that closes it and opens the copy's dialog. */
function addWithOpen(
  options: Parameters<typeof toastManager.add>[0],
  openDialog: (() => void) | null,
  label = "Open",
) {
  const id: string = toastManager.add({
    ...options,
    ...(openDialog
      ? {
          actionProps: {
            children: label,
            onClick: () => {
              toastManager.close(id);
              openDialog();
            },
          },
        }
      : {}),
  });
  return id;
}

export function announceCopy(
  REOPEN: string,
  status: FolderCopyStatus,
  machine: string,
  summary: FolderCopySourceSummary | null,
  sourceLabel: string,
  openDialog: (() => void) | null,
  /** False in a window that may not send the source's secrets: the text says where to. */
  sender: SecretsSender = "here",
) {
  const reopen = (what: string) => (openDialog ? `Open it to ${what}.` : `${REOPEN} to ${what}.`);
  if (status.state === "previewed") {
    const count = replacingCount(status);
    const replaced =
      count !== null && count > 0
        ? `${count.toLocaleString()} ${count === 1 ? "file" : "files"}`
        : replacementText(status.rows);
    addWithOpen(
      {
        type: "success",
        title: replaced
          ? `Copy to ${machine} would replace ${replaced}.${openDialog ? "" : ` ${REOPEN} to review.`}`
          : `Copy to ${machine} is ready to review.`,
        timeout: 0,
      },
      openDialog,
      "Review",
    );
  } else if (status.state === "applied" && copyProblem(status, sourceLabel)) {
    // Files changed while copying or a check failed: not a success; copying again fixes it.
    addWithOpen(
      {
        type: "warning",
        title: `Copy to ${machine} finished, but ${copyProblem(status, sourceLabel)}.`,
        description: reopen("see what differs and copy again"),
        timeout: 0,
      },
      openDialog,
    );
  } else if (status.state === "applied") {
    const left = leftBehind(status, summary, sourceLabel, sender);
    addWithOpen(
      {
        type: "success",
        // With an Open button the title names only what happened; the button says how to go on.
        title: openDialog
          ? status.mode === "copy-and-move"
            ? `Files are copied to ${machine}`
            : `Copy to ${machine} is done`
          : status.mode === "copy-and-move"
            ? `Files are copied to ${machine}. ${REOPEN} to move the coordinator.`
            : `Copy to ${machine} is done. ${REOPEN} to finish setting it up.`,
        // The finished track, turning to success phase by phase as in the dialog.
        data: {
          progress: 1,
          progressSegments: 3,
          progressTone: "success",
          progressLabel: "Copy progress",
        },
        ...(openDialog || left
          ? {
              description: [
                left,
                openDialog
                  ? status.mode === "copy-and-move"
                    ? "Open it to move the coordinator."
                    : "Open it to finish setting it up."
                  : null,
              ]
                .filter(Boolean)
                .join(" "),
            }
          : {}),
      },
      openDialog,
    );
  } else if (status.state === "failed") {
    // A failure stays until dismissed: it names why and how to go on.
    const reason = failureReason(status.error?.message);
    addWithOpen(
      {
        type: "error",
        title: `Copy to ${machine} stopped`,
        description: [reason, reopen("retry; files already copied are kept")]
          .filter(Boolean)
          .join(" "),
        timeout: 0,
      },
      openDialog,
      "Retry",
    );
  }
}

const writePointer = (key: string, value: PendingCopy) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Only resuming after a reload needs the pointer. */
  }
};

/**
 * Mounted app wide while the handoff dialog is closed after it left a measure or copy
 * running, so switching projects never stops it. It watches that one operation, shows
 * its progress on the project's sidebar row and banner, and says when it is ready, then
 * stops. A one-click copy
 * keeps going here: once measured it starts comparing, and a plan that replaces nothing
 * is approved, as the dialog would, after the saved secrets choice goes to the source.
 * A finished copy-only copy is linked to its source here, so the link never waits for the
 * dialog. Reopening the dialog unmounts it; the dialog resumes the operation itself.
 */
export function HandoffFolderCopyWatcher({
  environmentId,
  projectId,
  machineLabel,
  projectName,
  sourceLabel = "this machine",
  onOpenDialog,
  restored = false,
  reviewOnly = false,
  homeSecrets = homeSecretsUnknown,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly machineLabel: (environmentId: string) => string;
  /** The project's name, for the toast's "Open Move {project}". */
  readonly projectName?: string | undefined;
  /** This machine's name, for what stayed here after the copy. */
  readonly sourceLabel?: string;
  /** Opens the handoff dialog, which resumes this copy; a warning toast's action calls it. */
  readonly onOpenDialog?: () => void;
  /** Restored after a reload: a copy that already finished is not announced again. */
  readonly restored?: boolean;
  /**
   * Closed at its review by the person: shows the copy as waiting, with no toast and no
   * approval, until a dialog takes it back or it changes on the machines.
   */
  readonly reviewOnly?: boolean;
  /**
   * Whether a machine writes `~/` secret files into its home folder; null while that is not
   * known, and then a copy with such files is left to the person instead of leaving them out.
   */
  readonly homeSecrets?: (environmentId: string) => boolean | null;
  /** Called once the watcher stops watching. */
  readonly onDone?: () => void;
}) {
  const REOPEN = reopenText(projectName);
  const status = useAtomCommand(machineHandoff.copyStatus, {
    reportFailure: false,
  });
  const sourceStatus = useAtomCommand(machineHandoff.copySourceStatus, {
    reportFailure: false,
  });
  const offerCopy = useSyncOffer();
  const start = useAtomCommand(machineHandoff.copyStart, {
    reportFailure: false,
  });
  const decide = useAtomCommand(machineHandoff.copyDecide, {
    reportFailure: false,
  });
  const approve = useAtomCommand(machineHandoff.copyApprove, {
    reportFailure: false,
  });
  const sendSecrets = useAtomCommand(machineHandoff.copySecrets, {
    reportFailure: false,
  });
  const sendSealedSecrets = useAtomCommand(machineHandoff.copySealedSecrets, {
    reportFailure: false,
  });
  const secretsRoute = useAtomCommand(machineHandoff.copySecretsRoute, {
    reportFailure: false,
  });
  const commands = {
    status,
    sourceStatus,
    offerCopy,
    start,
    decide,
    approve,
    sendSecrets,
    sendSealedSecrets,
    secretsRoute,
  };
  const links = {
    preview: useAtomCommand(projectLink.preview, { reportFailure: false }),
    prepare: useAtomCommand(projectLink.prepare, { reportFailure: false }),
    accept: useAtomCommand(projectLink.accept, { reportFailure: false }),
    commit: useAtomCommand(projectLink.commit, { reportFailure: false }),
  };
  const latest = useRef({
    commands,
    links,
    machineLabel,
    sourceLabel,
    projectName,
    onOpenDialog,
    homeSecrets,
    onDone,
  });
  latest.current = {
    commands,
    links,
    machineLabel,
    sourceLabel,
    projectName,
    onOpenDialog,
    homeSecrets,
    onDone,
  };

  useEffect(() => {
    const key = folderCopyStorageKey(environmentId, projectId);
    const activityKey = copyActivityKey(environmentId, projectId);
    if (!readPendingCopy(key)) {
      latest.current.onDone?.();
      return;
    }
    // Only the first check of a restored watch can find a copy that finished unseen.
    let quiet = restored || reviewOnly;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let startFailures = 0;
    let linkWaits = 0;
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

    /** The destination as the dialog knows it, for which secret files it can receive. */
    const destinationOf = (saved: PendingCopy): CopyMachine => ({
      id: saved.environmentId as EnvironmentId,
      label: latest.current.machineLabel(saved.environmentId),
      unavailable: null,
      homeSecretFiles: latest.current.homeSecrets(saved.environmentId) === true,
    });

    /**
     * Sends the copy's saved secrets choice (What comes along showed it) before an approval
     * here: every file the dialog would send, `~/` files included when that machine takes
     * them. Returns the list sent; false when the source's list cannot be read, the send
     * failed, or whether that machine takes `~/` files is not known yet.
     */
    const stageSecrets = async (
      previewed: FolderCopyStatus,
    ): Promise<ReadonlyArray<string> | false> => {
      const summary = await readSummary();
      // Read the pointer again: a reopened dialog owns the choice and the approval from here.
      const saved = readPendingCopy(key);
      if (stopped || !summary || saved?.operationId !== operationId) return false;
      const blocked = secretsBlockedNow(environmentId, saved.environmentId);
      const choice = blocked ? withoutSecrets(pendingSecrets(saved)) : pendingSecrets(saved);
      // Never leave `~/` files out on a guess: the person decides at the review.
      if (
        choice.included &&
        summary.secretFiles.some((file) => isHomeSecretRow(file.path)) &&
        latest.current.homeSecrets(saved.environmentId) === null
      )
        return false;
      const paths = sendableSecrets({
        summary,
        plan: previewed,
        repositories: null,
        machine: destinationOf(saved),
        choice,
      });
      if (!paths) return [];
      // Only the source's own window may send secrets: from here staged ones come off.
      if (blocked && paths.length === 0)
        return withdrawStagedSecrets({
          staged: async () => {
            const read = await latest.current.commands.sourceStatus({
              environmentId,
              input: { operationId },
            });
            return read._tag === "Success" ? (read.value.secrets?.files.length ?? 0) : null;
          },
          withdraw: async () =>
            (
              await latest.current.commands.sendSecrets({
                environmentId,
                input: {
                  operationId,
                  paths: [],
                  destinationLabel: latest.current.machineLabel(saved.environmentId),
                },
              })
            )._tag === "Success",
          sourceLabel: latest.current.machineLabel(environmentId),
        }).then(
          () => (stopped ? false : paths),
          () => false,
        );
      // Without access:write the source seals the files to that machine (copySecretsRoute).
      const send = (choice: PendingCopy, list: ReadonlyArray<string>) =>
        (list.length > 0 && secretsSealed(environmentId, choice.environmentId)
          ? latest.current.commands.sendSealedSecrets
          : latest.current.commands.sendSecrets)({
          environmentId,
          input: {
            operationId,
            paths: list,
            destinationLabel: latest.current.machineLabel(choice.environmentId),
          },
        });
      const sent = await send(saved, paths);
      if (sent._tag === "Success" && !unchanged(saved)) {
        // Another tab changed the choice, and may have approved, while this list was on its way:
        // put the current choice back on the source and leave the copy to the person.
        const now = readPendingCopy(key);
        const current =
          now?.operationId === operationId &&
          sendableSecrets({
            summary,
            plan: previewed,
            repositories: null,
            machine: destinationOf(now),
            choice: pendingSecrets(now),
          });
        if (now && current) await send(now, current);
        return false;
      }
      return !stopped && sent._tag === "Success" ? paths : false;
    };
    /** The pointer still says what this run acted on: same copy, Replace all and secrets. */
    const unchanged = (acted: PendingCopy) => {
      const now = readPendingCopy(key);
      const choice = (copy: PendingCopy) => JSON.stringify(pendingSecrets(copy));
      return (
        now?.operationId === operationId &&
        Boolean(now.replaceAll) === Boolean(acted.replaceAll) &&
        choice(now) === choice(acted)
      );
    };

    /**
     * A preview to carry on: the clone choice once, then approve a one-click plan that
     * replaces nothing, or a plan answered with Replace all once nothing is left open.
     * Replace all sent its secrets when it was clicked; a one-click plan sends them here.
     */
    const settle = async (read: PendingCopy, previewed: FolderCopyStatus) => {
      // Another tab may have changed the pointer while the status was read: act on the current one.
      const saved = readPendingCopy(key);
      if (stopped || saved?.operationId !== read.operationId) return "ask" as const;
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
        // A reopened dialog may have changed the pointer meanwhile: mark only this operation's.
        const now = readPendingCopy(key);
        if (stopped || now?.operationId !== operationId) return "ask" as const;
        writePointer(key, { ...now, cloneDecided: true });
        return "again" as const;
      }
      const approvable = saved.replaceAll
        ? replaceAllReady(previewed)
        : saved.auto === true && replacesNothing(previewed);
      if (!approvable) {
        const now = readPendingCopy(key);
        if (now?.replaceAll && now.operationId === operationId) {
          // The re-compared plan needs the person: the old click no longer approves it.
          const { replaceAll: _dropped, ...rest } = now;
          writePointer(key, rest);
        }
        return "ask" as const;
      }
      // The form said secrets are included, and this window turned out unable to send them:
      // nothing is approved without them unseen. The review says why; the person decides there.
      // The same for a pointer that carries no secrets choice at all (an older version's).
      await refreshSealedRoute(
        environmentId,
        saved.environmentId,
        latest.current.commands.secretsRoute,
      );
      if (
        saved.secrets === undefined ||
        (secretsBlockedNow(environmentId, saved.environmentId) && secretsPromised(saved))
      ) {
        if (saved.replaceAll) {
          const { replaceAll: _dropped, ...rest } = saved;
          writePointer(key, rest);
        }
        return "ask" as const;
      }
      // The choice goes to the source again even after a Replace all that sent it when
      // clicked: the approval then names every file, and the destination requires them. A
      // blocked window takes staged ones off, since an older destination ignores the
      // approval's withoutSecrets.
      const staged = await stageSecrets(previewed);
      if (staged === false) return "ask" as const;
      if (stopped || !unchanged(saved)) return "ask" as const;
      // Approved without secrets when this window may not send them or the choice leaves
      // them; otherwise with the list just sent, which the destination then requires.
      const input = approveInput(
        operationId,
        environmentId,
        pendingSecrets(saved).included,
        staged,
        saved.environmentId,
        previewed.previewRevision,
      );
      const approved = await approve({ environmentId: destination, input });
      if (approved._tag === "Success") return "again" as const;
      // The approval may have landed although its answer was lost.
      const current = await status({
        environmentId: destination,
        input: { operationId },
      });
      return current._tag === "Success" && APPROVED.has(current.value.state)
        ? ("again" as const)
        : ("ask" as const);
    };

    /**
     * Links a finished copy-only copy as a member that runs workers, as the dialog's Done
     * does, and records it on the pointer. A link that needs review or fails is left for the
     * dialog, which tries again when it opens.
     */
    const linkDone = async (done: FolderCopyStatus) => {
      const saved = readPendingCopy(key);
      // A dialog that took the copy back links it itself.
      if (stopped || saved?.operationId !== operationId) return;
      if (saved.mode !== "copy-only" || saved.linked) return;
      if (stageForStatus(done) !== "done" || !done.projectId) return;
      const joining = `${saved.environmentId}:${done.projectId}`;
      try {
        const outcome = await linkCopyAsWorkers(latest.current.links, {
          kept: { environmentId, projectId: ProjectId.make(projectId) },
          joining: {
            environmentId: saved.environmentId as EnvironmentId,
            projectId: done.projectId,
          },
          keptLabel: latest.current.sourceLabel,
          joiningLabel: latest.current.machineLabel(saved.environmentId),
          newOperationId: randomUUID,
        });
        const now = readPendingCopy(key);
        // The machine menu says why beside Link while the dialog stays closed.
        recordLinkOutcome(`${environmentId}:${projectId}`, joining, outcome);
        if (outcome.status === "linked" && now?.operationId === operationId && !now.linked)
          writePointer(key, { ...now, linked: true });
      } catch (cause) {
        recordLinkFailure(
          `${environmentId}:${projectId}`,
          joining,
          cause instanceof Error && cause.message ? cause.message : "Linking stopped.",
        );
        /* The dialog links it when it opens. */
      }
    };

    /** Returns whether to keep watching. */
    /** The activity with what is copied and from where, for the banner and Needs you. */
    const named = (activity: CopyActivity | null): CopyActivity | null => {
      if (!activity) return null;
      const { projectName: project, sourceLabel: source } = latest.current;
      return {
        ...activity,
        ...(project ? { project } : {}),
        ...(source && source !== "this machine" ? { source } : {}),
      };
    };

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
      const firstCheck = quiet;
      quiet = false;
      if (destination._tag === "Success") {
        const activity = named(
          copyActivityFromStatus(
            destination.value,
            machine,
            saved.environmentId,
            saved.existingDestination,
            sourceLabel,
          ),
        );
        setCopyActivity(activityKey, activity);
        if (!copySettled(destination.value)) return true;
        // Closed on the machine, by a person or a later finished copy: nothing to come back to.
        if (destination.value.state === "cancelled") {
          try {
            // Another tab may have started a newer copy meanwhile: keep its pointer.
            if (readPendingCopy(key)?.operationId === operationId) localStorage.removeItem(key);
          } catch {
            /* A kept pointer only re-reads this closed copy at the next start. */
          }
          return false;
        }
        // A copy closed at its review that finished elsewhere was never seen: announce it.
        if (firstCheck && !(reviewOnly && destination.value.state !== "previewed")) {
          // Found waiting after a restart: nothing else says so, so the toast and a system
          // notification do, each with a way to the review.
          if (activity?.waiting && !reviewOnly) {
            const review = () => openCopyReview(activityKey);
            const title = copyActivityText(activity);
            addWithOpen(
              {
                type: "success",
                title: `${title}. Nothing is copied until you approve it.`,
                timeout: 0,
              },
              review,
              "Review",
            );
            notifyCopyReview({
              tag: `folder-copy-review:${operationId}`,
              title,
              environmentId,
              projectId,
              coordinatorThreadId: `project-coordinator:${projectId}`,
              onOpen: review,
            });
          }
          // A copy that finished while the app was closed is linked without being announced.
          // The link runs on by itself: the watch ends here either way.
          void linkDone(destination.value);
          return false;
        }
        if (
          !reviewOnly &&
          (saved.auto || saved.replaceAll) &&
          destination.value.state === "previewed"
        ) {
          // A refused choice or approval waits for the person instead of retrying.
          const outcome = await settle(saved, destination.value).catch(() => "ask" as const);
          if (stopped) return false;
          if (outcome === "again") return true;
        }
        const summary = destination.value.state === "applied" ? await readSummary() : null;
        if (stopped) return false;
        const open = latest.current.onOpenDialog ?? copyDetailsOpener(activityKey);
        announceCopy(
          REOPEN,
          destination.value,
          machine,
          summary,
          sourceLabel,
          open ? () => open() : null,
          secretsSenderNow(environmentId, saved.environmentId),
        );
        if (destination.value.state === "previewed" && activity)
          notifyCopyReview({
            tag: `folder-copy-review:${operationId}`,
            title: copyActivityText(activity),
            environmentId,
            projectId,
            coordinatorThreadId: `project-coordinator:${projectId}`,
            onOpen: () => openCopyReview(activityKey),
          });
        void linkDone(destination.value);
        return false;
      }
      // An unreachable destination may come back; keep watching, unless only restored.
      if (!isFolderCopyNotFound(squashAtomCommandFailure(destination))) {
        // After a restart machines connect a little later: a copy that may still need its
        // link waits for that, quietly, instead of leaving the link to a reopened dialog.
        const awaitsLink = restored && saved.mode === "copy-only" && !saved.linked;
        if (firstCheck && awaitsLink && (linkWaits += 1) <= RESTORED_LINK_WAITS) {
          quiet = true;
          return true;
        }
        return !firstCheck;
      }
      const source = await commands.sourceStatus({
        environmentId,
        input: { operationId },
      });
      if (stopped) return false;
      if (source._tag === "Failure") {
        const gone = isFolderCopyNotFound(squashAtomCommandFailure(source));
        if (gone) setCopyActivity(activityKey, null);
        return !gone;
      }
      setCopyActivity(
        activityKey,
        named(copyActivityFromSource(source.value, machine, sourceLabel)),
      );
      if (source.value.state === "scanning") return true;
      // Only observed: a copy closed at its review never starts a new comparison.
      if (reviewOnly || (firstCheck && !saved.auto)) return false;
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
              timeout: 0,
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
          title: "Measuring the folder stopped",
          description: [failureReason(source.value.error), `${REOPEN} to try again.`]
            .filter(Boolean)
            .join(" "),
          timeout: 0,
        });
      return false;
    };

    const tick = () => {
      timer = setTimeout(async () => {
        // Another dialog session finished or replaced this operation.
        const saved = readPendingCopy(key);
        if (stopped) return;
        if (saved?.operationId !== operationId) {
          latest.current.onDone?.();
          return;
        }
        let again = true;
        try {
          again = await check(saved);
        } catch {
          again = true;
        }
        if (stopped) return;
        if (again) tick();
        else latest.current.onDone?.();
      }, WATCH_MS);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [environmentId, projectId, restored, reviewOnly]);

  return null;
}
