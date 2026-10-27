import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@specweave-studio/client-runtime/state/runtime";
import type {
  EnvironmentId,
  FolderCopyChoice,
  FolderCopyFileClass,
  FolderCopyOffer,
  FolderCopySourceSummary,
  FolderCopyStatus,
  ProjectId,
} from "@specweave-studio/contracts";
import { folderCopyAllConflictsKey } from "@specweave-studio/contracts";
import { useAtomCommand } from "../state/use-atom-command";
import { copySettled } from "./folderCopy";
import { machineHandoff } from "./machineHandoff";
import { projectLink, type LinkCommands } from "./projectLink";

/**
 * The folder copy steps Add to another machine shares between its dialog (an
 * existing checkout to consolidate) and the job runner (extras after a clone).
 * Same RPCs and rules as the machine handoff copy; only the driving differs.
 */

export const COPY_POLL_MS = 1000;
const OPTIONS = { reportFailure: false } as const;

export function useCopyCommands() {
  return {
    offer: useAtomCommand(machineHandoff.copyOffer, OPTIONS),
    sourceStatus: useAtomCommand(machineHandoff.copySourceStatus, OPTIONS),
    sourceCancel: useAtomCommand(machineHandoff.copySourceCancel, OPTIONS),
    start: useAtomCommand(machineHandoff.copyStart, OPTIONS),
    status: useAtomCommand(machineHandoff.copyStatus, OPTIONS),
    decide: useAtomCommand(machineHandoff.copyDecide, OPTIONS),
    approve: useAtomCommand(machineHandoff.copyApprove, OPTIONS),
    cancel: useAtomCommand(machineHandoff.copyCancel, OPTIONS),
    undo: useAtomCommand(machineHandoff.copyUndo, OPTIONS),
    secrets: useAtomCommand(machineHandoff.copySecrets, OPTIONS),
  };
}
export type CopyCommands = ReturnType<typeof useCopyCommands>;

export function useLinkCommands(): LinkCommands {
  return {
    preview: useAtomCommand(projectLink.preview, OPTIONS),
    prepare: useAtomCommand(projectLink.prepare, OPTIONS),
    accept: useAtomCommand(projectLink.accept, OPTIONS),
    commit: useAtomCommand(projectLink.commit, OPTIONS),
  };
}

export function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

const tagged = (cause: unknown, tag: string) =>
  typeof cause === "object" && cause !== null && (cause as { _tag?: unknown })._tag === tag;
const codeOf = (cause: unknown) => (cause as { code?: unknown }).code;

export const isCopyError = (cause: unknown, code: string) =>
  tagged(cause, "FolderCopyError") && codeOf(cause) === code;

export const isAbort = (cause: unknown) =>
  cause instanceof DOMException && cause.name === "AbortError";

/** A machine that was offline or busy; the same step can work later. */
export function isTransient(cause: unknown): boolean {
  if (tagged(cause, "EnvironmentRpcUnavailableError")) return true;
  if (tagged(cause, "FolderCopyError"))
    return codeOf(cause) === "unreachable" || codeOf(cause) === "busy";
  if (tagged(cause, "ProjectLinkError"))
    return codeOf(cause) === "coordinator_busy" || codeOf(cause) === "handoff_in_progress";
  return false;
}

export const messageOf = (cause: unknown, fallback = "The copy could not continue.") =>
  cause instanceof Error && cause.message ? cause.message : fallback;

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("closed", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("closed", "AbortError"));
    });
  });

/** What a copy carries: the repository after a clone, the whole folder into an existing checkout. */
export function addCopySelection(
  kind: "clone" | "consolidate",
  copyIgnored: boolean,
): FolderCopyFileClass[] {
  const base: FolderCopyFileClass[] =
    kind === "clone" ? ["repository"] : ["repository", "tracked", "untracked"];
  return copyIgnored ? [...base, "ignoredData"] : base;
}

/** D-02: a diverged repository is never overwritten, so "take theirs" is not offered there. */
export function withoutDivergedTakeTheirs(status: FolderCopyStatus): FolderCopyStatus {
  if (!status.rows.some((row) => row.kind === "repository" && row.status === "diverged"))
    return status;
  return {
    ...status,
    rows: status.rows.map((row) =>
      row.kind === "repository" && row.status === "diverged"
        ? {
            ...row,
            choices: row.choices.filter((choice) => choice !== "take-theirs"),
            decision: row.decision === "take-theirs" ? null : row.decision,
          }
        : row,
    ),
  };
}

/** Keeps what the destination has for every open question; nothing there is overwritten. */
export function keepMineDecisions(status: FolderCopyStatus): Record<string, FolderCopyChoice> {
  const decisions: Record<string, FolderCopyChoice> = {};
  for (const row of status.rows) {
    if (row.needsDecision && row.choices.includes("keep-mine")) decisions[row.id] = "keep-mine";
    if (
      (row.moreConflicts > 0 || row.conflicts.some((conflict) => conflict.decision === null)) &&
      row.conflicts.every((conflict) => conflict.choices.includes("keep-mine"))
    )
      decisions[folderCopyAllConflictsKey(row.id)] = "keep-mine";
  }
  return decisions;
}

export const copyApplied = (status: FolderCopyStatus) =>
  status.state === "applied" && status.committed && status.projectId !== null;

