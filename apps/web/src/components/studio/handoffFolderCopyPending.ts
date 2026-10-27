import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type { AtomCommandResult } from "@specweave-studio/client-runtime/state/runtime";
import type {
  FolderCopyFileClass,
  FolderCopyMode,
  FolderCopySourceStatus,
  FolderCopyStatus,
} from "@specweave-studio/contracts";
import { formatBytes } from "../../studio/folderCopy";
import { isCopyStepId, type CopyStepId } from "./handoffCopyWizard";

/**
 * What "Replace all" leads to: "copy" when it answers everything still open, "copy-kept"
 * when some items keep the destination's version, "ask" when something still needs a choice.
 */
export type ReplaceAllOutcome = "copy" | "copy-kept" | "ask";

const REPLACE_ALL_OUTCOMES: ReadonlySet<unknown> = new Set(["copy", "copy-kept", "ask"]);

/** Browser-side pointer and helpers for a folder copy the dialog can leave and resume. */
export interface PendingCopy {
  readonly operationId: string;
  readonly environmentId: string;
  readonly mode: FolderCopyMode;
  readonly targetFolder: string;
  readonly projectId: string | null;
  readonly copyRoot?: string;
  readonly projectRelativePath?: string;
  /** What to copy, kept so a reopened dialog shows the same choice. */
  readonly selection?: ReadonlyArray<FolderCopyFileClass>;
  /**
   * One-click copy: measuring, comparing and an approval that replaces nothing run
   * straight through. Absent for copies that stop to choose what to copy.
   */
  readonly auto?: boolean;
  /** How the destination gets the files; "clone" answers cloneable rows automatically. */
  readonly method?: "copy" | "clone";
  /** The clone method's automatic choice was sent; a reopened preview keeps the person's edits. */
  readonly cloneDecided?: boolean;
  /**
   * The person clicked Replace all: once the re-compared plan has no open choice and the
   * destination has room, it is approved, even if the dialog closed meanwhile.
   */
  readonly replaceAll?: boolean;
  /** What that click led to, so a reopened re-compare says the same as the click did. */
  readonly replaceAllOutcome?: ReplaceAllOutcome;
  /**
   * The person chose Move anyway on a held move: transferring coordinator context, a retry
   * of that step and a reopened dialog go ahead despite the differences.
   */
  readonly moveAnyway?: boolean;
  /**
   * The person cancelled while the source was measuring, and the source has not confirmed
   * dropping it. A reopened dialog only tells the source again; it never resumes the copy.
   */
  readonly cancelled?: boolean;
  /** The furthest live step this browser rendered for the copy. */
  readonly seen?: CopyStepId;
  /** The step on screen when it last changed, live or a review; a reopen comes back to it. */
  readonly viewed?: CopyStepId;
  /** Done rendered for a committed copy-only copy: the next reopen archives it as the last copy. */
  readonly doneSeen?: true;
  /** The copy was linked as a worker; a reopen does not link it again. */
  readonly linked?: true;
  /** The person saw the compared plan, so a one-click copy's Review was not approved automatically. */
  readonly planShown?: true;
  /** The last copy, opened again with View: it can go back to being the last copy. */
  readonly reopened?: true;
}

export const CANCELLED_WHILE_MEASURING = "The copy was cancelled while measuring.";

/** A copy cancelled while measuring: nothing about it may run on by itself any more. */
export const cancelledPointer = (saved: PendingCopy): PendingCopy => {
  const { auto: _auto, replaceAll: _all, replaceAllOutcome: _outcome, ...rest } = saved;
  return { ...rest, cancelled: true };
};

export const folderCopyStorageKey = (environmentId: string, projectId: string) =>
  `specwithcode:folder-copy:${environmentId}:${projectId}`;

const COPYABLE_CLASSES: Readonly<Record<Exclude<FolderCopyFileClass, "secret">, true>> = {
  repository: true,
  tracked: true,
  untracked: true,
  ignoredData: true,
  rebuildable: true,
};

/** A pointer read back from storage, with every optional field checked; null when unusable. */
function parsePendingCopy(value: unknown): PendingCopy | null {
  const pointer = value as PendingCopy | null;
  if (
    !pointer ||
    typeof pointer !== "object" ||
    typeof pointer.operationId !== "string" ||
    typeof pointer.environmentId !== "string"
  )
    return null;
  const {
    selection,
    auto,
    method,
    cloneDecided,
    replaceAll,
    replaceAllOutcome,
    moveAnyway,
    cancelled,
    seen,
    viewed,
    doneSeen,
    linked,
    planShown,
    reopened,
    ...fields
  } = pointer;
  const rest: PendingCopy = {
    ...fields,
    ...(auto === true ? { auto } : {}),
    ...(method === "copy" || method === "clone" ? { method } : {}),
    ...(cloneDecided === true ? { cloneDecided } : {}),
    ...(replaceAll === true ? { replaceAll } : {}),
    ...(replaceAll === true && REPLACE_ALL_OUTCOMES.has(replaceAllOutcome)
      ? { replaceAllOutcome }
      : {}),
    ...(moveAnyway === true ? { moveAnyway } : {}),
    ...(cancelled === true ? { cancelled } : {}),
    ...(isCopyStepId(seen) ? { seen } : {}),
    ...(isCopyStepId(viewed) ? { viewed } : {}),
    ...(doneSeen === true ? { doneSeen } : {}),
    ...(linked === true ? { linked } : {}),
    ...(planShown === true ? { planShown } : {}),
    ...(reopened === true ? { reopened } : {}),
  };
  // Secret-like files are never part of the class selection.
  const kept: unknown[] = Array.isArray(selection)
    ? selection.filter((entry) => entry !== "secret")
    : [];
  const copyable = (entry: unknown): entry is FolderCopyFileClass =>
    typeof entry === "string" && Object.hasOwn(COPYABLE_CLASSES, entry);
  return kept.length > 0 && kept.every(copyable) ? { ...rest, selection: kept } : rest;
}

export function readPendingCopy(key: string): PendingCopy | null {
  try {
    return parsePendingCopy(JSON.parse(localStorage.getItem(key) ?? "null"));
  } catch {
    return null;
  }
}

/**
 * A finished copy-only copy, moved out of the pointer once Done was seen, so a reopen
 * starts a new copy while View and Undo stay one click away.
 */
export interface LastCopy extends PendingCopy {
  readonly finishedAt: string;
}

export const folderCopyLastKey = (environmentId: string, projectId: string) =>
  `specwithcode:folder-copy-last:${environmentId}:${projectId}`;

export function readLastCopy(key: string): LastCopy | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as LastCopy | null;
    const pointer = parsePendingCopy(value);
    return pointer && typeof value?.finishedAt === "string"
      ? { ...pointer, finishedAt: value.finishedAt }
      : null;
  } catch {
    return null;
  }
}

/**
 * Keeps a finished copy as the last copy and clears the pointer. Returns the archived copy,
 * or null when storage refused; the pointer then stays, so nothing about the copy is lost.
 */
export function archivePendingCopy(input: {
  readonly pendingKey: string;
  readonly lastKey: string;
  readonly pointer: PendingCopy;
  readonly finishedAt: string;
}): LastCopy | null {
  // Where the person was looking belongs to the open copy, not the archive.
  const { doneSeen: _doneSeen, viewed: _viewed, reopened: _reopened, ...kept } = input.pointer;
  const last: LastCopy = { ...kept, finishedAt: input.finishedAt };
  try {
    localStorage.setItem(input.lastKey, JSON.stringify(last));
    localStorage.removeItem(input.pendingKey);
    return last;
  } catch {
    return null;
  }
}

/**
 * Makes the last copy the pointer again, so resuming lands on its Done with Undo. Done has
 * to be seen again before it is archived again. Null when there is no last copy; a refused
 * write still returns it, since the dialog can resume from memory.
 */
export function readoptLastCopy(input: {
  readonly pendingKey: string;
  readonly lastKey: string;
}): PendingCopy | null {
  const last = readLastCopy(input.lastKey);
  if (!last) return null;
  const { finishedAt: _finishedAt, doneSeen: _doneSeen, viewed: _viewed, ...kept } = last;
  const pointer: PendingCopy = { ...kept, reopened: true };
  try {
    localStorage.setItem(input.pendingKey, JSON.stringify(pointer));
    localStorage.removeItem(input.lastKey);
  } catch {
    /* Resuming still works for this window; only a later reopen needs the pointer. */
  }
  return pointer;
}