/** Offers the source folder to the destination and waits for the source scan. */
export async function offerAndScan(
  commands: CopyCommands,
  input: {
    readonly source: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
    readonly destinationEnvironmentId: EnvironmentId;
    readonly operationId: string;
    readonly signal?: AbortSignal;
  },
): Promise<{ readonly offer: FolderCopyOffer; readonly summary: FolderCopySourceSummary }> {
  const offer = unwrap(
    await commands.offer({
      environmentId: input.source.environmentId,
      input: {
        projectId: input.source.projectId,
        operationId: input.operationId,
        mode: "copy-only",
        destinationEnvironmentId: input.destinationEnvironmentId,
      },
    }),
  );
  let scanned = offer.status;
  while (scanned.state === "scanning") {
    await sleep(COPY_POLL_MS, input.signal);
    scanned = unwrap(
      await commands.sourceStatus({
        environmentId: input.source.environmentId,
        input: { operationId: input.operationId },
      }),
    );
  }
  if (!scanned.summary) throw new Error(scanned.error ?? "The folder could not be read.");
  return { offer, summary: scanned.summary };
}

export async function pollCopy(
  commands: CopyCommands,
  environmentId: EnvironmentId,
  operationId: string,
  options: {
    readonly signal?: AbortSignal;
    readonly onStatus?: (status: FolderCopyStatus) => void;
  },
): Promise<FolderCopyStatus> {
  for (;;) {
    const next = unwrap(await commands.status({ environmentId, input: { operationId } }));
    options.onStatus?.(next);
    if (copySettled(next)) return next;
    await sleep(COPY_POLL_MS, options.signal);
  }
}

/** The destination pulls the offered folder into `targetFolder` and stops at the preview. */
export async function startCopy(
  commands: CopyCommands,
  input: {
    readonly offer: FolderCopyOffer;
    readonly destinationEnvironmentId: EnvironmentId;
    readonly targetFolder: string;
    readonly selection: ReadonlyArray<FolderCopyFileClass>;
    readonly signal?: AbortSignal;
    readonly onStatus?: (status: FolderCopyStatus) => void;
  },
): Promise<FolderCopyStatus> {
  const { offer } = input;
  unwrap(
    await commands.start({
      environmentId: input.destinationEnvironmentId,
      input: {
        operationId: offer.operationId,
        sourceEnvironmentId: offer.sourceEnvironmentId,
        sourceProjectId: offer.sourceProjectId,
        sourceUrl: offer.sourceUrl,
        ...(offer.sourceConnectUrl ? { sourceConnectUrl: offer.sourceConnectUrl } : {}),
        sourceMachine: offer.sourceMachine,
        token: offer.token,
        title: offer.title,
        mode: offer.mode,
        targetFolder: input.targetFolder,
        selection: input.selection,
      },
    }),
  );
  return pollCopy(commands, input.destinationEnvironmentId, offer.operationId, input);
}

/** Sends only the ticked secret files, then applies the previewed copy and waits for it. */
export async function applyCopy(
  commands: CopyCommands,
  input: {
    readonly sourceEnvironmentId: EnvironmentId;
    readonly destinationEnvironmentId: EnvironmentId;
    readonly destinationLabel: string;
    readonly operationId: string;
    readonly secrets: ReadonlyArray<string>;
    readonly signal?: AbortSignal;
    readonly onStatus?: (status: FolderCopyStatus) => void;
  },
): Promise<FolderCopyStatus> {
  const { operationId } = input;
  if (input.secrets.length > 0)
    unwrap(
      await commands.secrets({
        environmentId: input.sourceEnvironmentId,
        input: { operationId, paths: input.secrets, destinationLabel: input.destinationLabel },
      }),
    );
  try {
    const approved = unwrap(
      await commands.approve({
        environmentId: input.destinationEnvironmentId,
        input: { operationId },
      }),
    );
    input.onStatus?.(approved);
  } catch (cause) {
    // A refusal (disk space, a changed preview) happens before anything is copied.
    await pollCopy(commands, input.destinationEnvironmentId, operationId, input).catch(() => null);
    throw cause;
  }
  return pollCopy(commands, input.destinationEnvironmentId, operationId, input);
}

/** Withdraws a copy that was not applied, on both machines. */
export async function cancelCopy(
  commands: CopyCommands,
  input: {
    readonly sourceEnvironmentId: EnvironmentId;
    readonly destinationEnvironmentId: EnvironmentId | null;
    readonly operationId: string;
    readonly reason: string;
  },
): Promise<void> {
  const { operationId, reason } = input;
  if (input.destinationEnvironmentId)
    await commands
      .cancel({ environmentId: input.destinationEnvironmentId, input: { operationId, reason } })
      .catch(() => null);
  await commands
    .sourceCancel({ environmentId: input.sourceEnvironmentId, input: { operationId, reason } })
    .catch(() => null);
}

/** Tells the job runner in this tab that the dialog stored a job; `storage` fires only in other tabs. */
export const ADD_TO_MACHINE_JOBS_EVENT = "specwithcode:add-to-machine-jobs";
export function notifyAddToMachineJobs(): void {
  try {
    window.dispatchEvent(new Event(ADD_TO_MACHINE_JOBS_EVENT));
  } catch {
    /* No window: nothing listens. */
  }
}

/** The runner's copy for a job, so a reload resumes it instead of copying twice. */
const copyPointerKey = (environmentId: EnvironmentId, projectId: ProjectId) =>
  `specwithcode:add-to-machine-copy:${JSON.stringify([environmentId, projectId])}`;

export function readAddToMachineCopy(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): string | null {
  try {
    const value = JSON.parse(
      localStorage.getItem(copyPointerKey(environmentId, projectId)) ?? "null",
    ) as { operationId?: unknown } | null;
    return typeof value?.operationId === "string" ? value.operationId : null;
  } catch {
    return null;
  }
}

export function writeAddToMachineCopy(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  operationId: string | null,
): void {
  try {
    const key = copyPointerKey(environmentId, projectId);
    if (operationId === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ operationId }));
  } catch {
    /* Without storage a reload starts the copy again from its preview. */
  }
}