/** The setup choices while no copy has started, so closing the dialog on Where loses nothing. */
export interface CopyDraft {
  readonly machine: string | null;
  readonly folder: string;
  readonly copyRoot?: string;
  readonly mode: FolderCopyMode;
  readonly chooseFirst: boolean;
}

export const folderCopyDraftKey = (environmentId: string, projectId: string) =>
  `specwithcode:folder-copy-draft:${environmentId}:${projectId}`;

export function readCopyDraft(key: string): CopyDraft | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<CopyDraft> | null;
    if (!value || typeof value !== "object") return null;
    const { machine, folder, copyRoot, mode, chooseFirst } = value;
    if (machine !== null && typeof machine !== "string") return null;
    if (typeof folder !== "string" || typeof chooseFirst !== "boolean") return null;
    if (mode !== "copy-only" && mode !== "copy-and-move") return null;
    return {
      machine,
      folder,
      ...(typeof copyRoot === "string" && copyRoot ? { copyRoot } : {}),
      mode,
      chooseFirst,
    };
  } catch {
    return null;
  }
}

/** Saves the draft, or removes it for null. Returns false when storage refused. */
export function writeCopyDraft(key: string, draft: CopyDraft | null): boolean {
  try {
    if (draft) localStorage.setItem(key, JSON.stringify(draft));
    else localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export const isFolderCopyNotFound = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { _tag?: unknown })._tag === "FolderCopyError" &&
  (cause as { code?: unknown }).code === "not_found";

export const abortError = () => new DOMException("closed", "AbortError");
export const isAbortError = (cause: unknown) =>
  cause instanceof DOMException && cause.name === "AbortError";

export const sleep = (ms: number, ...signals: ReadonlyArray<AbortSignal>) =>
  new Promise<void>((resolve, reject) => {
    if (signals.some((signal) => signal.aborted)) {
      reject(abortError());
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      for (const signal of signals) signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    for (const signal of signals) signal.addEventListener("abort", stop, { once: true });
  });

/** "41,203 files, 1.2 GB" measured so far. */
export const measuredSoFar = (progress: { readonly files: number; readonly bytes: number }) =>
  `${progress.files.toLocaleString()} ${progress.files === 1 ? "file" : "files"}, ${formatBytes(progress.bytes)}`;

/** Destination states after an approval landed. */
export const APPROVED: ReadonlySet<FolderCopyStatus["state"]> = new Set([
  "approved",
  "transferring",
  "verifying",
  "applying",
  "applied",
]);
export const SOURCE_FINISHED: ReadonlySet<FolderCopySourceStatus["state"]> = new Set([
  "failed",
  "committed",
  "released",
  "cancelled",
]);

/**
 * Why the source did not drop an operation it was told to drop, or null when it did. A
 * source that no longer knows the operation has dropped it.
 */
export function sourceNotDropped<A, E>(
  result: AtomCommandResult<A, E>,
  sourceLabel: string,
): Error | null {
  if (result._tag === "Success") return null;
  const cause = squashAtomCommandFailure(result);
  if (isFolderCopyNotFound(cause)) return null;
  const said = (cause as { message?: unknown } | null)?.message;
  const message = typeof said === "string" && said ? said : "It did not answer.";
  return new Error(
    `${sourceLabel} has not dropped the copy yet: ${message} Reopen this window to tell it again, or cancel the copy on ${sourceLabel}.`,
  );
}

/** The source kept the copy, and releasing it failed too: say both, without repeating. */
export function withReleaseFailure(notDropped: Error, releaseCause: unknown): Error {
  const said = (releaseCause as { message?: unknown } | null)?.message;
  const message = typeof said === "string" && said ? said : "It did not answer.";
  return notDropped.message.includes(message)
    ? notDropped
    : new Error(`${notDropped.message} Releasing it failed too: ${message}`);
}

export function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}
